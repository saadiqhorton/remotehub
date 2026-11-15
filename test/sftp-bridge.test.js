import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fingerprintOf } from '../server/ssh-bridge.js';
import { describeSftpError, MAX_VIEW_BYTES, normalizeEntry, safePath, VIEW_WINDOW_BYTES } from '../server/sftp-bridge.js';
import { startFakeSshServer } from './helpers/fake-ssh-server.js';
import { httpClient, openFiles, openTerminal, sleep, startTestApp, unusedPort } from './helpers/app-harness.js';

/**
 * SFTP bridge tests (SAA-288): the /ws/files surface built on server/ssh-bridge.js.
 *
 * The pure helpers (safePath / describeSftpError / normalizeEntry) are unit tested; the rest
 * drives the bridge against the fake SSH server's fixed SFTP tree. The known-host fingerprint
 * for the shared fake server is seeded in `before`, so those tests skip the trust prompt.
 */

const OWNER_PASSWORD = 'owner-password-123';
const SSH_PASSWORD = 'correct horse';
const HOME = '/home/tester';

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

  await env.app.store.setKnownHost('127.0.0.1', ssh.port, {
    keyType: 'ssh-ed25519',
    fingerprint: fingerprintOf(ssh.publicBlob),
  });
});

after(async () => {
  await env.stop();
  await ssh.close();
});

const files = () => openFiles(env.base, { headers: { Cookie: client.cookie, Origin: env.origin } });
const term = () => openTerminal(env.base, { headers: { Cookie: client.cookie, Origin: env.origin } });
const isReady = (m) => m.t === 'status' && m.s === 'ready';
const connError = (m) => m.t === 'error' && m.id === undefined;
const resultFor = (id) => (m) => m.t === 'result' && m.id === id;
const opErrorFor = (id) => (m) => m.t === 'error' && m.id === id;

const lastResult = (f, id) => f.control.find((m) => m.t === 'result' && m.id === id);
const lastOpError = (f, id) => f.control.find((m) => m.t === 'error' && m.id === id);

async function connect(f) {
  await f.opened;
  f.send({ t: 'connect', hostId, password: SSH_PASSWORD });
  await f.untilControl(isReady, 'ready');
}

// --- unit: safePath ----------------------------------------------------------------------

test('safePath accepts absolute printable paths and rejects everything else', () => {
  for (const value of ['/', '/a', '/a/b.txt', '/home/tester/../x', '.']) {
    assert.equal(safePath(value), value, value);
  }
  for (const value of [
    undefined,
    42,
    '',
    'relative',
    './x',
    'C:\\x',
    '/a\0b',
    '/a\nb',
    '/a\u007fb',
    `/${'a'.repeat(4096)}`,
  ]) {
    assert.equal(safePath(value), null, JSON.stringify(value));
  }
});

// --- unit: describeSftpError -------------------------------------------------------------

test('describeSftpError maps statuses to stable codes', () => {
  assert.deepEqual(describeSftpError({ code: 2 }), { code: 'not-found', message: 'No such file or directory' });
  assert.deepEqual(describeSftpError({ code: 3 }), { code: 'denied', message: 'Permission denied' });
  for (const code of [4, 5, 6, 7, 8, undefined, 99]) {
    const mapped = describeSftpError({ code, message: `server said ${code}` });
    assert.equal(mapped.code, 'sftp', String(code));
    if (code !== undefined) assert.equal(mapped.message, `server said ${code}`);
  }
});

// --- unit: normalizeEntry ----------------------------------------------------------------

