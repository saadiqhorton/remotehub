import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeDocument } from './helpers/fake-dom.js';
import { stubTunnelFactory } from './helpers/desktop-stub-tunnel.js';
import { DesktopSession } from '../public/js/desktop-session.js';

// Independent failure/race tests. Mocked APIs do not prove physical OS shortcuts.
const sessions = [];
afterEach(() => { for (const s of sessions.splice(0)) s.dispose(); });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const tick = () => new Promise(resolve => setImmediate(resolve));
async function fixture({ lock = async () => {}, fullscreen = async () => {}, connected = true } = {}) {
  globalThis.document = makeDocument();
  const listeners = new Map();
  window.addEventListener = (name, fn) => (listeners.get(name) || listeners.set(name, new Set()).get(name)).add(fn);
  window.removeEventListener = (name, fn) => listeners.get(name)?.delete(fn);
  const windowEvent = name => { for (const fn of [...(listeners.get(name) || [])]) fn({ type: name }); };
  const counts = { requests: 0, locks: 0, unlocks: 0, exits: 0 };
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { keyboard: {
    async lock(...args) { ++counts.locks; assert.deepEqual(args, [], 'request all available keys'); await lock(); },
    unlock() { ++counts.unlocks; },
  } } });
  document.fullscreenElement = null;
  document.exitFullscreen = async () => { ++counts.exits; document.fullscreenElement = null; document.dispatch('fullscreenchange'); };
  const tunnels = stubTunnelFactory();
  const s = new DesktopSession({ host: { id: 'independent', name: 'Verifier', address: 'localhost', desktop: { protocol: 'vnc', port: 5900 } }, createTunnel: tunnels, clipboard: null });
  sessions.push(s);
  s.pane.requestFullscreen = async () => { ++counts.requests; await fullscreen(); document.fullscreenElement = s.pane; document.dispatch('fullscreenchange'); };
  if (s.modifierProfileSelect) { s.modifierProfileSelect.value = 'meta'; s.modifierProfileSelect.dispatchEvent({ type: 'change' }); }
  s.mount(document.createElement('div')); s.show();
  if (connected) {
    s.connect(); const t = tunnels.last();
    for (const [op, ...args] of [['ready', '$id'], ['size', '0', '800', '600'], ['rect', '0', '0', '0', '8', '8'], ['cfill', '14', '0', '0', '0', '0', '255'], ['sync', '1']]) t.receive(op, ...args);
    await new Promise(resolve => s.display.flush(resolve)); assert.equal(s.state, 'ready');
  }
  return { s, tunnel: tunnels.last(), tunnels, counts, windowEvent };
}
function key(s, type, name, which, extras = {}) {
  const e = { type, key: name, which, keyCode: which, location: 0, preventDefault() { this.defaultPrevented = true; }, stopPropagation() {}, stopImmediatePropagation() {}, ...extras };
  s.canvas.dispatchEvent(e); return e;
}

