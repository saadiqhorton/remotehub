import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeDocument } from './helpers/fake-dom.js';
import { stubTunnelFactory } from './helpers/desktop-stub-tunnel.js';

/** SAA-352: RDP targets that refuse a resize. The tab reconnects once at the computer's own size with resizing off. */

globalThis.document ??= makeDocument();
globalThis.window ??= { addEventListener() {}, removeEventListener() {} };
globalThis.navigator ??= {};
const { DesktopSession, RESIZE_CONFIRM_MS, RECONNECT_BACKOFF_SEC } = await import('../public/js/desktop-session.js');
const { desktopTunnelUrl } = await import('../public/js/desktop-tunnel.js');
const FAKE = { apis: ['setTimeout', 'setInterval', 'Date'] };

const RDP_HOST = { id: 'r1', name: 'Win', address: '10.0.0.9', username: 'me', port: 22, desktop: { protocol: 'rdp', port: 3389, username: 'alice', certPin: 'sha256:aa' } };
const VNC_HOST = { ...RDP_HOST, desktop: { protocol: 'vnc', port: 5900 } };
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');

function make(extra = {}) {
  const factory = stubTunnelFactory();
  const lost = [];
  const s = new DesktopSession({
    host: RDP_HOST, createTunnel: factory, clipboard: null,
    onConnectionLost: () => lost.push(1),
    ...extra,
  });
  s.mount(document.createElement('div'));
  s.show();
  return { s, factory, lost };
}

// The real order: ready, the screen size, then a painted frame and its sync (drawn on a later tick).
async function live(t, width, height) {
  t.receive('ready', '$id');
  t.receive('size', '0', String(width), String(height));
  t.receive('rect', '0', '0', '0', '8', '8');
  t.receive('cfill', '14', '0', '0', '0', '0', '255');
  t.receive('sync', '1');
  await new Promise((r) => setImmediate(r));
}

// Drives a connection that the target refuses at connect: the handshake size 1032x716 bounces to 1024x768.
function refusedAtConnect(s, factory) {
  s.viewport.clientWidth = 1032;
  s.viewport.clientHeight = 716;
  s.connect();
  const t1 = factory.last();
  t1.receive('size', '0', '1032', '716');
  t1.receive('size', '0', '1024', '768');
  return t1;
}

test('SAA-352 regression: refused size at connect (real guacd sequence) reconnects once at the computer\'s own size with resizing off', async (t) => {
  t.mock.timers.enable(FAKE);
  const { s, factory } = make();
  s.viewport.clientWidth = 1032;
  s.viewport.clientHeight = 716;
  s.connect();
  const t1 = factory.last();
  assert.deepEqual({ width: t1.options.width, height: t1.options.height }, s.viewportSize());
  t1.receive('ready', '$id');
  t1.receive('required', 'password');
  s.argvInputs.get('password').value = 'Rdp-Pw-1';
  s.submitCredentials();
  t1.receive('size', '0', '1032', '716');
  t1.receive('size', '0', '1024', '768');

  assert.equal(factory.made.length, 2, 'one reconnect');
  assert.equal(t1.closed, true, 'old tunnel closed');
  const t2 = factory.last();
  assert.equal(t2.options.fixed, true);
  assert.equal(t2.options.width, 1024);
  assert.equal(t2.options.height, 768);
  assert.deepEqual(s.fixedSize, { width: 1024, height: 768 });
  assert.equal(s.state, 'connecting');
  assert.equal(s.reason, 'resize-fallback');
  assert.equal(s.pane.getAttribute('data-resize'), 'fixed');

  // The new connection asks for the password again: answered from memory, no prompt.
  t2.receive('ready', '$id');
  t2.receive('required', 'password');
  assert.equal(t2.ops('argv').length, 1);
  assert.deepEqual(t2.ops('blob')[0].slice(2), [b64('Rdp-Pw-1')]);
  assert.equal(s.argvInputs.size, 0, 'no sign-in prompt shown');
  assert.notEqual(s.state, 'authentication');

  // Late events from the old connection change nothing.
  const before = { state: s.state, reason: s.reason, message: s.message };
  t1.receive('error', 'Aborted. See logs.', '520');
  t1.end(1011, 'Aborted. See logs.');
  assert.deepEqual({ state: s.state, reason: s.reason, message: s.message }, before);
  assert.equal(s.tunnel, t2);
  s.disconnect();
});

