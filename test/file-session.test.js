import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FileSession,
  crumbList,
  formatModified,
  formatSize,
  joinPath,
  parentPath,
  sortEntries,
  textLines,
  transferPercent,
  transferStateLabel,
} from '../public/js/file-session.js';
import { hostActions } from '../public/js/host-actions.js';

const host = { id: 'nas', name: 'lab-nas', username: 'alex', address: '192.168.1.20', port: 22 };

test('files action follows the sftp capability', () => {
  const enabled = hostActions({ capabilities: { terminal: { ssh: true }, files: { sftp: true }, desktop: { vnc: true } } });
  assert.equal(enabled[1].enabled, true);
  assert.equal(enabled[1].reason, '');
  assert.equal(enabled[2].enabled, false);
  const unavailable = hostActions({ capabilities: { files: { sftp: false } } });
  assert.equal(unavailable[1].enabled, false);
  assert.match(unavailable[1].reason, /^Files aren’t available on this computer\.$/);
});

test('path crumbs, parents, joins, sizes, times, and sort order', () => {
  assert.deepEqual(crumbList('/home/alex').map((crumb) => crumb.path), ['/', '/home', '/home/alex']);
  assert.deepEqual(crumbList('/').map((crumb) => crumb.label), ['/']);
  assert.equal(crumbList('.' )[0].label, '…');
  assert.equal(parentPath('/'), null);
  assert.equal(parentPath('/home'), '/');
  assert.equal(parentPath('/home/alex/'), '/home');
  assert.equal(joinPath('/home/alex', 'Documents'), '/home/alex/Documents');
  assert.equal(joinPath('/', 'etc'), '/etc');
  assert.equal(joinPath('/home', '..'), null);
  assert.equal(joinPath('/home', 'a/b'), null);
  assert.equal(formatSize({ type: 'dir', size: 4096 }), '—');
  assert.equal(formatSize({ type: 'file', size: 860 }), '860 B');
  assert.equal(formatSize({ type: 'file', size: 1536 }), '1.5 KB');
  assert.equal(formatSize({ type: 'file', size: 18432 }), '18 KB');
  assert.equal(formatSize({ type: 'file', size: 46 * 1024 * 1024 }), '46.0 MB');
  assert.equal(formatSize({ type: 'file', size: 5 * 1024 * 1024 * 1024 }), '5.0 GB');
  assert.equal(formatModified(0), '—');
  assert.match(formatModified(Date.UTC(2026, 2, 12, 18, 4)), /^\d{2} \w{3} \d{4} {2}\d{2}:\d{2}$/);
  assert.deepEqual(
    sortEntries([
      { name: 'notes.txt', type: 'file' },
      { name: 'file10.txt', type: 'file' },
      { name: 'file2.txt', type: 'file' },
      { name: 'link-out', type: 'symlink' },
      { name: 'Documents', type: 'dir' },
      { name: 'archive', type: 'dir' },
    ]).map((entry) => entry.name),
    ['archive', 'Documents', 'link-out', 'file2.txt', 'file10.txt', 'notes.txt'],
  );
});

function node(tag) {
  const classes = new Set();
  const listeners = {};
  const element = {
    tagName: tag,
    children: [],
    attributes: {},
    hidden: false,
    classList: {
      add(value) { classes.add(value); },
      remove(value) { classes.delete(value); },
      toggle(value, force) {
        const on = force === undefined ? !classes.has(value) : Boolean(force);
        if (on) classes.add(value);
        else classes.delete(value);
      },
      contains(value) { return classes.has(value); },
    },
    set className(value) { this.attributes.class = value; },
    get className() { return this.attributes.class || ''; },
    get firstChild() { return this.children[0] || null; },
    get nextSibling() {
      if (!this.parentNode) return null;
      const siblings = this.parentNode.children;
      return siblings[siblings.indexOf(this) + 1] || null;
    },
    setAttribute(name, value) { this.attributes[name] = String(value); },
    getAttribute(name) { return Object.prototype.hasOwnProperty.call(this.attributes, name) ? this.attributes[name] : null; },
    removeAttribute(name) { delete this.attributes[name]; },
    addEventListener(type, listener) { (listeners[type] ||= []).push(listener); },
    replaceChildren(...children) {
      for (const child of this.children) if (child && typeof child === 'object') child.parentNode = null;
      this.children = children.flat();
      for (const child of this.children) if (child && typeof child === 'object') child.parentNode = this;
    },
    append(...children) {
      for (const child of children.flat()) {
        if (child && typeof child === 'object' && child.parentNode) child.parentNode.removeChild(child);
        this.children.push(child);
        if (child && typeof child === 'object') child.parentNode = this;
      }
    },
    insertBefore(child, reference) {
      if (child && typeof child === 'object' && child.parentNode) child.parentNode.removeChild(child);
      const index = reference ? this.children.indexOf(reference) : -1;
      if (index < 0) this.children.push(child);
      else this.children.splice(index, 0, child);
      if (child && typeof child === 'object') child.parentNode = this;
      return child;
    },
    removeChild(child) {
      const index = this.children.indexOf(child);
      if (index >= 0) this.children.splice(index, 1);
      if (child && typeof child === 'object') child.parentNode = null;
      return child;
    },
    remove() { this.parentNode?.removeChild(this); this.removed = true; },
    contains(target) {
      let current = target;
      while (current) {
        if (current === this) return true;
        current = current.parentNode;
      }
      return false;
    },
    focus() { this.focused = true; },
    querySelector() { return null; },
    click() {
      for (const listener of listeners.click || []) listener({ preventDefault() {}, target: element });
    },
    dispatchEvent(event) {
      for (const listener of listeners[event.type] || []) listener(event);
    },
  };
  return element;
}

function textOf(value) {
  if (value == null || value === false) return '';
  if (typeof value !== 'object') return String(value);
  return (value.children || []).map(textOf).join('');
}

function collect(value, found = []) {
  if (!value || typeof value !== 'object') return found;
  found.push(value);
  for (const child of value.children || []) collect(child, found);
  return found;
}

function buttons(root) {
  return collect(root).filter((item) => item.tagName === 'button');
}

function openListedFile(session, name) {
  buttons(session.listEl).find((button) => button.getAttribute('data-files-key') === name).click();
  assert.equal(session.file, null, 'selection must not open a file');
  assert.equal(session.pending, null, 'selection must not send a read');
  buttons(session.listEl).find((button) => textOf(button) === 'Open').click();
}

function listHome(session) {
  session.handleControl({ t: 'status', s: 'ready' });
  session.handleControl({ t: 'result', id: session.pending.id, op: 'realpath', path: '/home/alex' });
  const id = session.pending.id;
  session.handleControl({
    t: 'result',
    id,
    op: 'list',
    entries: [
      { name: 'notes.txt', type: 'file', size: 860, mtime: 0 },
      { name: 'link-out', type: 'symlink', size: 18, mtime: 0 },
      { name: 'Documents', type: 'dir', size: 4096, mtime: 0 },
      { name: 'readme.md', type: 'file', size: 1200, mtime: 0 },
    ],
  });
}

function pollingDocument() {
  const listeners = new Map();
  return {
    hidden: false,
    activeElement: null,
    createElement: (tag) => node(tag),
    addEventListener(type, listener) { listeners.set(type, listener); },
    removeEventListener(type, listener) { if (listeners.get(type) === listener) listeners.delete(type); },
    dispatch(type) { listeners.get(type)?.(); },
  };
}

function fakeTimers() {
  const previousSetTimeout = globalThis.setTimeout;
  const previousClearTimeout = globalThis.clearTimeout;
  const scheduled = new Map();
  let id = 0;
  globalThis.setTimeout = (callback, delay) => {
    const timerId = ++id;
    scheduled.set(timerId, { callback, delay });
    return timerId;
  };
  globalThis.clearTimeout = (timerId) => scheduled.delete(timerId);
  return {
    delays: () => [...scheduled.values()].map(({ delay }) => delay),
    run(delay) {
      const timer = [...scheduled.entries()].find(([, task]) => task.delay === delay);
      assert.ok(timer, `expected a ${delay}ms timer`);
      scheduled.delete(timer[0]);
      timer[1].callback();
    },
    restore() {
      globalThis.setTimeout = previousSetTimeout;
      globalThis.clearTimeout = previousClearTimeout;
    },
  };
}

function fileRow(session, name) {
  return buttons(session.listEl).find((button) => button.getAttribute('data-files-key') === name);
}

test('agentless polling lists only the active directory and reconciles external changes by row', () => {
  const previousDocument = globalThis.document;
  const document = pollingDocument();
  const timers = fakeTimers();
  globalThis.document = document;
  try {
    const session = new FileSession({ host });
    const sent = [];
    session.ws = { readyState: 1, send(data) { sent.push(data); } };
    listHome(session);
    session.show();
    const selectedIndex = session.entries.findIndex((entry) => entry.name === 'notes.txt');
    session.selected = selectedIndex;
    session.renderBrowser();
    const unchangedRow = fileRow(session, 'Documents');
    sent.length = 0;

    assert.deepEqual(timers.delays(), [5_000]);
    timers.run(5_000);
    const polls = jsonSent(sent).filter((message) => message.t === 'list');
    assert.equal(polls.length, 1);
    assert.equal(polls[0].path, '/home/alex');
    assert.equal(session.pending.poll, true);
    assert.deepEqual(timers.delays(), [35_000], 'a slow list gets the server deadline plus reply time, without overlapping polls');

    session.handleControl({
      t: 'result',
      id: polls[0].id,
      op: 'list',
      entries: [
        { name: 'Documents', type: 'dir', size: 4096, mtime: 0 },
        { name: 'link-out', type: 'file', size: 18, mtime: 0 },
        { name: 'notes.txt', type: 'file', size: 861, mtime: 10 },
        { name: 'new.txt', type: 'file', size: 3, mtime: 11 },
        { name: 'renamed.md', type: 'file', size: 1200, mtime: 0 },
      ],
    });

    assert.equal(session.entries.some((entry) => entry.name === 'readme.md'), false, 'external deletion is reflected');
    assert.equal(session.entries.some((entry) => entry.name === 'new.txt'), true, 'external creation is reflected');
    assert.equal(session.entries.some((entry) => entry.name === 'renamed.md'), true, 'external rename is reflected under its new name');
    assert.equal(session.entries.find((entry) => entry.name === 'link-out').type, 'file', 'type changes are reflected');
    assert.equal(session.entries.find((entry) => entry.name === 'notes.txt').size, 861, 'size and mtime changes are reflected');
    assert.equal(session.entries.findIndex((entry) => entry.name === 'notes.txt'), session.selected, 'selection follows the same name through a poll');
    assert.equal(fileRow(session, 'Documents'), unchangedRow, 'an unchanged row keeps its DOM node');
    assert.deepEqual(timers.delays(), [5_000], 'the next poll is scheduled at the normal interval');

    document.hidden = true;
    document.dispatch('visibilitychange');
    assert.deepEqual(timers.delays(), [], 'hidden documents stop polling');
    document.hidden = false;
    document.dispatch('visibilitychange');
    assert.deepEqual(timers.delays(), [5_000], 'visible documents resume polling');
    session.hide();
    session.schedulePolling();
    assert.deepEqual(timers.delays(), [], 'inactive file panes do not poll');
    session.show();
    assert.deepEqual(timers.delays(), [5_000], 'active panes poll at the normal interval');
    timers.run(5_000);
    const failedPoll = session.pending;
    session.handleControl({ t: 'error', id: failedPoll.id, code: 'unavailable', message: 'Temporary SFTP error' });
    assert.deepEqual(timers.delays(), [10_000], 'a poll error backs off before retrying');
    session.dispose();
  } finally {
    timers.restore();
    globalThis.document = previousDocument;
  }
});

function withPollingSession(run) {
  const previousDocument = globalThis.document;
  const document = pollingDocument();
  const timers = fakeTimers();
  globalThis.document = document;
  const session = new FileSession({ host });
  const sent = [];
  session.ws = { readyState: 1, send(data) { sent.push(data); } };
  try {
    listHome(session);
    session.show();
    sent.length = 0;
    run({ session, sent, document, timers });
  } finally {
    session.dispose();
    timers.restore();
    globalThis.document = previousDocument;
  }
}

test('a pending quiet poll keeps unchanged rows and controls available during selection', () => {
  withPollingSession(({ session, timers }) => {
    const unchangedRow = fileRow(session, 'notes.txt');
    timers.run(5_000);
    session.moveSelection(1);
    assert.ok(fileRow(session, 'notes.txt') === unchangedRow, 'selection during a poll does not recreate unrelated rows');
    assert.equal(unchangedRow.attributes.disabled, undefined);
    assert.equal(session.searchSubmit.disabled, false);
    assert.equal(session.mkdirButton.disabled, false);
    assert.equal(session.refreshButton.disabled, false);
    assert.deepEqual(timers.delays(), [35_000], 'selection cannot start another poll before the pending one completes');
  });
});

