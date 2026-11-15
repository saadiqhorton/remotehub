import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { fingerprintOf } from '../server/ssh-bridge.js';
import { startFakeSshServer } from './helpers/fake-ssh-server.js';
import { httpClient, openTerminal, sleep, startTestApp, unusedPort } from './helpers/app-harness.js';

/**
 * SSH bridge regression tests (SAA-284): capture current /ws/terminal behavior so the
 * multi-surface session work cannot silently change it.
 *
 * Gaps covered here (existing e2e tests cover the happy path, first-trust prompt, wrong
 * password, fingerprint rejection/mismatch, and logout):
 *   - connect errors: unknown host, missing password, refused TCP connection
 *   - terminal size clamping on connect and resize
 *   - keyboard-interactive-only SSH servers (tryKeyboard fallback)
 *   - reconnect after the remote shell exits and after a server-side drop
 *   - concurrent terminals on one host
 *   - protocol robustness: malformed/unknown/binary/pre-shell/duplicate messages
 *
 * The known-host fingerprint is seeded in `before` so these tests skip the trust prompt;
 * fingerprint flows have their own coverage in e2e.test.js and api-regression.test.js.
 */

const OWNER_PASSWORD = 'owner-password-123';
const SSH_PASSWORD = 'correct horse';

let env;
let client;
let ssh;
let hostId;

before(async () => {
  env = await startTestApp();
  client = httpClient(env.base, env.origin);
  ssh = await startFakeSshServer({ password: SSH_PASSWORD });

  const setup = await client.request('/api/auth/setup', {
    method: 'POST',
    body: { setupCode: env.app.setupCode, password: OWNER_PASSWORD },
  });
  assert.equal(setup.status, 200);

  const created = await client.request('/api/hosts', {
    method: 'POST',
    body: { name: 'Fake box', address: '127.0.0.1', port: ssh.port, username: 'tester' },
  });
  assert.equal(created.status, 201);
  hostId = created.body.host.id;

  // Trust the fake server key up front so connects go straight to authentication.
  await env.app.store.setKnownHost('127.0.0.1', ssh.port, {
    keyType: 'ssh-ed25519',
    fingerprint: fingerprintOf(ssh.publicBlob),
  });
});

after(async () => {
  await env.stop();
  await ssh.close();
});

const term = () => openTerminal(env.base, { headers: { Cookie: client.cookie, Origin: env.origin } });
const isReady = (m) => m.t === 'status' && m.s === 'ready';
const isError = (m) => m.t === 'error';

test('connect to an unknown host id fails without touching the network', async () => {
  const t = term();
  await t.opened;
  t.send({ t: 'connect', hostId: 'no-such-host', password: SSH_PASSWORD, cols: 80, rows: 24 });
  await t.untilControl(isError, 'error');
  assert.equal(t.control.find(isError).code, 'host');
  await t.closed();
  assert.equal(ssh.events.passwordsTried, 0);
});

test('connect without a password fails before any SSH handshake', async () => {
  for (const password of [undefined, '', 42]) {
    const t = term();
    await t.opened;
    t.send({ t: 'connect', hostId, password, cols: 80, rows: 24 });
    await t.untilControl(isError, 'error');
    assert.equal(t.control.find(isError).code, 'auth');
    await t.closed();
  }
  assert.equal(ssh.events.passwordsTried, 0, 'no password attempt may reach the SSH server');
});

test('a refused TCP connection reports a network error', async () => {
  const port = await unusedPort();
  const created = await client.request('/api/hosts', {
    method: 'POST',
    body: { name: 'Dead box', address: '127.0.0.1', port, username: 'tester' },
  });
  assert.equal(created.status, 201);

  const t = term();
  await t.opened;
  t.send({ t: 'connect', hostId: created.body.host.id, password: SSH_PASSWORD, cols: 80, rows: 24 });
  await t.untilControl(isError, 'error');
  const error = t.control.find(isError);
  assert.equal(error.code, 'network');
  assert.match(error.message, /^Nothing answered when RemoteHub tried to connect to this computer\.$/);
  await t.closed();
});

test('terminal dimensions are clamped to safe bounds on connect', async () => {
  const t = term();
  await t.opened;
  t.send({ t: 'connect', hostId, password: SSH_PASSWORD, cols: 100000, rows: 100000 });
  await t.untilControl(isReady, 'ready');
  assert.deepEqual(ssh.events.ptys.at(-1), { term: 'xterm-256color', cols: 500, rows: 300 });
  t.ws.close();
  await t.closed();

  const fallback = term();
  await fallback.opened;
  fallback.send({ t: 'connect', hostId, password: SSH_PASSWORD, cols: 'wide', rows: null });
  await fallback.untilControl(isReady, 'ready');
  assert.deepEqual(ssh.events.ptys.at(-1), { term: 'xterm-256color', cols: 120, rows: 32 });
  fallback.ws.close();
  await fallback.closed();
});

test('resize dimensions are clamped before reaching the SSH server', async () => {
  const t = term();
  await t.opened;
  t.send({ t: 'connect', hostId, password: SSH_PASSWORD, cols: 80, rows: 24 });
  await t.untilControl(isReady, 'ready');
  t.send({ t: 'resize', cols: 100000, rows: -5 });
  await t.until(
    () => ssh.events.resizes.some((r) => r.cols === 500 && r.rows === 2),
    'clamped window change',
  );
  t.ws.close();
  await t.closed();
});

