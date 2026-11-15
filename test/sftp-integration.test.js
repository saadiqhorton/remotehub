import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { fingerprintOf } from '../server/ssh-bridge.js';
import { TRANSFER_CHUNK_BYTES } from '../server/sftp-bridge.js';
import { startFakeSshServer } from './helpers/fake-ssh-server.js';
import { httpClient, openFiles, openTerminal, sleep, startTestApp } from './helpers/app-harness.js';

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
  ssh = await startFakeSshServer({ password: SSH_PASSWORD, persistTree: true });

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

const files = (headers = { Cookie: client.cookie, Origin: env.origin }) => openFiles(env.base, { headers });
const isReady = (m) => m.t === 'status' && m.s === 'ready';
const resultFor = (id) => (m) => m.t === 'result' && m.id === id;
const opErrorFor = (id) => (m) => m.t === 'error' && m.id === id;
const connError = (m) => m.t === 'error' && m.id === undefined;
const phase = (id, name) => (m) => m.t === 'transfer' && m.id === id && m.phase === name;
const lastResult = (f, id) => f.control.find((m) => m.t === 'result' && m.id === id);
const lastOpError = (f, id) => f.control.find((m) => m.t === 'error' && m.id === id);

async function connect(f, id = hostId, password = SSH_PASSWORD) {
  await f.opened;
  f.send({ t: 'connect', hostId: id, password });
  await f.untilControl(isReady, 'ready');
}

// The bridge ends its SSH connection when the browser socket closes, but the fake
// server only sees the TCP close a moment later, so give it a bounded window.
async function assertNoSshClients(server = ssh) {
  for (let i = 0; i < 40; i += 1) {
    if (server.clientCount() === 0) return;
    await sleep(50);
  }
  assert.equal(server.clientCount(), 0);
}

async function closeSocket(f, server = ssh) {
  f.ws.close();
  await f.closed();
  await assertNoSshClients(server);
}

async function closeOnly(f) {
  f.ws.close();
  await f.closed();
}

async function completeDownload(f, id) {
  await f.untilControl(phase(id, 'start'), `download ${id} start`);
  for (let i = 0; i < 50; i += 1) {
    if (f.control.some(phase(id, 'complete'))) return;
    if (f.control.some(opErrorFor(id))) return;
    f.send({ t: 'ack', id });
    await sleep(20);
  }
  throw new Error(`download ${id} did not finish`);
}

test('files websocket rejects missing auth and foreign origins', async () => {
  const noCookie = openFiles(env.base, { headers: { Origin: env.origin } });
  await assert.rejects(noCookie.opened, (err) => err.status === 401);

  const foreign = openFiles(env.base, { headers: { Cookie: client.cookie, Origin: 'http://evil.test' } });
  await assert.rejects(foreign.opened, (err) => err.status === 403);
});

test('an expired session cannot open files and a files upgrade touches the session', async () => {
  const tiny = await startTestApp({ sessionTtlMs: 250 });
  const tinyClient = httpClient(tiny.base, tiny.origin);
  const tinySsh = await startFakeSshServer({ password: SSH_PASSWORD });
  try {
    await tinyClient.request('/api/auth/setup', {
      method: 'POST',
      body: { setupCode: tiny.app.setupCode, password: OWNER_PASSWORD },
    });
    const created = await tinyClient.request('/api/hosts', {
      method: 'POST',
      body: { name: 'Tiny', address: '127.0.0.1', port: tinySsh.port, username: 'tester' },
    });
    await tiny.app.store.setKnownHost('127.0.0.1', tinySsh.port, {
      keyType: 'ssh-ed25519',
      fingerprint: fingerprintOf(tinySsh.publicBlob),
    });
    await sleep(600);
    const expired = openFiles(tiny.base, { headers: { Cookie: tinyClient.cookie, Origin: tiny.origin } });
    await assert.rejects(expired.opened, (err) => err.status === 401);

    await tinyClient.request('/api/auth/login', { method: 'POST', body: { password: OWNER_PASSWORD } });
    const f = openFiles(tiny.base, { headers: { Cookie: tinyClient.cookie, Origin: tiny.origin } });
    await f.opened;
    assert.equal((await tinyClient.request('/api/auth/state')).body.authenticated, true);
    f.ws.close();
    await f.closed();
    assert.equal(tinySsh.clientCount(), 0);
  } finally {
    await tinySsh.close();
    await tiny.stop();
  }
});

