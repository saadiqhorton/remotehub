import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { agentFeatures, agentStatus, hostActions, discoverAction, discoveryResultLines, confirmPrompt } from '../public/js/host-actions.js';

class Element {
  constructor(tag) {
    this.tagName = tag;
    this.attributes = {};
    this.children = [];
    this.listeners = {};
    this.parentNode = null;
    this.textContent = '';
    this.hidden = false;
    this.open = false;
    this.value = '';
    this.form = { reset() {} };
  }

  set className(value) { this.attributes.class = value; }
  get className() { return this.attributes.class || ''; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name] ?? null; }
  addEventListener(name, listener) { (this.listeners[name] ||= []).push(listener); }
  append(...children) {
    for (const child of children.flat()) {
      if (child == null || child === false) continue;
      if (typeof child !== 'object') {
        this.textContent += String(child);
        continue;
      }
      child.parentNode = this;
      this.children.push(child);
    }
  }
  replaceChildren(...children) {
    for (const child of this.children) child.parentNode = null;
    this.children = [];
    this.append(...children);
  }
  showModal() { this.open = true; }
  close() { this.open = false; }
  reset() {}
  get elements() { return this.formElements; }
  focus() { fixture.document.activeElement = this; }
  click() { for (const listener of this.listeners.click || []) listener({ target: this, preventDefault() {} }); }
  find(predicate) {
    if (predicate(this)) return this;
    for (const child of this.children) {
      const found = child.find(predicate);
      if (found) return found;
    }
    return null;
  }
}

const fixture = { document: null };

function makeFixture() {
  const body = new Element('body');
  const document = {
    body,
    activeElement: null,
    createElement: (tag) => new Element(tag),
    getElementById(id) {
      return body.find((node) => node.getAttribute('id') === id);
    },
    querySelectorAll(selector) {
      const className = selector.slice(1);
      const found = [];
      const visit = (node) => {
        if ((node.getAttribute('class') || '').split(/\s+/).includes(className)) found.push(node);
        for (const child of node.children) visit(child);
      };
      visit(body);
      return found;
    },
  };
  fixture.document = document;
  for (const id of [
    'tabs', 'host-list', 'empty-state', 'host-count', 'session-count', 'launcher-btn',
    'app-view', 'launcher-dialog', 'host-dialog', 'launcher-input', 'launcher-list',
    'boot', 'auth-view', 'setup-code-field', 'confirm-field', 'auth-title', 'auth-lede',
    'password-label', 'auth-password', 'auth-submit', 'auth-form', 'auth-error',
    'setup-code', 'workspace', 'focus-btn', 'stage',
  ]) {
    const node = new Element('div');
    node.setAttribute('id', id);
    body.append(node);
  }
  return document;
}

function buildAppHarness() {
  const document = makeFixture();
  const source = readFile(new URL('../public/js/app.js', import.meta.url), 'utf8');
  return source.then((code) => {
    code = code.replace(/^import .*;\r?\n/gm, '').replace(/\nboot\(\);\s*$/, '');
    code += `\nconst originalRenderHosts = renderHosts; renderHosts = () => {}; renderEmpty = () => {};\n` +
      `globalThis.app = { state, newSession, openHost, openSurface, activate, closeSession, render, showAuth, openLauncher, renderLauncher, launcherKeys, openHostDialog, saveHost, checkDesktopOptions, confirmDiscoveredDesktop, renderHosts: originalRenderHosts };`;
    const el = (tag, props = {}, ...children) => {
      const node = document.createElement(tag);
      for (const [key, value] of Object.entries(props)) {
        if (key === 'class') node.className = value;
        else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
        else if (value !== undefined && value !== null && value !== false) node.setAttribute(key, value === true ? '' : value);
      }
      node.append(...children);
      return node;
    };
    const context = {
      document,
      window: { confirm() { throw new Error('Unexpected browser confirm'); } },
      localStorage: { getItem: () => null, setItem() {} },
      api: async () => ({}),
      setUnauthorizedHandler() {},
      ICONS: {},
      svgIcon() {},
      el,
      hostActions,
      discoverAction,
      discoveryResultLines,
      confirmPrompt,
      agentStatus,
      agentFeatures,
      TerminalSurface: class {},
      FileSession: class {},
      DesktopSession: class {},
      console,
    };
    vm.runInNewContext(code, context, { filename: 'public/js/app.js' });
    return { app: context.app, document, context };
  });
}