for (const action of ['directory', 'file', 'search', 'mkdir']) {
  test(`a user ${action} action preempts a pending poll and ignores its late result`, () => {
    withPollingSession(({ session, sent, timers }) => {
      timers.run(5_000);
      const pollId = session.pending.id;
      if (action === 'directory') session.activate(session.entries.findIndex((entry) => entry.name === 'Documents'));
      else if (action === 'file') session.openFile(session.entries.findIndex((entry) => entry.name === 'notes.txt'));
      else if (action === 'search') {
        session.searchInput.value = 'notes';
        session.startSearch();
      } else session.beginMutation('mkdir');
      assert.notEqual(session.pending?.id, pollId, 'the user operation does not wait for the quiet poll');
      const pending = session.pending;
      const entries = session.entries;
      session.handleControl({ t: 'result', id: pollId, op: 'list', entries: [{ name: 'stale', type: 'file' }] });
      assert.ok(session.pending === pending, 'a stale poll must not finish the current request');
      assert.ok(session.entries === entries, 'a stale poll must not replace the current directory');
      const requests = jsonSent(sent).filter((message) => ['list', 'read', 'search'].includes(message.t));
      assert.equal(requests.length, action === 'mkdir' ? 1 : 2);
      if (action === 'directory') assert.equal(requests[1].path, '/home/alex/Documents');
      else if (action === 'file') assert.equal(session.file.path, '/home/alex/notes.txt');
      else if (action === 'search') assert.equal(session.search.status, 'loading');
      else assert.equal(session.mutation.action, 'mkdir');
    });
  });
}

test('a timed out poll drains a queued refresh and late replies cannot overwrite it', () => {
  withPollingSession(({ session, sent, timers }) => {
    timers.run(5_000);
    const pollId = session.pending.id;
    session.refreshListing();
    assert.equal(session.refreshQueued, true);
    timers.run(35_000);
    assert.equal(session.refreshQueued, false);
    assert.equal(session.pending.op, 'list');
    assert.notEqual(session.pending.id, pollId);
    assert.equal(session.pending.poll, undefined);
    const refreshId = session.pending.id;
    session.handleControl({ t: 'result', id: pollId, op: 'list', entries: [] });
    assert.equal(session.pending.id, refreshId);
    assert.equal(jsonSent(sent).filter((message) => message.t === 'list').length, 2);
  });
});

test('unhealthy polling uses bounded backoff and recovery restores the normal cadence', () => {
  withPollingSession(({ session, timers }) => {
    for (const delay of [5_000, 10_000, 20_000, 40_000, 80_000, 160_000, 200_000, 200_000]) {
      assert.deepEqual(timers.delays(), [delay]);
      timers.run(delay);
      session.handleControl({ t: 'error', id: session.pending.id, code: 'unavailable' });
    }
    timers.run(200_000);
    session.handleControl({ t: 'result', id: session.pending.id, op: 'list', entries: session.entries });
    assert.deepEqual(timers.delays(), [5_000]);
    session.disconnect();
    assert.deepEqual(timers.delays(), [], 'disconnection clears every polling timer');
  });
});

test('switching and restarting inline drafts displays the current form while retaining unrelated rows', () => {
  withPollingSession(({ session }) => {
    session.activate(session.entries.findIndex((entry) => entry.name === 'notes.txt'));
    const unrelatedRow = fileRow(session, 'Documents');
    session.beginMutation('rename');
    let previousForm = session.mutationForm;
    assert.ok(collect(session.listEl).includes(previousForm));
    for (const action of ['move', 'move', 'rename']) {
      session.beginMutation(action);
      assert.ok(session.mutationForm !== previousForm, 'each new draft creates a new form');
      assert.ok(collect(session.listEl).includes(session.mutationForm), 'the current draft form must be attached');
      assert.ok(!collect(session.listEl).includes(previousForm), 'the old draft form must be removed');
      assert.ok(fileRow(session, 'Documents') === unrelatedRow, 'draft replacement does not rebuild unrelated rows');
      previousForm = session.mutationForm;
    }
  });
});

for (const recovery of ['refresh', 'navigation']) {
  test(`successful ${recovery} restores the normal cadence after polling failures`, () => {
    withPollingSession(({ session, timers }) => {
      for (const delay of [5_000, 10_000, 20_000, 40_000, 80_000, 160_000]) {
        timers.run(delay);
        session.handleControl({ t: 'error', id: session.pending.id, code: 'unavailable' });
      }
      assert.deepEqual(timers.delays(), [200_000]);
      if (recovery === 'refresh') session.refreshListing();
      else session.openPath('/healthy');
      session.handleControl({ t: 'result', id: session.pending.id, op: 'list', entries: [{ name: 'healthy.txt', type: 'file', size: 1, mtime: 0 }] });
      assert.deepEqual(timers.delays(), [5_000], 'a successful foreground list clears the previous unhealthy backoff');
    });
  });
}

test('files browser lists a directory and moves through it', () => {
  const previousDocument = globalThis.document;
  globalThis.document = { createElement: (tag) => node(tag), activeElement: null };
  try {
    let lost = 0;
    const session = new FileSession({ host, onConnectionLost() { lost += 1; } });
    assert.equal(session.surfaceType, 'files');
    assert.equal(session.label, 'lab-nas · Files');
    assert.equal(session.state, 'password');
    session.show();
    assert.equal(session.pane.classList.contains('active'), true);
    assert.equal(session.pane.focused, true);
    session.hide();
    session.updateHost({ ...host, name: 'New NAS' });
    assert.equal(session.heading.textContent, 'New NAS');
    session.updateHost(host);

    session.handleControl({ t: 'error', code: 'auth', message: 'Authentication failed.' });
    assert.equal(session.state, 'password');
    assert.equal(lost, 1);
    assert.match(textOf(session.overlay), /Authentication failed/);

    session.handleControl({ t: 'status', s: 'authenticating' });
    assert.equal(session.state, 'authenticating');

    listHome(session);
    assert.equal(session.state, 'ready');
    assert.equal(session.path, '/home/alex');
    assert.equal(session.view, 'ready');
    assert.deepEqual(session.entries.map((entry) => entry.name), ['Documents', 'link-out', 'notes.txt', 'readme.md']);
    const rows = buttons(session.listEl).filter((button) => button.getAttribute('data-files-key'));
    assert.match(textOf(rows[0]), /Documents/);
    assert.match(textOf(rows[0]), /folder {2}· {2}—/);
    assert.match(textOf(rows[2]), /860 B/);
    assert.equal(session.countEl.textContent, '04');
    assert.equal(rows[0].getAttribute('aria-selected'), 'true');

    const home = buttons(session.crumbsEl).find((button) => textOf(button) === 'home');
    home.click();
    assert.equal(session.path, '/home');
    assert.equal(session.view, 'loading');
    const stale = session.pending.id;
    session.openPath('/home/alex');
    session.handleControl({
      t: 'result',
      id: stale,
      op: 'list',
      entries: [{ name: 'old', type: 'file', size: 1, mtime: 0 }],
    });
    assert.equal(session.path, '/home/alex');
    assert.equal(session.view, 'loading');
    session.handleControl({
      t: 'result',
      id: session.pending.id,
      op: 'list',
      entries: [
        { name: 'notes.txt', type: 'file', size: 860, mtime: 0 },
        { name: 'Documents', type: 'dir', size: 4096, mtime: 0 },
      ],
    });

    openListedFile(session, 'notes.txt');
    assert.equal(session.pending.op, 'read');
    session.handleControl({
      t: 'result',
      id: session.pending.id,
      op: 'read',
      text: 'hello\n',
      truncated: false,
      size: 6,
    });
    buttons(session.readerEl).find((button) => textOf(button) === 'Close').click();
    assert.equal(session.file, null);
    assert.equal(session.entries[session.selected].name, 'notes.txt');

    buttons(session.listEl).find((button) => textOf(button).includes('Documents')).click();
    assert.equal(session.path, '/home/alex/Documents');
    assert.equal(session.view, 'loading');
    assert.equal(session.pending.op, 'list');

    let prevented = false;
    session.onListKey({
      key: 'Backspace',
      altKey: false,
      metaKey: false,
      ctrlKey: false,
      target: { tagName: 'BUTTON' },
      preventDefault() { prevented = true; },
    });
    assert.equal(prevented, true);
    assert.equal(session.path, '/home/alex');

    session.handleControl({ t: 'result', id: session.pending.id, op: 'list', entries: [] });
    assert.equal(session.view, 'empty');
    assert.match(textOf(session.listEl), /This folder is empty/);

    session.openPath('/etc');
    session.handleControl({ t: 'error', id: session.pending.id, code: 'denied', message: 'Permission denied: /etc' });
    assert.equal(session.view, 'denied');
    assert.match(textOf(session.listEl), /Permission denied/);
    assert.match(textOf(session.crumbsEl), /etc/);
    assert.equal(session.path, '/etc');

    session.openPath('/tmp/missing');
    session.handleControl({ t: 'error', id: session.pending.id, code: 'not-found', message: 'No such file or directory: /tmp/missing' });
    assert.equal(session.view, 'missing');
    assert.match(textOf(session.listEl), /This file or folder doesn’t exist/);

    session.openPath('/home/alex');
    session.handleControl({
      t: 'result',
      id: session.pending.id,
      op: 'list',
      entries: [
        { name: 'notes.txt', type: 'file', size: 860, mtime: 0 },
        { name: 'link-out', type: 'symlink', size: 18, mtime: 0 },
      ],
    });
    session.onListKey({
      key: 'ArrowDown',
      altKey: false,
      metaKey: false,
      ctrlKey: false,
      target: { tagName: 'BUTTON' },
      preventDefault() {},
    });
    assert.equal(session.selected, 1);
    assert.equal(session.entries[session.selected].name, 'notes.txt');
    buttons(session.listEl).find((button) => textOf(button).includes('link-out')).click();
    assert.equal(session.path, '/home/alex/link-out');

    session.handleControl({ t: 'closed', reason: 'The Files connection ended.' });
    assert.equal(session.state, 'ended');
    assert.match(textOf(session.listEl), /The Files connection ended/);
    assert.match(textOf(session.overlay), /Disconnected/);
    assert.equal(buttons(session.crumbsEl)[0].getAttribute('disabled'), '');

    session.dispose();
    assert.equal(session.pane.removed, true);
  } finally {
    globalThis.document = previousDocument;
  }
});

test('opening a file shows a numbered read-only page and closing restores the row', () => {
  const previousDocument = globalThis.document;
  globalThis.document = { createElement: (tag) => node(tag), activeElement: null };
  try {
    const session = new FileSession({ host });
    listHome(session);
    openListedFile(session, 'notes.txt');
    assert.equal(session.state, 'ready');
    assert.equal(session.path, '/home/alex');
    assert.equal(session.entries.length, 4);
    assert.equal(session.pending.op, 'read');
    assert.equal(session.pending.path, '/home/alex/notes.txt');
    assert.match(textOf(session.readerEl), /notes\.txt/);
    assert.match(textOf(session.readerEl), /\/home\/alex\/notes\.txt/);
    assert.equal(session.listEl.hidden, true);

    session.handleControl({
      t: 'result',
      id: session.pending.id,
      op: 'read',
      text: 'alpha\n    beta\n',
      truncated: false,
      size: 15,
    });
    const lines = collect(session.readerEl).filter((item) => item.tagName === 'li').map(textOf);
    assert.deepEqual(lines, ['alpha', '    beta']);
    assert.match(session.footStatus.textContent, /entire file/);
    assert.equal(session.pending, null);

    buttons(session.readerEl).find((button) => textOf(button) === 'Close').click();
    assert.equal(session.file, null);
    assert.equal(session.listEl.hidden, false);
    assert.equal(session.entries[session.selected].name, 'notes.txt');
    assert.equal(session.path, '/home/alex');

    openListedFile(session, 'readme.md');
    session.handleControl({ t: 'error', id: session.pending.id, code: 'denied', message: 'Permission denied: /home/alex/readme.md' });
    assert.equal(session.state, 'ready');
    assert.equal(session.entries.length, 4);
    assert.match(textOf(session.readerEl), /Permission denied/);
    assert.doesNotMatch(textOf(session.readerEl), /alpha/);

    buttons(session.readerEl).find((button) => textOf(button) === 'Close').click();
    openListedFile(session, 'readme.md');
    session.handleControl({ t: 'error', id: session.pending.id, code: 'not-found', message: 'No such file or directory: /home/alex/readme.md' });
    assert.match(textOf(session.readerEl), /Not found|no longer/);
    assert.equal(session.entries.length, 4);

    buttons(session.readerEl).find((button) => textOf(button) === 'Close').click();
    openListedFile(session, 'readme.md');
    session.handleControl({ t: 'error', id: session.pending.id, code: 'binary', message: 'This file is not text: /home/alex/readme.md' });
    assert.match(textOf(session.readerEl), /Binary|not text/);
    assert.doesNotMatch(textOf(session.readerEl), /\u0000/);

    buttons(session.readerEl).find((button) => textOf(button) === 'Close').click();
    openListedFile(session, 'readme.md');
    session.handleControl({ t: 'error', id: session.pending.id, code: 'too-large', message: 'This file is over the view limit: /home/alex/readme.md', size: 999999 });
    assert.match(textOf(session.readerEl), /Too large|view limit/);
    assert.equal(session.entries.length, 4);
    assert.equal(session.state, 'ready');

    buttons(session.readerEl).find((button) => textOf(button) === 'Close').click();
    buttons(session.listEl).find((button) => textOf(button).includes('Documents')).click();
    assert.equal(session.pending.op, 'list');
    assert.equal(session.path, '/home/alex/Documents');
    session.dispose();
  } finally {
    globalThis.document = previousDocument;
  }
});

