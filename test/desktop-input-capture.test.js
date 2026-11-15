import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeDocument } from './helpers/fake-dom.js';
import { stubTunnelFactory } from './helpers/desktop-stub-tunnel.js';
import { DesktopSession } from '../public/js/desktop-session.js';

const sessions = [];
afterEach(() => { for (const s of sessions.splice(0)) s.dispose(); });
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
async function ready({ lock = async () => {}, fullscreen = true } = {}) {
  globalThis.document = makeDocument();
  const listeners = new Map();
  globalThis.window.addEventListener = (type, fn) => (listeners.get(type) || listeners.set(type, new Set()).get(type)).add(fn);
  globalThis.window.removeEventListener = (type, fn) => listeners.get(type)?.delete(fn);
  const windowEvent = (type) => { for (const fn of listeners.get(type) || []) fn({}); };
  let locks = 0, unlocks = 0, fullscreenRequests = 0;
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { keyboard: lock ? { lock(...args) { ++locks; assert.equal(args.length, 0, 'request all available keys'); return lock(); }, unlock() { ++unlocks; } } : {} } });
  document.fullscreenElement = null;
  document.exitFullscreen = async () => { document.fullscreenElement = null; document.dispatch('fullscreenchange'); };
  const factory = stubTunnelFactory();
  const s = new DesktopSession({ host: { id: 'capture', name: 'Linux', address: 'localhost', desktop: { protocol: 'vnc', port: 5900 } }, createTunnel: factory, clipboard: null });
  sessions.push(s);
  if (fullscreen) s.pane.requestFullscreen = async (options) => { assert.equal(options?.keyboardLock, 'browser', 'request browser shortcut capture on supporting engines'); ++fullscreenRequests; document.fullscreenElement = s.pane; document.dispatch('fullscreenchange'); };
  s.mount(document.createElement('div')); s.show(); s.connect();
  const t = factory.last(); t.receive('ready', '$id'); t.receive('size', '0', '800', '600');
  t.receive('rect', '0', '0', '0', '8', '8'); t.receive('cfill', '14', '0', '0', '0', '0', '255'); t.receive('sync', '1');
  await new Promise((resolve) => s.display.flush(resolve));
  return { s, t, windowEvent, counts: () => ({ locks, unlocks, fullscreenRequests }) };
}
const key = (s, type, name, which, extras = {}) => s.canvas.dispatchEvent({ type, key: name, which, keyCode: which, preventDefault() { this.defaultPrevented = true; }, stopPropagation() {}, stopImmediatePropagation() {}, ...extras });

test('default capture is windowed and lock state follows resolved request', async () => {
  const pending = deferred();
  const { s, counts } = await ready({ lock: () => pending.promise });
  assert.equal(counts().fullscreenRequests, 0);
  assert.ok(s.captureButton, 'ready desktop offers explicit input capture');
  const entry = s.inputCapture.enter();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(document.fullscreenElement, null);
  assert.equal(s.inputCapture.state, 'entering');
  assert.equal(s.releaseCaptureButton.hidden, false, 'cancel remains available while requesting');
  assert.equal(s.toolbar.parentNode, s.pane);
  pending.resolve(); await entry;
  assert.equal(s.inputCapture.state, 'locked');
  assert.match(s.captureStatus.textContent, /Keyboard lock active/);
  assert.match(s.captureStatus.textContent, /system shortcuts.*local/i);
  s.inputCapture.exit();
  assert.equal(s.inputCapture.state, 'idle');
  assert.equal(counts().unlocks, 1);
});

for (const options of [{ lock: null }, { lock: async () => { throw new Error('denied'); } }]) {
  test(`unavailable or denied capture stays partial: ${JSON.stringify(options)}`, async () => {
    const { s } = await ready(options);
    assert.ok(s.inputCapture, 'desktop exposes supported capture controller');
    await s.inputCapture.enter();
    assert.equal(s.inputCapture.state, 'partial');
    assert.match(s.captureStatus.textContent, /Partial capture/);
    assert.doesNotMatch(s.captureStatus.textContent, /Keyboard lock active/);
  });
}

