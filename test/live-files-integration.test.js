import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import WebSocket from 'ws';
import { fingerprintOf } from '../server/ssh-bridge.js';
import { startFakeSshServer } from './helpers/fake-ssh-server.js';
import { httpClient, startTestApp } from './helpers/app-harness.js';
import { makeDocument } from './helpers/fake-dom.js';

// SAA-298 end to end: production FileSession (in node:vm) -> real HTTP/WS server
// -> real SSH client -> fake SSH server whose direct-tcpip channel reaches a
// scripted agent on loopback. SFTP stays the source of truth; the agent only
// says "something changed".

async function waitFor(predicate, label, timeout = 8000) {
  const deadline = performance.now() + timeout;
  while (!predicate()) {
    assert.ok(performance.now() < deadline, `timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const row = (session, name) => session.listEl.children.find((node) => node.getAttribute('data-files-key') === name);
const rows = (session) => session.listEl.children.filter((node) => node.getAttribute('data-files-key'));

const AGENT_TOKEN = 'c0ffee'.repeat(10) + 'beef';

// Scripted agent: like the real one, it requires the per-start token in the
// first request (a hello) and hangs up on anything else.
function startFakeAgent({ token = AGENT_TOKEN } = {}) {
  const requests = [];
  const rejected = [];
  const sockets = new Set();
  let nextWatch = 1;
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    const write = (frame) => socket.write(`${JSON.stringify(frame)}\n`);
    write({ event: 'hello', protocol: 1, name: 'remotehub-agent', version: '0.1.0', mode: 'persistent', capabilities: { files: { watch: true } } });
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const request = JSON.parse(buffer.slice(0, index));
        buffer = buffer.slice(index + 1);
        if (!socket.authorized) {
          if (request.op !== 'hello' || request.params?.token !== token) {
            rejected.push(request);
            write({ id: request.id, ok: false, error: { code: 'unauthorized', message: 'a hello with the local access token is required' } });
            socket.end();
            return;
          }
          socket.authorized = true;
        }
        requests.push(request);
        if (request.op === 'hello') write({ id: request.id, ok: true, result: { event: 'authenticated', protocol: 1, mode: 'persistent' } });
        if (request.op === 'watchDirectory') write({ id: request.id, ok: true, result: { watchId: nextWatch++, path: request.params.path } });
        if (request.op === 'unwatchDirectory') write({ id: request.id, ok: true, result: { watchId: request.params.watchId, stopped: true } });
      }
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    port: server.address().port,
    requests,
    rejected,
    watches: () => requests.filter((r) => r.op === 'watchDirectory').map((r) => r.params.path),
    unwatches: () => requests.filter((r) => r.op === 'unwatchDirectory').map((r) => r.params.watchId),
    emit(frame) { for (const socket of sockets) socket.write(`${JSON.stringify(frame)}\n`); },
    dropAll() { for (const socket of sockets) socket.destroy(); },
    close: () => new Promise((done) => { for (const socket of sockets) socket.destroy(); server.close(() => done()); }),
  })));
}

// Real app + real ssh2 client + fake SSH server (with the agent token file in
// the home directory) + production FileSession running in node:vm.
async function startLiveFixture({ agentToken = AGENT_TOKEN, tokenFile = AGENT_TOKEN } = {}) {
  const fixture = { outbound: [], timers: new Set(), remoteTree: null };
  fixture.env = await startTestApp({ agentPort: 8377 });
  fixture.agent = await startFakeAgent({ token: agentToken });
  const sftpEntries = [[`${HOME}/.remotehub`, { type: 'dir', mode: 0o700 }]];
  if (tokenFile !== null) {
    sftpEntries.push([`${HOME}/.remotehub/agent-local-token`, { type: 'file', mode: 0o600, size: tokenFile.length + 1, mtime: 1700000600, atime: 1700000600, content: Buffer.from(`${tokenFile}\n`) }]);
  }
  fixture.ssh = await startFakeSshServer({
    sftpEntries,
    onSftpTree(tree) { fixture.remoteTree = tree; },
    onTcpip(info, accept, reject) {
      if (info.destIP !== '127.0.0.1' || info.destPort !== 8377) return reject();
      const channel = accept();
      const socket = net.connect(fixture.agent.port, '127.0.0.1');
      channel.pipe(socket).pipe(channel);
      socket.on('error', () => channel.destroy());
      socket.on('close', () => channel.destroy());
      channel.on('close', () => socket.destroy());
    },
  });
  const { env, ssh, outbound, timers } = fixture;
  const client = httpClient(env.base, env.origin);
  await client.request('/api/auth/setup', { method: 'POST', body: { setupCode: env.app.setupCode, password: 'live-owner-password' } });
  const created = await client.request('/api/hosts', {
    method: 'POST', body: { name: 'Live proof', address: '127.0.0.1', port: ssh.port, username: 'tester' },
  });
  await env.app.store.setKnownHost('127.0.0.1', ssh.port, { keyType: 'ssh-ed25519', fingerprint: fingerprintOf(ssh.publicBlob) });

  const document = makeDocument();
  const context = vm.createContext({
    document, console, Date, queueMicrotask,
    location: new URL(env.base),
    setTimeout: (fn, ms) => { const id = setTimeout(() => { timers.delete(id); fn(); }, ms); timers.add(id); return id; },
    clearTimeout: (id) => { timers.delete(id); clearTimeout(id); },
    WebSocket: class extends WebSocket {
      constructor(url) { super(url, { headers: { Cookie: client.cookie, Origin: env.origin } }); }
      send(data, ...args) {
        const message = JSON.parse(data);
        outbound.push({ t: message.t, id: message.id, path: message.path });
        return super.send(data, ...args);
      }
    },
  });
  const domSource = await readFile(new URL('../public/js/dom.js', import.meta.url), 'utf8');
  const fileSource = await readFile(new URL('../public/js/file-session.js', import.meta.url), 'utf8');
  vm.runInContext(domSource.replace(/^export /gm, '') + '\n' + fileSource.replace("import { el } from './dom.js';", '').replace(/^export /gm, '') + '\nglobalThis.FileSession = FileSession;', context);
  fixture.session = new context.FileSession({ host: created.body.host });
  fixture.session.show();
  fixture.session.connect('correct horse');
  fixture.lists = () => outbound.filter((m) => m.t === 'list').length;
  fixture.stop = async () => {
    fixture.session?.dispose();
    for (const id of timers) clearTimeout(id);
    await ssh?.close();
    await fixture.agent.close();
    await env.stop();
  };
  return fixture;
}

const HOME = '/home/tester';

test('agent events refresh the visible directory live, follow navigation, and fall back to polling', { timeout: 60_000 }, async () => {
  const fixture = await startLiveFixture();
  const { agent, ssh, session, outbound } = fixture;
  try {
    // 0. The bridge read the token over SFTP and the agent accepted it.
    await waitFor(() => session.livePath === HOME && !session.pending, 'live watch on home');
    assert.ok(ssh.events.sftp.opens.includes(`${HOME}/.remotehub/agent-local-token`));
    assert.equal(agent.requests[0].op, 'hello');
    assert.equal(agent.requests[0].params.token, AGENT_TOKEN);
    assert.deepEqual(agent.rejected, []);
    const remoteTree = fixture.remoteTree;

    // 1. The visible directory is subscribed through the SSH connection, and live mode stops polling.
    assert.deepEqual(agent.watches(), [HOME]);
    assert.deepEqual(ssh.events.tcpip, [{ destIP: '127.0.0.1', destPort: 8377 }]);
    assert.equal(session.pollTimer, null, 'no poll timer while live');
    assert.equal(session.liveBadge.hidden, false);
    assert.equal(session.liveBadge.textContent, 'Live \u00b7 agent', 'persistent agent is labelled differently from a temporary helper');
    assert.equal(session.helperChip.hidden, true);
    // Going live runs one catch-up re-list (changes between the listing and the watch).
    await sleep(300);
    await waitFor(() => !session.pending, 'catch-up re-list');

    // 2. An external create shows up from one event, without waiting for a poll.
    const lists = fixture.lists;
    const before = lists();
    remoteTree.set(`${HOME}/created.txt`, { type: 'file', mode: 0o644, size: 4, mtime: 1700000500, content: Buffer.from('live') });
    const started = performance.now();
    agent.emit({ event: 'filesystemEvent', watchId: 1, change: 'create', path: `${HOME}/created.txt` });
    await waitFor(() => row(session, 'created.txt') && !session.pending, 'live create');
    assert.ok(performance.now() - started < 2000, 'appeared well before the 5 s poll');
    assert.equal(lists(), before + 1);

    // 3. A burst of events (rename + modify noise) is coalesced into one re-list, and
    //    repeating events never duplicates rows: SFTP re-list reconciles by name.
    remoteTree.set(`${HOME}/renamed.txt`, remoteTree.get(`${HOME}/created.txt`));
    remoteTree.delete(`${HOME}/created.txt`);
    const burst = lists();
    for (const change of ['rename', 'modify', 'modify', 'create']) {
      agent.emit({ event: 'filesystemEvent', watchId: 1, change, path: `${HOME}/renamed.txt`, from: `${HOME}/created.txt` });
    }
    await waitFor(() => row(session, 'renamed.txt') && !row(session, 'created.txt') && !session.pending, 'live rename');
    await sleep(300);
    assert.equal(lists(), burst + 1, 'one re-list for the whole burst');
    const count = rows(session).length;
    agent.emit({ event: 'filesystemEvent', watchId: 1, change: 'create', path: `${HOME}/renamed.txt` });
    await sleep(300);
    await waitFor(() => !session.pending, 'idempotent refresh');
    assert.equal(rows(session).length, count, 'repeat events do not add rows');

    // 4. Navigation unwatches the old directory and watches the new one.
    session.openPath(`${HOME}/documents`);
    await waitFor(() => session.livePath === `${HOME}/documents` && !session.pending, 'live watch follows navigation');
    assert.deepEqual(agent.watches(), [HOME, `${HOME}/documents`]);
    assert.deepEqual(agent.unwatches(), [1]);
    // Let the new watch's catch-up re-list finish, then a late event for the
    // old directory must cause nothing.
    await sleep(300);
    await waitFor(() => !session.pending, 'catch-up after navigation');
    const quiet = lists();
    agent.emit({ event: 'filesystemEvent', watchId: 1, change: 'create', path: `${HOME}/late.txt` });
    await sleep(300);
    assert.equal(lists(), quiet);

    // 5. Hiding the tab unsubscribes; showing it again re-subscribes.
    session.hide();
    await waitFor(() => agent.unwatches().length === 2, 'unwatch on hide');
    assert.equal(outbound.at(-1).t, 'unwatch');
    session.show();
    await waitFor(() => session.livePath === `${HOME}/documents`, 're-subscribe on show');

    // 6. The agent going away drops live mode and resumes the 5 s poll.
    agent.dropAll();
    await waitFor(() => session.livePath === null && session.pollTimer !== null, 'polling fallback');
    assert.equal(session.liveBadge.hidden, true);
    assert.match(session.notice, /Live updates paused/);
  } finally {
    await fixture.stop();
  }
});

for (const [label, tokenFile] of [['missing', null], ['wrong', 'c0ffee'.repeat(10) + 'dead']]) {
  test(`${label} agent token: the agent refuses the session and Files keeps polling`, { timeout: 60_000 }, async () => {
    const fixture = await startLiveFixture({ tokenFile });
    const { agent, ssh, session, outbound } = fixture;
    try {
      await waitFor(() => session.state === 'ready' && !session.pending && session.pollTimer !== null, 'polling session');
      await waitFor(() => outbound.some((m) => m.t === 'watch'), 'watch requested');
      await sleep(400);
      assert.equal(session.livePath, null, 'never goes live');
      assert.equal(session.liveBadge.hidden, true);
      assert.notEqual(session.pollTimer, null, 'the 5 s poll keeps running');
      assert.deepEqual(agent.watches(), [], 'no watch reaches the agent');
      if (tokenFile === null) {
        assert.equal(ssh.events.tcpip?.length ?? 0, 0, 'no agent channel without a token');
      } else {
        assert.equal(agent.rejected.length, 1);
        assert.equal(agent.rejected[0].params.token, tokenFile);
      }
      // The listing itself still works over SFTP.
      assert.ok(row(session, 'photo.jpg'));
    } finally {
      await fixture.stop();
    }
  });
}

test('rename and delete made through RemoteHub while live keep the listing correct', { timeout: 60_000 }, async () => {
  const fixture = await startLiveFixture();
  const { agent, ssh, session } = fixture;
  try {
    await waitFor(() => session.livePath === HOME && !session.pending, 'live watch on home');
    await sleep(300);
    await waitFor(() => !session.pending, 'catch-up re-list');
    const names = () => rows(session).map((node) => node.getAttribute('data-files-key')).sort();
    const initial = names();
    assert.ok(initial.includes('photo.jpg'));

    // The agent reports what the SFTP rename does on disk, as the real watcher would.
    const echo = (changes) => {
      for (const frame of changes) agent.emit({ event: 'filesystemEvent', watchId: 1, ...frame });
    };

    // Rename photo.jpg -> holiday.jpg through the Files UI.
    session.selected = session.entries.findIndex((entry) => entry.name === 'photo.jpg');
    session.beginMutation('rename');
    session.mutationInput.value = 'holiday.jpg';
    session.submitMutation();
    await waitFor(() => ssh.events.sftp.renames.length === 1, 'SFTP rename');
    echo([
      { change: 'rename', path: `${HOME}/holiday.jpg`, from: `${HOME}/photo.jpg` },
      { change: 'modify', path: `${HOME}/holiday.jpg` },
    ]);
    await waitFor(() => row(session, 'holiday.jpg') && !row(session, 'photo.jpg') && !session.pending && !session.mutation, 'rename reflected');
    await sleep(300);
    await waitFor(() => !session.pending, 'live re-list after rename');
    assert.deepEqual(names(), initial.map((name) => (name === 'photo.jpg' ? 'holiday.jpg' : name)).sort(), 'exactly one row renamed, no duplicates');
    assert.equal(session.entries[session.selected]?.name, 'holiday.jpg', 'selection follows the renamed item');
    assert.equal(session.livePath, HOME, 'still live after the rename');

    // Delete holiday.jpg through the Files UI (typed confirmation).
    session.beginMutation('delete');
    session.mutationInput.value = 'holiday.jpg';
    session.submitMutation();
    await waitFor(() => ssh.events.sftp.removes.length === 1, 'SFTP delete');
    echo([{ change: 'delete', path: `${HOME}/holiday.jpg` }]);
    await waitFor(() => !row(session, 'holiday.jpg') && !session.pending && !session.mutation, 'delete reflected');
    await sleep(300);
    await waitFor(() => !session.pending, 'live re-list after delete');
    assert.deepEqual(names(), initial.filter((name) => name !== 'photo.jpg'), 'deleted row gone, nothing else changed');
    assert.ok(!fixture.remoteTree.has(`${HOME}/holiday.jpg`));
    assert.equal(session.livePath, HOME, 'still live after the delete');
    assert.equal(session.pollTimer, null, 'no polling while live');
  } finally {
    await fixture.stop();
  }
});