test('independent: fullscreen denial never requests keyboard lock or reports locked', async () => {
  const { s, counts } = await fixture({ fullscreen: async () => { throw Error('fullscreen denied'); } });
  await s.inputCapture.enter({ fullscreen: true }); assert.equal(counts.locks, 0); assert.equal(s.inputCapture.state, 'partial');
  assert.match(s.captureStatus.textContent, /partial/i); assert.doesNotMatch(s.captureStatus.textContent, /Keyboard lock active/i);
});
test('independent: capture before a rendered desktop is a no-op', async () => {
  const { s, counts } = await fixture({ connected: false });
  await s.inputCapture.enter(); assert.equal(s.inputCapture.state, 'idle'); assert.equal(counts.requests, 0); assert.equal(counts.locks, 0);
});
for (const event of ['blur', 'pagehide', 'hidden', 'hide', 'disconnect', 'dispose']) {
  test(`independent: ${event} during pending fullscreen cancels late fullscreen and lock`, async () => {
    const fs = deferred(); const { s, counts, windowEvent } = await fixture({ fullscreen: () => fs.promise });
    const entry = s.inputCapture.enter({ fullscreen: true }); await tick();
    if (event === 'hidden') { document.hidden = true; document.dispatch('visibilitychange'); }
    else if (['hide', 'disconnect', 'dispose'].includes(event)) s[event](); else windowEvent(event);
    fs.resolve(); await entry; await tick();
    assert.equal(s.inputCapture.state, 'idle'); assert.equal(s.inputCapture.active, false);
    assert.equal(document.fullscreenElement, null, 'clean up a late fullscreen result'); assert.equal(counts.locks, 0, 'canceled intent never reaches lock');
  });
}
for (const outcome of ['resolve', 'reject']) {
  test(`independent: late lock ${outcome} after blur never revives capture`, async () => {
    const lock = deferred(); const { s, windowEvent } = await fixture({ lock: () => lock.promise });
    const entry = s.inputCapture.enter(); await tick(); windowEvent('blur');
    lock[outcome](outcome === 'reject' ? Error('late denial') : undefined); await entry; await tick();
    assert.equal(s.inputCapture.state, 'idle'); assert.equal(s.inputCapture.active, false); assert.equal(document.fullscreenElement, null);
    assert.doesNotMatch(s.captureStatus.textContent, /Keyboard lock active/i);
  });
}
test('independent: repeated capture action during entry issues one permission request', async () => {
  const lock = deferred(); const { s, counts } = await fixture({ lock: () => lock.promise });
  const first = s.inputCapture.enter(); await tick(); const second = s.inputCapture.enter(); await tick();
  assert.equal(counts.requests, 0); assert.equal(counts.locks, 1); lock.resolve(); await Promise.all([first, second]); assert.equal(s.inputCapture.state, 'locked');
});
for (const [location, which, sym] of [[1, 91, '65511'], [2, 92, '65512']]) {
  test(`independent: Meta location ${location} tap completes and held chord releases once`, async () => {
    const { s, tunnel: t, windowEvent } = await fixture(); await s.inputCapture.enter();
    key(s, 'keydown', 'Meta', which, { location, metaKey: true }); key(s, 'keyup', 'Meta', which, { location });
    assert.deepEqual(t.ops('key'), [['key', sym, '1'], ['key', sym, '0']], 'standalone tap works despite Guacamole event buffering');
    const before = t.ops('key').length;
    key(s, 'keydown', 'Meta', which, { location, metaKey: true }); key(s, 'keydown', 'a', 65, { metaKey: true });
    assert.ok(t.ops('key').slice(before).some(op => op[1] === sym && op[2] === '1'));
    windowEvent('blur');
    const releases = t.ops('key').slice(before).filter(op => op[1] === sym && op[2] === '0');
    assert.equal(releases.length, 1); windowEvent('pagehide');
    assert.equal(t.ops('key').slice(before).filter(op => op[1] === sym && op[2] === '0').length, 1);
    windowEvent('focus'); assert.equal(s.inputCapture.active, false, 'no automatic recapture on focus');
  });
}
test('independent: disconnect releases held Meta, ordinary key and every mouse button', async () => {
  const { s, tunnel: t } = await fixture(); await s.inputCapture.enter();
  key(s, 'keydown', 'Meta', 91, { location: 1, metaKey: true }); key(s, 'keydown', 'a', 65, { metaKey: true });
  s.mouse.press('left'); s.mouse.press('right'); s.disconnect();
  assert.ok(t.ops('key').some(op => op[1] === '65511' && op[2] === '0')); assert.ok(t.ops('key').some(op => op[1] === '97' && op[2] === '0'));
  assert.equal(t.ops('mouse').at(-1)[3], '0'); assert.deepEqual(Object.keys(s.keyboard.pressed), []); assert.equal(s.inputCapture.state, 'idle');
});
test('independent: capture bypasses clipboard then normal Command+V works after release', async () => {
  const { s, tunnel: t } = await fixture(); await s.inputCapture.enter();
  key(s, 'keydown', 'Meta', 91, { location: 1, metaKey: true }); key(s, 'keydown', 'v', 86, { metaKey: true });
  key(s, 'keyup', 'v', 86, { metaKey: true }); key(s, 'keyup', 'Meta', 91, { location: 1 });
  assert.deepEqual(t.ops('key'), [['key', '65511', '1'], ['key', '118', '1'], ['key', '118', '0'], ['key', '65511', '0']]); assert.equal(s.pendingPaste, null);
  const clips = t.ops('clipboard').length;
  s.canvas.dispatchEvent({ type: 'paste', preventDefault() {}, clipboardData: { getData: () => 'captured should not sync' } });
  assert.equal(t.ops('clipboard').length, clips);
  s.inputCapture.exit(); await tick(); s.focus(); const before = t.ops('key').length;
  key(s, 'keydown', 'Meta', 91, { location: 1, metaKey: true }); const v = key(s, 'keydown', 'v', 86, { metaKey: true }); assert.notEqual(v.defaultPrevented, true);
  s.canvas.dispatchEvent({ type: 'paste', preventDefault() {}, clipboardData: { getData: () => 'normal paste' } });
  key(s, 'keyup', 'v', 86, { metaKey: true }); key(s, 'keyup', 'Meta', 91, { location: 1 });
  assert.equal(t.ops('clipboard').length, clips + 1);
  assert.deepEqual(t.ops('key').slice(before), [['key', '65507', '1'], ['key', '118', '1'], ['key', '118', '0'], ['key', '65507', '0']]);
});
