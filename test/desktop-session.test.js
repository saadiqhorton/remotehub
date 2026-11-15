import { test } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { makeDocument } from './helpers/fake-dom.js';
import { stubTunnelFactory } from './helpers/desktop-stub-tunnel.js';
import { encodeTestImage } from './helpers/pixel-canvas.js';
import { startFakeGuacdSession } from './helpers/fake-guacd-session.js';
import { httpClient, startTestApp } from './helpers/app-harness.js';

/** SAA-303 browser Desktop view: states, close codes, argv, input, clipboard, lifecycle. */

globalThis.document = makeDocument();
globalThis.navigator ??= {};
const windowListeners = new Map();
globalThis.window = {
  addEventListener(type, fn) { (windowListeners.get(type) || windowListeners.set(type, new Set()).get(type)).add(fn); },
  removeEventListener(type, fn) { windowListeners.get(type)?.delete(fn); },
  dispatch(type) { for (const fn of windowListeners.get(type) || []) fn({}); },
};
const { DesktopSession, CLOSE_STATES } = await import('../public/js/desktop-session.js');
const { RemoteHubTunnel } = await import('../public/js/desktop-tunnel.js');
const { hostActions } = await import('../public/js/host-actions.js');

const HOST = { id: 'h1', name: 'Box', address: '10.0.0.5', username: 'me', port: 22, desktop: { protocol: 'vnc', port: 5901, username: null } };
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');

function make(extra = {}) {
  const factory = stubTunnelFactory();
  const changes = [];
  const lost = [];
  const closed = [];
  const clip = { written: [], reads: 0, text: 'local clip', writeText(t) { this.written.push(t); return Promise.resolve(); }, readText() { this.reads += 1; return Promise.resolve(this.text); } };
  const stage = document.createElement('div');
  const s = new DesktopSession({
    host: HOST, createTunnel: factory, clipboard: clip,
    onChange: (x) => changes.push(x.state), onConnectionLost: () => lost.push(1), onClose: (id) => closed.push(id), ...extra,
  });
  s.mount(stage);
  s.show();
  return { s, factory, changes, lost, closed, clip, stage };
}
// The real order: ready, the screen size, then the first frame-done sync. "Connected" is set
// once that frame is drawn (a later tick); a sync before any size never counts (RDP), and nothing counts before a picture is drawn (VNC).
const tick = () => new Promise((r) => setImmediate(r));
const flushDisplay = (s) => new Promise((resolve) => s.display.flush(resolve));
const visibleCanvas = (s) => s.display.getElement().querySelector('canvas');
async function firstFrame(t, s, sync = '1') { t.receive('size', '0', '800', '600'); t.receive('rect', '0', '0', '0', '8', '8'); t.receive('cfill', '14', '0', '0', '0', '0', '255'); t.receive('sync', sync); await flushDisplay(s); }
async function ready(extra = {}) {
  const ctx = make(extra);
  ctx.s.connect();
  ctx.factory.last().receive('ready', '$id');
  await firstFrame(ctx.factory.last(), ctx.s); // first complete frame: "Connected" (SAA-346)
  return ctx;
}

test('starts idle, connects on demand, sends initial password once via the tunnel and clears it', async () => {
  const { s, factory } = make();
  assert.equal(s.state, 'idle');
  assert.equal(factory.made.length, 0, 'no connection until the user clicks Connect');
  s.connectPassword.value = 'pw-1';
  s.connect();
  assert.equal(s.state, 'connecting');
  assert.equal(factory.last().options.password, 'pw-1');
  assert.equal(factory.last().options.host, HOST);
  assert.ok(factory.last().options.width >= 320 && factory.last().options.height >= 240);
  assert.equal(s.connectPassword.value, '', 'password cleared from the form');
  s.connect();
  assert.equal(factory.made.length, 1, 'connect while live is a no-op');
  factory.last().receive('ready', '$id');
  assert.equal(s.state, 'connecting', 'guacd ready is not "Connected" yet (SAA-346)');
  factory.last().receive('rect', '0', '0', '0', '8', '8'); factory.last().receive('cfill', '14', '0', '0', '0', '0', '255'); factory.last().receive('size', '0', '800', '600');
  factory.last().receive('sync', '1');
  await flushDisplay(s);
  assert.equal(s.state, 'ready');
  assert.equal(s.pane.getAttribute('data-state'), 'ready');
  assert.equal(s.overlay.hidden, true);
});

test('every documented close code maps to a distinct, sensible state', async () => {
  const expected = {
    1000: ['disconnected', 'normal'], 1003: ['failed', 'binary-frame'], 1007: ['failed', 'malformed'],
    1008: ['failed', 'protocol'], 1011: ['failed', 'remote-error'], 4401: ['failed', 'login'], 4403: ['failed', 'origin'],
    4404: ['unavailable', 'not-configured'], 4409: ['failed', 'cert-changed'], 4410: ['unavailable', 'cert-check-failed'],
    4502: ['disconnected', 'backend-lost'], 4503: ['unavailable', 'backend-down'],
  };
  assert.deepEqual(Object.keys(CLOSE_STATES).sort(), Object.keys(expected).sort());
  for (const [code, [state, reason]] of Object.entries(expected)) {
    for (const wasReady of [false, true]) {
      const { s, factory, lost } = make();
      s.connect();
      if (wasReady) factory.last().receive('ready', '$id');
      // SAA-346: a normal end is "normal" once something was drawn (before that: ended-early)
      if (code === '1000') { factory.last().receive('ready', '$id'); factory.last().receive('size', '0', '800', '600'); }
      factory.last().end(Number(code), 'server words');
      assert.equal(s.state, state, `${code} ready=${wasReady}`);
      assert.equal(s.reason, reason, `${code}`);
      assert.equal(s.pane.getAttribute('data-reason'), reason);
      assert.equal(s.overlay.hidden, false);
      assert.equal(lost.length, Number(code) === 4401 ? 1 : 0, '4401 sends the user to login');
      assert.equal(s.connectForm.hidden, Number(code) === 4401, 'reconnect offered except after login loss');
    }
  }
  const reasons = Object.values(expected).map(([, r]) => r);
  assert.equal(new Set(reasons).size, reasons.length);
});

test('HTTP 403 / 503 upgrade refusals (error, no open) show the refused state', async () => {
  const { s, factory } = make();
  s.connect();
  factory.last().fail();
  assert.equal(s.state, 'unavailable');
  assert.equal(s.reason, 'refused');
  assert.match(s.message, /couldn’t open this desktop/);
});