function session(id, state = 'ready', surfaceType = 'terminal') {
  return {
    id,
    state,
    surfaceType,
    label: surfaceType === 'files' ? `NAS · Files` : `Host ${id}`,
    host: { id: `host-${id}` },
    endpoint: `user@host-${id}${id === 'custom' ? ':2222' : ''}`,
    disposed: 0,
    focused: 0,
    dispose() { this.disposed += 1; },
    show() { this.focus(); },
    hide() {},
    focus() { this.focused += 1; },
  };
}

function button(document, id) {
  return document.getElementById(id);
}

function textOf(node) {
  if (!node || typeof node !== 'object') return String(node ?? '');
  return String(node.textContent ?? '') + (node.children || []).map(textOf).join('');
}

test('capability actions, launcher and host editing remain usable', async () => {
  const { app, document, context } = await buildAppHarness();
  const host = { id: 'nas', name: 'NAS', address: 'nas.lan', username: 'sam', port: 22,
    capabilities: { terminal: { ssh: true }, files: { sftp: true }, desktop: { vnc: true } } };
  app.state.hosts = [host];
  app.renderHosts();
  const actions = document.querySelectorAll('.host-capability');
  assert.equal(actions.length, 3);
  assert.match(actions[0].getAttribute('aria-label'), /Terminal/);
  assert.match(actions[1].getAttribute('aria-label'), /Files/);
  assert.match(actions[2].getAttribute('aria-label'), /Desktop/);
  assert.equal(actions[0].getAttribute('disabled'), null);
  assert.equal(actions[1].getAttribute('disabled'), null);
  assert.match(actions[1].getAttribute('title'), /Open Files on NAS/);
  assert.match(actions[2].getAttribute('title'), /not set up for this computer/);
  assert.equal(actions[2].getAttribute('disabled'), '');
  // SAA-303: desktop settings + server Desktop on enables the Desktop action.
  app.state.hosts = [{ ...host, desktop: { protocol: 'vnc', port: 5901, username: null }, desktopServerEnabled: true }];
  app.renderHosts();
  assert.equal(document.querySelectorAll('.host-capability')[2].getAttribute('disabled'), null);
  app.state.hosts = [host];
  app.renderHosts();

  let opened = null;
  context.FileSession = class {
    constructor(options) {
      opened = options;
      this.id = 'files-open';
      this.surfaceType = 'files';
      this.host = options.host;
      this.label = `${options.host.name} · Files`;
      this.state = 'password';
      this.endpoint = 'sam@nas.lan';
    }
    mount() {}
    show() {}
    hide() {}
    focus() {}
    dispose() {}
    setTheme() {}
    updateHost(host) { this.host = host; this.label = `${host.name} · Files`; }
  };
  actions[1].click();
  assert.equal(opened.host.id, 'nas');
  assert.equal(typeof opened.onChange, 'function');
  assert.equal(app.state.sessions.at(-1).surfaceType, 'files');
  assert.equal(app.state.activeId, 'files-open');
  actions[1].click();
  assert.equal(app.state.sessions.length, 1);

  const form = document.createElement('form');
  form.formElements = Object.fromEntries(['name', 'address', 'port', 'username'].map((key) => [key, { value: '', focus() {} }]));
  form.setAttribute('id', 'host-form');
  document.body.append(form);
  // SAA-317: the agent install controls in the host dialog are reset on every open.
  for (const id of ['host-dialog-kicker', 'host-dialog-title', 'host-save-btn', 'delete-host-btn', 'host-fingerprint', 'host-fingerprint-value', 'host-error',
    'agent-install-password', 'agent-install-form', 'agent-install-trust', 'agent-install-submit', 'agent-install-error', 'agent-install-done', 'install-agent-btn']) {
    const node = document.createElement('div');
    node.setAttribute('id', id);
    document.body.append(node);
  }
  app.openHostDialog(host);
  assert.equal(form.elements.name.value, 'NAS');
  assert.equal(form.elements.address.value, 'nas.lan');
  const requests = [];
  context.api = async (path, options) => {
    requests.push({ path, options });
    if (path === '/api/hosts/nas') return { host: { ...host, name: 'Updated NAS' } };
    if (path === '/api/hosts') return { hosts: [{ ...host, name: 'Updated NAS' }] };
    throw new Error(`Unexpected request: ${path}`);
  };
  form.elements.name.value = 'Updated NAS';
  await app.saveHost({ preventDefault() {} });
  assert.equal(requests[0].options.method, 'PUT');
  assert.equal(requests[0].options.body.name, 'Updated NAS');
  assert.equal(app.state.hosts[0].capabilities.files.sftp, true);
  assert.equal(document.getElementById('host-dialog').open, false);

  app.openLauncher();
  assert.equal(document.getElementById('launcher-dialog').open, true);
  const option = document.getElementById('launcher-list').children[0].children[0];
  assert.equal(app.state.hosts[0].name, 'Updated NAS');
  assert.equal(option.getAttribute('role'), 'option');
  const existing = session('existing', 'password');
  existing.host = app.state.hosts[0];
  app.state.sessions.push(existing);
  app.launcherKeys({ key: 'Enter', preventDefault() {} });
  assert.equal(document.getElementById('launcher-dialog').open, false);
  assert.equal(app.state.activeId, existing.id);
});