test('a long file shows a window, escape closes it, and a dropped session clears the text', () => {
  const previousDocument = globalThis.document;
  globalThis.document = { createElement: (tag) => node(tag), activeElement: null };
  try {
    const session = new FileSession({ host });
    listHome(session);
    openListedFile(session, 'notes.txt');
    session.handleControl({
      t: 'result',
      id: session.pending.id,
      op: 'read',
      text: 'kept\n',
      truncated: true,
      size: 90000,
    });
    assert.match(session.footStatus.textContent, /rest stays on the computer/);
    assert.match(textOf(session.readerEl), /stays on the computer/);
    session.onListKey({ key: 'Backspace', altKey: false, metaKey: false, ctrlKey: false, target: { tagName: 'BUTTON' }, preventDefault() {} });
    assert.equal(session.path, '/home/alex');
    session.onListKey({ key: 'Escape', altKey: false, metaKey: false, ctrlKey: false, target: { tagName: 'BUTTON' }, preventDefault() {} });
    assert.equal(session.file, null);
    assert.equal(session.entries[session.selected].name, 'notes.txt');

    openListedFile(session, 'notes.txt');
    session.handleControl({
      t: 'result',
      id: session.pending.id,
      op: 'read',
      text: 'secret line\n',
      truncated: false,
      size: 12,
    });
    session.handleControl({ t: 'closed', reason: 'The Files connection ended.' });
    assert.equal(session.state, 'ended');
    assert.match(textOf(session.readerEl), /Disconnected/);
    assert.doesNotMatch(textOf(session.readerEl), /secret line/);
    assert.equal(session.entries.length, 4);
    buttons(session.readerEl).find((button) => textOf(button) === 'Close').click();
    assert.equal(session.file, null);
    assert.match(textOf(session.listEl), /The Files connection ended/);
  } finally {
    globalThis.document = previousDocument;
  }
});

function fakeFile(name, bytes) {
  const data = typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes;
  return {
    name,
    size: data.byteLength,
    slice(start, end) {
      const part = data.slice(start, end);
      return {
        arrayBuffer: async () => part.buffer.slice(part.byteOffset, part.byteOffset + part.byteLength),
      };
    },
  };
}

function jsonSent(sent) {
  return sent.filter((item) => typeof item === 'string').map((item) => JSON.parse(item));
}

async function flush() {
  await Promise.resolve();
  await Promise.resolve();
}

test('transfer labels report percent as text and cap a live transfer below 100', () => {
  assert.equal(transferStateLabel('queued'), 'Queued');
  assert.equal(transferStateLabel('transferring'), 'Transferring');
  assert.equal(transferStateLabel('complete'), 'Complete');
  assert.equal(transferStateLabel('error'), 'Error');
  assert.equal(transferStateLabel('cancelled'), 'Cancelled');
  assert.equal(transferPercent({ state: 'queued', loaded: 0, total: 200 }), 0);
  assert.equal(transferPercent({ state: 'transferring', loaded: 200, total: 200 }), 99);
  assert.equal(transferPercent({ state: 'complete', loaded: 200, total: 200 }), 100);
  assert.equal(transferPercent({ state: 'transferring', loaded: 50, total: 200 }), 25);
});

test('the queue dock runs one transfer at a time and keeps the directory on error', async () => {
  const previousDocument = globalThis.document;
  globalThis.document = { createElement: (tag) => node(tag), activeElement: null };
  try {
    const session = new FileSession({ host });
    listHome(session);
    const names = session.entries.map((entry) => entry.name);
    const sent = [];
    session.ws = { readyState: 1, send(data) { sent.push(data); } };

    assert.match(textOf(session.dockEl), /Transfers/);
    assert.match(textOf(session.dockEl), /No transfers/);
    assert.equal(session.footPath.textContent, '/home/alex');
    session.queueDownload();
    assert.match(textOf(session.dockNotice), /Choose a file/);
    assert.equal(jsonSent(sent).some((message) => message.t === 'get'), false);
    assert.deepEqual(session.entries.map((entry) => entry.name), names);

    session.selected = session.entries.findIndex((entry) => entry.name === 'notes.txt');
    session.queueDownload();
    session.selected = session.entries.findIndex((entry) => entry.name === 'readme.md');
    session.queueDownload();
    const queued = jsonSent(sent).filter((message) => message.t === 'get');
    assert.equal(queued.length, 1);
    assert.equal(queued[0].path, '/home/alex/notes.txt');
    assert.match(textOf(session.dockList), /notes\.txt/);
    assert.match(textOf(session.dockList), /Transferring/);
    assert.match(textOf(session.dockList), /readme\.md/);
    assert.match(textOf(session.dockList), /Queued/);
    assert.equal(session.entries.length, 4);
    assert.equal(session.view, 'ready');

    const activeId = queued[0].id;
    const waitingId = session.transfers.find((transfer) => transfer.name === 'readme.md').id;
    session.cancelTransfer(waitingId);
    assert.equal(jsonSent(sent).some((message) => message.t === 'cancel'), false);
    assert.equal(session.transfers.find((transfer) => transfer.id === waitingId).state, 'cancelled');
    assert.equal(session.transfers.find((transfer) => transfer.id === activeId).state, 'transferring');
    assert.match(textOf(session.listEl), /Documents/);

    session.handleControl({ t: 'transfer', id: activeId, phase: 'start', kind: 'download', size: 860, path: '/home/alex/notes.txt' });
    session.handleControl({ t: 'transfer', id: activeId, phase: 'progress', loaded: 430, size: 860 });
    assert.match(textOf(session.dockList), /430 B \/ 860 B/);
    assert.match(textOf(session.dockList), /50%/);
    assert.equal(session.path, '/home/alex');
    assert.deepEqual(session.entries.map((entry) => entry.name), names);

    session.handleControl({
      t: 'error',
      id: activeId,
      code: 'denied',
      message: 'Permission denied: /home/alex/notes.txt',
    });
    assert.equal(session.view, 'ready');
    assert.equal(session.state, 'ready');
    assert.deepEqual(session.entries.map((entry) => entry.name), names);
    assert.match(textOf(session.listEl), /Documents/);
    assert.match(textOf(session.listEl), /notes\.txt/);
    assert.equal(session.footPath.textContent, '/home/alex');
    assert.match(textOf(session.dockList), /Error/);
    assert.match(textOf(session.dockList), /folder listing was not changed/);
    assert.doesNotMatch(textOf(session.listEl), /Permission denied/);

    session.queueUploads([fakeFile('a.txt', 'hello'), fakeFile('b.txt', 'world!!')]);
    const puts = jsonSent(sent).filter((message) => message.t === 'put');
    assert.equal(puts.length, 1);
    assert.equal(puts[0].path, '/home/alex/a.txt');
    assert.equal(session.transfers.find((transfer) => transfer.name === 'b.txt').state, 'queued');
    assert.match(textOf(session.dockList), /Queued/);

    session.handleControl({ t: 'transfer', id: puts[0].id, phase: 'start', kind: 'upload', size: 5, path: puts[0].path });
    await flush();
    const uploaded = sent.find((item) => item instanceof Uint8Array);
    assert.equal(uploaded?.byteLength, 5);
    session.handleControl({ t: 'transfer', id: puts[0].id, phase: 'ack', loaded: 5, size: 5 });
    await flush();
    assert.equal(jsonSent(sent).some((message) => message.t === 'put-end' && message.id === puts[0].id), true);
    const beforeSecond = jsonSent(sent).filter((message) => message.t === 'put').length;
    session.handleControl({ t: 'transfer', id: puts[0].id, phase: 'complete', loaded: 5, size: 5 });
    assert.equal(session.transfers.find((transfer) => transfer.name === 'a.txt').state, 'complete');
    assert.equal(jsonSent(sent).filter((message) => message.t === 'put').length, beforeSecond + 1);
    assert.equal(session.transfers.find((transfer) => transfer.name === 'b.txt').state, 'transferring');
    assert.deepEqual(session.entries.map((entry) => entry.name), names);

    let pickerClicks = 0;
    session.fileInput.click = () => { pickerClicks += 1; };
    buttons(session.dockEl).find((button) => textOf(button) === 'Upload').click();
    assert.equal(pickerClicks, 1);

    session.listEl.dispatchEvent({
      type: 'dragover',
      preventDefault() {},
      dataTransfer: { dropEffect: '' },
    });
    assert.equal(session.listEl.classList.contains('is-drop'), true);
    session.listEl.dispatchEvent({
      type: 'drop',
      preventDefault() {},
      dataTransfer: { files: [fakeFile('drop.txt', 'xyz')] },
    });
    assert.equal(session.listEl.classList.contains('is-drop'), false);
    assert.equal(session.transfers.some((transfer) => transfer.name === 'drop.txt' && transfer.state === 'queued'), true);
    assert.deepEqual(session.entries.map((entry) => entry.name), names);
    assert.equal(session.footPath.textContent, '/home/alex');
  } finally {
    globalThis.document = previousDocument;
  }
});

test('clear removes finished transfer rows and keeps queued or transferring rows', () => {
  const previousDocument = globalThis.document;
  globalThis.document = { createElement: (tag) => node(tag), activeElement: null };
  try {
    const session = new FileSession({ host });
    listHome(session);
    const names = session.entries.map((entry) => entry.name);
    const sent = [];
    session.ws = { readyState: 1, send(data) { sent.push(data); } };

    const clearButton = () => buttons(session.dockEl).find((button) => button.getAttribute('aria-label') === 'Clear finished transfers');
    const clear = clearButton();
    assert.equal(clear.tagName, 'button');
    assert.equal(clear.getAttribute('type'), 'button');
    assert.equal(textOf(clear), 'Clear');

    session.queueUploads([
      fakeFile('live.txt', 'aa'),
      fakeFile('wait.txt', 'bb'),
      fakeFile('done.txt', 'cc'),
      fakeFile('bad.txt', 'dd'),
      fakeFile('stop.txt', 'ee'),
    ]);
    const row = (name) => session.transfers.find((transfer) => transfer.name === name);
    row('done.txt').state = 'complete';
    row('bad.txt').state = 'error';
    row('bad.txt').message = 'Permission denied';
    row('stop.txt').state = 'cancelled';
    session.renderDock();
    assert.equal(row('live.txt').state, 'transferring');
    assert.equal(row('wait.txt').state, 'queued');
    assert.match(textOf(session.dockList), /done\.txt/);
    assert.match(textOf(session.dockList), /bad\.txt/);
    assert.match(textOf(session.dockList), /stop\.txt/);

    const sentBefore = sent.length;
    clearButton().click();

    assert.deepEqual(session.transfers.map((transfer) => transfer.name), ['live.txt', 'wait.txt']);
    assert.equal(row('live.txt').state, 'transferring');
    assert.equal(row('wait.txt').state, 'queued');
    assert.match(textOf(session.dockList), /live\.txt/);
    assert.match(textOf(session.dockList), /Transferring/);
    assert.match(textOf(session.dockList), /wait\.txt/);
    assert.match(textOf(session.dockList), /Queued/);
    assert.doesNotMatch(textOf(session.dockList), /done\.txt/);
    assert.doesNotMatch(textOf(session.dockList), /bad\.txt/);
    assert.doesNotMatch(textOf(session.dockList), /stop\.txt/);
    assert.equal(session.dockCount.textContent, '02');
    assert.equal(sent.length, sentBefore);
    assert.deepEqual(session.entries.map((entry) => entry.name), names);
    assert.equal(session.path, '/home/alex');
    assert.equal(session.footPath.textContent, '/home/alex');
    assert.equal(session.view, 'ready');

    clearButton().click();
    assert.deepEqual(session.transfers.map((transfer) => transfer.name), ['live.txt', 'wait.txt']);
    assert.equal(row('live.txt').state, 'transferring');
    assert.equal(row('wait.txt').state, 'queued');
    assert.equal(sent.length, sentBefore);

    row('live.txt').state = 'complete';
    row('wait.txt').state = 'error';
    session.renderDock();
    clearButton().click();
    assert.equal(session.transfers.length, 0);
    assert.match(textOf(session.dockList), /No transfers/);
    assert.equal(session.dockCount.textContent, '00');
    assert.deepEqual(session.entries.map((entry) => entry.name), names);
    assert.equal(session.footPath.textContent, '/home/alex');
    assert.equal(sent.length, sentBefore);
  } finally {
    globalThis.document = previousDocument;
  }
});