test('1011 after a forwarded guacd error shows guacd’s message as failed', async () => {
  const { s, factory } = await ready();
  factory.last().receive('error', 'Authentication failure', '769');
  factory.last().end(1011, 'Desktop connection failed (status 769).');
  assert.equal(s.state, 'failed');
  assert.equal(s.reason, 'remote-error');
  assert.match(s.message, /ran into a problem/);
  assert.doesNotMatch(s.message, /769|Authentication failure/);
});

test('unknown close codes: failed before ready, disconnected after', async () => {
  const a = make(); a.s.connect(); a.factory.last().end(1006, '', true);
  assert.equal(a.s.state, 'failed');
  const b = await ready(); b.factory.last().end(1006, '', true);
  assert.equal(b.s.reason, 'reconnecting', 'SAA-347: a drop after ready reconnects on its own');
  b.s.disconnect();
  const c = await ready(); c.factory.last().end(4000, '', true);
  assert.equal(c.s.state, 'disconnected');
});

test('guacd required → argv form → one argv stream per name, values cleared, repeat prompt ignored', async () => {
  const { s, factory } = make();
  s.connect();
  const t = factory.last();
  t.receive('required', 'password');
  assert.equal(s.state, 'authentication');
  assert.equal(s.authForm.hidden, false);
  assert.equal(s.argvInputs.get('password').getAttribute('type'), 'password');
  s.argvInputs.get('password').value = 'sésame';
  const input = s.argvInputs.get('password');
  s.submitCredentials();
  assert.deepEqual(t.ops('argv'), [['argv', '0', 'text/plain', 'password']]);
  assert.deepEqual(t.ops('blob'), [['blob', '0', b64('sésame')]]);
  assert.deepEqual(t.ops('end'), [['end', '0']]);
  assert.equal(input.value, '');
  assert.equal(s.argvInputs.size, 0);
  assert.equal(s.state, 'connecting');
  s.submitCredentials();
  assert.equal(t.ops('argv').length, 1, 'second submit sends nothing');
  t.receive('required', 'password');
  assert.equal(s.state, 'connecting', 'a name already answered is not prompted again');
  t.receive('required', 'username', 'domain');
  assert.deepEqual([...s.argvInputs.keys()], ['username', 'domain']);
  s.argvInputs.get('username').value = 'me';
  s.argvInputs.get('domain').value = 'LAN';
  s.submitCredentials();
  assert.deepEqual(t.ops('argv').map((a) => a[3]), ['password', 'username', 'domain']);
  t.receive('ready', '$id');
  await firstFrame(t, s);
  assert.equal(s.state, 'ready');
});

test('real guacd order: ready, then required; answering it returns to ready on the first complete frame', async () => {
  const { s, factory } = make();
  s.connect();
  const t = factory.last();
  t.receive('ready', '$id');
  t.receive('required', 'password');
  assert.equal(s.state, 'authentication');
  s.argvInputs.get('password').value = 'pw';
  s.submitCredentials();
  assert.equal(s.state, 'connecting');
  t.receive('size', '0', '1024', '768');
  t.receive('rect', '0', '0', '0', '8', '8'); t.receive('cfill', '14', '0', '0', '0', '0', '255'); assert.equal(s.state, 'connecting', 'a size alone is not a drawn frame');
  t.receive('sync', '2');
  await flushDisplay(s);
  assert.equal(s.state, 'ready');
});

test('SAA-346: empty VNC password - never "Connected" over a blank screen before the sign-in prompt', async () => {
  const { s, factory } = make();
  const seen = [];
  s.connect();
  const t = factory.last();
  const record = () => seen.push(s.state);
  t.receive('ready', '$id'); record();
  assert.equal(s.overlay.hidden, false, 'overlay stays up after guacd ready');
  assert.match(s.message, /Starting the remote desktop/);
  t.receive('required', 'password'); record();
  assert.deepEqual(seen, ['connecting', 'authentication'], 'no "ready" between guacd ready and the prompt');
  s.argvInputs.get('password').value = 'pw';
  s.submitCredentials();
  t.receive('rect', '0', '0', '0', '8', '8'); t.receive('cfill', '14', '0', '0', '0', '0', '255'); t.receive('size', '0', '1024', '768'); record();
  t.receive('sync', '3'); await flushDisplay(s); record();
  assert.deepEqual(seen.slice(2), ['connecting', 'ready']);
  assert.equal(s.overlay.hidden, true);
});

test('display: size, img streams (acked) and legacy png draw on layer 0; sync is echoed', async () => {
  const { s, factory } = await ready();
  const t = factory.last();
  t.receive('size', '0', '640', '480');
  await flushDisplay(s);
  assert.equal(s.display.getDefaultLayer().width, 640);
  assert.equal(s.display.getDefaultLayer().height, 480);
  t.receive('img', '3', '14', '0', 'image/jpeg', '10', '20');
  t.receive('blob', '3', 'AAA');
  t.receive('blob', '3', 'BBB');
  t.receive('end', '3');
  t.receive('img', '4', '14', '1', 'image/png', '0', '0');
  t.receive('end', '4');
  t.receive('png', '14', '0', '1', '2', 'CCC');
  t.receive('rect', '0', '0', '0', '5', '6');
  t.receive('cfill', '14', '0', '42', '93', '143', '255');
  t.receive('sync', '777');
  await flushDisplay(s);
  assert.ok(visibleCanvas(s).width >= 640);
  assert.ok(visibleCanvas(s).height >= 480);
  assert.deepEqual(visibleCanvas(s).pixel(1, 1), [42, 93, 143, 255], 'official Display paints cfill into the visible canvas');
  assert.equal(t.ops('ack').length, 0, 'receiving complete image streams does not create client-owned ack traffic');
  assert.deepEqual(t.ops('sync'), [['sync', '1'], ['sync', '777']], 'every sync echoed (1 = the first frame from await ready())');
});

test('resize sends one clamped size per change, only when ready', async () => {
  const { s, factory } = make();
  s.connect();
  const t = factory.last();
  t.receive('ready', '$id');
  s.viewport.clientWidth = 1200; s.viewport.clientHeight = 700;
  s.fit();
  assert.equal(t.ops('size').length, 0, 'no size before the remote display reports its own size');
  t.receive('size', '0', '1024', '768');
  t.receive('rect', '0', '0', '0', '8', '8'); t.receive('cfill', '14', '0', '0', '0', '0', '255');
  t.receive('sync', '1'); await tick();
  assert.equal(s.state, 'ready');
  s.fit(); s.fit();
  s.viewport.clientWidth = 100; s.viewport.clientHeight = 100;
  s.fit();
  assert.deepEqual(t.ops('size'), [['size', '1200', '700'], ['size', '320', '240']]);
  t.end(1000);
  s.viewport.clientWidth = 900;
  s.fit();
  assert.equal(t.ops('size').length, 2);
});