test('workspace hosts terminal, files and desktop without changing terminal host actions', async () => {
  const { app, document, context } = await buildAppHarness();
  const host = { id: 'nas', name: 'NAS' };
  const calls = [];
  const makeSurface = (surfaceType) => class {
    constructor({ host: target }) {
      this.id = `${surfaceType}-${calls.length}`;
      this.surfaceType = surfaceType;
      this.host = target;
      this.label = target.name;
      this.state = surfaceType === 'terminal' ? 'ready' : 'unavailable';
      calls.push(`${surfaceType}:created`);
    }
    mount() { calls.push(`${this.surfaceType}:mount`); }
    show() { calls.push(`${this.surfaceType}:show`); }
    hide() { calls.push(`${this.surfaceType}:hide`); }
    dispose() { calls.push(`${this.surfaceType}:dispose`); }
    focus() {}
  };
  context.TerminalSurface = makeSurface('terminal');
  context.FileSession = makeSurface('files');
  context.DesktopSession = makeSurface('desktop');
  app.newSession(host);
  app.newSession(host, 'files');
  app.newSession(host, 'desktop');
  assert.equal(Array.from(app.state.sessions, (s) => s.surfaceType).join(','), 'terminal,files,desktop');
  assert.equal(app.state.activeId, app.state.sessions[2].id);
  assert.equal(document.getElementById('tabs').children.length, 3);
  assert.equal(document.getElementById('tabs').children.map((tab) => tab.getAttribute('data-surface-type')).join(','), 'terminal,files,desktop');
  app.openHost(host);
  assert.equal(app.state.activeId, app.state.sessions[0].id);
  assert.equal(app.state.sessions.length, 3);
  app.closeSession(app.state.sessions[1].id);
  assert.equal(app.state.sessions.length, 2);
  assert.ok(calls.includes('files:dispose'));
  assert.equal(document.getElementById('close-session-dialog'), null);
  assert.throws(() => app.newSession(host, 'unknown'), /Unknown session surface/);
});

test('cancel after tab rerender keeps the session and focuses its current close button', async () => {
  const { app, document } = await buildAppHarness();
  const target = session('one');
  app.state.sessions = [target];
  app.state.activeId = target.id;
  app.render();
  app.closeSession(target.id);
  assert.equal(target.disposed, 0);
  assert.equal(button(document, 'close-session-dialog').open, true);

  app.render();
  const currentButton = document.querySelectorAll('.tab-close')[0];
  button(document, 'keep-session-btn').click();
  assert.equal(target.disposed, 0);
  assert.equal(button(document, 'close-session-dialog').open, false);
  assert.equal(document.activeElement, currentButton);
});

test('confirm disconnects only the captured ready session once', async () => {
  const { app, document } = await buildAppHarness();
  const target = session('one');
  const other = session('two');
  app.state.sessions = [target, other];
  app.state.activeId = target.id;
  app.closeSession(target.id);
  button(document, 'disconnect-session-btn').click();
  button(document, 'disconnect-session-btn').click();

  assert.equal(target.disposed, 1);
  assert.equal(other.disposed, 0);
  assert.equal(other.focused, 1);
  assert.deepEqual(app.state.sessions.map(({ id }) => id), ['two']);
  assert.equal(button(document, 'close-session-dialog').open, false);
});

