import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import WebSocket from 'ws';
import { fingerprintOf } from '../server/ssh-bridge.js';
import { startFakeSshServer } from './helpers/fake-ssh-server.js';
import { httpClient, startTestApp } from './helpers/app-harness.js';

// Runs production FileSession against real HTTP/WebSocket/SSH/SFTP. Only the DOM
// and later client timers are simulated; server/network timers remain real.
function makeDocument() {
  const listeners = new Map();
  const document = { hidden: false, activeElement: null };
  class Node {
    constructor(tag, text = '') {
      this.tagName = tag;
      this.text = text;
      this.children = [];
      this.attributes = {};
      this.parentNode = null;
      this.listeners = new Map();
      this.classes = new Set();
      this.classList = {
        add: (value) => this.classes.add(value),
        remove: (value) => this.classes.delete(value),
        contains: (value) => this.classes.has(value),
        toggle: (value, force = !this.classes.has(value)) => force ? this.classes.add(value) : this.classes.delete(value),
      };
    }
    set className(value) { this.classes = new Set(value.split(/\s+/)); }
    get className() { return [...this.classes].join(' '); }
    get firstChild() { return this.children[0] || null; }
    get nextSibling() { return this.parentNode?.children[this.parentNode.children.indexOf(this) + 1] || null; }
    get textContent() { return this.text + this.children.map((child) => child.textContent).join(''); }
    set textContent(value) { this.replaceChildren(String(value)); }
    setAttribute(name, value) {
      this.attributes[name] = String(value);
      if (name === 'disabled') this.disabled = true;
      if (name === 'class') this.className = value;
    }
    getAttribute(name) { return this.attributes[name] ?? null; }
    removeAttribute(name) { delete this.attributes[name]; if (name === 'disabled') this.disabled = false; }
    append(...children) { for (const child of children.flat(Infinity)) this.insertBefore(typeof child === 'object' ? child : new Node('#text', String(child)), null); }
    insertBefore(child, reference) {
      child.parentNode?.removeChild(child);
      const index = reference ? this.children.indexOf(reference) : this.children.length;
      assert.ok(index >= 0, 'insertBefore reference belongs to the parent');
      this.children.splice(index, 0, child);
      child.parentNode = this;
      return child;
    }
    removeChild(child) { this.children.splice(this.children.indexOf(child), 1); child.parentNode = null; return child; }
    replaceChildren(...children) { for (const child of [...this.children]) this.removeChild(child); this.append(...children); }
    remove() { this.parentNode?.removeChild(this); }
    contains(node) { return node === this || this.children.some((child) => child.contains(node)); }
    focus() { document.activeElement = this; }
    querySelector() { return null; }
    addEventListener(type, listener) { (this.listeners.get(type) || this.listeners.set(type, new Set()).get(type)).add(listener); }
  }
  Object.assign(document, {
    createElement: (tag) => new Node(tag),
    addEventListener(type, listener) { (listeners.get(type) || listeners.set(type, new Set()).get(type)).add(listener); },
    removeEventListener(type, listener) { listeners.get(type)?.delete(listener); },
    dispatch(type) { for (const listener of listeners.get(type) || []) listener(); },
  });
  return document;
}

function clientClock() {
  const tasks = new Map();
  const fired = [];
  let sequence = 0;
  let controlled = false;
  let logicalNow = 0;
  const now = () => controlled ? logicalNow : performance.now();
  const fire = (id) => {
    const task = tasks.get(id);
    if (!task) return;
    tasks.delete(id);
    fired.push({ delay: task.delay, realElapsed: performance.now() - task.created, controlled });
    task.callback();
  };
  return {
    fired,
    setTimeout(callback, delay) {
      const id = ++sequence;
      const task = { callback, delay, deadline: now() + delay, created: performance.now() };
      tasks.set(id, task);
      if (!controlled) task.native = setTimeout(() => fire(id), delay);
      return id;
    },
    clearTimeout(id) { const task = tasks.get(id); if (task?.native) clearTimeout(task.native); tasks.delete(id); },
    delays: () => [...tasks.values()].map((task) => task.delay),
    control() {
      logicalNow = performance.now();
      controlled = true;
      for (const task of tasks.values()) if (task.native) clearTimeout(task.native);
    },
    advance(ms) {
      assert.ok(controlled);
      const target = logicalNow + ms;
      let due;
      while ((due = [...tasks.entries()].filter(([, task]) => task.deadline <= target).sort((a, b) => a[1].deadline - b[1].deadline)[0])) {
        logicalNow = due[1].deadline;
        fire(due[0]);
      }
      logicalNow = target;
    },
    stop() { for (const task of tasks.values()) if (task.native) clearTimeout(task.native); tasks.clear(); },
  };
}