test('capture forwards Meta+V as a remote shortcut without native paste', async () => {
  const { s, t } = await ready();
  assert.ok(s.inputCapture, 'desktop exposes supported capture controller');
  await s.inputCapture.enter();
  key(s, 'keydown', 'Meta', 91, { metaKey: true, location: 1 });
  key(s, 'keydown', 'v', 86, { metaKey: true });
  key(s, 'keyup', 'v', 86, { metaKey: true });
  key(s, 'keyup', 'Meta', 91, { location: 1 });
  assert.deepEqual(t.ops('key'), [['key', '65515', '1'], ['key', '118', '1'], ['key', '118', '0'], ['key', '65515', '0']]);
  assert.equal(s.pendingPaste, null);
});

for (const exit of ['blur', 'hidden', 'fullscreen', 'hide', 'disconnect']) {
  test(`${exit} exits capture and releases held input`, async () => {
    const { s, t, windowEvent } = await ready();
    assert.ok(s.inputCapture, 'desktop exposes supported capture controller');
  await s.inputCapture.enter({ fullscreen: true });
    s.keyboard.press(65507); s.keyboard.press(97);
    s.mouse.press('left');
    if (exit === 'blur') windowEvent('blur');
    if (exit === 'hidden') { document.hidden = true; document.dispatch('visibilitychange'); }
  if (exit === 'fullscreen') { document.fullscreenElement = null; document.dispatch('fullscreenchange'); }
    if (exit === 'hide') s.hide();
    if (exit === 'disconnect') s.disconnect();
    assert.equal(s.inputCapture.state, 'idle');
    assert.equal(Object.keys(s.keyboard.pressed).length, 0);
    assert.ok(t.ops('key').some((op) => op[1] === '65507' && op[2] === '0'));
    assert.ok(t.ops('key').some((op) => op[1] === '97' && op[2] === '0'));
    assert.equal(t.ops('mouse').at(-1)?.[3], '0', 'all mouse buttons released before disconnect');
  });
}

test('exit while lock is pending cannot resurrect capture', async () => {
  const pending = deferred(); const { s, counts } = await ready({ lock: () => pending.promise });
  assert.ok(s.inputCapture, 'desktop exposes supported capture controller');
  const entry = s.inputCapture.enter({ fullscreen: true }); await new Promise((resolve) => setImmediate(resolve));
  s.inputCapture.exit(); pending.resolve(); await entry;
  assert.equal(s.inputCapture.state, 'idle');
  assert.equal(document.fullscreenElement, null);
  assert.ok(counts().unlocks >= 1);
});

test('losing fullscreen does not exit windowed capture', async () => {
  const { s } = await ready();
  await s.inputCapture.enter();
  document.fullscreenElement = s.pane;
  document.dispatch('fullscreenchange');
  assert.equal(s.inputCapture.state, 'locked');
  document.fullscreenElement = null;
  document.dispatch('fullscreenchange');
  assert.equal(s.inputCapture.state, 'locked');
});

test('full-screen capture falls back when keyboardLock option is unsupported', async () => {
  const { s } = await ready({ fullscreen: false });
  let calls = 0;
  s.pane.requestFullscreen = async (options) => {
    ++calls;
    if (options?.keyboardLock === 'browser') {
      const error = new Error('keyboardLock option unsupported');
      error.name = 'NotSupportedError';
      throw error;
    }
    document.fullscreenElement = s.pane;
    document.dispatch('fullscreenchange');
  };
  await s.inputCapture.enter({ fullscreen: true });
  assert.equal(calls, 2, 'retry plain fullscreen after NotSupportedError');
  assert.equal(document.fullscreenElement, s.pane);
  assert.equal(s.inputCapture.state, 'locked');
});

test('full-screen capture without keyboard lock stays partial and exits on fullscreen loss', async () => {
  const { s } = await ready({ lock: null });
  await s.inputCapture.enter({ fullscreen: true });
  assert.equal(document.fullscreenElement, s.pane);
  assert.equal(s.inputCapture.state, 'partial');
  document.fullscreenElement = null;
  document.dispatch('fullscreenchange');
  assert.equal(s.inputCapture.state, 'idle');
});