test('Escape cancellation prevents native dismissal and restores focus', async () => {
  const { app, document } = await buildAppHarness();
  const target = session('one');
  app.state.sessions = [target];
  app.state.activeId = target.id;
  app.render();
  app.closeSession(target.id);
  const opener = document.querySelectorAll('.tab-close')[0];
  let prevented = false;
  document.getElementById('close-session-dialog').listeners.cancel[0]({
    preventDefault() { prevented = true; },
  });

  assert.equal(prevented, true);
  assert.equal(target.disposed, 0);
  assert.equal(document.getElementById('close-session-dialog').open, false);
  assert.equal(document.activeElement, opener);
});

test('confirming an inactive session restores focus to the active terminal', async () => {
  const { app, document } = await buildAppHarness();
  const inactive = session('one');
  const active = session('two');
  app.state.sessions = [inactive, active];
  app.state.activeId = active.id;
  app.closeSession(inactive.id);
  button(document, 'disconnect-session-btn').click();

  assert.equal(inactive.disposed, 1);
  assert.equal(active.focused, 1);
});

test('confirming the last session restores focus to the launcher', async () => {
  const { app, document } = await buildAppHarness();
  const target = session('one');
  app.state.sessions = [target];
  app.state.activeId = target.id;
  app.closeSession(target.id);
  button(document, 'disconnect-session-btn').click();

  assert.equal(target.disposed, 1);
  assert.equal(document.activeElement, button(document, 'launcher-btn'));
});

test('ended and forced closes bypass confirmation', async () => {
  const { app, document } = await buildAppHarness();
  const ended = session('ended', 'ended');
  const forced = session('forced');
  app.state.sessions = [ended, forced];
  app.closeSession(ended.id);
  app.closeSession(forced.id, { force: true });

  assert.equal(ended.disposed, 1);
  assert.equal(forced.disposed, 1);
  assert.equal(button(document, 'close-session-dialog'), null);
});

test('ending the pending target dismisses the prompt after tabs rerender', async () => {
  const { app, document } = await buildAppHarness();
  const target = session('one');
  app.state.sessions = [target];
  app.state.activeId = target.id;
  app.closeSession(target.id);
  target.state = 'ended';
  app.render();

  assert.equal(button(document, 'close-session-dialog').open, false);
  assert.equal(target.disposed, 0);
  assert.equal(document.activeElement, document.querySelectorAll('.tab-close')[0]);
});

test('forced removal of a pending target restores focus to the active terminal', async () => {
  const { app, document } = await buildAppHarness();
  const target = session('one');
  const active = session('two');
  app.state.sessions = [target, active];
  app.state.activeId = active.id;
  app.closeSession(target.id);
  app.closeSession(target.id, { force: true });

  assert.equal(target.disposed, 1);
  assert.equal(button(document, 'close-session-dialog').open, false);
  assert.equal(active.focused, 1);
});

test('a ready Files tab closes without a disconnect dialog', async () => {
  const { app, document } = await buildAppHarness();
  const filesSession = session('files-one', 'ready', 'files');
  app.state.sessions = [filesSession];
  app.state.activeId = filesSession.id;
  app.closeSession(filesSession.id);
  assert.equal(filesSession.disposed, 1);
  assert.equal(button(document, 'close-session-dialog'), null);
});

test('hostActions without capabilities or files.sftp keeps Files disabled', async () => {
  const { app, context } = await buildAppHarness();
  const bare = { id: 'bare', name: 'Bare', address: 'bare.lan', username: 'u', port: 22 };
  const noFlag = { id: 'plain', name: 'Plain', address: 'plain.lan', username: 'u', port: 22, capabilities: { terminal: { ssh: true } } };
  const explicitOff = { id: 'off', name: 'Off', address: 'off.lan', username: 'u', port: 22, capabilities: { files: { sftp: false } } };
  assert.equal(hostActions(bare)[1].enabled, false);
  assert.equal(hostActions(noFlag)[1].enabled, false);
  assert.equal(hostActions(explicitOff)[1].enabled, false);
  let created = 0;
  context.FileSession = class { constructor() { created += 1; } mount() {} show() {} hide() {} focus() {} dispose() {} setTheme() {} updateHost() {} };
  app.openSurface(bare, 'files');
  app.openSurface(noFlag, 'files');
  app.openSurface(explicitOff, 'files');
  assert.equal(created, 0);
  assert.equal(app.state.sessions.length, 0);
});