function anchorDocument(anchorClicks) {
  return {
    createElement(tag) {
      const element = node(tag);
      if (tag === 'a') {
        const click = element.click.bind(element);
        element.click = () => {
          anchorClicks.push(element.download || element.getAttribute('download'));
          click();
        };
      }
      return element;
    },
    activeElement: null,
  };
}

function settle() {
  return new Promise((resolve) => setImmediate(resolve));
}

function saveWindow({ permission = 'granted', createWritable, remove } = {}) {
  const calls = [];
  const streams = [];
  const win = {
    calls,
    streams,
    focus() { calls.push('focus'); },
    showSaveFilePicker(options) {
      calls.push(`picker:${options.suggestedName}`);
      return Promise.resolve({
        queryPermission() {
          calls.push('query');
          return Promise.resolve(permission);
        },
        requestPermission() {
          calls.push('request');
          return Promise.resolve(permission === 'granted' ? 'granted' : 'denied');
        },
        remove() {
          calls.push('remove');
          if (remove) return remove();
          return Promise.resolve();
        },
        createWritable() {
          calls.push(`writable:${options.suggestedName}`);
          if (createWritable) return createWritable(options, streams, calls);
          const stream = {
            writes: [],
            closed: false,
            aborted: false,
            write(bytes) {
              this.writes.push(bytes.byteLength);
              return Promise.resolve();
            },
            close() {
              this.closed = true;
              return Promise.resolve();
            },
            abort() {
              this.aborted = true;
              return Promise.resolve();
            },
          };
          streams.push(stream);
          return Promise.resolve(stream);
        },
      });
    },
  };
  return win;
}

test('dismissing the save dialog cancels the download before it starts', async () => {
  const previousDocument = globalThis.document;
  const previousWindow = globalThis.window;
  const anchorClicks = [];
  globalThis.document = anchorDocument(anchorClicks);
  globalThis.window = {
    showSaveFilePicker() {
      return Promise.reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    },
  };
  try {
    const session = new FileSession({ host });
    listHome(session);
    const sent = [];
    session.ws = { readyState: 1, send(data) { sent.push(data); } };
    session.selected = session.entries.findIndex((entry) => entry.name === 'notes.txt');
    session.queueDownload();
    await settle();
    const transfer = session.transfers.find((item) => item.name === 'notes.txt');
    assert.equal(transfer.state, 'cancelled');
    assert.equal(jsonSent(sent).some((message) => message.t === 'get'), false);
    assert.deepEqual(anchorClicks, []);
    assert.equal(session.path, '/home/alex');
  } finally {
    globalThis.document = previousDocument;
    globalThis.window = previousWindow;
  }
});

test('a confirmed save streams to that file, and cancel aborts it without a second download', async () => {
  const previousDocument = globalThis.document;
  const previousWindow = globalThis.window;
  const anchorClicks = [];
  globalThis.document = anchorDocument(anchorClicks);
  const win = saveWindow();
  globalThis.window = win;
  try {
    const session = new FileSession({ host });
    listHome(session);
    const names = session.entries.map((entry) => entry.name);
    const sent = [];
    session.ws = { readyState: 1, send(data) { sent.push(data); } };
    const gets = () => jsonSent(sent).filter((message) => message.t === 'get');

    session.selected = session.entries.findIndex((entry) => entry.name === 'notes.txt');
    session.queueDownload();
    assert.deepEqual(win.calls, ['picker:notes.txt']);
    assert.equal(gets().length, 0);
    await settle();
    assert.equal(gets().length, 1);
    assert.equal(gets()[0].path, '/home/alex/notes.txt');
    const notes = session.transfers.find((transfer) => transfer.name === 'notes.txt');
    assert.equal(notes.state, 'transferring');
    assert.equal(notes.writable, win.streams[0]);

    session.selected = session.entries.findIndex((entry) => entry.name === 'readme.md');
    session.queueDownload();
    await settle();
    const readme = session.transfers.find((transfer) => transfer.name === 'readme.md');
    assert.equal(readme.state, 'queued');
    assert.equal(readme.writable, win.streams[1]);
    assert.equal(gets().length, 1);

    session.cancelTransfer(notes.id);
    assert.equal(notes.state, 'cancelled');
    assert.equal(win.streams[0].aborted, true);
    assert.equal(jsonSent(sent).some((message) => message.t === 'cancel' && message.id === notes.id), true);
    session.handleControl({ t: 'transfer', id: notes.id, phase: 'complete', loaded: 860, size: 860 });
    await settle();
    assert.equal(notes.state, 'cancelled');
    assert.equal(win.streams[0].closed, false);
    assert.deepEqual(anchorClicks, []);
    assert.equal(readme.state, 'transferring');
    assert.deepEqual(session.entries.map((entry) => entry.name), names);
  } finally {
    globalThis.document = previousDocument;
    globalThis.window = previousWindow;
  }
});

test('a blocked save file stays cancellable and is not saved when cancelled', async () => {
  const previousDocument = globalThis.document;
  const previousWindow = globalThis.window;
  const anchorClicks = [];
  globalThis.document = anchorDocument(anchorClicks);
  globalThis.Blob = globalThis.Blob || class Blob { constructor(parts) { this.parts = parts; } };
  if (typeof globalThis.URL.createObjectURL !== 'function') {
    globalThis.URL.createObjectURL = () => 'blob:mock';
    globalThis.URL.revokeObjectURL = () => {};
  }
  const win = saveWindow({
    permission: 'denied',
    createWritable() {
      throw Object.assign(new Error('not allowed'), { name: 'NotAllowedError' });
    },
  });
  globalThis.window = win;
  try {
    const session = new FileSession({ host });
    listHome(session);
    const sent = [];
    session.ws = { readyState: 1, send(data) { sent.push(data); } };
    session.selected = session.entries.findIndex((entry) => entry.name === 'notes.txt');
    session.queueDownload();
    await settle();
    await settle();
    const transfer = session.transfers.find((item) => item.name === 'notes.txt');
    assert.equal(win.calls.includes('writable:notes.txt'), false);
    assert.equal(win.calls.includes('remove'), false);
    assert.equal(transfer.state, 'transferring');
    assert.equal(transfer.message, '');
    session.cancelTransfer(transfer.id);
    session.handleControl({ t: 'transfer', id: transfer.id, phase: 'complete', loaded: 860, size: 860 });
    await settle();
    assert.equal(transfer.state, 'cancelled');
    assert.deepEqual(anchorClicks, []);
    assert.equal(session.path, '/home/alex');
  } finally {
    globalThis.document = previousDocument;
    globalThis.window = previousWindow;
  }
});

// Helper for the late-handle tests: runs one download from start to complete.
async function runBlockedDownload(session, sent, size) {
  const gets = jsonSent(sent).filter((message) => message.t === 'get');
  assert.equal(gets.length, 1);
  session.handleControl({ t: 'transfer', id: gets[0].id, phase: 'start', kind: 'download', size, path: gets[0].path });
  await session.acceptDownloadChunk(new Uint8Array(size).buffer);
  session.handleControl({ t: 'transfer', id: gets[0].id, phase: 'complete', loaded: size, size });
  await settle();
  return session.transfers.find((item) => item.id === gets[0].id);
}

test('a save that is blocked after the picker writes to the chosen file once and shows no second dialog', async () => {
  const previousDocument = globalThis.document;
  const previousWindow = globalThis.window;
  const anchorClicks = [];
  globalThis.document = anchorDocument(anchorClicks);
  globalThis.Blob = globalThis.Blob || class Blob { constructor(parts) { this.parts = parts; } };
  let writableCalls = 0;
  const win = saveWindow({
    createWritable(options, streams) {
      writableCalls += 1;
      if (writableCalls === 1) {
        throw Object.assign(new Error('not allowed'), { name: 'NotAllowedError' });
      }
      const stream = {
        writes: [],
        closed: false,
        write(bytes) {
          this.writes.push(bytes);
          return Promise.resolve();
        },
        close() {
          this.closed = true;
          return Promise.resolve();
        },
        abort() {
          return Promise.resolve();
        },
      };
      streams.push(stream);
      return Promise.resolve(stream);
    },
  });
  globalThis.window = win;
  try {
    const session = new FileSession({ host });
    listHome(session);
    const sent = [];
    session.ws = { readyState: 1, send(data) { sent.push(data); } };
    session.selected = session.entries.findIndex((entry) => entry.name === 'notes.txt');
    session.queueDownload();
    await settle();
    await settle();
    const transfer = session.transfers.find((item) => item.name === 'notes.txt');
    assert.equal(transfer.saveKind, 'late-handle');
    assert.equal(transfer.writable, null);
    assert.equal(win.calls.includes('remove'), false);

    const done = await runBlockedDownload(session, sent, 860);
    assert.equal(done.state, 'complete');
    assert.equal(done.handle, null);
    assert.equal(win.streams.length, 1);
    assert.deepEqual(win.streams[0].writes.map((bytes) => bytes.size), [860]);
    assert.equal(win.streams[0].closed, true);
    assert.deepEqual(anchorClicks, []);
    assert.equal(session.path, '/home/alex');
  } finally {
    globalThis.document = previousDocument;
    globalThis.window = previousWindow;
  }
});

test('a save that stays blocked reports an error after complete and shows no second dialog', async () => {
  const previousDocument = globalThis.document;
  const previousWindow = globalThis.window;
  const anchorClicks = [];
  globalThis.document = anchorDocument(anchorClicks);
  globalThis.Blob = globalThis.Blob || class Blob { constructor(parts) { this.parts = parts; } };
  globalThis.window = saveWindow({
    createWritable() {
      throw Object.assign(new Error('not allowed'), { name: 'NotAllowedError' });
    },
  });
  const win = globalThis.window;
  try {
    const session = new FileSession({ host });
    listHome(session);
    const sent = [];
    session.ws = { readyState: 1, send(data) { sent.push(data); } };
    session.selected = session.entries.findIndex((entry) => entry.name === 'notes.txt');
    session.queueDownload();
    await settle();
    await settle();

    const done = await runBlockedDownload(session, sent, 860);
    assert.equal(done.state, 'error');
    assert.equal(done.message, 'The browser blocked writing to the chosen file.');
    assert.equal(done.handle, null);
    assert.equal(done.parts.length, 0);
    assert.equal(win.streams.length, 0);
    assert.deepEqual(anchorClicks, []);
    assert.equal(session.path, '/home/alex');
  } finally {
    globalThis.document = previousDocument;
    globalThis.window = previousWindow;
  }
});

test('without a save picker one completed download uses a single blob download', async () => {
  const previousDocument = globalThis.document;
  const previousWindow = globalThis.window;
  const anchorClicks = [];
  globalThis.document = anchorDocument(anchorClicks);
  globalThis.window = {};
  globalThis.Blob = globalThis.Blob || class Blob { constructor(parts) { this.parts = parts; } };
  if (typeof globalThis.URL.createObjectURL !== 'function') {
    globalThis.URL.createObjectURL = () => 'blob:mock';
    globalThis.URL.revokeObjectURL = () => {};
  }
  try {
    const session = new FileSession({ host });
    listHome(session);
    const sent = [];
    session.ws = { readyState: 1, send(data) { sent.push(data); } };
    session.selected = session.entries.findIndex((entry) => entry.name === 'notes.txt');
    session.queueDownload();
    const gets = jsonSent(sent).filter((message) => message.t === 'get');
    assert.equal(gets.length, 1);
    session.handleControl({ t: 'transfer', id: gets[0].id, phase: 'start', kind: 'download', size: 860, path: gets[0].path });
    await session.acceptDownloadChunk(new Uint8Array([9]).buffer);
    session.handleControl({ t: 'transfer', id: gets[0].id, phase: 'complete', loaded: 860, size: 860 });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(anchorClicks, ['notes.txt']);
    assert.equal(session.transfers.find((item) => item.id === gets[0].id).state, 'complete');
  } finally {
    globalThis.document = previousDocument;
    globalThis.window = previousWindow;
  }
});