test('after the fallback the tab never sends size again and scales locally', async (t) => {
  t.mock.timers.enable(FAKE);
  const { s, factory } = make();
  refusedAtConnect(s, factory);
  const t2 = factory.last();
  await live(t2, 1024, 768);
  assert.equal(s.state, 'ready');
  s.viewport.clientWidth = 512;
  s.viewport.clientHeight = 384;
  s.fit();
  assert.deepEqual(t2.ops('size'), []);
  assert.equal(s.scale, 0.5, 'scaled down to the viewport');
  s.disconnect();
});

test('refused resize request (size then revert) falls back', async (t) => {
  t.mock.timers.enable(FAKE);
  const { s, factory } = make();
  s.viewport.clientWidth = 1280;
  s.viewport.clientHeight = 800;
  s.connect();
  const t1 = factory.last();
  await live(t1, 1280, 800);
  assert.equal(s.state, 'ready');
  s.viewport.clientWidth = 1600;
  s.viewport.clientHeight = 1000;
  s.fit();
  assert.deepEqual(t1.ops('size'), [['size', '1600', '1000']]);
  t1.receive('size', '0', '1600', '1000');
  assert.equal(factory.made.length, 1, 'accepted so far');
  t1.receive('size', '0', '1280', '800');

  assert.equal(factory.made.length, 2);
  assert.deepEqual(s.fixedSize, { width: 1280, height: 800 });
  assert.equal(factory.last().options.fixed, true);
  assert.equal(factory.last().options.width, 1280);
  assert.equal(factory.last().options.height, 800);
  assert.equal(s.pane.getAttribute('data-resize'), 'fixed');
  s.disconnect();
});

// CI (compose acceptance, guacd 1.6.0 + xrdp refusing every resize): the request is echoed at the
// requested size, then guacd aborts the session (error 520). That is a refusal, not a transient drop:
// reconnecting at the same size just repeats the refused request. Fall back at the size it had.
test('SAA-352 regression: resize echoed then aborted (error 520) falls back at the size before the request', async (t) => {
  t.mock.timers.enable(FAKE);
  const { s, factory } = make();
  s.viewport.clientWidth = 1280;
  s.viewport.clientHeight = 800;
  s.connect();
  const t1 = factory.last();
  await live(t1, 1280, 800);
  s.viewport.clientWidth = 1600;
  s.viewport.clientHeight = 1000;
  s.fit();
  t1.receive('size', '0', '1600', '1000');
  t1.receive('error', 'Aborted. See logs.', '520');
  t1.end(1011, 'Aborted. See logs.');

  assert.equal(factory.made.length, 2, 'one reconnect, not a retry loop');
  assert.equal(factory.last().options.fixed, true);
  assert.deepEqual(s.fixedSize, { width: 1280, height: 800 });
  assert.equal(s.reason, 'resize-fallback');
  s.disconnect();
});

test('an abort with no resize request outstanding is still a normal reconnect', async (t) => {
  t.mock.timers.enable(FAKE);
  const { s, factory } = make();
  s.viewport.clientWidth = 1280;
  s.viewport.clientHeight = 800;
  s.connect();
  const t1 = factory.last();
  await live(t1, 1280, 800);
  t1.receive('error', 'Aborted. See logs.', '520');
  t1.end(1011, 'Aborted. See logs.');
  t.mock.timers.tick(RECONNECT_BACKOFF_SEC[0] * 1000);

  assert.equal(factory.made.length, 2);
  assert.equal(factory.last().options.fixed, undefined);
  assert.equal(s.fixedSize, null);
  s.disconnect();
});

test('no reply to a resize within RESIZE_CONFIRM_MS falls back; a reply in time does not', async (t) => {
  t.mock.timers.enable(FAKE);
  assert.equal(RESIZE_CONFIRM_MS, 5000);

  // (a) nothing comes back: fall back at the size the remote last reported.
  const a = make();
  a.s.viewport.clientWidth = 1280;
  a.s.viewport.clientHeight = 800;
  a.s.connect();
  await live(a.factory.last(), 1280, 800);
  a.s.viewport.clientWidth = 1600;
  a.s.viewport.clientHeight = 1000;
  a.s.fit();
  t.mock.timers.tick(RESIZE_CONFIRM_MS - 1);
  assert.equal(a.factory.made.length, 1, 'not yet');
  t.mock.timers.tick(1);
  assert.equal(a.factory.made.length, 2);
  assert.deepEqual(a.s.fixedSize, { width: 1280, height: 800 });
  assert.equal(a.factory.last().options.fixed, true);
  a.s.disconnect();

  // (b) the matching size arrives in time: no fallback.
  const b = make();
  b.s.viewport.clientWidth = 1280;
  b.s.viewport.clientHeight = 800;
  b.s.connect();
  await live(b.factory.last(), 1280, 800);
  b.s.viewport.clientWidth = 1600;
  b.s.viewport.clientHeight = 1000;
  b.s.fit();
  b.factory.last().receive('size', '0', '1600', '1000');
  t.mock.timers.tick(RESIZE_CONFIRM_MS + 1000);
  assert.equal(b.factory.made.length, 1, 'no reconnect');
  assert.equal(b.s.fixedSize, null);
  assert.equal(b.s.state, 'ready');
  assert.equal(b.s.pane.getAttribute('data-resize'), null);
  b.s.disconnect();
});