test('keyboard-interactive-only servers log in with the same password', async () => {
  const pamOnly = await startFakeSshServer({ password: SSH_PASSWORD, keyboardInteractive: true });
  try {
    await env.app.store.setKnownHost('127.0.0.1', pamOnly.port, {
      keyType: 'ssh-ed25519',
      fingerprint: fingerprintOf(pamOnly.publicBlob),
    });
    const created = await client.request('/api/hosts', {
      method: 'POST',
      body: { name: 'PAM box', address: '127.0.0.1', port: pamOnly.port, username: 'tester' },
    });
    assert.equal(created.status, 201);

    const t = term();
    await t.opened;
    t.send({ t: 'connect', hostId: created.body.host.id, password: SSH_PASSWORD, cols: 80, rows: 24 });
    await t.untilControl(isReady, 'ready');
    assert.equal(pamOnly.events.keyboardTried, 1);
    assert.equal(pamOnly.events.passwordsTried, 0);
    t.send({ t: 'in', d: 'hi\r' });
    await t.untilOutput('you typed: hi');
    t.ws.close();
    await t.closed();
  } finally {
    await pamOnly.close();
  }
});

test('reconnect after the remote shell exits works without a new prompt', async () => {
  const first = term();
  await first.opened;
  first.send({ t: 'connect', hostId, password: SSH_PASSWORD, cols: 80, rows: 24 });
  await first.untilControl(isReady, 'ready');
  const closedCode = first.closedWithCode();
  first.send({ t: 'in', d: 'exit\r' });
  await first.untilControl((m) => m.t === 'closed', 'closed message');
  assert.equal(first.control.find((m) => m.t === 'closed').reason, 'The remote shell exited.');
  assert.equal(await closedCode, 1000);

  const second = term();
  await second.opened;
  second.send({ t: 'connect', hostId, password: SSH_PASSWORD, cols: 80, rows: 24 });
  await second.untilControl(isReady, 'ready');
  assert.ok(!second.control.some((m) => m.t === 'hostkey'), 'trusted hosts must not re-prompt');
  second.send({ t: 'in', d: 'back again\r' });
  await second.untilOutput('you typed: back again');
  second.ws.close();
  await second.closed();
});

test('a server-side drop reports closed and a fresh reconnect succeeds', async () => {
  const first = term();
  await first.opened;
  first.send({ t: 'connect', hostId, password: SSH_PASSWORD, cols: 80, rows: 24 });
  await first.untilControl(isReady, 'ready');

  ssh.closeClients();
  await first.untilControl((m) => m.t === 'closed', 'closed message');
  assert.equal(
    first.control.find((m) => m.t === 'closed').reason,
    'The connection was closed by the server.',
  );
  await first.closed();

  const second = term();
  await second.opened;
  second.send({ t: 'connect', hostId, password: SSH_PASSWORD, cols: 80, rows: 24 });
  await second.untilControl(isReady, 'ready');
  second.send({ t: 'in', d: 'still here\r' });
  await second.untilOutput('you typed: still here');
  second.ws.close();
  await second.closed();
});

test('two terminals on the same host run independently', async () => {
  const one = term();
  const two = term();
  await Promise.all([one.opened, two.opened]);
  one.send({ t: 'connect', hostId, password: SSH_PASSWORD, cols: 80, rows: 24 });
  two.send({ t: 'connect', hostId, password: SSH_PASSWORD, cols: 90, rows: 25 });
  await one.untilControl(isReady, 'ready (one)');
  await two.untilControl(isReady, 'ready (two)');

  one.send({ t: 'in', d: 'from-one\r' });
  await one.untilOutput('you typed: from-one');
  assert.ok(!two.output.includes('you typed: from-one'), 'output must not leak across terminals');

  one.ws.close();
  await one.closed();
  two.send({ t: 'in', d: 'from-two\r' });
  await two.untilOutput('you typed: from-two');
  two.ws.close();
  await two.closed();
});

test('binary, unknown-type, pre-shell, and duplicate messages are ignored', async () => {
  const before = ssh.events.passwordsTried;
  const t = term();
  await t.opened;

  // Nothing has started yet: all of these must be no-ops, and the socket must stay open.
  t.sendRaw(Buffer.from([0x00, 0x01, 0x02]));
  t.send({ t: 'bogus-type' });
  t.send({ t: 'in', d: 'too early' });
  t.send({ t: 'resize', cols: 50, rows: 10 });
  t.send({ t: 'hostkey', accept: true });
  await sleep(150);
  assert.equal(t.ws.readyState, t.ws.OPEN, 'socket must stay open');
  assert.equal(t.control.length, 0, 'no control messages may be sent before connect');

  t.send({ t: 'connect', hostId, password: SSH_PASSWORD, cols: 80, rows: 24 });
  await t.untilControl(isReady, 'ready');

  // A second connect on the same socket must be ignored, even with different credentials.
  t.send({ t: 'connect', hostId, password: 'wrong password', cols: 81, rows: 25 });
  t.send({ t: 'in', d: 'ping\r' });
  await t.untilOutput('you typed: ping');
  assert.equal(ssh.events.passwordsTried, before + 1, 'duplicate connect must not re-authenticate');
  assert.ok(!t.control.some(isError), 'duplicate connect must not error the session');

  t.ws.close();
  await t.closed();
});

test('malformed JSON from the browser is a protocol error, not a crash', async () => {
  const t = term();
  await t.opened;
  t.sendRaw('this is not json');
  await t.untilControl(isError, 'error');
  assert.equal(t.control.find(isError).code, 'protocol');
  await t.closed();
});
