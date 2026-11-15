import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { createServer } from '../server/app.js';
import { fingerprintOf } from '../server/ssh-bridge.js';
import { startFakeSshServer } from './helpers/fake-ssh-server.js';

let dataDir;
let app;
let base;
let origin;
let cookie = '';
let lastSetCookie = '';
let ssh;
let hostId;

const OWNER_PASSWORD = 'owner-password-123';
const SSH_PASSWORD = 'correct horse';

async function request(pathname, { method = 'GET', body, headers = {} } = {}) {
  const response = await fetch(`${base}${pathname}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
      Origin: origin,
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const setCookie = response.headers.get('set-cookie');
  if (setCookie) { lastSetCookie = setCookie; cookie = setCookie.split(';')[0]; }
  return { status: response.status, body: await response.json().catch(() => null) };
}

// Opens a terminal socket and collects control messages and output.
function openTerminal({ headers } = {}) {
  const ws = new WebSocket(`${base.replace('http', 'ws')}/ws/terminal`, {
    headers: headers || { Cookie: cookie, Origin: origin },
  });
  const control = [];
  let output = '';
  const waiters = [];
  const check = () => {
    for (const waiter of [...waiters]) {
      if (waiter.predicate()) {
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve();
      }
    }
  };
  ws.on('message', (data, isBinary) => {
    if (isBinary) output += data.toString('utf8');
    else control.push(JSON.parse(data.toString('utf8')));
    check();
  });
  ws.on('close', check);
  const until = (predicate, label, ms = 8000) =>
    new Promise((resolve, reject) => {
      // Poll too: some conditions (e.g. fake-server events) change without a socket message.
      const poll = setInterval(check, 20);
      const timer = setTimeout(() => {
        clearInterval(poll);
        reject(new Error(`Timed out waiting for ${label}. Control: ${JSON.stringify(control)} Output: ${JSON.stringify(output)}`));
      }, ms);
      waiters.push({ predicate, resolve: () => { clearTimeout(timer); clearInterval(poll); resolve(); } });
      check();
    });
  return {
    ws,
    control,
    get output() { return output; },
    opened: new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('unexpected-response', (_req, res) => reject(Object.assign(new Error('rejected'), { status: res.statusCode }))); ws.once('error', reject); }),
    send: (message) => ws.send(JSON.stringify(message)),
    until,
    untilControl: (predicate, label) => until(() => control.some(predicate), label),
    untilOutput: (text) => until(() => output.includes(text), `output "${text}"`),
    closed: () => until(() => ws.readyState === WebSocket.CLOSED, 'socket close'),
  };
}

before(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'remotehub-test-'));
  app = await createServer(
    { dataDir, trustProxy: 'loopback', allowedOrigins: [], sessionTtlMs: 60_000, maxTerminals: 8 },
    { log: () => {} },
  );
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${app.server.address().port}`;
  origin = base;
  ssh = await startFakeSshServer({ password: SSH_PASSWORD });
});

after(async () => {
  app.closeTerminals();
  await new Promise((resolve) => app.server.close(resolve));
  await ssh.close();
  await fs.rm(dataDir, { recursive: true, force: true });
});

test('first run requires the setup code', async () => {
  const state = await request('/api/auth/state');
  assert.deepEqual(state.body, { setupRequired: true, authenticated: false });

  const savedCode = (await fs.readFile(path.join(dataDir, 'SETUP-CODE.txt'), 'utf8')).trim();
  assert.equal(savedCode, app.setupCode);

  const wrong = await request('/api/auth/setup', { method: 'POST', body: { setupCode: 'NOPE-NOPE', password: OWNER_PASSWORD } });
  assert.equal(wrong.status, 403);

  const weak = await request('/api/auth/setup', { method: 'POST', body: { setupCode: app.setupCode, password: 'short' } });
  assert.equal(weak.status, 400);

  const ok = await request('/api/auth/setup', { method: 'POST', body: { setupCode: savedCode, password: OWNER_PASSWORD } });
  assert.equal(ok.status, 200);
  assert.ok(cookie.startsWith('rh_session='));
  assert.doesNotMatch(lastSetCookie, /;\s*secure(?:;|$)/i, 'loopback HTTP default must remain usable without TLS');
  await assert.rejects(fs.access(path.join(dataDir, 'SETUP-CODE.txt')));

  const data = JSON.parse(await fs.readFile(path.join(dataDir, 'remotehub.json'), 'utf8'));
  assert.equal(data.owner.password.algorithm, 'scrypt');
  assert.ok(!JSON.stringify(data).includes(OWNER_PASSWORD), 'owner password must not be stored in plain text');
});