test('keyboard and mouse are forwarded with keysyms and button masks; blur and hide release them', async () => {
  const { s, factory } = await ready();
  const t = factory.last();
  s.display.scale(0.5);
  const dispatch = (target, type, more = {}) => target.dispatchEvent({ type, preventDefault() { this.defaultPrevented = true; }, stopPropagation() {}, clientX: 10, clientY: 20, pageX: 10, pageY: 20, button: 0, buttons: 0, key: 'a', keyCode: 65, which: 65, location: 0, ...more });
  const displayElement = s.display.getElement();
  dispatch(displayElement, 'mousemove');
  dispatch(displayElement, 'mousedown', { buttons: 1 });
  dispatch(displayElement, 'mousewheel', { deltaY: 60, deltaMode: 0 });
  dispatch(s.canvas, 'keydown');
  dispatch(s.canvas, 'keydown', { key: 'Control', keyCode: 17, which: 17, location: 1 });
  dispatch(s.canvas, 'keydown', { key: 'Dead', keyCode: 229, which: 229 });
  assert.deepEqual(t.ops('mouse'), [['mouse', '20', '40', '0'], ['mouse', '20', '40', '1'], ['mouse', '20', '40', '17'], ['mouse', '20', '40', '1']]);
  assert.deepEqual(t.ops('key'), [['key', '97', '1'], ['key', '65507', '1']]);
  dispatch(s.canvas, 'blur');
  assert.deepEqual(t.ops('key').slice(2).sort(), [['key', '65507', '0'], ['key', '97', '0']]);
  assert.deepEqual(t.ops('mouse').at(-1), ['mouse', '20', '40', '0'], 'blur releases every held mouse button at the last pointer position');
  const hidden = await ready();
  hidden.s.keyboard.press(97);
  hidden.s.hide();
  assert.ok(hidden.factory.last().ops('key').some((op) => op[1] === '97' && op[2] === '0'), 'hide releases a held key');
  hidden.s.dispose();
});

test('official Keyboard preserves native paste shortcuts while capturing other browser shortcuts', async () => {
  const { s, factory } = await ready();
  const dispatchKey = (type, key, keyCode, more = {}) => {
    const event = { type, key, keyCode, which: keyCode, location: 0, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() {}, ...more };
    s.canvas.dispatchEvent(event);
    return event;
  };

  dispatchKey('keydown', 'Control', 17, { location: 1 });
  assert.equal(dispatchKey('keydown', 'v', 86).defaultPrevented, false, 'Ctrl+V reaches the browser paste event');
  assert.equal(dispatchKey('keydown', 'w', 87).defaultPrevented, true, 'Ctrl+W remains captured by the remote');
  dispatchKey('keyup', 'w', 87);
  dispatchKey('keyup', 'v', 86);
  dispatchKey('keyup', 'Control', 17, { location: 1 });

  dispatchKey('keydown', 'Meta', 91, { location: 1 });
  assert.equal(dispatchKey('keydown', 'v', 86).defaultPrevented, false, 'Command+V reaches the browser paste event');
  dispatchKey('keyup', 'v', 86);
  dispatchKey('keyup', 'Meta', 91, { location: 1 });
  // console.log('meta state', [...s.deferredMetaKeys], [...s.remoteMetaKeys], [...s.suppressedKeyUps]);
  s.dispose();
  assert.ok(factory.last().ops('key').length > 0, 'the official Keyboard still forwards remote key events');
});

test('paste text is queued before the remote paste shortcut; Command+V becomes Ctrl+V', async () => {
  const deniedClipboard = { readText: () => Promise.reject(new Error('NotAllowedError')), writeText() { return Promise.resolve(); } };
  const { s, factory } = await ready({ clipboard: deniedClipboard });
  await tick();
  const t = factory.last();
  const dispatchKey = (type, key, keyCode, more = {}) => s.canvas.dispatchEvent({
    type, key, keyCode, which: keyCode, location: 0, preventDefault() { this.defaultPrevented = true; },
    stopPropagation() {}, ...more,
  });
  const sendPasteChord = async ({ command = false, text = 'new clipboard text' } = {}) => {
    dispatchKey('keydown', command ? 'Meta' : 'Control', command ? 91 : 17, command
      ? { metaKey: true, location: 1 } : { ctrlKey: true, location: 1 });
    dispatchKey('keydown', 'v', 86, command ? { metaKey: true } : { ctrlKey: true });
    if (command) {
      assert.deepEqual([...s.deferredMetaKeys], [], 'Command is buffered into the paste intent');
      assert.ok(s.suppressedKeyUps.has(65511), 'Command release is suppressed after the paste intent');
    }
    s.canvas.dispatchEvent({ type: 'paste', preventDefault() {}, clipboardData: { getData: () => text } });
    dispatchKey('keyup', 'v', 86, command ? { metaKey: true } : { ctrlKey: true });
    dispatchKey('keyup', command ? 'Meta' : 'Control', command ? 91 : 17, { location: 1 });
    await tick();
    if (command) assert.equal(s.suppressedKeyUps.has(65511), false, 'physical Command keyup clears its suppression');
  };
  let before = t.sent.length;
  await sendPasteChord();
  const ctrlPaste = t.sent.slice(before);
  assert.deepEqual(ctrlPaste.map(([op]) => op), ['key', 'clipboard', 'blob', 'end', 'key', 'key', 'key'], 'clipboard stream completes before the remote V keydown');
  assert.deepEqual(ctrlPaste.filter(([op]) => op === 'key'), [['key', '65507', '1'], ['key', '118', '1'], ['key', '118', '0'], ['key', '65507', '0']]);

  before = t.sent.length;
  await sendPasteChord({ command: true, text: 'command clipboard text' });
  const commandPaste = t.sent.slice(before);
  assert.deepEqual(commandPaste.map(([op]) => op), ['clipboard', 'blob', 'end', 'key', 'key', 'key', 'key'], `Command+V ops: ${JSON.stringify(commandPaste)}`);
  assert.deepEqual(commandPaste.filter(([op]) => op === 'key'), [['key', '65507', '1'], ['key', '118', '1'], ['key', '118', '0'], ['key', '65507', '0']], 'Command is represented remotely as Ctrl');

  before = t.sent.length;
  dispatchKey('keydown', 'Meta', 91, { metaKey: true, location: 1 });
  dispatchKey('keydown', 'w', 87, { metaKey: true });
  dispatchKey('keyup', 'w', 87, { metaKey: true });
  dispatchKey('keyup', 'Meta', 91, { location: 1 });
  assert.deepEqual(t.sent.slice(before).filter(([op]) => op === 'key'), [['key', '65511', '1'], ['key', '119', '1'], ['key', '119', '0'], ['key', '65511', '0']], 'ordinary Command shortcuts remain remote Meta shortcuts');

  before = t.sent.length;
  dispatchKey('keydown', 'Meta', 91, { metaKey: true, location: 1 });
  dispatchKey('keydown', 'w', 87, { metaKey: true });
  dispatchKey('keyup', 'w', 87, { metaKey: true });
  dispatchKey('keydown', 'v', 86, { metaKey: true });
  s.canvas.dispatchEvent({ type: 'paste', preventDefault() {}, clipboardData: { getData: () => 'after ordinary Meta' } });
  dispatchKey('keyup', 'v', 86, { metaKey: true });
  dispatchKey('keydown', 'x', 88, { metaKey: true });
  dispatchKey('keyup', 'x', 88, { metaKey: true });
  dispatchKey('keyup', 'Meta', 91, { location: 1 });
  const mixed = t.sent.slice(before);
  assert.deepEqual(mixed.map(([op]) => op), ['key', 'key', 'key', 'key', 'clipboard', 'blob', 'end', 'key', 'key', 'key', 'key', 'key', 'key', 'key', 'key']);
  assert.deepEqual(mixed.slice(0, 4), [['key', '65511', '1'], ['key', '119', '1'], ['key', '119', '0'], ['key', '65511', '0']], 'remote Meta is released before the native paste can trigger a system menu');
  assert.deepEqual(mixed.slice(7, 11), [['key', '65507', '1'], ['key', '118', '1'], ['key', '118', '0'], ['key', '65507', '0']]);
  assert.deepEqual(mixed.slice(11), [['key', '65511', '1'], ['key', '120', '1'], ['key', '120', '0'], ['key', '65511', '0']], 'Meta resumes for a later ordinary key then releases normally');
  s.dispose();
});