test('normalizeEntry maps types, scales times, masks mode, and drops dot entries', () => {
  const dir = { mode: 0o040755, size: 0, mtime: 100, atime: 90, isDirectory: () => true };
  const file = { mode: 0o100644, size: 10, mtime: 200, atime: 190, isFile: () => true };
  const link = { mode: 0o120777, size: 0, mtime: 300, atime: 290, isSymbolicLink: () => true };
  assert.equal(normalizeEntry('d', dir).type, 'dir');
  assert.equal(normalizeEntry('f', file).type, 'file');
  assert.equal(normalizeEntry('l', link).type, 'symlink');
  assert.equal(normalizeEntry('f', file).mtime, 200 * 1000);
  assert.equal(normalizeEntry('f', file).atime, 190 * 1000);
  assert.equal(normalizeEntry('d', dir).mode, 0o755);

  assert.equal(normalizeEntry('.', dir), null);
  assert.equal(normalizeEntry('..', dir), null);

  const empty = normalizeEntry('x', undefined);
  assert.deepEqual(empty, { name: 'x', type: 'other', size: 0, mtime: 0, atime: 0, mode: 0 });

  // Plain objects with no is* methods fall back to the file-type bits.
  assert.equal(normalizeEntry('d', { mode: 0o040000 }).type, 'dir');
  assert.equal(normalizeEntry('f', { mode: 0o100000 }).type, 'file');
  assert.equal(normalizeEntry('l', { mode: 0o120000 }).type, 'symlink');
  assert.equal(normalizeEntry('o', { mode: 0 }).type, 'other');
});

// --- connect flow --------------------------------------------------------------------------

test('connect reports connecting, authenticating, then ready for a trusted host', async () => {
  const f = files();
  await f.opened;
  f.send({ t: 'connect', hostId, password: SSH_PASSWORD });
  await f.untilControl(isReady, 'ready');
  const statuses = f.control.filter((m) => m.t === 'status').map((m) => m.s);
  assert.deepEqual(statuses, ['connecting', 'authenticating', 'ready']);
  assert.ok(!f.control.some((m) => m.t === 'hostkey'), 'trusted hosts must not prompt');
  f.ws.close();
  await f.closed();
});

// --- list ----------------------------------------------------------------------------------

test('list returns sorted entries with normalized metadata and no dot entries', async () => {
  const f = files();
  await connect(f);
  f.send({ t: 'list', id: 1, path: HOME });
  await f.untilControl(resultFor(1), 'list result');
  const { entries } = lastResult(f, 1);
  assert.deepEqual(entries.map((e) => e.name), ['.hidden', 'documents', 'link-to-documents', 'photo.jpg']);
  assert.deepEqual(entries.map((e) => e.type), ['file', 'dir', 'symlink', 'file']);

  const photo = entries.find((e) => e.name === 'photo.jpg');
  assert.equal(photo.size, 2048);
  assert.equal(photo.mtime, 1700000100000);
  assert.equal(photo.mode, 0o644);
  assert.equal(entries.find((e) => e.name === 'documents').mode, 493);
  assert.ok(!entries.some((e) => e.name === '.' || e.name === '..'));
  f.ws.close();
  await f.closed();
});

// --- realpath ------------------------------------------------------------------------------

test('realpath resolves the home dir and existing paths, and reports missing ones', async () => {
  const f = files();
  await connect(f);

  f.send({ t: 'realpath', id: 'home', path: '.' });
  await f.untilControl(resultFor('home'), 'home realpath');
  assert.equal(lastResult(f, 'home').path, HOME);

  f.send({ t: 'realpath', id: 'dir', path: `${HOME}/documents` });
  await f.untilControl(resultFor('dir'), 'dir realpath');
  assert.equal(lastResult(f, 'dir').path, `${HOME}/documents`);

  f.send({ t: 'realpath', id: 'gone', path: '/nope' });
  await f.untilControl(opErrorFor('gone'), 'missing realpath');
  assert.deepEqual(lastOpError(f, 'gone'), {
    t: 'error',
    id: 'gone',
    code: 'not-found',
    message: 'No such file or directory: /nope',
  });
  assert.equal(f.ws.readyState, f.ws.OPEN, 'a missing path must not end the session');
  f.ws.close();
  await f.closed();
});

// --- stat (lstat semantics) ----------------------------------------------------------------