test('login, logout, and API protection', async () => {
  const session = cookie;
  cookie = '';
  assert.equal((await request('/api/hosts')).status, 401);
  assert.equal((await request('/api/auth/login', { method: 'POST', body: { password: 'wrong-password' } })).status, 401);

  const login = await request('/api/auth/login', { method: 'POST', body: { password: OWNER_PASSWORD } });
  assert.equal(login.status, 200);
  assert.notEqual(cookie, session);
  assert.equal((await request('/api/hosts')).status, 200);

  const crossSite = await request('/api/hosts', { method: 'POST', body: { name: 'x', address: '10.0.0.1', username: 'x' }, headers: { Origin: 'https://evil.example' } });
  assert.equal(crossSite.status, 403);
});

test('host CRUD validates input', async () => {
  const bad = await request('/api/hosts', { method: 'POST', body: { name: 'Bad', address: 'not a host!', username: 'root' } });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /Address/);

  const created = await request('/api/hosts', { method: 'POST', body: { name: 'Fake box', address: '127.0.0.1', port: ssh.port, username: 'tester' } });
  assert.equal(created.status, 201);
  hostId = created.body.host.id;
  assert.equal(created.body.host.knownHost, null);

  const updated = await request(`/api/hosts/${hostId}`, { method: 'PUT', body: { name: 'Fake box', address: '127.0.0.1', port: ssh.port, username: 'tester' } });
  assert.equal(updated.status, 200);

  const list = await request('/api/hosts');
  assert.equal(list.body.hosts.length, 1);
  assert.ok(!('password' in list.body.hosts[0]));
});

test('terminal socket rejects missing auth and foreign origins', async () => {
  const noCookie = openTerminal({ headers: { Origin: origin } });
  await assert.rejects(noCookie.opened, (err) => err.status === 401);

  const foreign = openTerminal({ headers: { Cookie: cookie, Origin: 'https://evil.example' } });
  await assert.rejects(foreign.opened, (err) => err.status === 403);
});

test('first connection asks to trust the fingerprint, then opens a working shell', async () => {
  const term = openTerminal();
  await term.opened;
  term.send({ t: 'connect', hostId, password: SSH_PASSWORD, cols: 100, rows: 30 });

  await term.untilControl((m) => m.t === 'hostkey', 'host key prompt');
  const prompt = term.control.find((m) => m.t === 'hostkey');
  assert.equal(prompt.status, 'new');
  assert.equal(prompt.keyType, 'ssh-ed25519');
  assert.equal(prompt.fingerprint, fingerprintOf(ssh.publicBlob));

  term.send({ t: 'hostkey', accept: true });
  await term.untilControl((m) => m.t === 'status' && m.s === 'ready', 'ready');
  assert.deepEqual(ssh.events.ptys.at(-1), { term: 'xterm-256color', cols: 100, rows: 30 });

  await term.untilOutput('fake-shell $ ');
  term.send({ t: 'in', d: 'hello\r' });
  await term.untilOutput('you typed: hello');

  term.send({ t: 'resize', cols: 140, rows: 40 });
  await term.until(() => ssh.events.resizes.some((r) => r.cols === 140 && r.rows === 40), 'window change');

  term.send({ t: 'in', d: 'exit\r' });
  await term.untilControl((m) => m.t === 'closed', 'closed message');
  await term.closed();

  const hosts = await request('/api/hosts');
  assert.equal(hosts.body.hosts[0].knownHost.fingerprint, prompt.fingerprint);

  const data = await fs.readFile(path.join(dataDir, 'remotehub.json'), 'utf8');
  assert.ok(!data.includes(SSH_PASSWORD), 'SSH password must never be written to disk');
});

