import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { agentFeatures, agentStatus, hostActions } from '../public/js/host-actions.js';

class Element {
  constructor(tag) {
    this.tagName = tag;
    this.attributes = {};
    this.children = [];
    this.listeners = {};
    this.parentNode = null;
    this._text = '';
    this.hidden = false;
    this.disabled = false;
    this.open = false;
    this.value = '';
    this.form = { reset() {} };
    this.classList = { toggle() {} };
  }
  set textContent(value) { this._text = String(value); this.children = []; }
  get textContent() { return this._text + this.children.map((child) => child.textContent ?? '').join(''); }
  set className(value) { this.attributes.class = value; }
  get className() { return this.attributes.class || ''; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name] ?? null; }
  addEventListener(name, listener) { (this.listeners[name] ||= []).push(listener); }
  append(...children) {
    for (const child of children.flat()) {
      const node = typeof child === 'string' ? new TextNode(child) : child;
      if (!node || typeof node !== 'object') continue;
      node.parentNode = this;
      this.children.push(node);
    }
  }
  replaceChildren(...children) { this.children = []; this._text = ''; this.append(...children); }
  showModal() { this.open = true; }
  close() { this.open = false; }
  reset() {}
  focus() { fixture.document.activeElement = this; }
  click() { for (const listener of this.listeners.click || []) listener({ target: this, preventDefault() {} }); }
  find(predicate) {
    if (predicate(this)) return this;
    for (const child of this.children) { const found = child.find?.(predicate); if (found) return found; }
    return null;
  }
  querySelectorAll(selector) {
    const cls = selector.slice(1);
    const found = [];
    const visit = (node) => { if ((node.getAttribute?.('class') || '').split(/\s+/).includes(cls)) found.push(node); for (const child of node.children || []) visit(child); };
    visit(this); return found;
  }
}
class TextNode { constructor(text) { this._text = text; this.children = []; } get textContent() { return this._text; } find() { return null; } }
const fixture = { document: null };

function makeDocument() {
  const body = new Element('body');
  const doc = {
    body, activeElement: null,
    createElement: (tag) => new Element(tag),
    getElementById(id) { return body.find((node) => node.getAttribute?.('id') === id); },
    querySelectorAll(selector) { return body.querySelectorAll(selector); },
  };
  fixture.document = doc;
  const ids = ['logout-btn','boot','app-view','auth-view','setup-code-field','confirm-field','auth-title','auth-lede','password-label','auth-password','auth-submit','auth-form','auth-error','setup-code','tabs','host-list','empty-state','host-count','session-count','launcher-btn','launcher-dialog','host-dialog','launcher-input','launcher-list','workspace','focus-btn'];
  for (const id of ids) { const node = new Element('div'); node.setAttribute('id', id); body.append(node); }
  return doc;
}

async function harness(apiImpl = async () => ({})) {
  const document = makeDocument();
  let code = await readFile(new URL('../public/js/app.js', import.meta.url), 'utf8');
  code = code.replace(/^import .*;\r?\n/gm, '').replace(/\nboot\(\);\s*$/, '');
  code += '\nglobalThis.app = { state, logout, confirmLogout, openLogoutDialog, refreshLogoutDialog, render, showAuth, openLauncher };';
  const el = (tag, props = {}, ...children) => {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
      if (key === 'class') node.className = value;
      else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
      else if (value !== undefined && value !== null && value !== false) node.setAttribute(key, value === true ? '' : value);
    }
    node.append(...children); return node;
  };
  const context = { document, window: { addEventListener() {} }, localStorage: { getItem: () => null, setItem() {} }, api: apiImpl, setUnauthorizedHandler() {}, ICONS: {}, svgIcon() {}, el, hostActions, agentStatus, agentFeatures, TerminalSurface: class {}, FileSession: class {}, DesktopSession: class {}, console };
  vm.runInNewContext(code, context, { filename: 'public/js/app.js' });
  context.renderHosts = () => {}; context.renderTabs = () => {}; context.renderEmpty = () => {};
  return { app: context.app, document };
}
function session(id, status = 'ready', endpoint = `user@${id}.lan`, surfaceType = 'terminal') {
  return {
    id,
    state: status,
    surfaceType,
    label: surfaceType === 'files' ? 'NAS · Files' : `<${id}>`,
    endpoint,
    host: { id },
    disposed: 0,
    dispose() { this.disposed += 1; },
  };
}

test('logout warning counts a ready Files session without calling it a terminal session', async () => {
  const { app, document } = await harness();
  const files = session('files', 'ready', 'sam@nas.lan', 'files');
  app.state.sessions = [files];
  await app.logout();
  const consequence = document.getElementById('logout-consequence').textContent;
  assert.equal(document.getElementById('logout-dialog').open, true);
  assert.match(consequence, /closes 1 session/);
  assert.doesNotMatch(consequence, /terminal/);
  assert.match(document.getElementById('logout-session-list').textContent, /NAS · Files/);
  assert.match(document.getElementById('logout-session-list').textContent, /sam@nas\.lan/);
  assert.equal(files.disposed, 0);
});