test('native paste wins over a denied or late Clipboard API focus read', async () => {
  let resolveRead;
  const clipboard = { readText: () => new Promise((resolve) => { resolveRead = resolve; }), writeText() { return Promise.resolve(); } };
  const { s, factory } = await ready({ clipboard });
  const t = factory.last();
  s.canvas.focus();
  s.canvas.dispatchEvent({ type: 'paste', preventDefault() {}, clipboardData: { getData: () => 'pasted now' } });
  resolveRead('older focus snapshot');
  await tick();
  const texts = t.ops('blob').map(([, , data]) => Buffer.from(data, 'base64').toString());
  assert.deepEqual(texts, ['pasted now'], 'an earlier asynchronous read cannot overwrite a newer native paste');
  s.dispose();
});

test('a late focus clipboard read is discarded after blur, hide, disconnect, or reconnect', async () => {
  for (const invalidate of [
    (s) => s.canvas.dispatchEvent({ type: 'blur' }),
    (s) => s.hide(),
    (s) => s.disconnect(),
    (s) => { s.disconnect(); s.connect(); },
  ]) {
    let resolveRead;
    const clipboard = { readText: () => new Promise((resolve) => { resolveRead = resolve; }), writeText() { return Promise.resolve(); } };
    const { s, factory } = await ready({ clipboard });
    s.canvas.focus();
    invalidate(s);
    const lastBeforeResolve = factory.last().sent.length;
    resolveRead('must not leak');
    await tick();
    assert.equal(factory.made.flatMap((t) => t.ops('clipboard')).length, 0);
    assert.ok(factory.last().sent.length >= lastBeforeResolve);
    s.dispose();
  }
});

test('a native paste that arrives after blur, hide, reconnect, or dispose is discarded', async () => {
  for (const invalidate of [
    (s) => s.canvas.dispatchEvent({ type: 'blur' }),
    () => window.dispatch('blur'),
    (s) => { document.hidden = true; document.dispatch('visibilitychange'); document.hidden = false; },
    () => window.dispatch('pagehide'),
    (s) => s.hide(),
    (s) => { s.disconnect(); s.connect(); },
    (s) => s.dispose(),
  ]) {
    const clipboard = { readText: () => Promise.reject(new Error('NotAllowedError')), writeText() { return Promise.resolve(); } };
    const { s, factory } = await ready({ clipboard });
    await tick();
    const dispatchKey = (type, key, keyCode, more = {}) => s.canvas.dispatchEvent({
      type, key, keyCode, which: keyCode, location: 0, preventDefault() {}, stopPropagation() {}, ...more,
    });
    dispatchKey('keydown', 'Control', 17, { ctrlKey: true, location: 1 });
    dispatchKey('keydown', 'v', 86, { ctrlKey: true });
    invalidate(s);
    s.canvas.dispatchEvent({ type: 'paste', preventDefault() {}, clipboardData: { getData: () => 'late paste' } });
    assert.equal(factory.made.flatMap((t) => t.ops('clipboard')).length, 0);
    assert.equal(factory.made.flatMap((t) => t.ops('blob')).length, 0);
    assert.equal(factory.made.flatMap((t) => t.ops('key')).some(([, keysym]) => keysym === '118'), false);
    s.dispose();
  }
});