test('logout with a download in progress closes the files socket with 4001', async () => {
  const f = files();
  try {
    await connect(f);
    f.send({ t: 'get', id: 'dl', path: '/srv/essay.txt' });
    await f.untilControl(phase('dl', 'start'), 'download start');
    const closeCode = f.closedWithCode();
    await client.request('/api/auth/logout', { method: 'POST' });
    assert.equal(await closeCode, 4001);
  } finally {
    await f.closed().catch(() => {});
    const login = await client.request('/api/auth/login', { method: 'POST', body: { password: OWNER_PASSWORD } });
    assert.equal(login.status, 200);
    assert.equal(ssh.clientCount(), 0);
  }
});

test('closeFiles shuts open files sockets with 1001', async () => {
  const f = files();
  try {
    await connect(f);
    const closeCode = f.closedWithCode();
    env.app.closeFiles();
    assert.equal(await closeCode, 1001);
  } finally {
    await f.closed().catch(() => {});
    await assertNoSshClients();
  }
});

test('revoking one session closes terminal and files sockets together', async () => {
  const t = openTerminal(env.base, { headers: { Cookie: client.cookie, Origin: env.origin } });
  const f = files();
  try {
    await t.opened;
    await connect(f);
    const termCode = t.closedWithCode();
    const filesCode = f.closedWithCode();
    env.app.sessions.revoke(client.sessionToken());
    assert.equal(await termCode, 4001);
    assert.equal(await filesCode, 4001);
  } finally {
    await t.closed().catch(() => {});
    await f.closed().catch(() => {});
    await client.request('/api/auth/login', { method: 'POST', body: { password: OWNER_PASSWORD } });
    assert.equal(ssh.clientCount(), 0);
  }
});

test('keyboard-interactive login opens SFTP and a refused subsystem reports sftp error', async () => {
  const ki = await startFakeSshServer({ password: SSH_PASSWORD, keyboardInteractive: true });
  const reject = await startFakeSshServer({ password: SSH_PASSWORD, rejectSftp: true });
  try {
    for (const [server, label] of [[ki, 'keyboard'], [reject, 'reject']]) {
      const created = await client.request('/api/hosts', {
        method: 'POST',
        body: { name: label, address: '127.0.0.1', port: server.port, username: 'tester' },
      });
      await env.app.store.setKnownHost('127.0.0.1', server.port, {
        keyType: 'ssh-ed25519',
        fingerprint: fingerprintOf(server.publicBlob),
      });
      const f = files();
      await f.opened;
      f.send({ t: 'connect', hostId: created.body.host.id, password: SSH_PASSWORD });
      if (label === 'keyboard') {
        await f.untilControl(isReady, 'ready');
        assert.ok(server.events.keyboardTried >= 1);
      } else {
        await f.untilControl(connError, 'sftp refused');
        assert.equal(f.control.find(connError).code, 'sftp');
      }
      await closeSocket(f, server);
    }
  } finally {
    await ki.close();
    await reject.close();
  }
});

test('password longer than 1024 fails as auth before SSH', async () => {
  const f = files();
  try {
    await f.opened;
    f.send({ t: 'connect', hostId, password: 'x'.repeat(1025) });
    await f.untilControl(connError, 'auth error');
    assert.equal(f.control.find(connError).code, 'auth');
  } finally {
    await closeOnly(f);
  }
});