test('warning lists every open session as text and refreshes without moving focus', async () => {
  const { app, document } = await harness();
  app.state.sessions = [session('one', 'ready', 'sam@nas.lan:2222'), session('two', 'connecting', 'sam@pi.lan:2200'), session('three', 'ended')];
  await app.logout();
  const cancel = document.getElementById('logout-cancel-btn');
  assert.equal(document.activeElement, cancel);
  const list = document.getElementById('logout-session-list');
  assert.match(list.textContent, /<one>/);
  assert.match(list.textContent, /sam@nas\.lan:2222/);
  assert.match(list.textContent, /sam@pi\.lan:2200/);
  assert.match(document.getElementById('logout-consequence').textContent, /closes 3 terminal sessions/);
  app.state.sessions.push(session('four', 'verify'));
  app.render();
  assert.equal(document.activeElement, cancel);
  assert.equal(list.children.length, 4);
  assert.match(list.textContent, /user@four\.lan/);
  assert.equal(list.children[2].children[0].children[0].getAttribute('data-state'), 'idle');
});

test('cancel and Escape leave sessions intact and restore the logout trigger', async () => {
  const { app, document } = await harness();
  const target = session('one'); app.state.sessions = [target];
  app.openLogoutDialog();
  document.getElementById('logout-cancel-btn').click();
  assert.equal(document.getElementById('logout-dialog').open, false);
  assert.equal(document.activeElement, document.getElementById('logout-btn'));
  assert.equal(target.disposed, 0);
  app.openLogoutDialog();
  let prevented = false;
  document.getElementById('logout-dialog').listeners.cancel[0]({ preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(document.activeElement, document.getElementById('logout-btn'));
  assert.equal(target.disposed, 0);
});

test('confirm sends one logout request and auth teardown disposes all sessions without restoring app focus', async () => {
  let resolveRequest; let requests = 0;
  const { app, document } = await harness(() => { requests += 1; return new Promise((resolve) => { resolveRequest = resolve; }); });
  const ready = session('one'); const pending = session('two', 'connecting');
  app.state.sessions = [ready, pending]; app.state.activeId = ready.id;
  app.openLogoutDialog();
  const first = app.confirmLogout(); const second = app.confirmLogout();
  assert.equal(requests, 1);
  assert.equal(document.getElementById('logout-confirm-btn').disabled, true);
  resolveRequest({});
  await Promise.all([first, second]);
  assert.equal(ready.disposed, 1); assert.equal(pending.disposed, 1);
  assert.equal(app.state.sessions.length, 0);
  assert.equal(document.getElementById('logout-dialog').open, false);
  assert.equal(document.activeElement, document.getElementById('auth-password'));
});

test('no ready sessions bypass warning and keep the existing logout endpoint', async () => {
  const paths = [];
  const { app, document } = await harness(async (path, options) => { paths.push([path, options.method]); return {}; });
  const pending = session('pending', 'connecting'); app.state.sessions = [pending];
  await app.logout();
  assert.deepEqual(paths, [['/api/auth/logout', 'POST']]);
  assert.equal(document.getElementById('logout-dialog'), null);
  assert.equal(pending.disposed, 1);
});

test('backdrop cancellation restores focus and launcher cannot open over the logout dialog', async () => {
  const { app, document } = await harness();
  app.state.sessions = [session('one')];
  app.openLogoutDialog();
  const dialog = document.getElementById('logout-dialog');
  app.openLauncher();
  assert.equal(document.getElementById('launcher-dialog').open, false);
  dialog.listeners.click[0]({ target: dialog });
  assert.equal(dialog.open, false);
  assert.equal(document.activeElement, document.getElementById('logout-btn'));
});

test('auth teardown dismisses an open warning without restoring app focus', async () => {
  const { app, document } = await harness();
  app.state.sessions = [session('one')];
  app.openLogoutDialog();
  app.showAuth(false, 'Your session expired. Log in again.');
  assert.equal(document.getElementById('logout-dialog').open, false);
  assert.equal(document.activeElement, document.getElementById('auth-password'));
});

test('Escape cannot dismiss the warning while logout is submitting', async () => {
  let resolveRequest;
  const { app, document } = await harness(() => new Promise((resolve) => { resolveRequest = resolve; }));
  app.state.sessions = [session('one')];
  app.openLogoutDialog();
  const submit = app.confirmLogout();
  const dialog = document.getElementById('logout-dialog');
  let prevented = false;
  dialog.listeners.cancel[0]({ preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(dialog.open, true);
  assert.equal(document.getElementById('logout-btn').disabled, true);
  assert.equal(document.getElementById('logout-confirm-btn').disabled, true);
  resolveRequest({});
  await submit;
  assert.equal(dialog.open, false);
});

test('a failed logout request still tears down sessions and releases submission controls', async () => {
  const failure = new Error('Network unavailable');
  const { app, document } = await harness(async () => { throw failure; });
  const target = session('one');
  app.state.sessions = [target];
  await app.logout();
  await assert.rejects(app.confirmLogout(), (error) => error === failure);
  assert.equal(target.disposed, 1);
  assert.equal(app.state.sessions.length, 0);
  assert.equal(document.getElementById('logout-dialog').open, false);
  assert.equal(document.activeElement, document.getElementById('auth-password'));
  assert.equal(app.state.logoutBusy, false);
  assert.equal(document.getElementById('logout-btn').disabled, false);
  app.state.sessions = [session('next')];
  await app.logout();
  assert.equal(document.getElementById('logout-confirm-btn').disabled, false);
  assert.equal(document.getElementById('logout-cancel-btn').disabled, false);
});
