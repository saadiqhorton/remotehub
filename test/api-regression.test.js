import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { fingerprintOf } from '../server/ssh-bridge.js';
import { startFakeSshServer } from './helpers/fake-ssh-server.js';
import { httpClient, openTerminal, startTestApp } from './helpers/app-harness.js';

/**
 * API, host, fingerprint, and session-revocation regression tests (SAA-284).
 *
 * Gaps covered here (existing e2e tests cover create/update/list, first-trust, rejection,
 * and mismatch blocking):
 *   - host CRUD: delete, 404s, connecting to a deleted host
 *   - fingerprint forgetting: prompt returns, forget is idempotent, per-endpoint scoping
 *   - a key mismatch never overwrites the stored fingerprint
 *   - WebSocket upgrade: wrong path 404, missing Origin 403, terminal slot limit 503,
 *     server shutdown closes with 1001
 *   - session revocation closes that session's terminals and blocks its API access
 */

const OWNER_PASSWORD = 'owner-password-123';
const SSH_PASSWORD = 'correct horse';

let env;
let client;
let ssh;

before(async () => {
  env = await startTestApp();
  client = httpClient(env.base, env.origin);
  ssh = await startFakeSshServer({ password: SSH_PASSWORD });
  const setup = await client.request('/api/auth/setup', {
    method: 'POST',
    body: { setupCode: env.app.setupCode, password: OWNER_PASSWORD },
  });
  assert.equal(setup.status, 200);
});

after(async () => {
  await env.stop();
  await ssh.close();
});

async function addHost(port = ssh.port) {
  const created = await client.request('/api/hosts', {
    method: 'POST',
    body: { name: `Box ${port}`, address: '127.0.0.1', port, username: 'tester' },
  });
  assert.equal(created.status, 201);
  return created.body.host;
}

const term = () => openTerminal(env.base, { headers: { Cookie: client.cookie, Origin: env.origin } });

test('host delete removes the host and unknown ids 404', async () => {
  const host = await addHost();
  assert.equal((await client.request(`/api/hosts/${host.id}`, { method: 'DELETE' })).status, 200);
  assert.ok(!(await client.request('/api/hosts')).body.hosts.some((h) => h.id === host.id));

  for (const [method, path] of [
    ['DELETE', `/api/hosts/${host.id}`],
    ['PUT', `/api/hosts/no-such-id`],
    ['DELETE', `/api/hosts/no-such-id/fingerprint`],
  ]) {
    const res = await client.request(path, {
      method,
      ...(method === 'PUT' ? { body: { name: 'x', address: '10.0.0.1', username: 'root' } } : {}),
    });
    assert.equal(res.status, 404, `${method} ${path}`);
  }
});

test('connecting to a deleted host fails cleanly', async () => {
  const host = await addHost();
  await client.request(`/api/hosts/${host.id}`, { method: 'DELETE' });

  const t = term();
  await t.opened;
  t.send({ t: 'connect', hostId: host.id, password: SSH_PASSWORD, cols: 80, rows: 24 });
  await t.untilControl((m) => m.t === 'error', 'error');
  assert.equal(t.control.find((m) => m.t === 'error').code, 'host');
  await t.closed();
});

test('forgetting a fingerprint is idempotent and makes the next connect prompt again', async () => {
  const host = await addHost();
  const trust = (fp) => env.app.store.setKnownHost('127.0.0.1', host.port, { keyType: 'ssh-ed25519', fingerprint: fp });
  await trust(fingerprintOf(ssh.publicBlob));
  assert.ok((await client.request('/api/hosts')).body.hosts.find((h) => h.id === host.id).knownHost);

  // Forgetting twice: the route stays 200 and the stored fingerprint is gone.
  assert.equal((await client.request(`/api/hosts/${host.id}/fingerprint`, { method: 'DELETE' })).status, 200);
  assert.equal((await client.request(`/api/hosts/${host.id}/fingerprint`, { method: 'DELETE' })).status, 200);
  assert.equal((await client.request('/api/hosts')).body.hosts.find((h) => h.id === host.id).knownHost, null);

  const t = term();
  await t.opened;
  t.send({ t: 'connect', hostId: host.id, password: SSH_PASSWORD, cols: 80, rows: 24 });
  await t.untilControl((m) => m.t === 'hostkey', 'host key prompt');
  assert.equal(t.control.find((m) => m.t === 'hostkey').status, 'new');
  t.send({ t: 'hostkey', accept: true });
  await t.untilControl((m) => m.t === 'status' && m.s === 'ready', 'ready');
  t.ws.close();
  await t.closed();

  assert.equal(
    (await client.request('/api/hosts')).body.hosts.find((h) => h.id === host.id).knownHost.fingerprint,
    fingerprintOf(ssh.publicBlob),
    're-accepted fingerprint must be stored again',
  );
});