test('known fingerprint connects without a prompt', async () => {
  const term = openTerminal();
  await term.opened;
  term.send({ t: 'connect', hostId, password: SSH_PASSWORD, cols: 80, rows: 24 });
  await term.untilControl((m) => m.t === 'status' && m.s === 'ready', 'ready');
  assert.ok(!term.control.some((m) => m.t === 'hostkey'));
  term.ws.close();
});

test('wrong SSH password reports an auth error', async () => {
  const term = openTerminal();
  await term.opened;
  term.send({ t: 'connect', hostId, password: 'nope', cols: 80, rows: 24 });
  await term.untilControl((m) => m.t === 'error', 'error');
  assert.equal(term.control.find((m) => m.t === 'error').code, 'auth');
  await term.closed();
});

test('rejecting an unknown fingerprint cancels and saves nothing', async () => {
  await request(`/api/hosts/${hostId}/fingerprint`, { method: 'DELETE' });
  const term = openTerminal();
  await term.opened;
  term.send({ t: 'connect', hostId, password: SSH_PASSWORD, cols: 80, rows: 24 });
  await term.untilControl((m) => m.t === 'hostkey', 'host key prompt');
  term.send({ t: 'hostkey', accept: false });
  await term.untilControl((m) => m.t === 'error', 'error');
  assert.equal(term.control.find((m) => m.t === 'error').code, 'hostkey-rejected');
  assert.equal((await request('/api/hosts')).body.hosts[0].knownHost, null);
});

test('a changed server key is blocked', async () => {
  // Trust the current key, then swap the server for one with a different key on a new port.
  const trust = openTerminal();
  await trust.opened;
  trust.send({ t: 'connect', hostId, password: SSH_PASSWORD, cols: 80, rows: 24 });
  await trust.untilControl((m) => m.t === 'hostkey', 'host key prompt');
  trust.send({ t: 'hostkey', accept: true });
  await trust.untilControl((m) => m.t === 'status' && m.s === 'ready', 'ready');
  trust.ws.close();

  const trusted = (await request('/api/hosts')).body.hosts[0].knownHost.fingerprint;
  const impostor = await startFakeSshServer({ password: SSH_PASSWORD });
  try {
    // Point the saved fingerprint at the impostor's endpoint to simulate a reinstalled machine.
    await app.store.setKnownHost('127.0.0.1', impostor.port, { keyType: 'ssh-ed25519', fingerprint: trusted });
    await request(`/api/hosts/${hostId}`, { method: 'PUT', body: { name: 'Fake box', address: '127.0.0.1', port: impostor.port, username: 'tester' } });

    const term = openTerminal();
    await term.opened;
    term.send({ t: 'connect', hostId, password: SSH_PASSWORD, cols: 80, rows: 24 });
    await term.untilControl((m) => m.t === 'error', 'error');
    const mismatch = term.control.find((m) => m.t === 'hostkey');
    assert.equal(mismatch.status, 'mismatch');
    assert.equal(mismatch.expected.fingerprint, trusted);
    assert.equal(term.control.find((m) => m.t === 'error').code, 'hostkey-mismatch');
    assert.equal(impostor.events.passwordsTried, 0, 'password must not be sent to an unverified server');
  } finally {
    await impostor.close();
  }
});

test('logout closes open terminals', async () => {
  await request(`/api/hosts/${hostId}`, { method: 'PUT', body: { name: 'Fake box', address: '127.0.0.1', port: ssh.port, username: 'tester' } });
  const term = openTerminal();
  await term.opened;
  term.send({ t: 'connect', hostId, password: SSH_PASSWORD, cols: 80, rows: 24 });
  await term.untilControl((m) => m.t === 'status' && m.s === 'ready', 'ready');
  const closeCode = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out waiting for the terminal to close on logout.')), 8000);
    term.ws.once('close', (code) => { clearTimeout(timer); resolve(code); });
  });
  await request('/api/auth/logout', { method: 'POST' });
  assert.equal(await closeCode, 4001);
});