test('stat uses lstat semantics for files, dirs, symlinks, and missing paths', async () => {
  const f = files();
  await connect(f);

  f.send({ t: 'stat', id: 1, path: `${HOME}/link-to-documents` });
  await f.untilControl(resultFor(1), 'symlink stat');
  assert.equal(lastResult(f, 1).entry.type, 'symlink');

  f.send({ t: 'stat', id: 2, path: `${HOME}/photo.jpg` });
  await f.untilControl(resultFor(2), 'file stat');
  const photo = lastResult(f, 2).entry;
  assert.equal(photo.type, 'file');
  assert.equal(photo.size, 2048);
  assert.equal(photo.mtime, 1700000100000);

  f.send({ t: 'stat', id: 3, path: `${HOME}/documents` });
  await f.untilControl(resultFor(3), 'dir stat');
  assert.equal(lastResult(f, 3).entry.type, 'dir');

  f.send({ t: 'stat', id: 4, path: `${HOME}/missing` });
  await f.untilControl(opErrorFor(4), 'missing stat');
  assert.equal(lastOpError(f, 4).code, 'not-found');
  f.ws.close();
  await f.closed();
});

// --- op errors -----------------------------------------------------------------------------

test('listing a file is an op error and the session survives', async () => {
  const f = files();
  await connect(f);
  f.send({ t: 'list', id: 'file', path: `${HOME}/photo.jpg` });
  await f.untilControl(opErrorFor('file'), 'file list error');
  const error = lastOpError(f, 'file');
  assert.equal(error.code, 'sftp');
  assert.match(error.message, /Not a directory/);

  f.send({ t: 'realpath', id: 'after', path: '.' });
  await f.untilControl(resultFor('after'), 'realpath after error');
  assert.equal(lastResult(f, 'after').path, HOME);
  f.ws.close();
  await f.closed();
});

test('listing a denied directory is a denied op error and the session survives', async () => {
  const f = files();
  await connect(f);
  f.send({ t: 'list', id: 'denied', path: '/denied' });
  await f.untilControl(opErrorFor('denied'), 'denied list error');
  assert.equal(lastOpError(f, 'denied').code, 'denied');

  f.send({ t: 'realpath', id: 'ok', path: '/' });
  await f.untilControl(resultFor('ok'), 'realpath after denied');
  assert.equal(lastResult(f, 'ok').path, '/');
  f.ws.close();
  await f.closed();
});

test('invalid paths produce path op errors and the session survives', async () => {
  const f = files();
  await connect(f);
  for (const [id, bad] of [['a', 'documents'], ['b', ''], ['c', '/a\u0001b']]) {
    f.send({ t: 'list', id, path: bad });
    await f.untilControl(opErrorFor(id), `path error ${id}`);
    const error = lastOpError(f, id);
    assert.equal(error.code, 'path', id);
    assert.equal(error.id, id);
  }
  f.send({ t: 'realpath', id: 'after', path: '.' });
  await f.untilControl(resultFor('after'), 'realpath after path errors');
  assert.equal(lastResult(f, 'after').path, HOME);
  f.ws.close();
  await f.closed();
});

test('missing or oversized ids are silently ignored, numeric ids are echoed', async () => {
  const f = files();
  await connect(f);
  const before = f.control.length;

  f.send({ t: 'list', path: HOME });
  f.send({ t: 'list', id: 'x'.repeat(65), path: HOME });
  await sleep(150);
  assert.equal(f.control.length, before, 'invalid ids must not produce a response');
  assert.equal(f.ws.readyState, f.ws.OPEN);

  f.send({ t: 'list', id: 7, path: HOME });
  await f.untilControl(resultFor(7), 'numeric id result');
  assert.equal(lastResult(f, 7).id, 7);
  f.ws.close();
  await f.closed();
});

// --- credential / host errors --------------------------------------------------------------

test('a wrong password is an auth connection error and the server saw one attempt', async () => {
  const before = ssh.events.passwordsTried;
  const f = files();
  await f.opened;
  f.send({ t: 'connect', hostId, password: 'not the password' });
  await f.untilControl(connError, 'auth error');
  assert.equal(f.control.find(connError).code, 'auth');
  assert.equal(ssh.events.passwordsTried, before + 1);
  await f.closed();
});