test('the host rail dot ignores Files sessions and two Files tabs get numeric suffixes', async () => {
  const { app, document, context } = await buildAppHarness();
  const host = { id: 'nas', name: 'NAS', address: 'nas.lan', username: 'sam', port: 22, capabilities: { terminal: { ssh: true }, files: { sftp: true } } };
  app.state.hosts = [host];
  let n = 0;
  context.FileSession = class {
    constructor({ host: h }) {
      this.id = `files-${++n}`;
      this.surfaceType = 'files';
      this.host = h;
      this.label = `${h.name} · Files`;
      this.state = 'ready';
      this.endpoint = 'sam@nas.lan';
    }
    mount() {} show() {} hide() {} focus() {} dispose() {} setTheme() {} updateHost() {}
  };
  app.newSession(host, 'files');
  app.newSession(host, 'files');
  app.renderHosts();
  const hostRow = document.querySelectorAll('.host-main')[0];
  assert.ok(hostRow);
  const dot = hostRow.children[0];
  assert.equal(dot.getAttribute('data-state'), 'idle');
  const labels = document.getElementById('tabs').children.map((tab) => textOf(tab));
  assert.deepEqual(labels, ['NAS · Files×', 'NAS · Files 2×']);

  const terminal = session('term');
  terminal.host = host;
  app.state.sessions.push(terminal);
  app.renderHosts();
  assert.equal(document.querySelectorAll('.host-main')[0].children[0].getAttribute('data-state'), 'ready');
});

test('the host rail distinguishes connected and disconnected agents', async () => {
  const { app, document } = await buildAppHarness();
  app.state.hosts = [
    { id: 'none', name: 'Bare', address: 'a.lan', username: 'sam', port: 22, agent: { registered: false, connected: false } },
    { id: 'down', name: 'Down', address: 'b.lan', username: 'sam', port: 22, agent: { registered: true, connected: false } },
    { id: 'up', name: 'Up', address: 'c.lan', username: 'sam', port: 22, agent: { registered: true, connected: true } },
  ];
  app.renderHosts();
  const labels = [...document.querySelectorAll('.host-agent')].map((node) => `${node.getAttribute('data-agent')}:${textOf(node)}`);
  assert.deepEqual(labels, ['disconnected:Agent · Not connected right now', 'connected:Agent · Connected']);
  assert.equal(agentStatus(app.state.hosts[0]).label, 'Not set up on this computer');
});

test('the host rail shows live agent details and temporary helpers (SAA-300)', async () => {
  const { app, document } = await buildAppHarness();
  app.state.hosts = [
    { id: 'p', name: 'P', address: 'a.lan', username: 'sam', port: 22, agent: { registered: true, connected: true }, liveAgent: { connected: true, source: 'registered', mode: 'persistent', version: '0.1.0', os: 'linux', arch: 'x86_64' }, effectiveCapabilities: { terminal: { ssh: true }, files: { sftp: true, watch: true } }, capabilityProvenance: { 'files.watch': 'agent' } },
    { id: 't', name: 'T', address: 'b.lan', username: 'sam', port: 22, agent: { registered: false, connected: false }, liveAgent: { connected: true, source: 'helper', mode: 'temporary', version: '0.1.0', os: 'linux', arch: 'aarch64' } },
  ];
  app.renderHosts();
  const labels = [...document.querySelectorAll('.host-agent')].map((node) => textOf(node));
  assert.deepEqual(labels, ['Agent · Connected · persistent · v0.1.0 · linux/x86_64', 'Agent · Connected · temporary · temporary connection · v0.1.0 · linux/aarch64']);
});

