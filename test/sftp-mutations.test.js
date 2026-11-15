import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { fingerprintOf } from '../server/ssh-bridge.js';
import { startFakeSshServer } from './helpers/fake-ssh-server.js';
import { startTestApp, httpClient, openFiles } from './helpers/app-harness.js';

let env, client, ssh, hostId;
before(async () => {
  env = await startTestApp(); client = httpClient(env.base, env.origin);
  ssh = await startFakeSshServer();
  await client.request('/api/auth/setup', { method: 'POST', body: { setupCode: env.app.setupCode, password: 'owner-password-123' } });
  const created = await client.request('/api/hosts', { method: 'POST', body: { name: 'Mutation fixture', address: '127.0.0.1', port: ssh.port, username: 'tester' } });
  hostId = created.body.host.id;
  await env.app.store.setKnownHost('127.0.0.1', ssh.port, { keyType: 'ssh-ed25519', fingerprint: fingerprintOf(ssh.publicBlob) });
});
after(async () => { await env.stop(); await ssh.close(); });
async function connected() {
  const f = openFiles(env.base, { headers: { Cookie: client.cookie, Origin: env.origin } });
  await f.opened; f.send({ t: 'connect', hostId, password: 'correct horse' });
  await f.untilControl(m => m.t === 'status' && m.s === 'ready', 'SFTP ready');
  return f;
}
let seq = 0;
async function op(f, request, error = false) {
  const id = `mutation-${++seq}`; f.send({ ...request, id });
  await f.untilControl(m => m.id === id && m.t === (error ? 'error' : 'result'), `${request.t} response`);
  return f.control.find(m => m.id === id && m.t === (error ? 'error' : 'result'));
}
async function names(f, path) { return (await op(f, { t: 'list', path })).entries.map(e=>e.name); }

test('mkdir, file/directory rename and move, recursive delete reconcile real SFTP listings', async () => {
  const f = await connected();
  try {
    await op(f, { t: 'mkdir', path: '/home/tester/new-dir' });
    assert.ok((await names(f, '/home/tester')).includes('new-dir'));
    await op(f, { t: 'move', path: '/srv/notes.txt', destination: '/home/tester/new-dir/notes.txt' });
    await op(f, { t: 'rename', path: '/home/tester/new-dir/notes.txt', destination: '/home/tester/new-dir/renamed.txt' });
    assert.deepEqual(await names(f, '/home/tester/new-dir'), ['renamed.txt']);
    await op(f, { t: 'rename', path: '/home/tester/new-dir', destination: '/home/tester/renamed-dir' });
    await op(f, { t: 'move', path: '/home/tester/renamed-dir', destination: '/srv/renamed-dir' });
    assert.deepEqual(await names(f, '/srv/renamed-dir'), ['renamed.txt']);
    assert.equal((await op(f, { t: 'read', path: '/srv/renamed-dir/renamed.txt' })).text, 'alpha\n    beta\n');
    await op(f, { t: 'delete', path: '/srv/renamed-dir', confirm: 'renamed-dir' });
    assert.ok(!(await names(f, '/srv')).includes('renamed-dir'));
    await op(f, { t: 'delete', path: '/home/tester/.hidden', confirm: '.hidden' });
    assert.ok(!(await names(f, '/home/tester')).includes('.hidden'));
  } finally { f.ws.close(); await f.closed(); }
});

test('deleting a symlink removes only the link and keeps its destination', async () => {
  const f = await connected();
  try {
    await op(f, { t: 'delete', path: '/home/tester/link-to-documents', confirm: 'link-to-documents' });
    const listed = await names(f, '/home/tester');
    assert.ok(!listed.includes('link-to-documents')); assert.ok(listed.includes('documents'));
    assert.deepEqual(await names(f, '/home/tester/documents'), []);
  } finally { f.ws.close(); await f.closed(); }
});

test('invalid mutation paths, confirmation, and destination collisions leave originals usable', async () => {
  const f = await connected();
  try {
    for (const path of ['.', '/', '///', '/home/..', '/home/./tester', 'relative', '/bad\0name']) {
      const error = await op(f, { t: 'delete', path, confirm: 'tester' }, true);
      assert.equal(error.code, 'path', path);
    }
    assert.equal((await op(f, { t: 'delete', path: '/srv/notes.txt', confirm: 'wrong' }, true)).code, 'confirmation');
    assert.equal((await op(f, { t: 'rename', path: '/srv/notes.txt', destination: '/srv/private.key' }, true)).code, 'exists');
    assert.equal((await op(f, { t: 'move', path: '/srv/notes.txt', destination: 'relative' }, true)).code, 'path');
    assert.equal((await op(f, { t: 'rename', path: '/srv/notes.txt', destination: '/home/tester/notes.txt' }, true)).code, 'path');
    assert.equal((await op(f, { t: 'move', path: '/home/tester/documents', destination: '/home/tester/documents/nested' }, true)).code, 'path');
    assert.equal((await op(f, { t: 'read', path: '/srv/notes.txt' })).text, 'alpha\n    beta\n');
    assert.equal((await op(f, { t: 'stat', path: '/srv/private.key' })).entry.size, 8);
  } finally { f.ws.close(); await f.closed(); }
});

test('permission errors and partial delete identify the action and retain the SFTP session', async () => {
  const f = await connected();
  try {
    assert.match((await op(f, { t: 'mkdir', path: '/denied/new-dir' }, true)).message, /mkdir failed.*Permission denied/);
    assert.match((await op(f, { t: 'move', path: '/srv/notes.txt', destination: '/denied/notes.txt' }, true)).message, /move failed.*Permission denied/);
    assert.match((await op(f, { t: 'delete', path: '/srv', confirm: 'srv' }, true)).message, /delete failed.*Permission denied/);
    const listing = await names(f, '/srv');
    assert.ok(listing.includes('private.key'));
    assert.ok(!listing.includes('notes.txt'), 'listing must expose partial deletion, not a stale optimistic copy');
    await op(f, { t: 'mkdir', path: '/home/tester/recovery' });
    assert.ok((await names(f, '/home/tester')).includes('recovery'));
  } finally { f.ws.close(); await f.closed(); }
});

test('mutations cannot overlap an active transfer or one another', async () => {
  const f = await connected();
  try {
    f.send({ t: 'get', id: 'download', path: '/srv/essay.txt' });
    await f.untilControl(m => m.id === 'download' && m.phase === 'start', 'transfer start');
    assert.equal((await op(f, { t: 'mkdir', path: '/home/tester/busy' }, true)).code, 'busy');
    f.send({ t: 'cancel', id: 'download' });
    await f.untilControl(m => m.id === 'download' && m.phase === 'cancelled', 'cancel transfer');
    ssh.events.lagMs = 150;
    f.send({ t: 'mkdir', id: 'first', path: '/home/tester/first' });
    await f.until(() => ssh.events.sftp.mkdirs.includes('/home/tester/first'), 'mkdir reached SSH');
    assert.equal((await op(f, { t: 'mkdir', path: '/home/tester/second' }, true)).code, 'busy');
    f.send({ t: 'put', id: 'upload', path: '/home/tester/upload.txt', size: 0 });
    await f.untilControl(m => m.id === 'upload' && m.code === 'busy', 'upload refused during mutation');
    await f.untilControl(m => m.id === 'first' && m.t === 'result', 'first mutation');
    const listing = await names(f, '/home/tester');
    assert.ok(listing.includes('first')); assert.ok(!listing.includes('second')); assert.ok(!listing.includes('upload.txt'));
  } finally { ssh.events.lagMs = 0; f.ws.close(); await f.closed(); }
});