test('an unknown host id fails without touching the network', async () => {
  const before = ssh.events.passwordsTried;
  const f = files();
  await f.opened;
  f.send({ t: 'connect', hostId: 'no-such-host', password: SSH_PASSWORD });
  await f.untilControl(connError, 'host error');
  assert.equal(f.control.find(connError).code, 'host');
  await f.closed();
  assert.equal(ssh.events.passwordsTried, before);
});

test('missing or invalid passwords fail before any SSH handshake', async () => {
  const before = ssh.events.passwordsTried;
  for (const password of [undefined, '', 42]) {
    const f = files();
    await f.opened;
    f.send({ t: 'connect', hostId, password });
    await f.untilControl(connError, 'auth error');
    assert.equal(f.control.find(connError).code, 'auth');
    await f.closed();
  }
  assert.equal(ssh.events.passwordsTried, before, 'no password attempt may reach the SSH server');
});

test('a refused TCP connection reports the same network message as the terminal', async () => {
  const port = await unusedPort();
  const created = await client.request('/api/hosts', {
    method: 'POST',
    body: { name: 'Dead box', address: '127.0.0.1', port, username: 'tester' },
  });
  assert.equal(created.status, 201);
  const deadHostId = created.body.host.id;

  for (const open of [files, term]) {
    const ws = open();
    await ws.opened;
    ws.send({ t: 'connect', hostId: deadHostId, password: SSH_PASSWORD, cols: 80, rows: 24 });
    await ws.untilControl(connError, 'network error');
    const error = ws.control.find(connError);
    assert.equal(error.code, 'network');
    assert.match(error.message, /^Nothing answered when RemoteHub tried to connect to this computer\.$/);
    await ws.closed();
  }
});

// --- host key flows ------------------------------------------------------------------------

test('a new host key prompts, persists on accept, and is not re-prompted', async () => {
  const fresh = await startFakeSshServer({ password: SSH_PASSWORD });
  try {
    const created = await client.request('/api/hosts', {
      method: 'POST',
      body: { name: 'Fresh box', address: '127.0.0.1', port: fresh.port, username: 'tester' },
    });
    const freshHostId = created.body.host.id;

    const first = files();
    await first.opened;
    first.send({ t: 'connect', hostId: freshHostId, password: SSH_PASSWORD });
    await first.untilControl((m) => m.t === 'hostkey', 'host key prompt');
    const prompt = first.control.find((m) => m.t === 'hostkey');
    assert.equal(prompt.status, 'new');
    assert.ok(prompt.fingerprint.startsWith('SHA256:'));
    first.send({ t: 'hostkey', accept: true });
    await first.untilControl(isReady, 'ready after accept');
    first.ws.close();
    await first.closed();

    assert.equal(
      env.app.store.getKnownHost('127.0.0.1', fresh.port).fingerprint,
      fingerprintOf(fresh.publicBlob),
    );

    const second = files();
    await second.opened;
    second.send({ t: 'connect', hostId: freshHostId, password: SSH_PASSWORD });
    await second.untilControl(isReady, 'ready second');
    assert.ok(!second.control.some((m) => m.t === 'hostkey'), 'trusted hosts must not re-prompt');
    second.ws.close();
    await second.closed();
  } finally {
    await fresh.close();
  }
});