test('saving a host calls updateHost on the open files session', async () => {
  const { app, document, context } = await buildAppHarness();
  const host = { id: 'nas', name: 'NAS', address: 'nas.lan', username: 'sam', port: 22 };
  const files = session('files', 'ready', 'files');
  files.host = host;
  const updates = [];
  files.updateHost = (next) => {
    updates.push(next);
    files.host = next;
  };
  app.state.sessions = [files];
  app.state.editingHost = host;
  const form = document.createElement('form');
  form.formElements = Object.fromEntries(['name', 'address', 'port', 'username'].map((key) => [key, { value: host[key] }]));
  form.setAttribute('id', 'host-form');
  document.body.append(form);
  const save = document.createElement('button');
  save.setAttribute('id', 'host-save-btn');
  document.body.append(save);
  const saved = { ...host, name: 'Updated NAS' };
  context.api = async (path, options) => {
    if (path === '/api/hosts/nas' && options.method === 'PUT') return { host: saved };
    if (path === '/api/hosts') return { hosts: [{ ...saved }] };
    throw new Error(`Unexpected request: ${path}`);
  };

  form.elements.name.value = 'Updated NAS';
  await app.saveHost({ preventDefault() {} });

  assert.equal(updates.length, 1);
  assert.equal(updates[0], saved);
  assert.equal(files.host.name, 'Updated NAS');
});

test('auth teardown closes a pending prompt without restoring app focus', async () => {
  const { app, document } = await buildAppHarness();
  const target = session('one');
  app.state.sessions = [target];
  app.state.activeId = target.id;
  app.closeSession(target.id);
  const expectedAuthInput = button(document, 'auth-password');
  app.showAuth(false);

  assert.equal(button(document, 'close-session-dialog').open, false);
  assert.equal(app.state.sessions.length, 0);
  assert.equal(document.activeElement, expectedAuthInput);
});

// SAA-306: owner-only "Check desktop options" host action.
test('Check desktop options: owner-only, shown while Desktop is disabled, results enable Desktop via capabilities', async () => {
  const { app, document, context } = await buildAppHarness();
  const host = { id: 'pc', name: 'PC', address: 'pc.lan', username: 'sam', port: 22, desktopServerEnabled: true,
    capabilities: { terminal: { ssh: true }, files: { sftp: true }, desktop: {} } };
  app.state.hosts = [host];
  app.state.owner = false;
  app.renderHosts();
  assert.equal(document.querySelectorAll('.host-discover-btn').length, 0, 'not shown without an owner session');
  const calls = [];
  context.api = async (path, opts) => { calls.push([path, opts?.method]); throw new Error('must not be called'); };
  await app.checkDesktopOptions(host);
  assert.equal(calls.length, 0, 'non-owner cannot trigger discovery');

  app.state.owner = true;
  app.renderHosts();
  const btn = document.querySelectorAll('.host-discover-btn');
  assert.equal(btn.length, 1, 'shown for the owner');
  assert.equal(btn[0].getAttribute('disabled'), null);
  assert.equal(document.querySelectorAll('.host-capability')[2].getAttribute('disabled'), '', 'Desktop still disabled (unconfigured)');

  const discovered = { ...host,
    effectiveCapabilities: { terminal: { ssh: true }, files: { sftp: true }, desktop: { rdp: true } },
    capabilityProvenance: { 'desktop.rdp': 'discovery' },
    desktop: null, desktopPreference: 'auto',
    desktopDiscovery: { rdp: { available: true, port: 3389 }, vnc: { available: false } },
    desktopBackends: [{ backend: 'rdp', available: true, selectable: true, source: 'probe', reason: '' },
      { backend: 'vnc', available: false, selectable: false, source: 'probe', reason: 'Nothing answered on port 5900. Check that the remote computer is on and VNC remote desktop is turned on.' },
      { backend: 'nativeStream', available: false, selectable: false, source: 'agent', reason: 'Needs the RemoteHub agent.' }] };
  context.api = async (path, opts) => { calls.push([path, opts?.method, opts?.body]); return { host: discovered }; };
  await app.checkDesktopOptions(app.state.hosts[0]);
  assert.deepEqual(calls[0].slice(0, 2), ['/api/hosts/pc/desktop/discover', 'POST']);
  assert.equal(calls[0][2], undefined, 'no body: no credentials sent');
  app.renderHosts();
  const results = textOf(document.querySelectorAll('.host-discover-results')[0]);
  assert.match(results, /RDP: available/);
  assert.match(results, /VNC: Nothing answered on port 5900\. Check that the remote computer is on and VNC remote desktop is turned on\./);
  assert.match(results, /Desktop can now open with RDP/);
  const desktopBtn = document.querySelectorAll('.host-capability')[2];
  assert.equal(desktopBtn.getAttribute('disabled'), null, 'Desktop enabled via the capability path');
  assert.equal(app.state.hosts[0].desktopServerEnabled, true, 'local server flags kept');

  // Opening Desktop on a discovered (unconfigured) host saves settings from the preference first.
  context.api = async (path, opts) => { calls.push([path, opts?.method, opts?.body]); return { host: { ...discovered, desktop: { protocol: 'rdp', port: 3389, username: null } } }; };
  let opened = null;
  context.DesktopSession = class { constructor(o) { opened = o; this.id = 'd1'; this.surfaceType = 'desktop'; this.host = o.host; this.label = 'PC · Desktop'; } mount() {} show() {} hide() {} focus() {} dispose() {} };
  await app.openSurface(app.state.hosts[0], 'desktop');
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(JSON.stringify(calls.at(-1)), JSON.stringify(['/api/hosts/pc/desktop', 'PUT', { preference: 'auto' }]));
  assert.equal(opened?.host.desktop.protocol, 'rdp');
});