test('acceptance walk covers listings, errors, mutations, and transfers on one socket', async () => {
  const f = files();
  try {
    await connect(f);

    f.send({ t: 'list', id: 'home', path: HOME });
    await f.untilControl(resultFor('home'), 'home list');
    const homeNames = lastResult(f, 'home').entries.map((e) => e.name);
    assert.ok(homeNames.includes('documents'));
    assert.ok(homeNames.includes('link-to-documents'));

    f.send({ t: 'list', id: 'empty', path: `${HOME}/documents` });
    await f.untilControl(resultFor('empty'), 'empty dir');
    assert.deepEqual(lastResult(f, 'empty').entries.map((e) => e.name), []);

    f.send({ t: 'list', id: 'root', path: '/' });
    await f.untilControl(resultFor('root'), 'root list');

    f.send({ t: 'realpath', id: 'link', path: `${HOME}/link-to-documents` });
    await f.untilControl(resultFor('link'), 'symlink realpath');
    assert.equal(lastResult(f, 'link').path, `${HOME}/link-to-documents`);

    for (const [id, op, payload] of [
      ['bad-list', 'list', { path: 'relative' }],
      ['bad-stat', 'stat', { path: '/a\0b' }],
      ['bad-rp', 'realpath', { path: '' }],
      ['bad-read', 'read', { path: './x' }],
      ['bad-get', 'get', { path: 'nope' }],
      ['bad-put', 'put', { path: 'relative.txt', size: 1 }],
      ['bad-mkdir', 'mkdir', { path: '.' }],
      ['bad-rename', 'rename', { path: `${HOME}/photo.jpg`, destination: '/../x' }],
      ['bad-move', 'move', { path: `${HOME}/photo.jpg`, destination: `${HOME}/photo.jpg` }],
      ['bad-delete', 'delete', { path: `${HOME}/photo.jpg`, confirm: 'wrong' }],
    ]) {
      f.send({ t: op, id, ...payload });
      await f.untilControl(opErrorFor(id), `${op} invalid`);
      const code = id === 'bad-delete' ? 'confirmation' : 'path';
      assert.equal(lastOpError(f, id).code, code, id);
    }

    f.send({ t: 'list', id: 'denied', path: '/denied' });
    await f.untilControl(opErrorFor('denied'), 'denied list');
    assert.equal(lastOpError(f, 'denied').code, 'denied');

    f.send({ t: 'read', id: 'deny-read', path: '/srv/private.key' });
    await f.untilControl(opErrorFor('deny-read'), 'denied read');
    assert.equal(lastOpError(f, 'deny-read').code, 'denied');

    f.send({ t: 'get', id: 'deny-get', path: `${HOME}/scratch.bin` });
    await f.untilControl(opErrorFor('deny-get'), 'denied get');

    f.send({ t: 'put', id: 'deny-put', path: `${HOME}/scratch.bin`, size: 1 });
    await f.untilControl(opErrorFor('deny-put'), 'denied put');

    f.send({ t: 'mkdir', id: 'deny-mkdir', path: '/denied/new' });
    await f.untilControl(opErrorFor('deny-mkdir'), 'denied mkdir');

    f.send({ t: 'move', id: 'deny-move', path: `${HOME}/photo.jpg`, destination: '/denied/here.jpg' });
    await f.untilControl(opErrorFor('deny-move'), 'denied move');

    f.send({ t: 'delete', id: 'deny-del', path: '/srv/private.key', confirm: 'private.key' });
    await f.untilControl(opErrorFor('deny-del'), 'denied delete');

    f.send({ t: 'list', id: 'home-again', path: HOME });
    await f.untilControl(resultFor('home-again'), 'home after denials');

    const uploadPath = `${HOME}/roundtrip.bin`;
    const payload = Buffer.from('hello-roundtrip');
    f.send({ t: 'put', id: 'up', path: uploadPath, size: payload.length });
    await f.untilControl(phase('up', 'start'), 'upload start');
    f.sendRaw(payload);
    f.send({ t: 'put-end', id: 'up' });
    await f.untilControl(phase('up', 'complete'), 'upload complete');

    f.send({ t: 'get', id: 'down', path: uploadPath });
    await completeDownload(f, 'down');
    assert.equal(Buffer.concat(f.binaries).toString('utf8'), payload.toString('utf8'));

    f.send({ t: 'put', id: 'overwrite', path: uploadPath, size: 3 });
    await f.untilControl(phase('overwrite', 'start'), 'overwrite start');
    f.sendRaw(Buffer.from('new'));
    f.send({ t: 'put-end', id: 'overwrite' });
    await f.untilControl(phase('overwrite', 'complete'), 'overwrite complete');

    f.send({ t: 'put', id: 'missing-parent', path: `${HOME}/missing-parent/x.bin`, size: 2 });
    await f.untilControl(opErrorFor('missing-parent'), 'missing parent');

    f.send({ t: 'mkdir', id: 'mk', path: `${HOME}/fresh-dir` });
    await f.untilControl(resultFor('mk'), 'mkdir');
    f.send({ t: 'rename', id: 'ren', path: `${HOME}/fresh-dir`, destination: `${HOME}/renamed-dir` });
    await f.untilControl(resultFor('ren'), 'rename dir');
    f.send({ t: 'move', id: 'mv', path: `${HOME}/renamed-dir`, destination: `${HOME}/documents/moved-dir` });
    await f.untilControl(resultFor('mv'), 'move dir');
    f.send({ t: 'delete', id: 'del', path: `${HOME}/documents/moved-dir`, confirm: 'moved-dir' });
    await f.untilControl(resultFor('del'), 'delete dir');

    f.send({ t: 'list', id: 'final', path: `${HOME}/documents` });
    await f.untilControl(resultFor('final'), 'final list');
    assert.ok(!lastResult(f, 'final').entries.some((e) => e.name === 'moved-dir'));
  } finally {
    await closeSocket(f);
  }
});