test('a host key mismatch never overwrites the stored fingerprint', async () => {
  const host = await addHost();
  const trusted = fingerprintOf(ssh.publicBlob);
  await env.app.store.setKnownHost('127.0.0.1', host.port, { keyType: 'ssh-ed25519', fingerprint: trusted });

  const impostor = await startFakeSshServer({ password: SSH_PASSWORD });
  try {
    // Move the saved host to the impostor while keeping the old fingerprint trusted.
    const moved = await client.request(`/api/hosts/${host.id}`, {
      method: 'PUT',
      body: { name: host.name, address: '127.0.0.1', port: impostor.port, username: 'tester' },
    });
    assert.equal(moved.status, 200);
    await env.app.store.setKnownHost('127.0.0.1', impostor.port, { keyType: 'ssh-ed25519', fingerprint: trusted });

    const t = term();
    await t.opened;
    t.send({ t: 'connect', hostId: host.id, password: SSH_PASSWORD, cols: 80, rows: 24 });
    await t.untilControl((m) => m.t === 'error', 'error');
    assert.equal(t.control.find((m) => m.t === 'error').code, 'hostkey-mismatch');
    await t.closed();

    assert.equal(
      env.app.store.getKnownHost('127.0.0.1', impostor.port).fingerprint,
      trusted,
      'the blocked connection must not replace the stored fingerprint',
    );
    assert.equal(impostor.events.passwordsTried, 0, 'the password must never reach an unverified server');
  } finally {
    await impostor.close();
  }
});

test('fingerprints are scoped to address:port, not to the saved host entry', async () => {
  const first = await addHost();
  const second = await addHost(ssh.port + 1); // same address, different (untrusted) endpoint
  await env.app.store.setKnownHost('127.0.0.1', first.port, {
    keyType: 'ssh-ed25519',
    fingerprint: fingerprintOf(ssh.publicBlob),
  });

  const hosts = (await client.request('/api/hosts')).body.hosts;
  assert.ok(hosts.find((h) => h.id === first.id).knownHost);
  assert.equal(hosts.find((h) => h.id === second.id).knownHost, null);

  // Repointing the second host at the trusted endpoint adopts its fingerprint.
  const moved = await client.request(`/api/hosts/${second.id}`, {
    method: 'PUT',
    body: { name: second.name, address: '127.0.0.1', port: first.port, username: 'tester' },
  });
  assert.equal(moved.body.host.knownHost.fingerprint, fingerprintOf(ssh.publicBlob));
});

test('websocket upgrade rejects unknown paths and missing origins', async () => {
  const wrongPath = new WebSocket(`${env.base.replace('http', 'ws')}/ws/other`, {
    headers: { Cookie: client.cookie, Origin: env.origin },
  });
  await assert.rejects(
    new Promise((resolve, reject) => {
      wrongPath.once('open', resolve);
      wrongPath.once('unexpected-response', (_req, res) => reject(Object.assign(new Error('rejected'), { status: res.statusCode })));
      wrongPath.once('error', reject);
    }),
    (err) => err.status === 404,
  );

  const noOrigin = openTerminal(env.base, { headers: { Cookie: client.cookie } });
  await assert.rejects(noOrigin.opened, (err) => err.status === 403);
});

test('the terminal slot limit rejects extra sockets with 503 and frees on close', async () => {
  const tiny = await startTestApp({ maxTerminals: 1 });
  const tinyClient = httpClient(tiny.base, tiny.origin);
  try {
    await tinyClient.request('/api/auth/setup', {
      method: 'POST',
      body: { setupCode: tiny.app.setupCode, password: OWNER_PASSWORD },
    });
    const headers = { Cookie: tinyClient.cookie, Origin: tiny.origin };

    const first = openTerminal(tiny.base, { headers });
    await first.opened;

    const second = openTerminal(tiny.base, { headers });
    await assert.rejects(second.opened, (err) => err.status === 503);

    first.ws.close();
    await first.closed();
    const third = openTerminal(tiny.base, { headers });
    await third.opened;
    third.ws.close();
    await third.closed();
  } finally {
    await tiny.stop();
  }
});

test('server shutdown closes open terminals with 1001', async () => {
  const doomed = await startTestApp();
  const doomedClient = httpClient(doomed.base, doomed.origin);
  await doomedClient.request('/api/auth/setup', {
    method: 'POST',
    body: { setupCode: doomed.app.setupCode, password: OWNER_PASSWORD },
  });
  const t = openTerminal(doomed.base, { headers: { Cookie: doomedClient.cookie, Origin: doomed.origin } });
  await t.opened;
  const closeCode = t.closedWithCode();
  doomed.app.closeTerminals();
  assert.equal(await closeCode, 1001);
  await doomed.stop();
});

test('revoking a session closes its terminals and blocks its API access', async () => {
  const host = await addHost();
  await env.app.store.setKnownHost('127.0.0.1', host.port, {
    keyType: 'ssh-ed25519',
    fingerprint: fingerprintOf(ssh.publicBlob),
  });

  const t = term();
  await t.opened;
  t.send({ t: 'connect', hostId: host.id, password: SSH_PASSWORD, cols: 80, rows: 24 });
  await t.untilControl((m) => m.t === 'status' && m.s === 'ready', 'ready');

  const token = client.sessionToken();
  assert.ok(token);
  const closeCode = t.closedWithCode();
  env.app.sessions.revoke(token);
  assert.equal(await closeCode, 4001, 'revoked sessions must drop their terminals');

  assert.equal((await client.request('/api/hosts')).status, 401);
  const rejected = term();
  await assert.rejects(rejected.opened, (err) => err.status === 401);

  // Other sessions are unaffected: a fresh login works immediately.
  const relogin = await client.request('/api/auth/login', { method: 'POST', body: { password: OWNER_PASSWORD } });
  assert.equal(relogin.status, 200);
  assert.equal((await client.request('/api/hosts')).status, 200);
});
