import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { fingerprintOf } from '../server/ssh-bridge.js';
import { TRANSFER_CHUNK_BYTES } from '../server/sftp-bridge.js';
import { startFakeSshServer } from './helpers/fake-ssh-server.js';
import { httpClient, openFiles, startTestApp } from './helpers/app-harness.js';

/**
 * SFTP transfer regression (SAA-290): queued uploads and downloads stream one chunk
 * at a time on the existing files socket. A transfer error or cancel leaves the session
 * and the directory listing usable.
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

describe('sftp transfers', { concurrency: 1 }, () => {
const files = () => openFiles(env.base, { headers: { Cookie: client.cookie, Origin: env.origin } });
const isReady = (message) => message.t === 'status' && message.s === 'ready';
const resultFor = (id) => (message) => message.t === 'result' && message.id === id;
const opErrorFor = (id) => (message) => message.t === 'error' && message.id === id;
const phase = (id, name) => (message) => message.t === 'transfer' && message.id === id && message.phase === name;

async function connect(socket) {
  await socket.opened;
  socket.send({ t: 'connect', hostId, password: SSH_PASSWORD });
  await socket.untilControl(isReady, 'ready');
}

async function listNames(socket, id, path) {
  socket.send({ t: 'list', id, path });
  await socket.untilControl(resultFor(id), `list ${id}`);
  return socket.control.find((message) => message.t === 'result' && message.id === id).entries.map((entry) => entry.name);
}

test('a download streams in chunks, a second transfer waits, and the directory still lists', async () => {
  const socket = files();
  try {
  await connect(socket);
  const beforeReads = ssh.events.sftp.readLengths.length;

  socket.send({ t: 'get', id: 'essay', path: '/srv/essay.txt' });
  await socket.untilControl(phase('essay', 'start'), 'download start');
  const start = socket.control.find(phase('essay', 'start'));
  assert.equal(start.size, 96 * 1024);
  assert.equal(ssh.events.sftp.readLengths.length, beforeReads);

  socket.send({ t: 'list', id: 'during', path: HOME });
  await socket.untilControl(resultFor('during'), 'list during download');
  assert.ok(socket.control.find(resultFor('during')).entries.some((entry) => entry.name === 'photo.jpg'));

  socket.send({ t: 'get', id: 'busy', path: '/srv/notes.txt' });
  await socket.untilControl(opErrorFor('busy'), 'busy download');
  assert.equal(socket.control.find(opErrorFor('busy')).code, 'busy');
  assert.equal(socket.control.some(phase('essay', 'complete')), false);

  socket.send({ t: 'ack', id: 'essay' });
  await socket.untilControl(
    (message) => message.t === 'transfer' && message.id === 'essay' && message.phase === 'progress' && message.loaded === TRANSFER_CHUNK_BYTES,
    'first chunk',
  );
  const firstReads = ssh.events.sftp.readLengths.slice(beforeReads);
  assert.equal(firstReads.reduce((sum, n) => sum + n, 0), TRANSFER_CHUNK_BYTES);
  assert.ok(Math.max(...firstReads) <= TRANSFER_CHUNK_BYTES);
  assert.ok(Math.max(...firstReads) < 96 * 1024);
  assert.equal(Buffer.concat(socket.binaries).length, TRANSFER_CHUNK_BYTES);
  assert.equal(socket.control.some(phase('essay', 'complete')), false);
  assert.ok(TRANSFER_CHUNK_BYTES < 96 * 1024);

  socket.send({ t: 'ack', id: 'essay' });
  await socket.untilControl(phase('essay', 'complete'), 'download complete');
  const file = Buffer.concat(socket.binaries);
  assert.equal(file.length, 96 * 1024);
  assert.equal(file.every((byte) => byte === 0x61), true);
  const allReads = ssh.events.sftp.readLengths.slice(beforeReads);
  assert.equal(allReads.reduce((sum, n) => sum + n, 0), 96 * 1024);
  assert.ok(Math.max(...allReads) <= TRANSFER_CHUNK_BYTES);
  assert.equal(socket.ws.readyState, socket.ws.OPEN);

  const names = await listNames(socket, 'after', HOME);
  assert.ok(names.includes('photo.jpg'));
  assert.equal(names.includes('essay.txt'), false);
  } finally {
    socket.ws.close();
  }
  await socket.closed();
});

test('a download error or cancel does not close the session or replace the directory', async () => {
  const socket = files();
  try {
  await connect(socket);

  socket.send({ t: 'get', id: 'dir', path: `${HOME}/documents` });
  await socket.untilControl(opErrorFor('dir'), 'directory download');
  assert.equal(socket.control.find(opErrorFor('dir')).code, 'not-file');

  socket.send({ t: 'get', id: 'denied', path: '/srv/private.key' });
  await socket.untilControl(opErrorFor('denied'), 'denied download');
  assert.equal(socket.control.find(opErrorFor('denied')).code, 'denied');
  assert.equal(JSON.stringify(socket.control.find(opErrorFor('denied'))).includes('not-sent'), false);

  const beforeReads = ssh.events.sftp.readLengths.length;
  socket.send({ t: 'get', id: 'cut', path: '/srv/essay.txt' });
  await socket.untilControl(phase('cut', 'start'), 'cancel start');
  socket.send({ t: 'ack', id: 'cut' });
  await socket.untilControl((message) => message.t === 'transfer' && message.id === 'cut' && message.phase === 'progress', 'cancel chunk');
  socket.send({ t: 'cancel', id: 'cut' });
  await socket.untilControl(phase('cut', 'cancelled'), 'cancelled');
  const cutReads = ssh.events.sftp.readLengths.slice(beforeReads);
  assert.equal(cutReads.reduce((sum, n) => sum + n, 0), TRANSFER_CHUNK_BYTES);
  assert.ok(Math.max(...cutReads) < 96 * 1024);

  socket.send({ t: 'get', id: 'short', path: '/srv/big.log' });
  await socket.untilControl(phase('short', 'start'), 'short start');
  socket.send({ t: 'ack', id: 'short' });
  await socket.untilControl(opErrorFor('short'), 'short read');
  assert.match(socket.control.find(opErrorFor('short')).message, /ended before/);

  const names = await listNames(socket, 'still', HOME);
  assert.deepEqual(names, ['.hidden', 'documents', 'link-to-documents', 'photo.jpg']);
  assert.equal(socket.ws.readyState, socket.ws.OPEN);
  } finally {
    socket.ws.close();
  }
  await socket.closed();
});

test('an upload streams each chunk, a cancel removes the partial, and a denial leaves the listing', async () => {
  const socket = files();
  try {
  await connect(socket);
  const beforeWrites = ssh.events.sftp.writeLengths.length;
  const payload = Buffer.concat([Buffer.from('0123456789'), Buffer.from('abcdefghij')]);

  socket.send({ t: 'put', id: 'up', path: `${HOME}/fresh.txt`, size: payload.length });
  await socket.untilControl(phase('up', 'start'), 'upload start');
  socket.sendRaw(payload.subarray(0, 10));
  await socket.untilControl((message) => message.t === 'transfer' && message.id === 'up' && message.phase === 'ack' && message.loaded === 10, 'first write');
  assert.deepEqual(ssh.events.sftp.writeLengths.slice(beforeWrites), [10]);
  socket.sendRaw(payload.subarray(10));
  await socket.untilControl((message) => message.t === 'transfer' && message.id === 'up' && message.phase === 'ack' && message.loaded === 20, 'second write');
  assert.deepEqual(ssh.events.sftp.writeLengths.slice(beforeWrites), [10, 10]);
  socket.send({ t: 'put-end', id: 'up' });
  await socket.untilControl(phase('up', 'complete'), 'upload complete');

  socket.send({ t: 'get', id: 'back', path: `${HOME}/fresh.txt` });
  await socket.untilControl(phase('back', 'start'), 'read back start');
  const readFrom = socket.binaries.length;
  let loaded = 0;
  const size = socket.control.find(phase('back', 'start')).size;
  assert.equal(size, payload.length);
  while (loaded < size) {
    socket.send({ t: 'ack', id: 'back' });
    await socket.untilControl(
      (message) => message.t === 'transfer' && message.id === 'back' && (message.phase === 'progress' || message.phase === 'complete') && message.loaded > loaded,
      'read back chunk',
    );
    const latest = [...socket.control].reverse().find((message) => message.t === 'transfer' && message.id === 'back' && message.loaded > loaded);
    loaded = latest.loaded;
  }
  await socket.untilControl(phase('back', 'complete'), 'read back complete');
  assert.equal(Buffer.concat(socket.binaries.slice(readFrom)).equals(payload), true);

  const listed = await listNames(socket, 'with-fresh', HOME);
  assert.ok(listed.includes('fresh.txt'));
  assert.ok(listed.includes('photo.jpg'));

  socket.send({ t: 'put', id: 'partial', path: `${HOME}/partial.txt`, size: 40 });
  await socket.untilControl(phase('partial', 'start'), 'partial start');
  socket.sendRaw(Buffer.from('only-some'));
  await socket.untilControl((message) => message.t === 'transfer' && message.id === 'partial' && message.phase === 'ack', 'partial ack');
  socket.send({ t: 'cancel', id: 'partial' });
  await socket.untilControl(phase('partial', 'cancelled'), 'partial cancelled');
  assert.ok(ssh.events.sftp.removes.includes(`${HOME}/partial.txt`));

  socket.send({ t: 'put', id: 'scratch', path: `${HOME}/scratch.bin`, size: 4 });
  await socket.untilControl(opErrorFor('scratch'), 'denied upload');
  assert.equal(socket.control.find(opErrorFor('scratch')).code, 'denied');

  const after = await listNames(socket, 'after-upload', HOME);
  assert.ok(after.includes('fresh.txt'));
  assert.ok(after.includes('photo.jpg'));
  assert.equal(after.includes('partial.txt'), false);
  assert.equal(after.includes('scratch.bin'), false);
  assert.equal(socket.ws.readyState, socket.ws.OPEN);
  } finally {
    socket.ws.close();
  }
  await socket.closed();
});
});