test('paste without text does not reuse the remote clipboard; paste after V keyup is still ordered', async () => {
  const clipboard = { readText: () => Promise.reject(new Error('NotAllowedError')), writeText() { return Promise.resolve(); } };
  const { s, factory } = await ready({ clipboard });
  await tick();
  const t = factory.last();
  const dispatchKey = (type, key, keyCode, more = {}) => s.canvas.dispatchEvent({
    type, key, keyCode, which: keyCode, location: 0, preventDefault() {}, stopPropagation() {}, ...more,
  });
  dispatchKey('keydown', 'Control', 17, { ctrlKey: true, location: 1 });
  dispatchKey('keydown', 'v', 86, { ctrlKey: true });
  s.canvas.dispatchEvent({ type: 'paste', preventDefault() {}, clipboardData: { getData: () => '' } });
  dispatchKey('keyup', 'v', 86, { ctrlKey: false });
  dispatchKey('keyup', 'Control', 17, { location: 1 });
  assert.equal(t.ops('clipboard').length, 0);
  assert.equal(t.ops('key').some(([, keysym]) => keysym === '118'), false, 'no text means no stale remote paste action');

  const before = t.sent.length;
  dispatchKey('keydown', 'Control', 17, { ctrlKey: true, location: 1 });
  dispatchKey('keydown', 'v', 86, { ctrlKey: true });
  dispatchKey('keyup', 'v', 86, { ctrlKey: true });
  s.canvas.dispatchEvent({ type: 'paste', preventDefault() {}, clipboardData: { getData: () => 'paste after keyup' } });
  dispatchKey('keyup', 'Control', 17, { location: 1 });
  const ops = t.sent.slice(before);
  assert.deepEqual(ops.map(([op]) => op), ['key', 'clipboard', 'blob', 'end', 'key', 'key', 'key']);
  assert.equal(ops.findIndex(([op]) => op === 'end') < ops.findIndex(([op, keysym, pressed]) => op === 'key' && keysym === '118' && pressed === '1'), true);

  const releasedBeforePaste = t.sent.length;
  dispatchKey('keydown', 'Control', 17, { ctrlKey: true, location: 1 });
  dispatchKey('keydown', 'v', 86, { ctrlKey: true });
  dispatchKey('keyup', 'Control', 17, { location: 1 });
  s.canvas.dispatchEvent({ type: 'paste', preventDefault() {}, clipboardData: { getData: () => 'control released early' } });
  dispatchKey('keyup', 'v', 86, { ctrlKey: false });
  const earlyControl = t.sent.slice(releasedBeforePaste);
  assert.deepEqual(earlyControl.map(([op]) => op), ['key', 'key', 'clipboard', 'blob', 'end', 'key', 'key', 'key', 'key']);
  assert.deepEqual(earlyControl.filter(([op]) => op === 'key'), [['key', '65507', '1'], ['key', '65507', '0'], ['key', '65507', '1'], ['key', '118', '1'], ['key', '118', '0'], ['key', '65507', '0']], 'the synthetic paste stays modified even if Control is released before the paste event');

  const nativeVariants = t.sent.length;
  dispatchKey('keydown', 'Control', 17, { ctrlKey: true, location: 1 });
  dispatchKey('keydown', 'Shift', 16, { shiftKey: true, ctrlKey: true, location: 1 });
  dispatchKey('keydown', 'V', 86, { shiftKey: true, ctrlKey: true });
  s.canvas.dispatchEvent({ type: 'paste', preventDefault() {}, clipboardData: { getData: () => 'shifted paste' } });
  dispatchKey('keyup', 'v', 86, { shiftKey: true, ctrlKey: true });
  dispatchKey('keyup', 'Shift', 16, { ctrlKey: true, location: 1 });
  dispatchKey('keyup', 'Control', 17, { location: 1 });
  assert.deepEqual(t.sent.slice(nativeVariants).filter(([op]) => op === 'key').map(([, keysym]) => keysym),
    ['65507', '65505', '86', '86', '65505', '65507'], 'Ctrl+Shift+V remains modified through the ordered native paste');
  const shiftedPasteOps = t.sent.slice(nativeVariants);
  assert.equal(shiftedPasteOps.findIndex(([op]) => op === 'end') < shiftedPasteOps.findIndex(([op, keysym, pressed]) => op === 'key' && keysym === '86' && pressed === '1'), true);

  const shiftInsert = t.sent.length;
  dispatchKey('keydown', 'Shift', 16, { shiftKey: true, location: 1 });
  dispatchKey('keydown', 'Insert', 45, { shiftKey: true });
  dispatchKey('keyup', 'Insert', 45, { shiftKey: true });
  dispatchKey('keyup', 'Shift', 16, { location: 1 });
  assert.deepEqual(t.sent.slice(shiftInsert).filter(([op]) => op === 'key').map(([, keysym]) => keysym),
    ['65505', '65379', '65379', '65505'], 'Shift+Insert remains an ordinary remote shortcut');
  s.dispose();
});

test('clipboard text/plain both ways', async () => {
  const { s, factory, clip } = await ready();
  const t = factory.last();
  t.receive('clipboard', '7', 'text/plain');
  t.receive('blob', '7', b64('from remote '));
  t.receive('blob', '7', b64('✓'));
  t.receive('end', '7');
  assert.equal(s.remoteClipboard, 'from remote ✓');
  assert.deepEqual(clip.written, ['from remote ✓']);
  assert.deepEqual(t.ops('ack').filter(([, id]) => id === '7').map(([, , , code]) => code), ['0', '0'], 'each clipboard chunk is acknowledged');
  const beforeRemoteEcho = t.ops('clipboard').length;
  s.sendClipboard('from remote ✓');
  assert.equal(t.ops('clipboard').length, beforeRemoteEcho, 'remote text is not echoed back');
  const clipboardBeforePaste = t.ops('clipboard').length;
  const blobsBeforePaste = t.ops('blob').length;
  s.canvas.dispatchEvent({ type: 'paste', preventDefault() {}, clipboardData: { getData: () => 'pasted ü' } });
  await s.syncLocalClipboard();
  const streams = t.ops('clipboard').slice(clipboardBeforePaste);
  assert.deepEqual(streams.map((c) => c[2]), ['text/plain', 'text/plain']);
  const blobs = t.ops('blob').slice(blobsBeforePaste).map((b) => Buffer.from(b[2], 'base64').toString());
  assert.deepEqual(blobs, ['pasted ü', 'local clip']);
});

test('mousedown on an already focused display does not resync the local clipboard', async () => {
  const { s, factory, clip } = await ready();
  const displayElement = s.display.getElement();
  s.canvas.focus();
  await tick();
  assert.equal(document.activeElement, s.canvas);
  assert.equal(clip.reads, 1, 'focus reads the local clipboard once');
  const clipboardInstructions = factory.last().ops('clipboard').length;
  const focusReads = clip.reads;

  displayElement.dispatchEvent({ type: 'mousedown', button: 0, buttons: 1, clientX: 2, clientY: 2, preventDefault() {}, stopPropagation() {} });
  await tick();
  assert.equal(document.activeElement, s.canvas);
  assert.equal(clip.reads, focusReads, 'calling focus on the already focused display wrapper emits no second focus event');
  assert.equal(factory.last().ops('clipboard').length, clipboardInstructions, 'the click sends no duplicate clipboard stream');
  s.dispose();
});

test('disconnect, reconnect and close tab', async () => {
  const { s, factory, closed } = await ready();
  s.disconnect();
  assert.equal(factory.made[0].closed, true);
  assert.equal(s.state, 'disconnected');
  assert.equal(s.reason, 'user');
  factory.made[0].end(1000);
  assert.equal(s.reason, 'user', 'late close of the old tunnel is ignored');
  assert.equal(s.connectForm.hidden, false);
  s.connect();
  assert.equal(factory.made.length, 2);
  factory.last().receive('ready', '$2');
  await firstFrame(factory.last(), s);
  assert.equal(s.state, 'ready');
  for (const l of s.closeButton.listeners.get('click')) l({});
  assert.deepEqual(closed, [s.id]);
  s.dispose();
  assert.equal(factory.last().closed, true);
  assert.equal(s.pane.parentNode, null);
  s.connect();
  assert.equal(factory.made.length, 2, 'disposed sessions never reconnect');
});