test('a host key mismatch is blocked before authentication', async () => {
  const impostor = await startFakeSshServer({ password: SSH_PASSWORD });
  try {
    const created = await client.request('/api/hosts', {
      method: 'POST',
      body: { name: 'Impostor', address: '127.0.0.1', port: impostor.port, username: 'tester' },
    });
    const impostorHostId = created.body.host.id;
    const trusted = fingerprintOf(ssh.publicBlob);
    await env.app.store.setKnownHost('127.0.0.1', impostor.port, { keyType: 'ssh-ed25519', fingerprint: trusted });

    const f = files();
    await f.opened;
    f.send({ t: 'connect', hostId: impostorHostId, password: SSH_PASSWORD });
    await f.untilControl((m) => m.t === 'hostkey', 'mismatch prompt');
    assert.equal(f.control.find((m) => m.t === 'hostkey').status, 'mismatch');
    await f.untilControl(connError, 'mismatch error');
    assert.equal(f.control.find(connError).code, 'hostkey-mismatch');
    await f.closed();
    assert.equal(impostor.events.passwordsTried, 0, 'the password must never reach an unverified server');
  } finally {
    await impostor.close();
  }
});

test('rejecting a new host key cancels the connection and stores nothing', async () => {
  const untrusted = await startFakeSshServer({ password: SSH_PASSWORD });
  try {
    const created = await client.request('/api/hosts', {
      method: 'POST',
      body: { name: 'Untrusted', address: '127.0.0.1', port: untrusted.port, username: 'tester' },
    });
    const untrustedHostId = created.body.host.id;

    const f = files();
    await f.opened;
    f.send({ t: 'connect', hostId: untrustedHostId, password: SSH_PASSWORD });
    await f.untilControl((m) => m.t === 'hostkey', 'host key prompt');
    f.send({ t: 'hostkey', accept: false });
    await f.untilControl(connError, 'reject error');
    assert.equal(f.control.find(connError).code, 'hostkey-rejected');
    await f.closed();
    assert.equal(env.app.store.getKnownHost('127.0.0.1', untrusted.port), null);
  } finally {
    await untrusted.close();
  }
});

// --- protocol robustness -------------------------------------------------------------------

test('malformed JSON is a protocol connection error', async () => {
  const f = files();
  await f.opened;
  f.sendRaw('this is not json');
  await f.untilControl(connError, 'protocol error');
  assert.equal(f.control.find(connError).code, 'protocol');
  await f.closed();
});

test('binary, unknown, pre-connect, and duplicate messages are ignored', async () => {
  const before = ssh.events.passwordsTried;
  const f = files();
  await f.opened;

  f.sendRaw(Buffer.from([0x00, 0x01, 0x02]));
  f.send({ t: 'bogus-type' });
  f.send({ t: 'list', id: 1, path: HOME });
  await sleep(150);
  assert.equal(f.ws.readyState, f.ws.OPEN);
  assert.equal(f.control.length, 0, 'no messages may be sent before connect');

  f.send({ t: 'connect', hostId, password: SSH_PASSWORD });
  await f.untilControl(isReady, 'ready');

  // A second connect must be ignored even with different credentials.
  f.send({ t: 'connect', hostId, password: 'wrong password' });
  f.send({ t: 'list', id: 2, path: HOME });
  await f.untilControl(resultFor(2), 'list after duplicate connect');
  assert.equal(ssh.events.passwordsTried, before + 1, 'duplicate connect must not re-authenticate');
  assert.ok(!f.control.some(connError), 'duplicate connect must not error the session');
  f.ws.close();
  await f.closed();
});

test('credentials are never persisted to disk or echoed in control frames', async () => {
  const f = files();
  await connect(f);
  f.send({ t: 'list', id: 1, path: HOME });
  await f.untilControl(resultFor(1), 'list result');
  f.ws.close();
  await f.closed();

  const raw = await fs.readFile(path.join(env.dataDir, 'remotehub.json'), 'utf8');
  assert.ok(!raw.includes(SSH_PASSWORD), 'the SSH password must never be written to disk');
  assert.ok(!f.control.some((m) => JSON.stringify(m).includes(SSH_PASSWORD)), 'control frames must not echo the password');
});

// --- concurrency / independence ------------------------------------------------------------