test('transfer edges cover empty files, ordering, ignored control, and read failures', async () => {
  const f = files();
  try {
    await connect(f);

    f.send({ t: 'put', id: 'empty-up', path: `${HOME}/empty-up.bin`, size: 0 });
    await f.untilControl(phase('empty-up', 'start'), 'empty upload start');
    f.send({ t: 'put-end', id: 'empty-up' });
    await f.untilControl(phase('empty-up', 'complete'), 'empty upload complete');

    f.send({ t: 'get', id: 'empty-dl', path: `${HOME}/empty-up.bin` });
    await f.untilControl(phase('empty-dl', 'complete'), 'empty download');

    f.send({ t: 'put', id: 'bad-size', path: `${HOME}/bad-size.bin`, size: -1 });
    await f.untilControl(opErrorFor('bad-size'), 'bad size');

    f.send({ t: 'put', id: 'extra', path: `${HOME}/extra.bin`, size: 2 });
    await f.untilControl(phase('extra', 'start'), 'extra upload start');
    f.sendRaw(Buffer.from([1, 2, 3]));
    await f.untilControl(opErrorFor('extra'), 'extra bytes');

    f.send({ t: 'put', id: 'early-chunk', path: `${HOME}/early.bin`, size: 4 });
    f.sendRaw(Buffer.from([1]));
    await f.untilControl(opErrorFor('early-chunk'), 'chunk before open');

    const laggyWrite = await startFakeSshServer({ password: SSH_PASSWORD, lagMs: 200 });
    try {
      const created = await client.request('/api/hosts', {
        method: 'POST',
        body: { name: 'Lag write', address: '127.0.0.1', port: laggyWrite.port, username: 'tester' },
      });
      await env.app.store.setKnownHost('127.0.0.1', laggyWrite.port, {
        keyType: 'ssh-ed25519',
        fingerprint: fingerprintOf(laggyWrite.publicBlob),
      });
      const w = files();
      await connect(w, created.body.host.id);
      w.send({ t: 'put', id: 'order', path: `${HOME}/order.bin`, size: 4 });
      await w.untilControl(phase('order', 'start'), 'ordered upload');
      w.sendRaw(Buffer.from([1, 2]));
      w.sendRaw(Buffer.from([3, 4]));
      await w.untilControl(opErrorFor('order'), 'second chunk while writing');
      w.ws.close();
      await w.closed();
    } finally {
      await laggyWrite.close();
    }

    f.send({ t: 'put', id: 'ignore-empty', path: `${HOME}/ignore.bin`, size: 2 });
    await f.untilControl(phase('ignore-empty', 'start'), 'ignore upload');
    f.sendRaw(Buffer.alloc(0));
    f.sendRaw(Buffer.from([9, 9]));
    f.send({ t: 'put-end', id: 'ignore-empty' });
    await f.untilControl(phase('ignore-empty', 'complete'), 'ignore empty binary');

    f.send({ t: 'put', id: 'short-end', path: `${HOME}/short.bin`, size: 4 });
    await f.untilControl(phase('short-end', 'start'), 'short upload');
    f.sendRaw(Buffer.from([1]));
    f.send({ t: 'put-end', id: 'short-end' });
    await f.untilControl(opErrorFor('short-end'), 'short put-end');

    f.send({ t: 'put-end', id: 'wrong-end' });
    f.send({ t: 'ack', id: 'wrong-ack' });
    f.send({ t: 'cancel', id: 'wrong-cancel' });
    assert.ok(!f.control.some((m) => m.t === 'error' && m.id === 'wrong-end'));

    const shrink = await startFakeSshServer({
      password: SSH_PASSWORD,
      sftpEntries: [[`${HOME}/shrink.txt`, { type: 'file', size: 20, mode: 0o644, mtime: 1, content: Buffer.from('1234567890') }]],
    });
    try {
      const created = await client.request('/api/hosts', {
        method: 'POST',
        body: { name: 'Shrink', address: '127.0.0.1', port: shrink.port, username: 'tester' },
      });
      await env.app.store.setKnownHost('127.0.0.1', shrink.port, {
        keyType: 'ssh-ed25519',
        fingerprint: fingerprintOf(shrink.publicBlob),
      });
      const g = files();
      await connect(g, created.body.host.id);
      g.send({ t: 'get', id: 'shrink', path: `${HOME}/shrink.txt` });
      await g.untilControl(phase('shrink', 'start'), 'shrink start');
      g.send({ t: 'ack', id: 'shrink' });
      await g.until(() => g.binaries.length > 0, 'shrink bytes');
      g.send({ t: 'ack', id: 'shrink' });
      await g.untilControl(opErrorFor('shrink'), 'shrink download eof');
      assert.equal(Buffer.concat(g.binaries).length, 10);
      g.ws.close();
      await g.closed();
    } finally {
      await shrink.close();
    }

    f.send({ t: 'read', id: 'dir-read', path: HOME });
    await f.untilControl(opErrorFor('dir-read'), 'read directory');
    assert.equal(lastOpError(f, 'dir-read').code, 'not-file');

    f.send({ t: 'get', id: 'busy-dl', path: '/srv/essay.txt' });
    await f.untilControl(phase('busy-dl', 'start'), 'busy download');
    f.send({ t: 'list', id: 'during-dl', path: HOME });
    f.send({ t: 'get', id: 'parallel-dl', path: '/srv/notes.txt' });
    await f.untilControl(resultFor('during-dl'), 'list during download');
    await f.untilControl(opErrorFor('parallel-dl'), 'second download');
    assert.equal(lastOpError(f, 'parallel-dl').code, 'busy');
    f.send({ t: 'cancel', id: 'busy-dl' });
    await f.untilControl(phase('busy-dl', 'cancelled'), 'cancel busy download');
  } finally {
    await closeSocket(f);
  }
});