test('inline mutations retain failed drafts, refresh without losing the session, and reconcile new names', () => {
  const previousDocument = globalThis.document;
  globalThis.document = { createElement: tag => node(tag), activeElement: null };
  try {
    const session = new FileSession({ host });
    const sent = []; session.send = message => sent.push(message);
    listHome(session);
    buttons(session.listEl).find(button => button.getAttribute('data-files-key') === 'notes.txt').click();
    assert.equal(session.file, null); assert.equal(session.pending, null);
    buttons(session.listEl).find(button => textOf(button) === 'Rename').click();
    session.mutationInput.value = 'renamed.txt'; session.submitMutation();
    const rename = sent.at(-1);
    assert.deepEqual(rename, { t: 'rename', id: rename.id, path: '/home/alex/notes.txt', destination: '/home/alex/renamed.txt' });
    session.handleControl({ t: 'result', id: rename.id, op: 'rename' });
    assert.equal(session.pending.op, 'list');
    session.handleControl({ t: 'result', id: session.pending.id, op: 'list', entries: [{ name: 'renamed.txt', type: 'file', size: 860 }] });
    assert.equal(session.entries[session.selected].name, 'renamed.txt');
    assert.equal(session.mutation, null); assert.equal(session.state, 'ready');

    session.beginMutation('move');
    const form = session.mutationForm;
    session.browseMove('/denied');
    session.handleControl({ t: 'result', id: sent.at(-1).id, op: 'list', entries: [] });
    session.submitMutation();
    const move = sent.at(-1);
    session.handleControl({ t: 'error', id: move.id, code: 'denied', message: 'Permission denied' });
    assert.equal(session.state, 'ready'); assert.equal(session.mutationForm, form);
    assert.equal(session.mutation.draft, '/denied');
    assert.match(textOf(session.mutationError), /Move failed.*Permission denied/);
    assert.equal(sent.at(-1).t, 'list');
    session.handleControl({ t: 'error', id: session.pending.id, code: 'denied', message: 'Permission denied listing' });
    assert.equal(session.entries.length, 1); assert.match(session.footStatus.textContent, /Refresh failed/);
    session.handleControl({ t: 'error', id: move.id, message: 'late error' });
    assert.equal(session.state, 'ready', 'late operation errors must not close a session');
    session.clearMutation(); session.beginMutation('delete');
    session.mutationInput.value = 'wrong'; session.submitMutation();
    assert.equal(session.pending, null);
    session.mutationInput.value = 'renamed.txt'; session.submitMutation();
    const deletion = sent.at(-1);
    assert.equal(deletion.t, 'delete'); assert.equal(deletion.confirm, 'renamed.txt');
    assert.equal(session.mutation.busy, true);
    const transferCount = session.transfers.length;
    session.queueUploads([{ name: 'queued.txt', size: 1 }]);
    assert.equal(session.transfers.length, transferCount, 'uploads during a mutation must not become stranded');
    assert.match(session.transferNotice, /Wait for the file action/);
    session.handleControl({ t: 'closed', reason: 'Connection lost' });
    assert.equal(session.mutation, null); assert.equal(session.state, 'ended');
  } finally { globalThis.document = previousDocument; }
});

test('move folder browsing stays isolated, retains a destination on errors, and ignores cancelled responses', () => {
  const previousDocument = globalThis.document;
  globalThis.document = { createElement: tag => node(tag), activeElement: null };
  try {
    const session = new FileSession({ host });
    const sent = []; session.send = message => sent.push(message);
    listHome(session);
    session.selected = session.entries.findIndex(entry => entry.name === 'notes.txt');
    session.beginMutation('move');
    const originalEntries = session.entries;
    assert.equal(session.mutationInput, null, 'move uses only the selected destination, with no path input');
    assert.doesNotMatch(textOf(session.mutationForm), /Browse path|Enter a path instead/);
    const trigger = collect(session.movePickerEl).find(item => item.getAttribute?.('aria-haspopup') === 'listbox');
    const menu = collect(session.movePickerEl).find(item => item.getAttribute?.('role') === 'listbox');
    const options = collect(menu).filter(item => item.getAttribute?.('role') === 'option');
    trigger.click(); assert.equal(trigger.getAttribute('aria-expanded'), 'true');
    const key = key => ({ type: 'keydown', key, preventDefault() {}, stopPropagation() {} });
    menu.dispatchEvent(key('End'));
    assert.equal(options.at(-1).focused, true);
    menu.dispatchEvent(key('Escape'));
    assert.equal(trigger.getAttribute('aria-expanded'), 'false');
    assert.equal(menu.hidden, true);
    trigger.click(); options.at(-1).click();
    const listing = sent.at(-1);
    assert.equal(listing.t, 'list'); assert.equal(session.pending, null);
    session.submitMutation(); assert.equal(sent.at(-1), listing, 'cannot move while destination is loading');
    session.handleControl({ t: 'result', id: listing.id, op: 'list', entries: [{ name: 'nested', type: 'dir' }, { name: 'ignore.txt', type: 'file' }] });
    assert.equal(session.path, '/home/alex'); assert.equal(session.entries, originalEntries);
    assert.equal(session.mutation.draft, '/home/alex/Documents');
    assert.equal(textOf(session.mutationSubmit), 'Move here');
    assert.match(textOf(session.movePickerEl), /nested/);
    assert.doesNotMatch(textOf(session.movePickerEl), /ignore.txt/);
    session.browseMove('/denied');
    session.handleControl({ t: 'error', id: sent.at(-1).id, message: 'Permission denied' });
    assert.equal(session.mutation.picker.path, '/home/alex/Documents');
    assert.match(textOf(session.movePickerEl), /Cannot browse destination.*Permission denied/);
    session.submitMutation();
    assert.equal(sent.at(-1).destination, '/home/alex/Documents/notes.txt');
    session.clearMutation(); session.pending = null;
    session.beginMutation('move'); session.browseMove('/');
    const cancelled = sent.at(-1);
    session.clearMutation();
    session.handleControl({ t: 'result', id: cancelled.id, op: 'list', entries: [] });
    assert.equal(session.entries, originalEntries); assert.equal(session.mutation, null);
    session.selected = session.entries.findIndex(entry => entry.type === 'dir');
    session.beginMutation('move');
    session.browseMove(`${session.mutation.path}/nested`);
    assert.match(session.mutation.picker.error, /outside/);
    assert.equal(sent.at(-1), cancelled, 'must not browse inside the source directory');
  } finally { globalThis.document = previousDocument; }
});

test('explicit search shows metadata and reveals files or opens directories', () => {
  const previousDocument = globalThis.document;
  globalThis.document = { createElement: (tag) => node(tag), activeElement: null };
  try {
    const session = new FileSession({ host });
    const sent = [];
    session.send = (message) => sent.push(message);
    listHome(session);
    const listing = session.entries;
    session.searchInput.value = 'notes';
    assert.equal(sent.at(-1).t, 'list', 'typing alone sends no search');
    session.startSearch({ preventDefault() {} });
    assert.equal(sent.at(-1).t, 'search');
    assert.equal(sent.at(-1).path, '/home/alex');
    assert.equal(session.search.status, 'loading');
    const id = session.pending.id;
    session.handleControl({ t: 'result', id, op: 'search', entries: [
      { name: 'notes.txt', type: 'file', size: 860, mtime: Date.UTC(2026, 2, 12), path: '/srv/notes.txt' },
      { name: 'notes', type: 'dir', size: 0, mtime: 0, path: '/srv/notes' },
    ], skipped: 1, truncated: true });
    assert.equal(session.entries, listing, 'search does not replace the directory cache');
    assert.match(textOf(session.listEl), /860 B/);
    assert.match(textOf(session.listEl), /2026/);
    assert.match(textOf(session.listEl), /\/srv\/notes.txt/);
    assert.match(textOf(session.listEl), /limit reached/);
    assert.match(textOf(session.listEl), /1 folder could not be read/);
    const marks = collect(session.listEl).filter((item) => item.tagName === 'mark');
    assert.deepEqual(marks.map(textOf), ['notes', 'notes'], 'the matched part of each name is marked');
    assert.equal(session.uploadButton.disabled, true);
    buttons(session.listEl).find((button) => textOf(button).includes('notes.txt')).click();
    assert.equal(session.search, null);
    assert.equal(session.path, '/srv');
    assert.equal(sent.at(-1).t, 'list');
    session.handleControl({ t: 'result', id: session.pending.id, op: 'list', entries: [
      { name: 'another.txt', type: 'file' }, { name: 'notes.txt', type: 'file' },
    ] });
    assert.equal(session.entries[session.selected].name, 'notes.txt');
    assert.equal(session.file, null);
    session.searchInput.value = 'notes';
    session.startSearch();
    session.handleControl({ t: 'result', id: session.pending.id, op: 'search', entries: [
      { name: 'notes', type: 'dir', path: '/srv/notes' },
    ] });
    buttons(session.listEl)[0].click();
    assert.equal(session.path, '/srv/notes');
  } finally { globalThis.document = previousDocument; }
});

test('search cancellation, empty results, denied and disconnected states preserve the listing', () => {
  const previousDocument = globalThis.document;
  globalThis.document = { createElement: (tag) => node(tag), activeElement: null };
  try {
    const session = new FileSession({ host });
    const sent = [];
    session.send = (message) => sent.push(message);
    listHome(session);
    const listing = session.entries;
    session.searchInput.value = ' ';
    session.startSearch();
    assert.match(textOf(session.searchHint), /Enter part/);
    assert.equal(session.search, null);
    session.searchInput.value = 'missing';
    session.startSearch();
    let id = session.pending.id;
    assert.equal(session.searchInput.disabled, false, 'query stays editable during the walk');
    session.searchInput.value = '';
    session.searchInput.dispatchEvent({ type: 'input' });
    assert.deepEqual(sent.at(-1), { t: 'cancel', id });
    session.handleControl({ t: 'result', op: 'search', id, entries: [{ name: 'late', path: '/late' }] });
    assert.equal(session.search, null);
    assert.equal(session.entries, listing);
    session.searchInput.value = 'missing';
    session.startSearch();
    session.handleControl({ t: 'result', op: 'search', id: session.pending.id, entries: [] });
    assert.match(textOf(session.listEl), /No names match/);
    assert.match(textOf(session.listEl), /No match/);
    session.searchInput.value = '';
    session.searchInput.dispatchEvent({ type: 'input' });
    assert.equal(session.search, null);
    assert.equal(session.entries, listing);
    session.searchInput.value = 'secret';
    session.startSearch();
    session.handleControl({ t: 'error', id: session.pending.id, code: 'denied' });
    assert.match(textOf(session.listEl), /Permission denied/);
    assert.match(textOf(session.listEl), /Unauthorized/);
    session.clearSearch();
    assert.equal(session.entries, listing);
    session.searchInput.value = 'notes';
    session.startSearch();
    id = session.pending.id;
    session.handleControl({ t: 'closed', reason: 'The host disconnected.' });
    assert.equal(session.search.status, 'ended');
    assert.match(textOf(session.listEl), /Disconnected/);
    session.handleControl({ t: 'result', op: 'search', id, entries: [{ name: 'late', path: '/late' }] });
    assert.deepEqual(session.search.entries, []);
  } finally { globalThis.document = previousDocument; }
});

test('search progress displays live matches, preserves cancellation, and lets a hit stop the walk', () => {
  const previousDocument = globalThis.document;
  globalThis.document = { createElement: (tag) => node(tag), activeElement: null };
  try {
    const session = new FileSession({ host });
    const sent = [];
    session.send = (message) => sent.push(message);
    listHome(session);
    session.searchInput.value = 'notes';
    session.startSearch();
    const id = session.pending.id;
    session.handleControl({ t: 'search-progress', id, scanned: 4, entries: [
      { name: 'notes.txt', type: 'file', size: 860, path: '/home/alex/Documents/notes.txt' },
    ] });
    assert.equal(session.pending.id, id);
    assert.match(textOf(session.listEl), /4 folders searched/);
    assert.match(textOf(session.listEl), /notes.txt/);
    buttons(session.listEl)[0].click();
    assert.ok(sent.some((message) => message.t === 'cancel' && message.id === id));
    assert.equal(session.path, '/home/alex/Documents');
    session.handleControl({ t: 'search-progress', id, scanned: 10, entries: [] });
    assert.equal(session.search, null);
    assert.equal(session.pending.op, 'list');
  } finally { globalThis.document = previousDocument; }
});