test('hostActions enables Desktop only with host desktop settings and the server flag on', async () => {
  const caps = { terminal: { ssh: true }, files: { sftp: true }, desktop: { vnc: true } };
  const desktop = (h) => hostActions(h)[2];
  assert.equal(desktop({ capabilities: caps }).enabled, false);
  assert.match(desktop({ capabilities: caps }).reason, /not set up/);
  assert.equal(desktop({ capabilities: caps, desktop: HOST.desktop }).enabled, false);
  assert.match(desktop({ capabilities: caps, desktop: HOST.desktop }).reason, /isn’t set up in this copy of RemoteHub yet/);
  assert.equal(desktop({ capabilities: caps, desktop: HOST.desktop, desktopServerEnabled: true }).enabled, true);
  assert.equal(desktop({ desktop: null, desktopServerEnabled: true }).enabled, false);
});

// ── integration: the real view + real tunnel against the real SAA-302 bridge ──
async function bridgeSetup({ mode = 'ok', enabled = true, extra = {} } = {}) {
  const fake = await startFakeGuacdSession({ mode });
  const t = await startTestApp({ guacd: { enabled, host: '127.0.0.1', port: fake.port, protocol: 'vnc', timeoutMs: 500, cacheMs: 0 }, ...extra });
  const client = httpClient(t.base, t.origin);
  const code = (await import('node:fs/promises')).readFile(`${t.dataDir}/SETUP-CODE.txt`, 'utf8');
  await client.request('/api/auth/setup', { method: 'POST', body: { setupCode: (await code).trim(), password: 'owner-password-1' } });
  const host = (await client.request('/api/hosts', { method: 'POST', body: { name: 'box', address: '127.0.0.1', port: 22, username: 'me' } })).body.host;
  await client.request(`/api/hosts/${host.id}/desktop`, { method: 'PUT', body: { protocol: 'vnc', port: 5901 } });
  const view = (origin = t.origin) => {
    const WS = class extends WebSocket { constructor(url) { super(url, { headers: { Origin: origin, Cookie: client.cookie } }); } };
    return new DesktopSession({
      host: { ...host, desktop: { protocol: 'vnc', port: 5901 } },
      createTunnel: (o) => new RemoteHubTunnel({ url: `${t.base.replace('http', 'ws')}/ws/desktop?hostId=${o.host.id}&width=${o.width}&height=${o.height}`, WebSocketImpl: WS, password: o.password }),
    });
  };
  return { fake, t, client, host, view, stop: async () => { await t.stop(); await fake.stop(); } };
}
async function until(pred, ms = 4000) { const end = Date.now() + ms; while (!pred()) { if (Date.now() > end) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 10)); } }

test('integration: real bridge → ready with frames; password reaches guacd once; guacd kill → 4502; reconnect', async () => {
  const b = await bridgeSetup();
  try {
    const s = b.view();
    s.mount(document.createElement('div'));
    s.connectPassword.value = 'pw-int';
    s.connect();
    await until(() => s.state === 'ready');
    await until(() => s.remoteSize.width === 640);
    const connect = b.fake.received[0].find(([op]) => op === 'connect');
    assert.ok(connect.includes('pw-int'), 'password delivered to guacd');
    b.fake.dropAll();
    await until(() => s.reason === 'reconnecting'); // SAA-347: 4502 reconnects on its own
    assert.match(s.message, /Reconnecting in \d…/);
    await until(() => s.state === 'ready', 10000);
    assert.equal(b.fake.received.at(-1).find(([op]) => op === 'connect').includes('pw-int'), true, 'held password reused, no prompt');
    s.disconnect();
    assert.equal(s.state, 'disconnected');
    s.dispose();
  } finally { await b.stop(); }
});

test('child-canvas focus and held Ctrl survive 4502 only until the reconnect boundary', async () => {
  const { s, factory } = await ready({ clipboard: { readText: () => Promise.reject(new Error('denied')), writeText() {} } });
  const childCanvas = visibleCanvas(s);
  s.disconnectButton.focus(); // Shift+Tab can move from the toolbar into this focusable Guac canvas.
  childCanvas.focus();
  const dispatchKey = (type, key, keyCode, more = {}, target = childCanvas) => s.canvas.dispatchEvent({
    type, target, key, keyCode, which: keyCode, location: 1,
    preventDefault() {}, stopPropagation() {}, ...more,
  });
  dispatchKey('keydown', 'Control', 17, { ctrlKey: true });
  assert.equal(s.keyboard.pressed[65507], true, 'the official Keyboard received Ctrl on the descendant focus path');

  factory.last().end(4502);
  await until(() => s.reason === 'reconnecting');
  await until(() => factory.made.length === 2, 5000);
  const reconnected = factory.last();
  reconnected.receive('ready', '$id');
  await firstFrame(reconnected, s);

  // Ctrl remained physically held while the tunnel was down. Guac must rebuild the
  // modifier for this new client before forwarding an ordinary shortcut or native paste.
  dispatchKey('keydown', 'w', 87, { ctrlKey: true }, s.canvas);
  dispatchKey('keyup', 'w', 87, { ctrlKey: true }, s.canvas);
  dispatchKey('keydown', 'v', 86, { ctrlKey: true }, s.canvas);
  s.canvas.dispatchEvent({ type: 'paste', preventDefault() {}, clipboardData: { getData: () => 'after reconnect' } });
  dispatchKey('keyup', 'v', 86, { ctrlKey: true }, s.canvas);
  dispatchKey('keyup', 'Control', 17, { location: 1 }, s.canvas);

  assert.deepEqual(reconnected.ops('key'), [
    ['key', '65507', '1'], ['key', '119', '1'], ['key', '119', '0'],
    ['key', '65507', '0'], ['key', '65507', '1'],
    ['key', '118', '1'], ['key', '118', '0'], ['key', '65507', '0'],
  ], 'the new tunnel gets a fresh Ctrl state, then Ctrl+W and Ctrl+V in order');
  const endAt = reconnected.sent.findIndex(([op]) => op === 'end');
  const vDownAt = reconnected.sent.findIndex(([op, keysym, pressed]) => op === 'key' && keysym === '118' && pressed === '1');
  assert.ok(endAt >= 0 && vDownAt > endAt, 'paste stream completes before V reaches the new tunnel');
  s.dispose();
});

test('window focus restores clipboard eligibility when the descendant Guac canvas is active', async () => {
  const { s, clip } = await ready();
  s.disconnectButton.focus();
  const childCanvas = visibleCanvas(s);
  childCanvas.focus();
  assert.equal(s.canvasFocused, false, 'the fake DOM does not bubble descendant focus events');
  const reads = clip.reads;
  s.canvas.dispatchEvent({ type: 'focus', target: childCanvas }); // Simulate the browser's captured descendant focus.
  assert.equal(s.canvasFocused, true, 'the active child canvas belongs to this desktop surface');
  assert.equal(clip.reads, reads, 'focusing an internal canvas does not start another automatic clipboard read');
  window.dispatch('focus');
  assert.equal(s.canvasFocused, true, 'window focus retains descendant canvas focus');
  s.dispose();
});