test('upload cancel before open still unlinks and socket dispose keeps partial uploads', async () => {
  const f = files();
  try {
    await connect(f);
    const path = `${HOME}/cancel-before-open.bin`;
    f.send({ t: 'put', id: 'pre', path, size: 8 });
    f.send({ t: 'cancel', id: 'pre' });
    await f.untilControl(phase('pre', 'cancelled'), 'cancel before open');
    await sleep(100);
    f.send({ t: 'stat', id: 'gone', path });
    await f.untilControl(opErrorFor('gone'), 'partial removed');
    assert.equal(lastOpError(f, 'gone').code, 'not-found');

    f.send({ t: 'put', id: 'mid', path: `${HOME}/mid.bin`, size: 4 });
    await f.untilControl(phase('mid', 'start'), 'mid upload');
    f.sendRaw(Buffer.from([1, 2]));
    f.ws.close();
    await f.closed();

    const f2 = files();
    await connect(f2);
    f2.send({ t: 'stat', id: 'still', path: `${HOME}/mid.bin` });
    await f2.untilControl(resultFor('still'), 'partial kept after socket drop');
    await closeSocket(f2);
  } finally {
    for (let i = 0; i < 40; i += 1) {
      if (ssh.clientCount() === 0) break;
      await sleep(50);
    }
    assert.equal(ssh.clientCount(), 0);
  }
});