async function waitFor(predicate, label, timeout = 8000) {
  const deadline = performance.now() + timeout;
  while (!predicate()) {
    assert.ok(performance.now() < deadline, `timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function row(session, name) { return session.listEl.children.find((node) => node.getAttribute('data-files-key') === name); }

test('automatic polling reconciles external SFTP changes across the real app and connection', { timeout: 60_000 }, async (t) => {
  const HOME = '/home/tester';
  const env = await startTestApp();
  let ssh;
  let session;
  let remoteTree;
  const clock = clientClock();
  const outbound = [];
  try {
    ssh = await startFakeSshServer({ onSftpTree(tree) { remoteTree = tree; } });
    const client = httpClient(env.base, env.origin);
    assert.equal((await client.request('/api/auth/setup', {
      method: 'POST', body: { setupCode: env.app.setupCode, password: 'polling-owner-password' },
    })).status, 200);
    const created = await client.request('/api/hosts', {
      method: 'POST', body: { name: 'Polling proof', address: '127.0.0.1', port: ssh.port, username: 'tester' },
    });
    assert.equal(created.status, 201);
    await env.app.store.setKnownHost('127.0.0.1', ssh.port, { keyType: 'ssh-ed25519', fingerprint: fingerprintOf(ssh.publicBlob) });

    const document = makeDocument();
    const context = vm.createContext({
      document, console, Date, queueMicrotask,
      location: new URL(env.base),
      setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
      WebSocket: class extends WebSocket {
        constructor(url) { super(url, { headers: { Cookie: client.cookie, Origin: env.origin } }); }
        send(data, ...args) {
          const message = JSON.parse(data);
          // Record only operation metadata, never the test login secret.
          outbound.push({ t: message.t, id: message.id, path: message.path });
          return super.send(data, ...args);
        }
      },
    });
    const domSource = await readFile(new URL('../public/js/dom.js', import.meta.url), 'utf8');
    const fileSource = await readFile(new URL('../public/js/file-session.js', import.meta.url), 'utf8');
    vm.runInContext(domSource.replace(/^export /gm, '') + '\n' + fileSource.replace("import { el } from './dom.js';", '').replace(/^export /gm, '') + '\nglobalThis.FileSession = FileSession;', context);
    session = new context.FileSession({ host: created.body.host });
    session.show();
    session.connect('correct horse');
    await waitFor(() => session.view === 'ready' && !session.pending, 'initial SFTP listing');
    assert.equal(session.path, HOME);
    assert.deepEqual(clock.delays(), [5_000]);
    const unchanged = row(session, 'documents');
    const initialLists = outbound.filter((message) => message.t === 'list').length;
    const baselineOpens = ssh.events.sftp.opendirPaths.length;

    // Change the server fixture directly: no FileSession mutation or Refresh call.
    const fixtureFile = { type: 'file', mode: 0o644, size: 4, mtime: 1700000500, content: Buffer.from('live') };
    remoteTree.set(`${HOME}/created.txt`, { ...fixtureFile });
    remoteTree.delete(`${HOME}/photo.jpg`);
    remoteTree.set(`${HOME}/renamed.txt`, remoteTree.get(`${HOME}/.hidden`));
    remoteTree.delete(`${HOME}/.hidden`);
    remoteTree.set(`${HOME}/documents/nested.txt`, { ...fixtureFile });
    remoteTree.set('/srv/unviewed.txt', { ...fixtureFile });

    // First update waits for the production 5-second timer in real wall time.
    await waitFor(() => row(session, 'created.txt') && row(session, 'renamed.txt') && !session.pending, 'automatic create/delete/rename update', 30_000);
    assert.equal(row(session, 'photo.jpg'), undefined);
    assert.equal(row(session, '.hidden'), undefined);
    assert.ok(row(session, 'documents') === unchanged, 'unchanged row retains the exact node');
    assert.equal(outbound.filter((message) => message.t === 'list').length, initialLists + 1);
    assert.deepEqual(ssh.events.sftp.opendirPaths.slice(baselineOpens), [HOME]);
    // The only open allowed is the SAA-298 attempt to read the agent's token file
    // (absent here, so the session stays on polling); polling itself reads no content.
    assert.deepEqual(ssh.events.sftp.opens.filter((path) => !path.endsWith('/.remotehub/agent-local-token')), [], 'polling never reads file content');
    const realPoll = clock.fired.find((timer) => timer.delay === 5_000 && !timer.controlled);
    assert.ok(realPoll.realElapsed >= 4_900, 'the real timer did not fire early');
    clock.control();

    const createdRow = row(session, 'created.txt');
    remoteTree.get(`${HOME}/created.txt`).mtime += 1;
    clock.advance(5_000);
    await waitFor(() => !session.pending, 'mtime-only update');
    assert.ok(row(session, 'created.txt') !== createdRow, 'mtime alone changes the row');
    assert.ok(row(session, 'documents') === unchanged);

    for (const pause of ['hidden', 'inactive']) {
      const before = outbound.filter((message) => message.t === 'list').length;
      if (pause === 'hidden') { document.hidden = true; document.dispatch('visibilitychange'); }
      else session.hide();
      assert.deepEqual(clock.delays(), []);
      clock.advance(100_000);
      assert.equal(outbound.filter((message) => message.t === 'list').length, before);
      if (pause === 'hidden') { document.hidden = false; document.dispatch('visibilitychange'); }
      else session.show();
      assert.deepEqual(clock.delays(), [5_000]);
    }

    remoteTree.get(HOME).deny = true;
    for (const delay of [5_000, 10_000, 20_000, 40_000, 80_000, 160_000, 200_000]) {
      assert.deepEqual(clock.delays(), [delay]);
      clock.advance(delay);
      await waitFor(() => !session.pending, 'permission-error backoff');
      assert.ok(row(session, 'documents') === unchanged, 'failed poll preserves prior rows');
    }
    assert.deepEqual(clock.delays(), [200_000]);
    remoteTree.get(HOME).deny = false;
    clock.advance(200_000);
    await waitFor(() => !session.pending, 'poll recovery');
    assert.deepEqual(clock.delays(), [5_000]);

    const beforeNavigation = ssh.events.sftp.opendirPaths.length;
    session.openPath(`${HOME}/documents`);
    await waitFor(() => session.view === 'ready' && !session.pending, 'directory navigation');
    remoteTree.set(`${HOME}/documents/second.txt`, { ...fixtureFile });
    clock.advance(5_000);
    await waitFor(() => row(session, 'second.txt') && !session.pending, 'poll in the newly viewed folder');
    assert.deepEqual(ssh.events.sftp.opendirPaths.slice(beforeNavigation), [`${HOME}/documents`, `${HOME}/documents`]);
    assert.ok(outbound.filter((message) => message.t === 'list').every((message) => [HOME, `${HOME}/documents`].includes(message.path)));

    ssh.closeClients();
    await waitFor(() => session.state === 'ended', 'remote disconnection');
    assert.deepEqual(clock.delays(), []);
    const beforeDisconnect = outbound.filter((message) => message.t === 'list').length;
    clock.advance(300_000);
    assert.equal(outbound.filter((message) => message.t === 'list').length, beforeDisconnect);
    t.diagnostic(JSON.stringify({ realPollElapsedMs: Math.round(realPoll.realElapsed), externalCreateDeleteRename: 'updated automatically', unchangedRowIdentity: 'preserved', mtimeOnlyChange: 'patched', hiddenInactiveDisconnected: 'no poll requests', unhealthyDelaysMs: [10_000, 20_000, 40_000, 80_000, 160_000, 200_000, 200_000], actualSftpDirectories: ssh.events.sftp.opendirPaths, fileContentReads: ssh.events.sftp.opens.length }));
  } finally {
    session?.dispose();
    clock.stop();
    await env.stop();
    await ssh?.close();
  }
});