test('integration: wrong password (guacd error) → failed; desktop off → 4503; no desktop → 4404; bad origin → refused; login lost → 4401', async () => {
  const bad = await bridgeSetup({ mode: 'reject' });
  try {
    const s = bad.view(); s.connect();
    await until(() => s.state === 'failed');
    assert.equal(s.reason, 'remote-error');
    assert.match(s.message, /ran into a problem/);
    const o = bad.view('http://evil.example'); o.connect();
    await until(() => s.state !== 'connecting' && o.state !== 'connecting');
    // PR #26: a foreign Origin is now closed with 4403 after the upgrade (was HTTP 403).
    // The view's 4403 mapping lives in public/js/desktop-session.js (a separate file); until it
    // maps 4403 to the refused state, the view shows its generic close-code fallback.
    assert.equal(o.state, 'failed');
    assert.equal(o.reason, 'origin');
    await bad.client.request(`/api/hosts/${bad.host.id}/desktop`, { method: 'DELETE' });
    const n = bad.view(); n.connect();
    await until(() => n.state === 'unavailable');
    assert.equal(n.reason, 'not-configured');
    await bad.client.request('/api/auth/logout', { method: 'POST' });
    const l = bad.view(); l.connect();
    await until(() => l.state === 'failed');
    assert.equal(l.reason, 'login');
  } finally { await bad.stop(); }
  const off = await bridgeSetup({ enabled: false });
  try {
    const s = off.view(); s.connect();
    await until(() => s.state === 'unavailable');
    assert.equal(s.reason, 'backend-down');
  } finally { await off.stop(); }
  const full = await bridgeSetup({ extra: { maxDesktops: 0 } });
  try {
    const s = full.view(); s.connect();
    await until(() => s.state === 'unavailable');
    assert.equal(s.reason, 'refused', 'HTTP 503 session limit');
  } finally { await full.stop(); }
});

test('browser stream ids stay within guacd’s 64-stream limit', async () => {
  const { s, factory } = await ready();
  const first = factory.last().ops('clipboard').length;
  for (let i = 0; i < 70; i += 1) s.sendClipboard(`clip ${i}`);
  const ids = factory.last().ops('clipboard').slice(first).map((c) => Number(c[1]));
  assert.equal(ids.length, 70);
  assert.ok(ids.every((id) => id >= 0 && id < 64));
  assert.equal(ids[64], 0);
});

// ── off-screen buffers (negative layers) with real pixel checks ──
function pixelSession() {
  const ctx = make();
  const { s, factory } = ctx;
  s.connect();
  const t = factory.last();
  t.receive('ready', '$px');
  t.receive('size', '0', '8', '6');
  return { ...ctx, t };
}
const pixel = (s, x, y) => visibleCanvas(s).pixel(x, y);
const RED = [255, 0, 0, 255];
const BLUE = [0, 0, 255, 255];
const GREEN = [0, 128, 0, 255];
const CLEAR = [0, 0, 0, 0];

test('buffers: created on first reference, img/rect/cfill/png draw into them, copy buffer→layer 0 (pixels)', async () => {
  const { s, t } = pixelSession();
  // img stream into buffer -1 (never seen before)
  t.receive('img', '5', '14', '-1', 'image/png', '1', '1');
  t.receive('blob', '5', encodeTestImage([[RED, RED], [RED, RED]]));
  t.receive('end', '5');
  t.receive('rect', '-1', '0', '0', '1', '1');
  t.receive('cfill', '14', '-1', '0', '0', '255', '255');
  t.receive('png', '14', '-2', '0', '0', encodeTestImage([[GREEN]]));
  await flushDisplay(s);
  assert.deepEqual(pixel(s, 1, 1), CLEAR, 'offscreen buffers are not visible by themselves');
  t.receive('copy', '-1', '0', '0', '3', '3', '14', '0', '4', '2');
  t.receive('copy', '-2', '0', '0', '1', '1', '14', '0', '0', '5');
  await flushDisplay(s);
  assert.deepEqual(pixel(s, 4, 2), BLUE);
  assert.deepEqual(pixel(s, 6, 4), RED, 'image content beyond the original buffer size is retained');
  assert.deepEqual(pixel(s, 0, 5), GREEN);
  assert.deepEqual(pixel(s, 3, 2), CLEAR);
});

test('buffers: copy layer 0→buffer and buffer→buffer, size keeps content, dispose drops the buffer', async () => {
  const { s, t } = pixelSession();
  t.receive('rect', '0', '0', '0', '2', '2');
  t.receive('cfill', '14', '0', '255', '0', '0', '255');
  t.receive('size', '-3', '4', '4');
  t.receive('copy', '0', '0', '0', '2', '2', '14', '-3', '2', '2');
  t.receive('copy', '-3', '2', '2', '2', '2', '14', '-4', '0', '0');
  await flushDisplay(s);
  assert.deepEqual(pixel(s, 0, 0), RED);
  t.receive('size', '-3', '6', '6');
  await flushDisplay(s);
  assert.deepEqual(pixel(s, 0, 0), RED, 'copying into and resizing buffers does not disturb visible content');
  t.receive('copy', '-3', '2', '2', '2', '2', '12', '0', '5', '3');
  t.receive('dispose', '-3');
  await flushDisplay(s);
  assert.deepEqual(pixel(s, 6, 4), RED);
  t.receive('size', '0', '10', '6');
  await flushDisplay(s);
  assert.deepEqual(pixel(s, 6, 4), RED, 'layer 0 resize keeps the picture');
});

test('RDP-style glyph cache: draw text/bitmap into buffer -1 once, copy it to layer 0 many times', async () => {
  const { s, t } = pixelSession();
  // background fill on layer 0
  t.receive('rect', '0', '0', '0', '8', '6');
  t.receive('cfill', '14', '0', '255', '255', '255', '255');
  // "glyph" bitmap (an L shape) cached in buffer -1, then a cfill-colored strip drawn next to it
  const X = BLUE; const _ = CLEAR;
  t.receive('img', '9', '14', '-1', 'image/png', '0', '0');
  t.receive('blob', '9', encodeTestImage([[X, _], [X, _], [X, X]]));
  t.receive('end', '9');
  // stamp it three times like FreeRDP's glyph cache does
  for (const x of ['0', '3', '6']) t.receive('copy', '-1', '0', '0', '2', '3', '14', '0', x, '2');
  await flushDisplay(s);
  for (const x of [0, 3, 6]) {
    assert.deepEqual(pixel(s, x, 2), BLUE, `glyph at ${x}`);
    assert.deepEqual(pixel(s, x + 1, 4), BLUE);
    assert.deepEqual(pixel(s, x + 1, 2), [255, 255, 255, 255], 'transparent glyph pixels keep the background');
  }
  assert.deepEqual(pixel(s, 2, 0), [255, 255, 255, 255]);
});