test('concurrent ops with distinct ids all return with the right ids', async () => {
  const f = files();
  await connect(f);
  f.send({ t: 'list', id: 'l', path: HOME });
  f.send({ t: 'stat', id: 's', path: `${HOME}/photo.jpg` });
  f.send({ t: 'realpath', id: 'r', path: '.' });
  await f.untilControl(resultFor('l'), 'list result');
  await f.untilControl(resultFor('s'), 'stat result');
  await f.untilControl(resultFor('r'), 'realpath result');
  assert.equal(lastResult(f, 'l').op, 'list');
  assert.equal(lastResult(f, 's').op, 'stat');
  assert.equal(lastResult(f, 'r').op, 'realpath');
  assert.equal(lastResult(f, 'r').path, HOME);
  f.ws.close();
  await f.closed();
});

test('terminal and files sessions on one host are independent', async () => {
  const t = term();
  const f = files();
  await Promise.all([t.opened, f.opened]);
  t.send({ t: 'connect', hostId, password: SSH_PASSWORD, cols: 80, rows: 24 });
  f.send({ t: 'connect', hostId, password: SSH_PASSWORD });
  await t.untilControl(isReady, 'terminal ready');
  await f.untilControl(isReady, 'files ready');

  t.send({ t: 'in', d: 'hello files\r' });
  await t.untilOutput('you typed: hello files');
  f.send({ t: 'list', id: 1, path: HOME });
  await f.untilControl(resultFor(1), 'files list');

  // Closing files must not disturb the terminal.
  f.ws.close();
  await f.closed();
  t.send({ t: 'in', d: 'still here\r' });
  await t.untilOutput('you typed: still here');

  // Closing the terminal while a fresh files session is open must not disturb it.
  const other = files();
  await connect(other);
  t.ws.close();
  await t.closed();
  other.send({ t: 'list', id: 2, path: HOME });
  await other.untilControl(resultFor(2), 'files list after terminal close');
  other.ws.close();
  await other.closed();
});

// --- lifecycle -----------------------------------------------------------------------------

test('a server drop reports closed and a fresh files session reconnects', async () => {
  const first = files();
  await connect(first);
  ssh.closeClients();
  await first.untilControl((m) => m.t === 'closed', 'closed message');
  assert.equal(first.control.find((m) => m.t === 'closed').reason, 'The connection was closed by the server.');
  await first.closed();

  const second = files();
  await connect(second);
  second.send({ t: 'list', id: 1, path: HOME });
  await second.untilControl(resultFor(1), 'list after reconnect');
  second.ws.close();
  await second.closed();
});

test('ops sent before ready are dropped, and work after ready', async () => {
  const f = files();
  await f.opened;
  f.send({ t: 'connect', hostId, password: SSH_PASSWORD });
  f.send({ t: 'list', id: 'early', path: HOME });
  await f.untilControl(isReady, 'ready');
  assert.ok(!f.control.some(resultFor('early')), 'pre-ready ops must be dropped');

  f.send({ t: 'list', id: 'late', path: HOME });
  await f.untilControl(resultFor('late'), 'post-ready list');
  f.ws.close();
  await f.closed();
});

// --- limits --------------------------------------------------------------------------------

test('MAX_FILES limits files sockets without limiting terminals', async () => {
  const tiny = await startTestApp({ maxFiles: 1 });
  const tinyClient = httpClient(tiny.base, tiny.origin);
  try {
    await tinyClient.request('/api/auth/setup', {
      method: 'POST',
      body: { setupCode: tiny.app.setupCode, password: OWNER_PASSWORD },
    });
    const headers = { Cookie: tinyClient.cookie, Origin: tiny.origin };

    const first = openFiles(tiny.base, { headers });
    await first.opened;

    const second = openFiles(tiny.base, { headers });
    await assert.rejects(second.opened, (err) => err.status === 503);

    // Limits are independent: a terminal still fits under maxTerminals.
    const t = openTerminal(tiny.base, { headers });
    await t.opened;
    t.ws.close();
    await t.closed();

    first.ws.close();
    await first.closed();
  } finally {
    await tiny.stop();
  }
});

// --- revocation ----------------------------------------------------------------------------