test('an unresponsive or outdated server cannot leave search loading forever', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const previousDocument = globalThis.document;
  globalThis.document = { createElement: (tag) => node(tag), activeElement: null };
  try {
    const session = new FileSession({ host });
    const sent = [];
    session.send = (message) => sent.push(message);
    listHome(session);
    session.searchInput.value = 'notes';
    session.startSearch();
    const id = session.pending.id;
    t.mock.timers.tick(35_000);
    assert.equal(session.pending, null);
    assert.equal(session.search.status, 'error');
    assert.match(textOf(session.listEl), /Search stopped responding/);
    assert.ok(sent.some((m) => m.t === 'cancel' && m.id === id));
    session.handleControl({ t: 'result', id, op: 'search', entries: [] });
    assert.equal(session.search.status, 'error', 'a late reply does not overwrite the timeout');
    session.clearSearch();
    assert.equal(session.view, 'ready');
  } finally { globalThis.document = previousDocument; }
});

test('connect, host key, endpoint text, and textLines cover the remaining client paths', () => {
  const previousDocument = globalThis.document;
  globalThis.document = { createElement: (tag) => node(tag), activeElement: null, addEventListener() {}, removeEventListener() {} };
  try {
    assert.deepEqual(textLines('a\r\nb\r\n'), ['a', 'b']);
    assert.deepEqual(textLines('one line\n'), ['one line']);

    const customHost = { ...host, port: 2222 };
    assert.equal(new FileSession({ host: customHost }).endpoint, 'alex@192.168.1.20:2222');
    assert.equal(new FileSession({ host }).endpoint, 'alex@192.168.1.20');

    let lost = 0;
    let edited = 0;
    const wired = new FileSession({ host, onConnectionLost() { lost += 1; }, onEditHost() { edited += 1; } });
    wired.onConnectionError({ code: 'auth', message: 'Authentication failed.' });
    assert.equal(lost, 1);
    wired.everReady = true;
    wired.onConnectionError({ code: 'network', message: 'Lost the connection to the RemoteHub server.' });
    assert.match(textOf(wired.overlay), /Lost the connection/);

    wired.renderHostKeyPrompt({ fingerprint: 'AA:BB', keyType: 'ssh-ed25519' });
    const sent = [];
    wired.send = (message) => sent.push(message);
    buttons(wired.overlay).find((button) => textOf(button) === 'Trust and connect').click();
    assert.deepEqual(sent.at(-1), { t: 'hostkey', accept: true });
    wired.renderHostKeyPrompt({ fingerprint: 'CC:DD', keyType: 'ssh-ed25519' });
    buttons(wired.overlay).find((button) => textOf(button) === 'Cancel').click();
    assert.deepEqual(sent.at(-1), { t: 'hostkey', accept: false });

    wired.renderMismatch({ keyType: 'ssh-ed25519', fingerprint: 'RECEIVED', expected: { keyType: 'ssh-ed25519', fingerprint: 'TRUSTED' } });
    assert.match(textOf(wired.overlay), /TRUSTED/);
    assert.match(textOf(wired.overlay), /RECEIVED/);
    buttons(wired.overlay).find((button) => textOf(button) === 'Open computer settings').click();
    assert.equal(edited, 1);

    wired.renderProgress('Working…');
    buttons(wired.overlay).find((button) => textOf(button) === 'Cancel').click();
    assert.equal(wired.state, 'password');

    listHome(wired);
    wired.openPath('/home/alex');
    wired.handleControl({ t: 'error', id: wired.pending.id, code: 'sftp', message: 'List failed unexpectedly.' });
    assert.equal(wired.view, 'error');

    wired.openPath('/home/alex');
    wired.handleControl({ t: 'result', id: wired.pending.id, op: 'list', entries: [{ name: 'notes.txt', type: 'file', size: 1, mtime: 0 }] });
    openListedFile(wired, 'notes.txt');
    wired.handleControl({ t: 'error', id: wired.pending.id, code: 'sftp', message: 'Read failed.' });
    assert.equal(wired.file.status, 'error');
  } finally {
    globalThis.document = previousDocument;
  }
});

function withFilesDom(run) {
  const previousDocument = globalThis.document;
  globalThis.document = { createElement: (tag) => node(tag), activeElement: null };
  try {
    run();
  } finally {
    globalThis.document = previousDocument;
  }
}

function fakeSockets() {
  const sockets = [];
  const previousWebSocket = globalThis.WebSocket;
  const previousLocation = globalThis.location;
  globalThis.location = { protocol: 'http:', host: 'localhost:3000' };
  globalThis.WebSocket = class {
    constructor(url) {
      this.url = url;
      this.readyState = 1;
      this.binaryType = '';
      this.sent = [];
      sockets.push(this);
    }
    send(data) { this.sent.push(data); }
    close(code) { this.closeCode = code; this.readyState = 3; }
  };
  return {
    sockets,
    restore() {
      if (previousWebSocket === undefined) delete globalThis.WebSocket;
      else globalThis.WebSocket = previousWebSocket;
      if (previousLocation === undefined) delete globalThis.location;
      else globalThis.location = previousLocation;
    },
  };
}

function socketFrames(socket) {
  return socket.sent.filter((item) => typeof item === 'string').map((item) => JSON.parse(item));
}

function submitPassword(session, password) {
  const form = collect(session.overlay).find((item) => item.tagName === 'form');
  const input = collect(form).find((item) => item.getAttribute('type') === 'password');
  input.value = password;
  form.dispatchEvent({ type: 'submit', preventDefault() {} });
  return input;
}

function listKey(key, target = { tagName: 'BUTTON' }, extra = {}) {
  return { key, altKey: false, metaKey: false, ctrlKey: false, target, preventDefault() {}, ...extra };
}

function trackedSend(session) {
  const sent = [];
  session.send = (message) => sent.push(message);
  return sent;
}

function refreshedListing() {
  return [
    { name: 'Documents', type: 'dir', size: 4096, mtime: 0 },
    { name: 'link-out', type: 'symlink', size: 18, mtime: 0 },
    { name: 'readme.md', type: 'file', size: 1200, mtime: 0 },
  ];
}

test('hostActions with no capabilities object leaves Files disabled', () => {
  const files = hostActions({ id: 'nas', name: 'lab-nas' })[1];
  assert.equal(files.type, 'files');
  assert.equal(files.enabled, false);
  assert.equal(files.reason, 'Files aren’t available on this computer.');
});

test('a capabilities object with no files.sftp flag leaves Files disabled', () => {
  for (const capabilities of [{ terminal: { ssh: true } }, { files: {} }]) {
    const files = hostActions({ capabilities })[1];
    assert.equal(files.type, 'files');
    assert.equal(files.enabled, false);
    assert.equal(files.reason, 'Files aren’t available on this computer.');
  }
});

test('password submit connects and an empty submit stays on the prompt', () => {
  withFilesDom(() => {
    const net = fakeSockets();
    try {
      const session = new FileSession({ host });
      const empty = submitPassword(session, '');
      assert.equal(empty.focused, true);
      assert.equal(session.state, 'password');
      assert.equal(net.sockets.length, 0);

      const input = submitPassword(session, 'secret');
      assert.equal(input.value, '');
      assert.equal(session.state, 'connecting');
      assert.match(textOf(session.overlay), /Connecting to 192\.168\.1\.20…/);
      const socket = net.sockets[0];
      assert.equal(socket.url, 'ws://localhost:3000/ws/files');
      assert.equal(socket.binaryType, 'arraybuffer');
      socket.onopen();
      assert.deepEqual(socketFrames(socket)[0], { t: 'connect', hostId: 'nas', password: 'secret' });
      session.dispose();
    } finally {
      net.restore();
    }
  });
});

test('a connecting status keeps the login progress on screen', () => {
  withFilesDom(() => {
    const net = fakeSockets();
    try {
      const session = new FileSession({ host });
      submitPassword(session, 'secret');
      session.handleControl({ t: 'status', s: 'connecting' });
      assert.equal(session.state, 'connecting');
      assert.match(textOf(session.overlay), /Connecting to 192\.168\.1\.20…/);
      session.dispose();
    } finally {
      net.restore();
    }
  });
});