test('SAA-352 regression: a later resize with no reply falls back even after an earlier request was accepted', async (t) => {
  t.mock.timers.enable(FAKE);
  const { s, factory } = make();
  s.viewport.clientWidth = 800;
  s.viewport.clientHeight = 600;
  s.connect();
  const t1 = factory.last();
  await live(t1, 800, 600);
  // The first request is echoed at its own size: accepted.
  s.viewport.clientWidth = 1024;
  s.viewport.clientHeight = 768;
  s.fit();
  t1.receive('size', '0', '1024', '768');
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(s.remoteSize, { width: 1024, height: 768 });
  // The second request gets no reply: the earlier 1024x768 echo must not count as an answer to it.
  s.viewport.clientWidth = 1280;
  s.viewport.clientHeight = 720;
  s.fit();
  t.mock.timers.tick(RESIZE_CONFIRM_MS - 1);
  assert.equal(factory.made.length, 1, 'not yet');
  t.mock.timers.tick(1);
  assert.equal(factory.made.length, 2);
  assert.deepEqual(s.fixedSize, { width: 1024, height: 768 });
  assert.equal(factory.last().options.fixed, true);
  s.disconnect();
});

test('SAA-352 regression: a late echo for an accepted old size cannot satisfy the newest resize request', async (t) => {
  t.mock.timers.enable(FAKE);
  const { s, factory } = make();
  s.viewport.clientWidth = 800;
  s.viewport.clientHeight = 600;
  s.connect();
  const tunnel = factory.last();
  await live(tunnel, 800, 600);

  s.viewport.clientWidth = 1024;
  s.viewport.clientHeight = 768;
  s.fit();
  tunnel.receive('size', '0', '1024', '768');
  assert.deepEqual(s.remoteSize, { width: 1024, height: 768 });

  s.viewport.clientWidth = 1280;
  s.viewport.clientHeight = 720;
  s.fit();
  // The old size is delayed until after the newer request. Only an echo near the
  // latest requested size can confirm that request.
  tunnel.receive('size', '0', '1024', '768');
  assert.equal(factory.made.length, 1, 'a late old echo is not an immediate fallback');
  t.mock.timers.tick(RESIZE_CONFIRM_MS - 1);
  assert.equal(factory.made.length, 1, 'the newest request still has its confirmation window');
  t.mock.timers.tick(1);
  assert.equal(factory.made.length, 2, 'the unconfirmed newest request falls back');
  assert.deepEqual(s.fixedSize, { width: 1024, height: 768 }, 'fallback uses the last confirmed remote size');
  s.disconnect();
});

test('SAA-352 regression: queued replies for three successive size requests are accepted in order', async (t) => {
  t.mock.timers.enable(FAKE);
  const { s, factory } = make();
  s.viewport.clientWidth = 800;
  s.viewport.clientHeight = 600;
  s.connect();
  const tunnel = factory.last();
  await live(tunnel, 800, 600);

  const sizes = [[1024, 768], [1280, 720], [1600, 900]];
  for (const [width, height] of sizes) {
    s.viewport.clientWidth = width;
    s.viewport.clientHeight = height;
    s.fit();
  }
  assert.deepEqual(tunnel.ops('size').slice(-3), [
    ['size', '1024', '768'], ['size', '1280', '720'], ['size', '1600', '900'],
  ]);
  for (const [width, height] of sizes) tunnel.receive('size', '0', String(width), String(height));
  t.mock.timers.tick(RESIZE_CONFIRM_MS + 100);
  assert.equal(factory.made.length, 1, 'earlier queued replies do not cause a false refusal');
  assert.equal(s.fixedSize, null);
  assert.deepEqual(s.remoteSize, { width: 1600, height: 900 });
  s.disconnect();
});