test('delete guards reject deep, wide, unsafe names, filesystem root, and lstat failures', async () => {
  const wide = Array.from({ length: 1001 }, (_, i) => [`${HOME}/wide/item-${i}`, { type: 'file', size: 1, mode: 0o644, mtime: 1, content: Buffer.from('x') }]);
  wide.push([`${HOME}/wide`, { type: 'dir', mode: 0o755 }]);
  const deepRoot = `${HOME}/deep-tree`;
  const deepEntries = [[deepRoot, { type: 'dir', mode: 0o755 }]];
  let deep = deepRoot;
  for (let i = 0; i < 65; i += 1) {
    deep += '/d';
    deepEntries.push([deep, { type: 'dir', mode: 0o755 }]);
  }
  const trap = await startFakeSshServer({
    password: SSH_PASSWORD,
    sftpEntries: [
      ...wide,
      ...deepEntries,
      [`${HOME}/unsafe`, { type: 'dir', mode: 0o755 }],
      [`${HOME}/unsafe/bad\u0001name`, { type: 'file', size: 1, mode: 0o644, content: Buffer.from('x') }],
      [`${HOME}/root-trap`, { type: 'dir', mode: 0o755, realpathRoot: true }],
    ],
  });
  try {
    const created = await client.request('/api/hosts', {
      method: 'POST',
      body: { name: 'Trap', address: '127.0.0.1', port: trap.port, username: 'tester' },
    });
    await env.app.store.setKnownHost('127.0.0.1', trap.port, {
      keyType: 'ssh-ed25519',
      fingerprint: fingerprintOf(trap.publicBlob),
    });
    const f = files();
    await connect(f, created.body.host.id);

    for (const [id, path, confirm] of [
      ['wide', `${HOME}/wide`, 'wide'],
      ['deep', deepRoot, 'deep-tree'],
      ['unsafe', `${HOME}/unsafe`, 'unsafe'],
      ['root', `${HOME}/root-trap`, 'root-trap'],
    ]) {
      f.send({ t: 'delete', id, path, confirm });
      await f.until(() => f.control.some(opErrorFor(id)), `delete ${id}`, 30_000);
      assert.equal(lastOpError(f, id).code, 'sftp');
    }

    trap.failNextLstat = true;
    f.send({ t: 'move', id: 'lstat-fail', path: `${HOME}/photo.jpg`, destination: `${HOME}/photo-moved.jpg` });
    await f.untilControl(opErrorFor('lstat-fail'), 'lstat failure');
    assert.equal(lastOpError(f, 'lstat-fail').code, 'sftp');

    await closeSocket(f, trap);
  } finally {
    await trap.close();
  }
});

test('persisted tree survives interrupted list, transfer, and lagged mkdir', async () => {
  const laggy = await startFakeSshServer({ password: SSH_PASSWORD, persistTree: true, readdirDelayMs: 300, lagMs: 300 });
  try {
    const created = await client.request('/api/hosts', {
      method: 'POST',
      body: { name: 'Laggy', address: '127.0.0.1', port: laggy.port, username: 'tester' },
    });
    await env.app.store.setKnownHost('127.0.0.1', laggy.port, {
      keyType: 'ssh-ed25519',
      fingerprint: fingerprintOf(laggy.publicBlob),
    });
    const host = created.body.host.id;

    const listCut = files();
    await connect(listCut, host);
    listCut.send({ t: 'list', id: 'slow-list', path: HOME });
    laggy.closeClients();
    await listCut.untilControl((m) => m.t === 'closed', 'list interrupted');
    await listCut.closed();

    const partialPath = `${HOME}/partial-up.bin`;
    const upCut = files();
    await connect(upCut, host);
    upCut.send({ t: 'put', id: 'partial', path: partialPath, size: 8 });
    await upCut.untilControl(phase('partial', 'start'), 'partial upload');
    upCut.sendRaw(Buffer.from([1, 2, 3]));
    laggy.closeClients();
    await upCut.untilControl((m) => m.t === 'closed', 'upload interrupted');
    await upCut.closed();

    const mkCut = files();
    await connect(mkCut, host);
    mkCut.send({ t: 'mkdir', id: 'lag-mk', path: `${HOME}/lag-dir` });
    laggy.closeClients();
    await mkCut.untilControl((m) => m.t === 'closed', 'mkdir interrupted');
    await mkCut.closed();

    const verify = files();
    await connect(verify, host);
    verify.send({ t: 'list', id: 'verify', path: HOME });
    await verify.untilControl(resultFor('verify'), 'verify list');
    const names = lastResult(verify, 'verify').entries.map((e) => e.name);
    assert.ok(names.includes('partial-up.bin'));
    await closeSocket(verify, laggy);
  } finally {
    await laggy.close();
  }
});

test('endSftp reports the SFTP session ended without tearing down SSH first', async () => {
  const f = files();
  try {
    await connect(f);
    ssh.endSftp();
    await f.untilControl((m) => m.t === 'closed' && m.reason === 'The Files connection ended.', 'sftp ended');
    await f.closed();
  } finally {
    assert.equal(ssh.clientCount(), 0);
  }
});
