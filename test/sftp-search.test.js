import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { fingerprintOf } from '../server/ssh-bridge.js';
import { startFakeSshServer } from './helpers/fake-ssh-server.js';
import { httpClient, openFiles, sleep, startTestApp } from './helpers/app-harness.js';

/**
 * SFTP name search (SAA-323): the bounded, cancellable `search` op on /ws/files.
 *
 * Runs against the fake SSH server's fixed SFTP tree. The known-host fingerprint for the
 * shared fake server is seeded in `before`, so these tests skip the trust prompt.
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
const isReady = (m) => m.t === 'status' && m.s === 'ready';
const resultFor = (id) => (m) => m.t === 'result' && m.id === id;
const opErrorFor = (id) => (m) => m.t === 'error' && m.id === id;

const lastResult = (f, id) => f.control.find((m) => m.t === 'result' && m.id === id);
const lastOpError = (f, id) => f.control.find((m) => m.t === 'error' && m.id === id);

async function connect(f, id = hostId) {
  await f.opened;
  f.send({ t: 'connect', hostId: id, password: SSH_PASSWORD });
  await f.untilControl(isReady, 'ready');
}

test('search finds a directory and a symlink by name with absolute paths', async () => {
  const f = files();
  await connect(f);

  f.send({ t: 'search', id: 'docs', path: HOME, query: 'DOC' });
  await f.untilControl(resultFor('docs'), 'search result');
  const result = lastResult(f, 'docs');

  assert.equal(result.op, 'search');
  assert.equal(result.path, HOME);
  assert.equal(result.query, 'DOC');
  assert.deepEqual(result.entries.map((e) => e.name), ['documents', 'link-to-documents']);
  assert.deepEqual(result.entries.map((e) => e.type), ['dir', 'symlink']);
  assert.deepEqual(result.entries.map((e) => e.path), [`${HOME}/documents`, `${HOME}/link-to-documents`]);
  assert.equal(result.truncated, false);
  assert.equal(result.skipped, 0);
  assert.ok(result.scanned >= 1);

  f.ws.close();
  await f.closed();
});

test('search walks below root, skips denied folders, and never follows symlinks', async () => {
  const f = files();
  await connect(f);
  const before = ssh.events.sftp.opendirPaths.length;

  f.send({ t: 'search', id: 'notes', path: '/', query: 'notes' });
  await f.untilControl(resultFor('notes'), 'search result');
  const result = lastResult(f, 'notes');

  assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0].path, '/srv/notes.txt');
  assert.equal(result.entries[0].name, 'notes.txt');
  assert.equal(result.entries[0].size, 15);
  assert.ok(result.skipped >= 1, 'the denied /denied folder is counted as skipped');

  const opened = ssh.events.sftp.opendirPaths.slice(before);
  assert.ok(opened.includes('/denied'), 'the walk reached the denied folder');
  assert.ok(!opened.includes(`${HOME}/link-to-documents`), 'the walk must not open the symlink');

  f.ws.close();
  await f.closed();
});

test('search reports a denied root as a denied op error', async () => {
  const f = files();
  await connect(f);

  f.send({ t: 'search', id: 'root-denied', path: '/denied', query: 'x' });
  await f.untilControl(opErrorFor('root-denied'), 'search error');
  assert.equal(lastOpError(f, 'root-denied').code, 'denied');

  f.ws.close();
  await f.closed();
});

test('search refuses empty, blank, slash-bearing queries and relative paths', async () => {
  const f = files();
  await connect(f);

  const cases = [
    ['empty', HOME, ''],
    ['blank', HOME, '   '],
    ['slash', HOME, 'a/b'],
    ['relative', 'relative', 'doc'],
  ];
  for (const [id, path, query] of cases) {
    f.send({ t: 'search', id, path, query });
    await f.untilControl(opErrorFor(id), `${id} error`);
  }

  for (const id of ['empty', 'blank', 'slash']) {
    assert.equal(lastOpError(f, id).code, 'query', id);
  }
  assert.equal(lastOpError(f, 'relative').code, 'path');
  assert.ok(!f.control.some((m) => m.t === 'result'), 'refused searches never return results');

  f.ws.close();
  await f.closed();
});

test('cancel stops a running search with a cancelled error and no result', async () => {
  // A slow fake server keeps the walk in flight long enough to cancel it.
  const slow = await startFakeSshServer({ password: SSH_PASSWORD, lagMs: 200 });
  try {
    const created = await client.request('/api/hosts', {
      method: 'POST',
      body: { name: 'Slow box', address: '127.0.0.1', port: slow.port, username: 'tester' },
    });
    assert.equal(created.status, 201);
    await env.app.store.setKnownHost('127.0.0.1', slow.port, {
      keyType: 'ssh-ed25519',
      fingerprint: fingerprintOf(slow.publicBlob),
    });

    const f = files();
    await connect(f, created.body.host.id);

    f.send({ t: 'search', id: 'slow', path: HOME, query: 'doc' });
    f.send({ t: 'cancel', id: 'slow' });
    await f.untilControl(opErrorFor('slow'), 'cancelled error');
    assert.equal(lastOpError(f, 'slow').code, 'cancelled');
    assert.equal(lastOpError(f, 'slow').message, 'Search cancelled.');

    await sleep(500);
    assert.equal(lastResult(f, 'slow'), undefined, 'a cancelled search must not return a result');

    f.ws.close();
    await f.closed();
  } finally {
    await slow.close();
  }
});

test('search returns no matches without reading file contents', async () => {
  const f = files();
  await connect(f);
  const before = ssh.events.sftp.opens.length;
  f.send({ t: 'search', id: 'none', path: HOME, query: 'name-that-does-not-exist' });
  await f.untilControl(resultFor('none'), 'empty result');
  assert.deepEqual(lastResult(f, 'none').entries, []);
  assert.equal(lastResult(f, 'none').truncated, false);
  assert.equal(ssh.events.sftp.opens.length, before);
  f.ws.close();
  await f.closed();
});

test('search bounds results and depth, and remains usable afterward', async () => {
  const entries = Array.from({ length: 205 }, (_, i) => [`${HOME}/match-${i}.txt`, { type: 'file', size: 10, mode: 0o644, mtime: 1700000400 }]);
  let deep = HOME;
  for (let i = 0; i < 34; i += 1) {
    deep += '/deep';
    entries.push([deep, { type: 'dir', mode: 0o755 }]);
  }
  const bounded = await startFakeSshServer({ sftpEntries: entries });
  const f = files();
  try {
    const created = await client.request('/api/hosts', { method: 'POST', body: { name: 'Bounded box', address: '127.0.0.1', port: bounded.port, username: 'tester' } });
    await env.app.store.setKnownHost('127.0.0.1', bounded.port, { keyType: 'ssh-ed25519', fingerprint: fingerprintOf(bounded.publicBlob) });
    await connect(f, created.body.host.id);
    f.send({ t: 'search', id: 'cap', path: HOME, query: 'match' });
    await f.untilControl(resultFor('cap'), 'bounded matches');
    assert.equal(lastResult(f, 'cap').entries.length, 200);
    assert.equal(lastResult(f, 'cap').truncated, true);
    f.send({ t: 'search', id: 'depth', path: HOME, query: 'not-present' });
    // A 32-level walk needs more than the harness's default 8 seconds over SSH.
    await f.until(() => f.control.some(resultFor('depth')), 'bounded depth', 15_000);
    assert.equal(lastResult(f, 'depth').truncated, true);
    assert.equal(lastResult(f, 'depth').scanned, 34); // root, documents, 32 levels below root
    assert.ok(!bounded.events.sftp.opendirPaths.includes(deep));
    f.send({ t: 'list', id: 'after-cap', path: HOME });
    await f.untilControl(resultFor('after-cap'), 'listing after bounded search');
    assert.ok(lastResult(f, 'after-cap').entries.some((e) => e.name === 'photo.jpg'));
  } finally {
    f.ws.close();
    await f.closed();
    await bounded.close();
  }
});

test('search publishes matches and scanned counts before the recursive walk finishes', async () => {
  const slow = await startFakeSshServer({ lagMs: 400 });
  const f = files();
  try {
    const created = await client.request('/api/hosts', { method: 'POST', body: { name: 'Progress box', address: '127.0.0.1', port: slow.port, username: 'tester' } });
    await env.app.store.setKnownHost('127.0.0.1', slow.port, { keyType: 'ssh-ed25519', fingerprint: fingerprintOf(slow.publicBlob) });
    await connect(f, created.body.host.id);
    f.send({ t: 'search', id: 'live', path: HOME, query: 'doc' });
    // Require progress-with-matches before any final result (avoids a race when the walk finishes in the same tick).
    await f.untilControl(
      (m) => m.t === 'search-progress' && m.id === 'live' && m.entries.length > 0 && lastResult(f, 'live') === undefined,
      'live matches before the walk finishes',
    );
    const progress = f.control.find((m) => m.t === 'search-progress' && m.id === 'live');
    assert.ok(progress.scanned >= 1);
    assert.ok(progress.entries.some((e) => e.name === 'documents'));
    assert.equal(lastResult(f, 'live'), undefined, 'matches arrive while child reads are still pending');
    f.send({ t: 'cancel', id: 'live' });
    await f.untilControl(opErrorFor('live'), 'cancel after progress');
    await sleep(500);
    assert.equal(lastResult(f, 'live'), undefined);
  } finally {
    f.ws.close();
    await f.closed();
    await slow.close();
  }
});

test('search reads sibling directories in bounded parallel batches', async () => {
  const siblings = Array.from({ length: 8 }, (_, i) => [`${HOME}/folder-${i}`, { type: 'dir', mode: 0o755 }]);
  const parallel = await startFakeSshServer({ lagMs: 100, sftpEntries: siblings });
  const f = files();
  try {
    const created = await client.request('/api/hosts', { method: 'POST', body: { name: 'Parallel box', address: '127.0.0.1', port: parallel.port, username: 'tester' } });
    await env.app.store.setKnownHost('127.0.0.1', parallel.port, { keyType: 'ssh-ed25519', fingerprint: fingerprintOf(parallel.publicBlob) });
    await connect(f, created.body.host.id);
    f.send({ t: 'search', id: 'parallel', path: HOME, query: 'folder' });
    await f.untilControl(resultFor('parallel'), 'parallel search');
    const counts = f.control.filter((m) => m.t === 'search-progress' && m.id === 'parallel').map((m) => m.scanned);
    assert.deepEqual(counts, [1, 5, 9, 10], 'root, two four-directory batches, final directory');
    assert.equal(lastResult(f, 'parallel').entries.length, 8);
  } finally {
    f.ws.close();
    await f.closed();
    await parallel.close();
  }
});

test('the search deadline returns collected matches instead of losing them', async () => {
  let dir = HOME;
  const entries = [];
  for (let i = 0; i < 32; i += 1) {
    dir += '/deep';
    entries.push([dir, { type: 'dir', mode: 0o755 }]);
  }
  const slow = await startFakeSshServer({ readdirDelayMs: 1000, sftpEntries: entries });
  const f = files();
  try {
    const created = await client.request('/api/hosts', { method: 'POST', body: { name: 'Deadline box', address: '127.0.0.1', port: slow.port, username: 'tester' } });
    await env.app.store.setKnownHost('127.0.0.1', slow.port, { keyType: 'ssh-ed25519', fingerprint: fingerprintOf(slow.publicBlob) });
    await connect(f, created.body.host.id);
    f.send({ t: 'search', id: 'deadline', path: HOME, query: 'doc' });
    await f.until(() => f.control.some(resultFor('deadline')), 'partial matches at the search deadline', 35_000);
    const result = lastResult(f, 'deadline');
    assert.equal(result.reason, 'timeout');
    assert.equal(result.truncated, true);
    assert.ok(result.entries.some((e) => e.name === 'documents'));
    assert.equal(lastOpError(f, 'deadline'), undefined);
    await sleep(200);
    assert.equal(f.control.filter((m) => m.t === 'result' && m.id === 'deadline').length, 1);
  } finally {
    f.ws.close();
    await f.closed();
    await slow.close();
  }
});

test('search rejects control characters and queries over 255 characters', async () => {
  const f = files();
  await connect(f);

  f.send({ t: 'search', id: 'control', path: HOME, query: 'a\u0001b' });
  await f.untilControl(opErrorFor('control'), 'control query');
  assert.equal(lastOpError(f, 'control').code, 'query');

  f.send({ t: 'search', id: 'long', path: HOME, query: 'a'.repeat(256) });
  await f.untilControl(opErrorFor('long'), 'long query');
  assert.equal(lastOpError(f, 'long').code, 'query');

  f.ws.close();
  await f.closed();
});

test('search skips directory entries with unsafe names and caps scanned directories at 1000', async () => {
  const entries = [[`${HOME}/unsafe-dir`, { type: 'dir', mode: 0o755 }], [`${HOME}/unsafe-dir/bad\u0001entry`, { type: 'file', size: 1, mode: 0o644, mtime: 1 }]];
  for (let i = 0; i < 1002; i += 1) {
    entries.push([`${HOME}/scan-${i}`, { type: 'dir', mode: 0o755 }]);
  }
  const capped = await startFakeSshServer({ sftpEntries: entries });
  const f = files();
  try {
    const created = await client.request('/api/hosts', {
      method: 'POST',
      body: { name: 'Cap box', address: '127.0.0.1', port: capped.port, username: 'tester' },
    });
    await env.app.store.setKnownHost('127.0.0.1', capped.port, {
      keyType: 'ssh-ed25519',
      fingerprint: fingerprintOf(capped.publicBlob),
    });
    await connect(f, created.body.host.id);
    f.send({ t: 'search', id: 'unsafe', path: `${HOME}/unsafe-dir`, query: 'bad' });
    await f.untilControl(resultFor('unsafe'), 'unsafe dir search');
    assert.deepEqual(lastResult(f, 'unsafe').entries, []);

    f.send({ t: 'search', id: 'cap', path: HOME, query: 'scan' });
    await f.untilControl(resultFor('cap'), 'directory cap');
    assert.equal(lastResult(f, 'cap').truncated, true);
    assert.ok(lastResult(f, 'cap').scanned <= 1000);
  } finally {
    f.ws.close();
    await f.closed();
    await capped.close();
  }
});
