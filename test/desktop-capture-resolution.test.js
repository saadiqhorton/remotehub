import { test, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { makeDocument } from './helpers/fake-dom.js';
import { stubTunnelFactory } from './helpers/desktop-stub-tunnel.js';
import { DesktopSession, TOOLBAR_INTRO_MS, TOOLBAR_LEAVE_MS } from '../public/js/desktop-session.js';

const sessions = [];
afterEach(() => { for (const s of sessions.splice(0)) s.dispose(); });

async function ready({ lock = async () => {} } = {}) {
  globalThis.document = makeDocument();
  document.fullscreenElement = null;
  document.exitFullscreen = async () => { document.fullscreenElement = null; document.dispatch('fullscreenchange'); };
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { keyboard: {
    async lock(...args) { assert.deepEqual(args, [], 'request all available keys'); await lock(); },
    async unlock() {},
  } } });
  const factory = stubTunnelFactory();
  const s = new DesktopSession({
    host: { id: 'capture-resolution', name: 'Linux', address: 'localhost', desktop: { protocol: 'vnc', port: 5900 } },
    createTunnel: factory,
    clipboard: null,
  });
  sessions.push(s);
  s.pane.requestFullscreen = async () => { document.fullscreenElement = s.pane; document.dispatch('fullscreenchange'); };
  s.mount(document.createElement('div')); s.show();
  s.viewport.clientWidth = 800; s.viewport.clientHeight = 600;
  s.connect();
  const t = factory.last();
  t.receive('ready', '$id');
  t.receive('size', '0', '800', '600');
  t.receive('rect', '0', '0', '0', '8', '8');
  t.receive('cfill', '14', '0', '0', '0', '0', '255');
  t.receive('sync', '1');
  await new Promise(resolve => s.display.flush(resolve));
  s.fit();
  const sizeCount = t.ops('size').length;
  return { s, t, sizeCount };
}

test('windowed capture follows a viewport change (e.g. browser full screen) instead of letterboxing', async () => {
  const { s, t, sizeCount } = await ready();
  await s.inputCapture.enter();
  assert.equal(t.ops('size').length, sizeCount, 'entering capture alone sends no size');
  s.viewport.clientWidth = 1600; s.viewport.clientHeight = 1200;
  s.fit();
  assert.equal(t.ops('size').at(-1).join(' '), 'size 1600 1200');
  assert.equal(s.scale, 2, 'upscaled locally while the remote catches up');
  t.receive('size', '0', '1600', '1200');
  s.fit();
  assert.equal(s.scale, 1);
  s.inputCapture.exit();
  s.fit();
  assert.equal(t.ops('size').length, sizeCount + 1, 'releasing capture alone sends no size');
});

test('fullscreen capture resizes the remote to fill the screen, then restores on exit', async () => {
  const { s, t, sizeCount } = await ready();
  await s.inputCapture.enter({ fullscreen: true });
  assert.equal(document.fullscreenElement, s.pane);
  assert.equal(s.isFullscreen, true);
  s.viewport.clientWidth = 1920; s.viewport.clientHeight = 1040;
  s.fit();
  assert.equal(t.ops('size').length, sizeCount + 1, 'one size request for the full-screen viewport');
  assert.equal(t.ops('size').at(-1).join(' '), 'size 1920 1040');
  t.receive('size', '0', '1920', '1040');
  s.fit();
  assert.equal(s.scale, 1, 'remote matches the screen: no letterbox gaps');
  assert.equal(t.ops('size').length, sizeCount + 1, 'no repeat request for the same size');
  document.fullscreenElement = null;
  document.dispatch('fullscreenchange');
  assert.equal(s.inputCapture.state, 'idle');
  s.viewport.clientWidth = 800; s.viewport.clientHeight = 600;
  s.fit();
  assert.equal(t.ops('size').at(-1).join(' '), 'size 800 600', 'windowed size returns after full screen');
});

test('fullscreen capture on a computer that refused resizing scales locally only', async () => {
  const { s, t, sizeCount } = await ready();
  s.fixedSize = { width: 800, height: 600 };
  await s.inputCapture.enter({ fullscreen: true });
  s.viewport.clientWidth = 1920; s.viewport.clientHeight = 1080;
  s.fit();
  assert.equal(t.ops('size').length, sizeCount);
  assert.equal(s.scale, Math.min(1920 / 800, 1080 / 600));
});