test('closing the socket before ready reports an expired login', () => {
  withFilesDom(() => {
    const net = fakeSockets();
    try {
      let lost = 0;
      const session = new FileSession({ host, onConnectionLost() { lost += 1; } });
      submitPassword(session, 'secret');
      net.sockets[0].onclose({ code: 1006 });
      assert.equal(lost, 1);
      assert.equal(session.state, 'password');
      assert.match(textOf(session.overlay), /Couldn't open a file connection\. Your RemoteHub login may have expired\./);
      session.dispose();
    } finally {
      net.restore();
    }
  });
});

test('closing after ready without a closed frame ends the session and reconnect starts again', () => {
  withFilesDom(() => {
    const net = fakeSockets();
    try {
      let lost = 0;
      const session = new FileSession({ host, onConnectionLost() { lost += 1; } });
      submitPassword(session, 'secret');
      const first = net.sockets[0];
      first.onopen();
      listHome(session);
      assert.equal(session.state, 'ready');
      first.onclose({ code: 1006 });
      assert.equal(lost, 0);
      assert.equal(session.state, 'ended');
      assert.match(textOf(session.overlay), /Lost the connection to the RemoteHub server\./);
      assert.match(textOf(session.listEl), /Lost the connection to the RemoteHub server\./);
      const submit = buttons(session.overlay).find((button) => button.getAttribute('type') === 'submit');
      assert.equal(textOf(submit), 'Reconnect');
      submitPassword(session, 'next');
      assert.equal(session.state, 'connecting');
      assert.equal(net.sockets.length, 2);
      const second = net.sockets[1];
      assert.equal(second.url, 'ws://localhost:3000/ws/files');
      second.onopen();
      assert.deepEqual(socketFrames(second)[0], { t: 'connect', hostId: 'nas', password: 'next' });
      session.dispose();
    } finally {
      net.restore();
    }
  });
});

test('close code 4001 leaves the files screen in place', () => {
  withFilesDom(() => {
    const net = fakeSockets();
    try {
      let lost = 0;
      const session = new FileSession({ host, onConnectionLost() { lost += 1; } });
      submitPassword(session, 'secret');
      const socket = net.sockets[0];
      socket.onopen();
      listHome(session);
      socket.onclose({ code: 4001 });
      assert.equal(lost, 0);
      assert.equal(session.state, 'ready');
      assert.equal(session.view, 'ready');
      assert.equal(session.overlay.hidden, true);
      assert.match(textOf(session.listEl), /notes\.txt/);
      assert.equal(session.ws, null);
      session.dispose();
    } finally {
      net.restore();
    }
  });
});

test('trusting a host key accepts it and cancelling rejects it', () => {
  withFilesDom(() => {
    const net = fakeSockets();
    try {
      const trust = new FileSession({ host });
      submitPassword(trust, 'secret');
      trust.handleControl({ t: 'hostkey', status: 'new', keyType: 'ssh-ed25519', fingerprint: 'SHA256:new' });
      assert.equal(trust.state, 'verify');
      assert.match(textOf(trust.overlay), /SHA256:new/);
      buttons(trust.overlay).find((button) => textOf(button) === 'Trust and connect').click();
      assert.deepEqual(socketFrames(net.sockets[0]).at(-1), { t: 'hostkey', accept: true });
      assert.match(textOf(trust.overlay), /Logging in as alex…/);

      const reject = new FileSession({ host });
      submitPassword(reject, 'secret');
      reject.handleControl({ t: 'hostkey', status: 'new', keyType: 'ssh-ed25519', fingerprint: 'SHA256:other' });
      buttons(reject.overlay).find((button) => textOf(button) === 'Cancel').click();
      assert.deepEqual(socketFrames(net.sockets[1]).at(-1), { t: 'hostkey', accept: false });
      assert.equal(reject.state, 'verify');
      assert.match(textOf(reject.overlay), /Check this computer’s ID/);
      trust.dispose();
      reject.dispose();
    } finally {
      net.restore();
    }
  });
});

test('a host key mismatch shows both fingerprints and opens host settings', () => {
  withFilesDom(() => {
    let edited = null;
    const session = new FileSession({ host, onEditHost(next) { edited = next; } });
    session.handleControl({
      t: 'hostkey',
      status: 'mismatch',
      keyType: 'ssh-ed25519',
      fingerprint: 'SHA256:received',
      expected: { keyType: 'ssh-rsa', fingerprint: 'SHA256:trusted' },
    });
    session.handleControl({ t: 'error', code: 'hostkey-mismatch', message: 'Host key changed.' });
    assert.equal(session.state, 'ended');
    assert.match(textOf(session.overlay), /SHA256:trusted/);
    assert.match(textOf(session.overlay), /SHA256:received/);
    // Plain labels (PR #26): "Saved ID" / "ID it sent now", no key-type jargon.
    assert.match(textOf(session.overlay), /Saved ID/);
    assert.match(textOf(session.overlay), /ID it sent now/);
    assert.doesNotMatch(textOf(session.overlay), /ssh-rsa|ssh-ed25519|fingerprint/);
    buttons(session.overlay).find((button) => textOf(button) === 'Open computer settings').click();
    assert.equal(edited, host);
    session.dispose();
  });
});

test('cancel on the progress overlay returns to the password prompt', () => {
  withFilesDom(() => {
    const net = fakeSockets();
    try {
      const session = new FileSession({ host });
      submitPassword(session, 'secret');
      assert.equal(session.state, 'connecting');
      buttons(session.overlay).find((button) => textOf(button) === 'Cancel').click();
      assert.equal(session.state, 'password');
      assert.match(textOf(session.overlay), /SSH password/);
      assert.equal(textOf(buttons(session.overlay).find((button) => button.getAttribute('type') === 'submit')), 'Connect');
      assert.equal(net.sockets[0].closeCode, 1000);
      session.dispose();
    } finally {
      net.restore();
    }
  });
});

test('a non-absolute realpath and an unexpected list error stay in the browser', () => {
  withFilesDom(() => {
    const session = new FileSession({ host });
    session.handleControl({ t: 'status', s: 'ready' });
    session.handleControl({ t: 'result', id: session.pending.id, op: 'realpath', path: 'notes.txt' });
    assert.equal(session.pending, null);
    assert.equal(session.view, 'error');
    assert.equal(session.path, '.');
    assert.match(textOf(session.listEl), /The computer did not return a folder/);

    session.openPath('/var/log');
    session.handleControl({ t: 'error', id: session.pending.id, code: 'io', message: 'Input/output error' });
    assert.equal(session.state, 'ready');
    assert.equal(session.view, 'error');
    assert.equal(session.path, '/var/log');
    assert.match(textOf(session.listEl), /Input\/output error/);
    session.dispose();
  });
});

test('arrow, home, and end move the selection, and fields, the dock, and modifiers do not', () => {
  withFilesDom(() => {
    const session = new FileSession({ host });
    trackedSend(session);
    listHome(session);
    const nameAt = () => session.entries[session.selected].name;
    session.onListKey(listKey('ArrowDown'));
    assert.equal(nameAt(), 'link-out');
    session.onListKey(listKey('ArrowUp'));
    assert.equal(nameAt(), 'Documents');
    session.onListKey(listKey('End'));
    assert.equal(nameAt(), 'readme.md');
    session.onListKey(listKey('Home'));
    assert.equal(nameAt(), 'Documents');
    session.onListKey(listKey('ArrowDown'));
    assert.equal(nameAt(), 'link-out');
    const dockTarget = { tagName: 'BUTTON', closest(selector) { return selector === '.dock' ? session.dockEl : null; } };
    session.onListKey(listKey('ArrowDown', { tagName: 'INPUT' }));
    session.onListKey(listKey('ArrowDown', dockTarget));
    session.onListKey(listKey('ArrowDown', { tagName: 'BUTTON' }, { altKey: true }));
    session.onListKey(listKey('ArrowDown', { tagName: 'BUTTON' }, { ctrlKey: true }));
    session.onListKey(listKey('ArrowDown', { tagName: 'BUTTON' }, { metaKey: true }));
    assert.equal(nameAt(), 'link-out');
    session.dispose();
  });
});

test('escape clears an inline mutation and the search field', () => {
  withFilesDom(() => {
    const session = new FileSession({ host });
    const sent = trackedSend(session);
    try {
      listHome(session);
      session.mkdirButton.click();
      assert.equal(session.mutation.action, 'mkdir');
      session.mutationForm.dispatchEvent({ type: 'keydown', key: 'Escape', preventDefault() {}, stopPropagation() {} });
      assert.equal(session.mutation, null);

      session.searchInput.value = 'notes';
      session.startSearch({ preventDefault() {} });
      const id = session.pending.id;
      session.searchInput.dispatchEvent({ type: 'keydown', key: 'Escape', preventDefault() {}, stopPropagation() {} });
      assert.equal(session.search, null);
      assert.deepEqual(sent.at(-1), { t: 'cancel', id });
    } finally {
      session.dispose();
    }
  });
});

test('an open file stays in the crumbs, the directory crumb closes it, and download uses that file', () => {
  withFilesDom(() => {
    const previousWindow = globalThis.window;
    globalThis.window = {};
    try {
      const session = new FileSession({ host });
      const sent = [];
      session.ws = { readyState: 1, send(data) { sent.push(data); } };
      listHome(session);
      openListedFile(session, 'notes.txt');
      session.handleControl({
        t: 'result',
        id: session.pending.id,
        op: 'read',
        text: 'alpha\r\nbeta\r\n',
        truncated: false,
        size: 12,
      });
      const lines = collect(session.readerEl).filter((item) => item.tagName === 'li').map(textOf);
      assert.deepEqual(lines, ['alpha', 'beta']);
      const current = collect(session.crumbsEl).find((item) => item.getAttribute('aria-current') === 'page');
      assert.equal(textOf(current), 'notes.txt');
      session.selected = session.entries.findIndex((entry) => entry.name === 'Documents');
      session.queueDownload();
      const got = jsonSent(sent).filter((message) => message.t === 'get');
      assert.equal(got.length, 1);
      assert.equal(got[0].path, '/home/alex/notes.txt');
      buttons(session.crumbsEl).find((button) => textOf(button) === 'alex').click();
      assert.equal(session.file, null);
      assert.equal(session.listEl.hidden, false);
      assert.equal(session.path, '/home/alex');
      session.dispose();
    } finally {
      globalThis.window = previousWindow;
    }
  });
});

test('a read error other than denied, missing, binary, or too large stays on the file', () => {
  withFilesDom(() => {
    const session = new FileSession({ host });
    listHome(session);
    openListedFile(session, 'notes.txt');
    session.handleControl({ t: 'error', id: session.pending.id, code: 'io', message: 'The read failed unexpectedly.' });
    assert.equal(session.state, 'ready');
    assert.equal(session.file.status, 'error');
    assert.equal(session.entries.length, 4);
    assert.match(textOf(session.readerEl), /^Files/); assert.doesNotMatch(textOf(session.readerEl), /SFTP/);
    assert.match(textOf(session.readerEl), /The read failed unexpectedly/);
    session.dispose();
  });
});

test('search rejects a slash, a control character, and a query over 255 characters', () => {
  withFilesDom(() => {
    const session = new FileSession({ host });
    const sent = trackedSend(session);
    try {
      listHome(session);
      for (const query of ['a/b', 'a\u0001b', 'n'.repeat(256)]) {
        session.searchInput.value = query;
        session.startSearch({ preventDefault() {} });
        assert.equal(session.search, null);
        assert.equal(session.searchHint.hidden, false);
        assert.equal(textOf(session.searchHint), 'Enter a name without slashes, up to 255 characters.');
      }
      assert.equal(sent.some((message) => message.t === 'search'), false);
    } finally {
      session.dispose();
    }
  });
});

test('a missing search shows not found and a timed-out walk keeps the matches found so far', () => {
  withFilesDom(() => {
    const session = new FileSession({ host });
    const sent = trackedSend(session);
    try {
      listHome(session);
      session.searchInput.value = 'notes';
      session.startSearch({ preventDefault() {} });
      session.handleControl({ t: 'error', id: session.pending.id, code: 'not-found', message: 'Missing directory.' });
      assert.equal(session.search.code, 'not-found');
      assert.equal(session.search.status, 'error');
      assert.match(textOf(session.listEl), /Not found/);
      assert.match(textOf(session.listEl), /Missing directory/);
      session.clearSearch();

      session.searchInput.value = 'notes';
      session.startSearch({ preventDefault() {} });
      session.handleControl({
        t: 'result',
        id: session.pending.id,
        op: 'search',
        entries: [{ name: 'notes.txt', type: 'file', size: 4, mtime: 0, path: '/home/alex/notes.txt' }],
        truncated: true,
        reason: 'timeout',
      });
      assert.match(textOf(session.listEl), /Time limit reached\. Showing matches found so far\./);
      assert.equal(sent.some((message) => message.t === 'search'), true);
    } finally {
      session.dispose();
    }
  });
});

test('the search cancel button stops the walk and transfers do not start', () => {
  withFilesDom(() => {
    const session = new FileSession({ host });
    const sent = trackedSend(session);
    try {
      listHome(session);
      session.searchInput.value = 'notes';
      session.startSearch({ preventDefault() {} });
      assert.equal(textOf(session.searchCancel), 'Cancel');
      session.selected = session.entries.findIndex((entry) => entry.name === 'notes.txt');
      session.queueUploads([fakeFile('during.txt', 'x')]);
      session.queueDownload();
      assert.equal(session.transfers.length, 0);
      assert.equal(sent.some((message) => message.t === 'put' || message.t === 'get'), false);
      const id = session.pending.id;
      session.searchCancel.click();
      assert.equal(session.search, null);
      assert.deepEqual(sent.at(-1), { t: 'cancel', id });
    } finally {
      session.dispose();
    }
  });
});

test('toolbar mkdir can be cancelled and a successful mkdir selects the new directory', () => {
  withFilesDom(() => {
    const session = new FileSession({ host });
    const sent = trackedSend(session);
    listHome(session);
    assert.equal(textOf(session.mkdirButton), '+ New folder');
    session.mkdirButton.click();
    assert.equal(session.mutation.action, 'mkdir');
    assert.ok(collect(session.listEl).includes(session.mutationForm));
    session.mutationCancel.click();
    assert.equal(session.mutation, null);

    session.mkdirButton.click();
    session.mutationInput.value = 'projects';
    session.mutationForm.dispatchEvent({ type: 'submit', preventDefault() {} });
    const mkdir = sent.at(-1);
    assert.equal(mkdir.t, 'mkdir');
    assert.equal(mkdir.path, '/home/alex/projects');
    session.handleControl({ t: 'result', id: mkdir.id, op: 'mkdir' });
    assert.equal(session.pending.op, 'list');
    assert.equal(session.pending.quiet, true);
    assert.equal(session.pending.path, '/home/alex');
    session.handleControl({
      t: 'result',
      id: session.pending.id,
      op: 'list',
      entries: [
        { name: 'notes.txt', type: 'file', size: 860, mtime: 0 },
        { name: 'Documents', type: 'dir', size: 4096, mtime: 0 },
        { name: 'projects', type: 'dir', size: 0, mtime: 0 },
      ],
    });
    assert.equal(session.mutation, null);
    assert.equal(session.entries[session.selected].name, 'projects');
    assert.equal(session.footStatus.textContent, 'Create folder complete. Folder refreshed.');
    session.dispose();
  });
});

test('move and delete refresh the current directory', () => {
  withFilesDom(() => {
    const session = new FileSession({ host });
    const sent = trackedSend(session);
    listHome(session);
    session.selected = session.entries.findIndex((entry) => entry.name === 'notes.txt');
    session.beginMutation('move');
    session.browseMove('/home/alex/Documents');
    const browse = sent.at(-1);
    session.handleControl({ t: 'result', id: browse.id, op: 'list', entries: [] });
    session.mutationForm.dispatchEvent({ type: 'submit', preventDefault() {} });
    const move = sent.at(-1);
    assert.equal(move.t, 'move');
    assert.equal(move.path, '/home/alex/notes.txt');
    assert.equal(move.destination, '/home/alex/Documents/notes.txt');
    session.handleControl({ t: 'result', id: move.id, op: 'move' });
    assert.equal(session.pending.op, 'list');
    assert.equal(session.pending.path, '/home/alex');
    session.handleControl({ t: 'result', id: session.pending.id, op: 'list', entries: refreshedListing() });
    assert.equal(session.mutation, null);
    assert.equal(session.entries.some((entry) => entry.name === 'notes.txt'), false);
    assert.equal(session.entries[session.selected].name, 'readme.md');
    assert.equal(session.footStatus.textContent, 'Move complete. Folder refreshed.');

    session.selected = session.entries.findIndex((entry) => entry.name === 'readme.md');
    session.beginMutation('delete');
    session.mutationInput.value = 'readme.md';
    session.mutationForm.dispatchEvent({ type: 'submit', preventDefault() {} });
    const deletion = sent.at(-1);
    assert.equal(deletion.t, 'delete');
    assert.equal(deletion.confirm, 'readme.md');
    session.handleControl({ t: 'result', id: deletion.id, op: 'delete' });
    const refresh = sent.at(-1);
    assert.equal(refresh.t, 'list');
    assert.equal(refresh.path, '/home/alex');
    session.handleControl({
      t: 'result',
      id: refresh.id,
      op: 'list',
      entries: [
        { name: 'Documents', type: 'dir', size: 4096, mtime: 0 },
        { name: 'link-out', type: 'symlink', size: 18, mtime: 0 },
      ],
    });
    assert.equal(session.mutation, null);
    assert.equal(session.entries[session.selected].name, 'Documents');
    assert.equal(session.footStatus.textContent, 'Delete complete. Folder refreshed.');
    session.dispose();
  });
});

test('an active transfer blocks a mutation, and empty names and a same-path move fail in the form', () => {
  withFilesDom(() => {
    const session = new FileSession({ host });
    const sent = trackedSend(session);
    listHome(session);
    session.mkdirButton.click();
    session.mutationInput.value = '';
    const beforeEmpty = sent.length;
    session.mutationForm.dispatchEvent({ type: 'submit', preventDefault() {} });
    assert.equal(sent.length, beforeEmpty);
    assert.equal(session.pending, null);
    assert.equal(textOf(session.mutationError), 'Create folder failed: Enter one name without slashes or control characters.');
    session.mutationCancel.click();

    session.selected = session.entries.findIndex((entry) => entry.name === 'notes.txt');
    session.beginMutation('rename');
    session.mutationInput.value = '   ';
    session.mutationForm.dispatchEvent({ type: 'submit', preventDefault() {} });
    assert.equal(session.pending, null);
    assert.equal(textOf(session.mutationError), 'Rename failed: Enter one name without slashes or control characters.');
    session.mutationCancel.click();

    session.beginMutation('move');
    assert.equal(session.mutationInput, null);
    const beforeMove = sent.length;
    session.mutationForm.dispatchEvent({ type: 'submit', preventDefault() {} });
    assert.equal(sent.length, beforeMove);
    assert.equal(session.pending, null);
    assert.equal(textOf(session.mutationError), 'Move failed: Choose a different name or folder.');
    session.dispose();

    const busy = new FileSession({ host });
    busy.ws = { readyState: 1, send() {} };
    listHome(busy);
    busy.queueUploads([fakeFile('busy.txt', 'x')]);
    assert.equal(busy.transfers[0].state, 'transferring');
    busy.mkdirButton.click();
    assert.equal(busy.mutation, null);
    assert.equal(busy.notice, 'Wait for transfers to finish before changing files.');
    busy.dispose();
  });
});

test('the move picker moves with the keyboard, chooses the current folder, and collapses when focus leaves', () => {
  withFilesDom(() => {
    const session = new FileSession({ host });
    const sent = trackedSend(session);
    listHome(session);
    const key = (name) => ({ type: 'keydown', key: name, preventDefault() {}, stopPropagation() {} });
    const openMove = () => {
      session.selected = session.entries.findIndex((entry) => entry.name === 'notes.txt');
      session.beginMutation('move');
      const trigger = collect(session.movePickerEl).find((item) => item.getAttribute('aria-haspopup') === 'listbox');
      const menu = collect(session.movePickerEl).find((item) => item.getAttribute('role') === 'listbox');
      const options = collect(menu).filter((item) => item.getAttribute('role') === 'option');
      trigger.click();
      return { trigger, menu, options };
    };

    const arrows = openMove();
    assert.equal(arrows.options.length, 3);
    arrows.menu.dispatchEvent(key('End'));
    arrows.menu.dispatchEvent(key('ArrowUp'));
    assert.equal(arrows.options.at(-2).focused, true);

    const home = openMove();
    home.menu.dispatchEvent(key('End'));
    home.menu.dispatchEvent(key('Home'));
    home.menu.dispatchEvent(key('ArrowDown'));
    assert.equal(home.options[1].focused, true);

    const picker = openMove();
    assert.match(textOf(picker.options[0]), /Current folder: \/home\/alex/);
    const control = collect(session.movePickerEl).find((item) => item.className === 'files-folder-control');
    control.dispatchEvent({ type: 'focusout', relatedTarget: picker.options[0] });
    assert.equal(picker.trigger.getAttribute('aria-expanded'), 'true');
    assert.equal(picker.menu.hidden, false);
    control.dispatchEvent({ type: 'focusout', relatedTarget: session.pane });
    assert.equal(picker.trigger.getAttribute('aria-expanded'), 'false');
    assert.equal(picker.menu.hidden, true);
    picker.trigger.click();
    picker.options[0].click();
    assert.equal(picker.menu.hidden, true);
    assert.equal(sent.at(-1).t, 'list');
    assert.equal(sent.at(-1).path, '/home/alex');
    session.dispose();
  });
});

test('uploads follow the file input and a dock drop, and ignore drag leave, an unready drop, an empty drop, and a name that cannot be joined', () => {
  withFilesDom(() => {
    const cold = new FileSession({ host });
    cold.listEl.dispatchEvent({
      type: 'drop',
      preventDefault() {},
      dataTransfer: { files: [fakeFile('early.txt', 'x')] },
    });
    assert.equal(cold.transfers.length, 0);
    assert.equal(cold.transferNotice, 'Open a folder before uploading. The folder listing was not changed.');
    cold.dispose();

    const session = new FileSession({ host });
    const sent = [];
    session.ws = { readyState: 1, send(data) { sent.push(data); } };
    listHome(session);
    session.listEl.dispatchEvent({ type: 'dragover', preventDefault() {}, dataTransfer: { dropEffect: '' } });
    assert.equal(session.listEl.classList.contains('is-drop'), true);
    session.listEl.dispatchEvent({ type: 'dragleave', relatedTarget: session.dropCaption });
    assert.equal(session.listEl.classList.contains('is-drop'), true);
    session.listEl.dispatchEvent({ type: 'dragleave', relatedTarget: null });
    assert.equal(session.listEl.classList.contains('is-drop'), false);

    session.listEl.dispatchEvent({ type: 'drop', preventDefault() {}, dataTransfer: { files: [] } });
    assert.equal(session.transfers.length, 0);
    assert.equal(session.transferNotice, 'No file in that drop. The folder listing was not changed.');

    session.listEl.dispatchEvent({ type: 'drop', preventDefault() {}, dataTransfer: { files: [fakeFile('..', 'no')] } });
    assert.equal(session.transfers.length, 0);
    assert.equal(session.transferNotice, 'Those files cannot be uploaded here. The folder listing was not changed.');
    assert.equal(session.path, '/home/alex');

    const target = { files: [fakeFile('picked.txt', 'hi')], value: 'C:\\fakepath\\picked.txt' };
    session.fileInput.dispatchEvent({ type: 'change', target });
    assert.equal(target.value, '');
    assert.equal(session.transfers.find((transfer) => transfer.name === 'picked.txt').state, 'transferring');
    assert.equal(jsonSent(sent).some((message) => message.t === 'put' && message.path === '/home/alex/picked.txt'), true);

    session.dockEl.dispatchEvent({ type: 'dragover', preventDefault() {}, dataTransfer: { dropEffect: '' } });
    assert.equal(session.dockEl.classList.contains('is-drop'), true);
    session.dockEl.dispatchEvent({
      type: 'drop',
      preventDefault() {},
      dataTransfer: { files: [fakeFile('docked.txt', 'z')] },
    });
    assert.equal(session.dockEl.classList.contains('is-drop'), false);
    assert.equal(session.transfers.find((transfer) => transfer.name === 'docked.txt').state, 'queued');
    assert.equal(session.path, '/home/alex');
    session.dispose();
  });
});

test('cancelling an in-flight upload sends cancel, and a file that cannot be sliced becomes an error', () => {
  withFilesDom(() => {
    const session = new FileSession({ host });
    const sent = [];
    session.ws = { readyState: 1, send(data) { sent.push(data); } };
    listHome(session);
    session.queueUploads([fakeFile('live.txt', 'hello'), fakeFile('next.txt', 'world')]);
    const live = session.transfers.find((transfer) => transfer.name === 'live.txt');
    assert.equal(live.state, 'transferring');
    buttons(session.findTransferRow(live.id)).find((button) => textOf(button) === 'Cancel').click();
    assert.equal(live.state, 'cancelled');
    assert.equal(jsonSent(sent).some((message) => message.t === 'cancel' && message.id === live.id), true);
    assert.equal(session.transfers.find((transfer) => transfer.name === 'next.txt').state, 'queued');

    const raw = new FileSession({ host });
    const rawSent = [];
    raw.ws = { readyState: 1, send(data) { rawSent.push(data); } };
    listHome(raw);
    raw.queueUploads([{ name: 'raw.bin', size: 4 }]);
    const put = jsonSent(rawSent).find((message) => message.t === 'put');
    const transfer = raw.transferById(put.id);
    assert.equal(transfer.state, 'transferring');
    raw.handleControl({ t: 'transfer', id: put.id, phase: 'start', kind: 'upload', size: 4, path: put.path });
    assert.equal(transfer.state, 'error');
    assert.equal(transfer.message, 'This browser could not read the file in chunks.');
    assert.equal(jsonSent(rawSent).some((message) => message.t === 'cancel' && message.id === put.id), true);
    assert.match(textOf(raw.dockList), /This browser could not read the file in chunks/);
    assert.equal(raw.path, '/home/alex');
    session.dispose();
    raw.dispose();
  });
});

test('a server cancelled phase marks the transfer cancelled and starts the next one', () => {
  withFilesDom(() => {
    const session = new FileSession({ host });
    const sent = [];
    session.ws = { readyState: 1, send(data) { sent.push(data); } };
    listHome(session);
    session.queueUploads([fakeFile('live.txt', 'hello'), fakeFile('next.txt', 'world')]);
    const live = session.transfers.find((transfer) => transfer.name === 'live.txt');
    const next = session.transfers.find((transfer) => transfer.name === 'next.txt');
    assert.equal(jsonSent(sent).filter((message) => message.t === 'put').length, 1);
    session.handleControl({ t: 'transfer', id: live.id, phase: 'cancelled', loaded: 1 });
    assert.equal(live.state, 'cancelled');
    assert.equal(live.loaded, 1);
    assert.match(textOf(session.dockList), /Cancelled/);
    assert.equal(next.state, 'transferring');
    assert.equal(jsonSent(sent).filter((message) => message.t === 'put').length, 2);
    session.dispose();
  });
});

test('polling does not send during a transfer, and ending the session marks those rows as errors', () => {
  withPollingSession(({ session, sent, timers }) => {
    assert.deepEqual(timers.delays(), [5_000]);
    session.queueUploads([fakeFile('live.txt', 'aa'), fakeFile('wait.txt', 'bb')]);
    assert.equal(session.transfers[0].state, 'transferring');
    assert.equal(session.transfers[1].state, 'queued');
    assert.deepEqual(timers.delays(), []);
    assert.equal(jsonSent(sent).some((message) => message.t === 'list'), false);
    session.handleControl({ t: 'closed', reason: 'The host disconnected.' });
    assert.deepEqual(session.transfers.map((transfer) => [transfer.state, transfer.message]), [
      ['error', 'The Files connection ended.'],
      ['error', 'The Files connection ended.'],
    ]);
    assert.match(textOf(session.dockList), /The Files connection ended/);
  });
});

test('endpoint text omits port 22 and shows any other port', () => {
  withFilesDom(() => {
    const session = new FileSession({ host });
    assert.equal(session.endpoint, 'alex@192.168.1.20');
    assert.equal(textOf(session.addressEl), 'alex@192.168.1.20');
    session.updateHost({ ...host, port: 2222 });
    assert.equal(session.addressEl.textContent, 'alex@192.168.1.20:2222');
    session.updateHost({ ...host, port: 22 });
    assert.equal(session.addressEl.textContent, 'alex@192.168.1.20');
    const other = new FileSession({ host: { ...host, port: 2022 } });
    assert.equal(textOf(other.addressEl), 'alex@192.168.1.20:2022');
    assert.match(textOf(other.overlay), /alex@192\.168\.1\.20:2022/);
    session.dispose();
    other.dispose();
  });
});