test('toolbar shows windowed and full-screen capture controls appropriately', async () => {
  const { s } = await ready();
  assert.equal(s.captureButton.hidden, false, 'windowed capture is offered when ready');
  assert.equal(s.fullscreenCaptureButton.hidden, false, 'full-screen capture is offered when ready');
  await s.inputCapture.enter();
  assert.equal(s.captureButton.hidden, true, 'capture entry hides the windowed button');
  assert.equal(s.fullscreenCaptureButton.hidden, true, 'capture entry hides the full-screen button');
  assert.equal(s.releaseCaptureButton.hidden, false, 'release stays available while captured');
  s.inputCapture.exit();
  assert.equal(s.captureButton.hidden, false);
  assert.equal(s.fullscreenCaptureButton.hidden, false);
});
for (const [location, keyCode, superSym] of [[1, 91, '65515'], [2, 92, '65516']]) {
  test(`captured physical Meta ${location} presses Super immediately and releases once`, async () => {
    const { s, t } = await ready(); await s.inputCapture.enter();
    key(s, 'keydown', 'Meta', keyCode, { metaKey: true, location });
    assert.deepEqual(t.ops('key'), [['key', superSym, '1']], 'do not wait for another event to deliver a held Super');
    key(s, 'keyup', 'Meta', keyCode, { location });
    assert.deepEqual(t.ops('key'), [['key', superSym, '1'], ['key', superSym, '0']], 'upstream queue must not duplicate the tap');
  });
}

test('profile changes release the mapped held Super before forwarding Meta/Command', async () => {
  const { s, t } = await ready(); await s.inputCapture.enter();
  assert.ok(s.modifierProfileSelect, 'remote key meaning is an explicit visible profile');
  assert.equal(s.modifierProfileSelect.value, 'super');
  key(s, 'keydown', 'Meta', 91, { metaKey: true, location: 1 });
  s.modifierProfileSelect.value = 'meta';
  s.modifierProfileSelect.dispatchEvent({ type: 'change' });
  assert.deepEqual(t.ops('key'), [['key', '65515', '1'], ['key', '65515', '0']]);
  key(s, 'keydown', 'Meta', 91, { metaKey: true, location: 1 });
  key(s, 'keyup', 'Meta', 91, { location: 1 });
  assert.deepEqual(t.ops('key').slice(-2), [['key', '65511', '1'], ['key', '65511', '0']]);
});

test('exit releases mapped Super and clears the buffered physical Meta before next typing', async () => {
  const { s, t } = await ready(); await s.inputCapture.enter();
  key(s, 'keydown', 'Meta', 91, { metaKey: true, location: 1 });
  s.inputCapture.exit();
  key(s, 'keydown', 'x', 88);
  key(s, 'keyup', 'x', 88);
  assert.deepEqual(t.ops('key'), [['key', '65515', '1'], ['key', '65515', '0'], ['key', '120', '1'], ['key', '120', '0']]);
});
for (const [profile, expected] of [['super', '65515'], ['meta', '65511']]) {
  test(`already named Super uses the ${profile} profile without a duplicate Meta press`, async () => {
    const { s, t } = await ready(); await s.inputCapture.enter();
    s.modifierProfileSelect.value = profile; s.modifierProfileSelect.dispatchEvent({ type: 'change' });
    key(s, 'keydown', 'Super', 91, { code: 'MetaLeft', metaKey: true, location: 1 });
    key(s, 'keyup', 'Super', 91, { code: 'MetaLeft', location: 1 });
    assert.deepEqual(t.ops('key'), [['key', expected, '1'], ['key', expected, '0']]);
  });
}
test('fallback cleanup releases retained aliases once when Guacamole pressed state is empty', async () => {
  const { s, t } = await ready(); await s.inputCapture.enter();
  // Exercise the forwarded-state fallback independently of Guacamole's reset:
  // both aliases were sent, but the input abstraction has no pressed entries.
  s.sendKey(65511, 1);
  s.sendKey(65515, 1);
  assert.deepEqual(Object.keys(s.keyboard.pressed), []);
  assert.equal(s.forwardedKeysyms.size, 2);
  assert.deepEqual(t.ops('key'), [['key', '65515', '1']], 'aliases share one remote press');
  s.releaseInput();
  s.releaseInput();
  assert.deepEqual(t.ops('key'), [['key', '65515', '1'], ['key', '65515', '0']], 'fallback and repeated cleanup release the remote modifier once');
  assert.equal(s.forwardedKeysyms.size, 0);
});