test('Check desktop options shows 429 Retry-After and errors', async () => {
  const { app, document, context } = await buildAppHarness();
  const host = { id: 'pc', name: 'PC', address: 'pc.lan', username: 'sam', port: 22, capabilities: { terminal: { ssh: true }, desktop: {} } };
  app.state.hosts = [host];
  app.state.owner = true;
  context.api = async () => { const e = new Error('Desktop discovery ran moments ago; try again shortly.'); e.status = 429; e.retryAfterSeconds = 7; throw e; };
  await app.checkDesktopOptions(host);
  app.renderHosts();
  assert.match(textOf(document.querySelectorAll('.host-discover-results')[0]), /Try again in 7 s/);
  assert.equal(document.querySelectorAll('.host-discover-btn')[0].getAttribute('disabled'), null, 'usable again after the error');
  // Logging out clears owner-only state and removes the host list (and its buttons) from the DOM.
  app.showAuth(false);
  assert.equal(app.state.owner, false);
  assert.equal(document.querySelectorAll('.host-discover-btn').length, 0, 'button gone from the DOM after logout');
  assert.equal(app.state.hosts.length, 0);
});

// Review ruling: a backend found only on an unsaved port -> the first click shows the exact
// address:port and saves only after the owner confirms it.
test('first click on an unsaved discovered port asks to confirm the exact address:port, then PUTs that confirmation', async () => {
  const { app, document, context } = await buildAppHarness();
  const host = { id: 'pc', name: 'PC', address: '127.0.0.1', username: 'sam', port: 22, desktopServerEnabled: true, desktop: null, desktopPreference: 'auto',
    capabilities: { terminal: { ssh: true }, desktop: {} },
    effectiveCapabilities: { terminal: { ssh: true }, desktop: { vnc: true } },
    desktopDiscovery: { rdp: { available: false }, vnc: { available: true, port: 15901 } },
    desktopBackends: [{ backend: 'rdp', available: false, selectable: false, reason: 'down' },
      { backend: 'vnc', available: true, selectable: true, unconfirmed: true, port: 15901, source: 'probe', note: 'found; you’ll be asked to confirm before first use', reason: '' },
      { backend: 'nativeStream', available: false, selectable: false, reason: 'Needs the RemoteHub agent.' }] };
  app.state.hosts = [host];
  app.state.owner = true;
  const calls = [];
  context.api = async (path, opts) => { calls.push([path, opts?.method, JSON.stringify(opts?.body)]); return { host: { ...host, desktop: { protocol: 'vnc', port: 15901 } } }; };
  let opened = null;
  context.DesktopSession = class { constructor(o) { opened = o; this.id = 'd1'; this.surfaceType = 'desktop'; this.host = o.host; this.label = 'PC · Desktop'; } mount() {} show() {} hide() {} focus() {} dispose() {} };
  app.renderHosts();
  assert.equal(document.querySelectorAll('.host-capability')[2].getAttribute('disabled'), null, 'Desktop enabled (found)');
  await app.openSurface(host, 'desktop');
  assert.equal(calls.length, 0, 'nothing saved before confirmation');
  assert.equal(opened, null);
  app.renderHosts();
  const prompt = textOf(document.querySelectorAll('.host-discover-confirm')[0]);
  assert.match(prompt, /Use VNC at 127\.0\.0\.1:15901\? RemoteHub found it in a place you haven't used for this computer before/);
  assert.match(prompt, /Confirm 127\.0\.0\.1:15901 and open/);
  // Cancel keeps nothing.
  for (const fn of document.querySelectorAll('.host-discover-cancel-btn')[0].listeners.click) fn({});
  app.renderHosts(); // (the harness stubs the app's internal re-render)
  assert.equal(document.querySelectorAll('.host-discover-confirm').length, 0);
  assert.equal(calls.length, 0);
  await app.openSurface(host, 'desktop');
  app.renderHosts();
  await app.confirmDiscoveredDesktop(host);
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(calls[0], ['/api/hosts/pc/desktop', 'PUT', JSON.stringify({ preference: 'auto', confirm: { protocol: 'vnc', address: '127.0.0.1', port: 15901 } })]);
  assert.equal(opened?.host.desktop.port, 15901, 'opened after the confirmed save');
});

// Review (ui-07): after the first-click save the card no longer says "not saved; confirm on first use".
test('after the confirmed first-click save the host card is refreshed from the saved host', async () => {
  const { app, document, context } = await buildAppHarness();
  const backends = (unconfirmed) => [{ backend: 'rdp', available: false, selectable: false, reason: 'down' },
    { backend: 'vnc', available: true, selectable: true, unconfirmed, port: 15901, source: 'probe', note: unconfirmed ? 'found; you’ll be asked to confirm before first use' : '', reason: '' },
    { backend: 'nativeStream', available: false, selectable: false, reason: 'Needs the RemoteHub agent.' }];
  const host = { id: 'pc', name: 'PC', address: '127.0.0.1', username: 'sam', port: 22, desktopServerEnabled: true, desktop: null, desktopPreference: 'auto',
    capabilities: { terminal: { ssh: true }, desktop: {} }, effectiveCapabilities: { terminal: { ssh: true }, desktop: { vnc: true } },
    desktopDiscovery: { rdp: { available: false }, vnc: { available: true, port: 15901 } }, desktopBackends: backends(true) };
  app.state.hosts = [host];
  app.state.owner = true;
  app.state.discovery.pc = { busy: false, lines: discoveryResultLines(host) };
  context.api = async () => ({ host: { ...host, desktop: { protocol: 'vnc', port: 15901 }, effectiveCapabilities: { terminal: { ssh: true }, desktop: { vnc: true } }, desktopBackends: backends(false) } });
  context.DesktopSession = class { constructor(o) { this.id = 'd1'; this.surfaceType = 'desktop'; this.host = o.host; this.label = 'PC · Desktop'; } mount() {} show() {} hide() {} focus() {} dispose() {} };
  app.renderHosts();
  assert.match(textOf(document.querySelectorAll('.host-discover-results')[0]), /you’ll be asked to confirm before first use/);
  await app.openSurface(host, 'desktop');
  await app.confirmDiscoveredDesktop(host);
  await new Promise((r) => setTimeout(r, 0));
  app.renderHosts();
  const card = textOf(document.querySelectorAll('.host-discover-results')[0]);
  assert.doesNotMatch(card, /not saved|confirm/);
  assert.match(card, /VNC: available/);
  assert.match(card, /Desktop can now open with VNC\./);
});

test('review (7): "Set up agent" in the Desktop help opens the host dialog (agent / temporary helper path)', async () => {
  const { app, context } = await buildAppHarness();
  const host = { id: 'pc', name: 'PC', address: 'pc.lan', username: 'sam', port: 22, desktopServerEnabled: true,
    desktop: { protocol: 'vnc', port: 5901 }, capabilities: { terminal: { ssh: true }, desktop: { vnc: true } } };
  app.state.hosts = [host];
  let options = null;
  context.DesktopSession = class { constructor(o) { options = o; this.id = 'd1'; this.surfaceType = 'desktop'; this.host = o.host; this.label = 'PC · Desktop'; } mount() {} show() {} hide() {} focus() {} dispose() {} };
  app.newSession(host, 'desktop');
  assert.equal(typeof options.onSetUpAgent, 'function', 'wired');
  try { options.onSetUpAgent(host); } catch { /* the fixture lacks some dialog nodes; state is set first */ }
  const dialogFor = app.state.editingHost;
  assert.equal(dialogFor?.id, 'pc', 'host dialog opened for this host (agent registration + temporary helper live there)');
});