test('capture scaling maps local pointer coordinates to remote units', async () => {
  const { s, t } = await ready();
  await s.inputCapture.enter();
  s.viewport.clientWidth = 1600; s.viewport.clientHeight = 1200;
  s.fit();
  assert.equal(s.scale, 2);
  const before = t.ops('mouse').length;
  s.display.getElement().dispatchEvent({
    type: 'mousemove', preventDefault() {}, stopPropagation() {},
    clientX: 10, clientY: 20, pageX: 10, pageY: 20, button: 0, buttons: 0,
  });
  assert.deepEqual(t.ops('mouse').at(-1), ['mouse', '5', '10', '0']);
  assert.equal(t.ops('mouse').length, before + 1);
});

test('windowed capture states are truthful', async () => {
  const { s } = await ready({ lock: async () => { throw Error('denied'); } });
  await s.inputCapture.enter();
  assert.equal(s.inputCapture.state, 'partial');
  assert.match(s.captureStatus.textContent, /Partial capture/);
  assert.match(s.captureStatus.textContent, /System shortcuts may act locally/);
});

test('full screen floats the toolbar: shown on entry, hidden after, kept open while in use', async () => {
  const { s } = await ready();
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    await s.inputCapture.enter({ fullscreen: true });
    assert.equal(s.pane.getAttribute('data-toolbar'), 'shown', 'controls and exit hint shown on entry');
    assert.equal(s.toolbarHandle.getAttribute('aria-expanded'), 'true');
    mock.timers.tick(TOOLBAR_INTRO_MS);
    assert.equal(s.pane.getAttribute('data-toolbar'), null, 'then out of the way');
    assert.equal(s.toolbarHandle.getAttribute('aria-expanded'), 'false');
    s.toolbarHandle.dispatchEvent({ type: 'click' });
    assert.equal(s.pane.getAttribute('data-toolbar'), 'shown', 'the Controls tab brings it back');
    s.toolbar.dispatchEvent({ type: 'mouseenter' });
    mock.timers.tick(TOOLBAR_INTRO_MS * 2);
    assert.equal(s.pane.getAttribute('data-toolbar'), 'shown', 'stays while pointed at');
    s.toolbar.dispatchEvent({ type: 'mouseleave' });
    mock.timers.tick(TOOLBAR_LEAVE_MS);
    assert.equal(s.pane.getAttribute('data-toolbar'), null, 'hides once the pointer leaves');
    s.toolbarHandle.dispatchEvent({ type: 'mouseenter' });
    assert.equal(s.pane.getAttribute('data-toolbar'), 'shown');
    mock.timers.tick(TOOLBAR_INTRO_MS);
    assert.equal(s.pane.getAttribute('data-toolbar'), null, 'a reveal from the tab hides even if the pointer never reaches the toolbar');
    s.toolbarHandle.dispatchEvent({ type: 'click' });
    assert.equal(s.pane.getAttribute('data-toolbar'), 'shown');
    document.fullscreenElement = null;
    document.dispatch('fullscreenchange');
    assert.equal(s.pane.getAttribute('data-toolbar'), null, 'leaving full screen resets an open toolbar');
    assert.equal(s.toolbarHandle.getAttribute('aria-expanded'), 'false');
  } finally { mock.timers.reset(); }
});

test('the capture status keeps its full text in a tooltip', async () => {
  const { s } = await ready();
  await s.inputCapture.enter();
  assert.ok(s.captureStatus.textContent.length > 0);
  assert.equal(s.captureStatus.getAttribute('title') ?? s.captureStatus.title, s.captureStatus.textContent);
});

test('a viewport resize rescales at once and asks the remote for the size after the debounce', async () => {
  let observed = null;
  globalThis.ResizeObserver = class { constructor(cb) { observed = cb; } observe() {} disconnect() {} };
  try {
    const { s, t, sizeCount } = await ready();
    assert.equal(typeof observed, 'function', 'mount observes the viewport');
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      s.viewport.clientWidth = 400; s.viewport.clientHeight = 300;
      observed([]);
      assert.equal(s.scale, 0.5, 'picture rescaled immediately, so it never overflows');
      assert.equal(t.ops('size').length, sizeCount, 'no size request before the debounce');
      mock.timers.tick(120);
      assert.equal(t.ops('size').length, sizeCount + 1, 'exactly one size request after it');
      assert.equal(t.ops('size').at(-1).join(' '), 'size 400 300');
    } finally { mock.timers.reset(); }
  } finally { delete globalThis.ResizeObserver; }
});