test('read returns text for a small file and keeps the session open', async () => {
  const f = files();
  await connect(f);
  f.send({ t: 'read', id: 1, path: '/srv/notes.txt' });
  await f.untilControl(resultFor(1), 'read result');
  const result = lastResult(f, 1);
  assert.equal(result.op, 'read');
  assert.equal(result.text, 'alpha\n    beta\n');
  assert.equal(result.truncated, false);
  assert.equal(result.size, 15);
  assert.equal(f.ws.readyState, f.ws.OPEN);

  f.send({ t: 'list', id: 2, path: HOME });
  await f.untilControl(resultFor(2), 'list after read');
  assert.ok(lastResult(f, 2).entries.length > 0);
  f.ws.close();
  await f.closed();
});

test('read reports missing, denied, binary, and too-large without sending bytes', async () => {
  const f = files();
  await connect(f);

  f.send({ t: 'read', id: 'gone', path: '/srv/missing.txt' });
  await f.untilControl(opErrorFor('gone'), 'missing read');
  assert.equal(lastOpError(f, 'gone').code, 'not-found');

  f.send({ t: 'read', id: 'key', path: '/srv/private.key' });
  await f.untilControl(opErrorFor('key'), 'denied read');
  const denied = lastOpError(f, 'key');
  assert.equal(denied.code, 'denied');
  assert.equal(JSON.stringify(denied).includes('not-sent'), false);

  f.send({ t: 'read', id: 'bin', path: '/srv/icon.bin' });
  await f.untilControl(opErrorFor('bin'), 'binary read');
  const binary = lastOpError(f, 'bin');
  assert.equal(binary.code, 'binary');
  assert.equal(Object.hasOwn(binary, 'text'), false);
  assert.equal(JSON.stringify(binary).includes('\\u0000'), false);
  assert.equal(JSON.stringify(binary).includes('89504e47'), false);

  assert.ok(1024 * 1024 > MAX_VIEW_BYTES);
  f.send({ t: 'read', id: 'big', path: '/srv/big.log' });
  await f.untilControl(opErrorFor('big'), 'too-large read');
  const large = lastOpError(f, 'big');
  assert.equal(large.code, 'too-large');
  assert.equal(large.size, 1024 * 1024);
  assert.equal(Object.hasOwn(large, 'text'), false);
  assert.equal(ssh.events.sftp.opens.includes('/srv/big.log'), false);

  assert.ok(96 * 1024 > VIEW_WINDOW_BYTES);
  assert.ok(96 * 1024 <= MAX_VIEW_BYTES);
  f.send({ t: 'read', id: 'essay', path: '/srv/essay.txt' });
  await f.untilControl(resultFor('essay'), 'windowed read');
  const essay = lastResult(f, 'essay');
  assert.equal(essay.truncated, true);
  assert.equal(essay.size, 96 * 1024);
  assert.equal(essay.text.length, VIEW_WINDOW_BYTES);
  assert.equal(ssh.events.sftp.readBytes['/srv/essay.txt'], VIEW_WINDOW_BYTES);
  assert.equal(f.ws.readyState, f.ws.OPEN);

  f.send({ t: 'list', id: 'still', path: HOME });
  await f.untilControl(resultFor('still'), 'list after failed reads');
  assert.ok(lastResult(f, 'still').entries.some((entry) => entry.name === 'photo.jpg'));
  f.ws.close();
  await f.closed();
});

test('logging out revokes the files socket with 4001', async () => {
  const own = await startTestApp();
  const ownClient = httpClient(own.base, own.origin);
  try {
    await ownClient.request('/api/auth/setup', {
      method: 'POST',
      body: { setupCode: own.app.setupCode, password: OWNER_PASSWORD },
    });
    const headers = { Cookie: ownClient.cookie, Origin: own.origin };
    const f = openFiles(own.base, { headers });
    await f.opened;

    const token = ownClient.sessionToken();
    assert.ok(token);
    const closeCode = f.closedWithCode();
    own.app.sessions.revoke(token);
    assert.equal(await closeCode, 4001, 'revoked sessions must drop their files sockets');
  } finally {
    await own.stop();
  }
});