test('normal resizing keeps working: repeated accepted resizes never fall back', async (t) => {
  t.mock.timers.enable(FAKE);
  const { s, factory } = make();
  s.viewport.clientWidth = 1280;
  s.viewport.clientHeight = 800;
  s.connect();
  const t1 = factory.last();
  await live(t1, 1280, 800);
  // Each request is answered; the odd width 1025 comes back as 1024 (guacd rounds to even).
  const requests = [[1600, 1000, 1600, 1000], [1601, 900, 1600, 900], [1025, 768, 1024, 768]];
  for (const [w, h, answerW, answerH] of requests) {
    s.viewport.clientWidth = w;
    s.viewport.clientHeight = h;
    s.fit();
    t1.receive('size', '0', String(answerW), String(answerH));
  }
  assert.equal(factory.made.length, 1, 'still one connection');
  assert.equal(s.fixedSize, null);
  assert.equal(s.state, 'ready');
  assert.deepEqual(t1.ops('size'), [['size', '1600', '1000'], ['size', '1601', '900'], ['size', '1025', '768']]);
  t.mock.timers.tick(RESIZE_CONFIRM_MS * 2);
  assert.equal(factory.made.length, 1, 'no late fallback either');
  s.disconnect();
});

test('VNC is unaffected: the same bounce keeps the connection and sends no fixed option', async (t) => {
  t.mock.timers.enable(FAKE);
  const { s, factory } = make({ host: VNC_HOST });
  s.viewport.clientWidth = 1032;
  s.viewport.clientHeight = 716;
  s.connect();
  const t1 = factory.last();
  await live(t1, 1032, 716);
  t1.receive('size', '0', '1024', '768');
  assert.equal(factory.made.length, 1);
  assert.equal(t1.options.fixed, undefined);
  assert.equal(s.fixedSize, null);
  assert.equal(s.pane.getAttribute('data-resize'), null);
  assert.equal(s.state, 'ready');
  s.viewport.clientWidth = 1600;
  s.viewport.clientHeight = 1000;
  s.fit();
  assert.deepEqual(t1.ops('size'), [['size', '1600', '1000']], 'VNC still sends resizes');
  t.mock.timers.tick(RESIZE_CONFIRM_MS * 2);
  assert.equal(factory.made.length, 1);
  s.disconnect();
});

test('desktopTunnelUrl adds fixed=1 only when asked', () => {
  const location = { host: 'h:1', protocol: 'http:' };
  const host = { id: 'a' };
  assert.equal(desktopTunnelUrl({ host, width: 800, height: 600, location }), 'ws://h:1/ws/desktop?hostId=a&width=800&height=600&dpi=96');
  assert.equal(desktopTunnelUrl({ host, width: 800, height: 600, fixed: false, location }), 'ws://h:1/ws/desktop?hostId=a&width=800&height=600&dpi=96');
  assert.equal(desktopTunnelUrl({ host, width: 800, height: 600, fixed: true, location }), 'ws://h:1/ws/desktop?hostId=a&width=800&height=600&dpi=96&fixed=1');
});

test('a changed computer address clears the fixed size', async (t) => {
  t.mock.timers.enable(FAKE);
  const { s, factory } = make();
  refusedAtConnect(s, factory);
  assert.deepEqual(s.fixedSize, { width: 1024, height: 768 });
  s.updateHost({ ...RDP_HOST, address: '10.0.0.99' });
  assert.equal(s.fixedSize, null);
  assert.equal(s.pane.getAttribute('data-resize'), null);
  s.disconnect();
});

test('a size request equal to the remote\'s current size is not watched (guacd sends no reply): no fallback', async (t) => {
  t.mock.timers.enable(FAKE);
  const { s, factory } = make();
  s.viewport.clientWidth = 1024;
  s.viewport.clientHeight = 768;
  s.connect();
  const t1 = factory.last();
  await live(t1, 1024, 768);
  assert.equal(s.state, 'ready');
  assert.deepEqual(s.remoteSize, s.viewportSize(), 'remote already at the viewport size');
  s.fit();
  assert.deepEqual(t1.ops('size'), [['size', '1024', '768']], 'one post-ready size request');
  // guacd skips a request equal to its current size, so no size arrives in reply.
  t.mock.timers.tick(RESIZE_CONFIRM_MS + 1000);
  assert.equal(factory.made.length, 1, 'no reconnect');
  assert.equal(s.fixedSize, null);
  assert.equal(s.state, 'ready');
  s.disconnect();
});