test('after a close, the connect button says Reconnect (and Connect only when idle)', async () => {
  const { s, factory } = make();
  assert.equal(s.connectButton.textContent, 'Connect');
  s.connect();
  factory.last().receive('ready', '$id');
  factory.last().end(4502);
  assert.equal(s.connectButton.textContent, 'Reconnect');
  s.connect();
  factory.last().end(1000);
  assert.equal(s.connectButton.textContent, 'Reconnect');
});

async function holdKeys() {
  const ctx = await ready();
  const fire = (type, ev) => { for (const l of ctx.s.canvas.listeners.get(type)) l({ preventDefault() {}, ...ev }); };
  fire('keydown', { key: 'a' });
  fire('keydown', { key: 'Shift', location: 1 });
  return { ...ctx, t: ctx.factory.last() };
}
const keyUps = (t) => t.ops('key').filter((k) => k[2] === '0').map((k) => k[1]).sort();

test('document visibilitychange → hidden releases every held key once', async () => {
  const { s, t } = await holdKeys();
  document.hidden = false;
  document.dispatch('visibilitychange');
  assert.deepEqual(keyUps(t), [], 'visible: nothing released');
  document.hidden = true;
  document.dispatch('visibilitychange');
  document.dispatch('visibilitychange');
  assert.deepEqual(keyUps(t), ['65505', '97'], 'one key-up per held key, no duplicates');
  document.hidden = false;
  s.dispose();
});

test('window pagehide releases every held key once', async () => {
  const { s, t } = await holdKeys();
  window.dispatch('pagehide');
  window.dispatch('pagehide');
  assert.deepEqual(keyUps(t), ['65505', '97']);
  s.dispose();
  assert.equal([...(windowListeners.get('pagehide') || [])].includes(s.onPageHide), false, 'listener removed on dispose');
});

test('SAA-346: a 1000 close before any frame is a neutral failure, not "session ended" or "wrong password"', async () => {
  const { s, factory } = make();
  s.connect();
  factory.last().receive('ready', '$id');
  factory.last().end(1000, 'Desktop session ended.');
  assert.equal(s.state, 'failed');
  assert.equal(s.reason, 'ended-early');
  assert.doesNotMatch(s.message, /password/i);
  // after a frame, 1000 stays a normal end
  s.connect();
  factory.last().receive('ready', '$id');
  factory.last().receive('size', '0', '800', '600');
  factory.last().end(1000, 'bye');
  assert.equal(s.state, 'disconnected');
  assert.equal(s.reason, 'normal');
  // user disconnect is untouched
  s.connect();
  s.disconnect();
  assert.equal(s.reason, 'user');
});

test('SAA-346: the VNC pre-check never says the password was rejected after a plain 1000', async () => {
  const { s, factory } = make();
  s.host.desktop = { protocol: 'vnc', port: 5900 };
  s.vncExplain = async () => ({ reason: 'vnc-auth', message: 'The VNC server rejected the password.' });
  s.connectPassword.value = 'pw';
  s.connect();
  factory.last().receive('ready', '$id');
  factory.last().end(1000, '');
  await new Promise((r) => setImmediate(r));
  assert.equal(s.reason, 'vnc-auth');
  assert.doesNotMatch(s.message, /rejected/);
  assert.match(s.message, /It needs a password: enter it and click Connect/);
});

test('SAA-346: "Connected" appears only after the first frame\'s queued drawing has finished', async () => {
  const { s, factory } = make();
  s.connect();
  const realFlush = s.display.flush.bind(s.display);
  let finish;
  s.display.flush = (callback) => { finish = () => realFlush(callback); };
  const t = factory.last();
  t.receive('ready', '$id');
  t.receive('rect', '0', '0', '0', '8', '8'); t.receive('cfill', '14', '0', '0', '0', '0', '255'); t.receive('size', '0', '800', '600');
  t.receive('sync', '1');
  await new Promise((r) => setImmediate(r));
  assert.equal(s.state, 'connecting', 'frame still being drawn');
  finish();
  await new Promise((r) => setImmediate(r));
  assert.equal(s.state, 'ready');
});

test('SAA-346: RDP order (ready, sync, required) - a sync before any screen size is never "Connected"', async () => {
  const { s, factory } = make();
  const seen = [];
  s.onChange = () => seen.push(s.state);
  s.connect();
  const t = factory.last();
  t.receive('ready', '$id');
  t.receive('sync', '0'); // xrdp/guacd: sync before anything is drawn
  await flushDisplay(s);
  t.receive('required', 'password');
  assert.ok(!seen.includes('ready'), `states: ${seen.join(' > ')}`);
  s.argvInputs.get('password').value = 'pw';
  s.submitCredentials();
  await firstFrame(t, s, '2');
  assert.equal(s.state, 'ready');
});

test('SAA-346: VNC order (size, sync with nothing drawn, drawing later) - "Loading the screen…" until the first picture, keys not sent before it', async () => {
  const { s, factory } = make();
  const seen = [];
  s.onChange = () => seen.push(`${s.state}/${s.reason}`);
  s.connectPassword.value = 'pw';
  s.connect();
  const t = factory.last();
  t.receive('ready', '$id');
  t.receive('size', '0', '800', '600');
  t.receive('sync', '1'); // a freshly restarted VNC server: the frame is empty
  await flushDisplay(s); await new Promise((r) => setImmediate(r));
  assert.notEqual(s.state, 'ready', `"Connected" with nothing drawn: ${seen.join(' > ')}`);
  assert.equal(s.reason, 'loading');
  assert.equal(s.message, 'Loading the screen…');
  assert.equal(s.overlay.hidden, false, 'the pane says it is not ready yet');
  s.canvas.dispatchEvent({ type: 'keydown', preventDefault() {}, key: 'a' });
  assert.equal(t.ops('key').length, 0, 'no keys sent into a screen that is not shown yet');
  t.receive('sync', '2'); // still nothing drawn
  await flushDisplay(s);
  assert.equal(s.reason, 'loading');
  t.receive('png', '14', '0', '0', '0', 'FIRST');
  t.receive('sync', '3');
  await flushDisplay(s); await new Promise((r) => setImmediate(r));
  assert.deepEqual(visibleCanvas(s).pixel(0, 0), [255, 0, 0, 255], 'the official Display painted the delayed first picture');
  assert.equal(s.state, 'ready', 'Connected once the first picture is drawn');
  assert.deepEqual(t.ops('sync').map((x) => x[1]), ['1', '2', '3'], 'every sync still answered');
  s.dispose();
});
