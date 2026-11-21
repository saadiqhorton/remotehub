import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { makeDocument } from './helpers/fake-dom.js';
import { stubTunnelFactory } from './helpers/desktop-stub-tunnel.js';
import { desktopTunnelUrl } from '../public/js/desktop-tunnel.js';

/** SAA-347: automatic reconnect on the desktop view (Apache Guacamole web client behavior). */

globalThis.document = makeDocument();
const winListeners = new Map();
const on = (map) => ({
  addEventListener(type, fn) { (map.get(type) || map.set(type, new Set()).get(type)).add(fn); },
  removeEventListener(type, fn) { map.get(type)?.delete(fn); },
  dispatch(type) { for (const fn of [...(map.get(type) || [])]) fn({ type }); },
});
globalThis.window = on(winListeners);
const docListeners = new Map();
Object.assign(document, { addEventListener: on(docListeners).addEventListener, removeEventListener: on(docListeners).removeEventListener, visibilityState: 'visible', hidden: false });
const docEvents = on(docListeners);
let online = true;
Object.defineProperty(globalThis.navigator, 'onLine', { configurable: true, get: () => online });
const { DesktopSession, reconnectDecision, RECONNECT_CODES, RECONNECT_BACKOFF_SEC, RECONNECT_STEADY_SEC, RECONNECT_BUDGET_MS } = await import('../public/js/desktop-session.js');
// The first attempts use the backoff; the rest of the 5-minute budget the steady interval.
const RECONNECT_DELAYS_SEC = RECONNECT_BACKOFF_SEC;
const FAKE = { apis: ['setTimeout', 'setInterval', 'Date'] };

const HOST = { id: 'h1', name: 'Box', address: '10.0.0.5', username: 'me', port: 22, desktop: { protocol: 'vnc', port: 5901, username: null } };

function make() {
  const factory = stubTunnelFactory();
  const lost = [];
  const s = new DesktopSession({ host: HOST, createTunnel: factory, onConnectionLost: () => lost.push(1) });
  s.vncExplain = async () => null;
  s.mount(document.createElement('div'));
  s.show();
  return { s, factory, lost };
}
// The real order: ready, the screen size, then the frame-done sync (drawn on a later tick).
async function live(t) { t.receive('ready', '$id'); t.receive('size', '0', '800', '600'); t.receive('rect', '0', '0', '0', '8', '8'); t.receive('cfill', '14', '0', '0', '0', '0', '255'); t.receive('sync', '1'); await new Promise((r) => setImmediate(r)); }
const flushDisplay = (s) => new Promise((resolve) => s.display.flush(resolve));
async function readySession(password = 'pw-1') {
  const ctx = make();
  ctx.s.connectPassword.value = password;
  ctx.s.connect();
  await live(ctx.factory.last());
  assert.equal(ctx.s.state, 'ready');
  return ctx;
}
const JARGON = /guacd|tls|\b\d{3,4}\b|websocket|socket|status code|settings|check the|troubleshoot/i;

// Every close code the desktop view knows about, with whether it reconnects on its own.
const TABLE = [
  [1000, true, false], [1003, true, false], [1007, true, false], [1008, true, false],
  [1006, true, true], [1006, false, false], // 1006 with no handshake = HTTP 403/503 refusal
  [1011, true, true], [4401, true, false], [4404, true, false], [4409, true, false], [4410, true, false],
  [1011, true, true, 0x0202], [1011, true, true, 0x0208], [1011, true, false, 769], [1011, true, false, 0x0301],
  [4502, true, true], [4503, true, true], [1001, true, false], [1005, true, false], [4000, true, false],
];

test('reconnect decision table over every known close code (allow-list: 1006, 1011, 4502, 4503)', async () => {
  assert.deepEqual([...RECONNECT_CODES].sort(), [1006, 1011, 4502, 4503]);
  for (const [code, opened, expected, guacStatus] of TABLE) {
    assert.equal(reconnectDecision({ code, opened, guacStatus }), expected, `code ${code} opened=${opened} status=${guacStatus}`);
  }
});

test('a recoverable drop counts down, reconnects with the held password and never asks for it', async () => {
  mock.timers.enable(FAKE);
  try {
    const { s, factory } = await readySession();
    const firstAttempt = factory.last().options;
    assert.match(firstAttempt.pageTraceId, /^[a-z0-9-]{8,64}$/i);
    assert.match(firstAttempt.traceId, /^[a-z0-9-]{8,64}$/i);
    assert.equal(firstAttempt.attempt, 1);
    assert.equal(firstAttempt.attemptCause, 'user');
    factory.last().end(4502, 'Desktop service stopped unexpectedly.');
    assert.equal(s.state, 'connecting');
    assert.equal(s.reason, 'reconnecting');
    assert.match(s.message, new RegExp(`Reconnecting in ${RECONNECT_DELAYS_SEC[0]}…`));
    assert.doesNotMatch(s.message, JARGON);
    assert.equal(s.disconnectButton.hidden, false, 'Disconnect stays available during the countdown');
    assert.equal(s.connectForm.hidden, true, 'no password form during the countdown');
    mock.timers.tick(1000);
    assert.match(s.message, new RegExp(`Reconnecting in ${RECONNECT_DELAYS_SEC[0] - 1}…`));
    assert.equal(factory.made.length, 1);
    mock.timers.tick((RECONNECT_DELAYS_SEC[0] - 1) * 1000);
    assert.equal(factory.made.length, 2, 'reconnected automatically');
    assert.equal(factory.last().options.password, 'pw-1', 'held password reused');
    assert.equal(factory.last().options.pageTraceId, firstAttempt.pageTraceId);
    assert.equal(factory.last().options.traceId, firstAttempt.traceId);
    assert.equal(factory.last().options.attempt, 2);
    assert.equal(factory.last().options.attemptCause, 'auto-retry');
    await live(factory.last());
    assert.equal(s.state, 'ready');
    // A second drop later starts again from the first (short) delay.
    factory.last().end(1006, '', true);
    assert.match(s.message, new RegExp(`Reconnecting in ${RECONNECT_DELAYS_SEC[0]}…`));
    mock.timers.tick(RECONNECT_DELAYS_SEC[0] * 1000);
    assert.equal(factory.last().options.pageTraceId, firstAttempt.pageTraceId);
    assert.equal(factory.last().options.traceId, firstAttempt.traceId);
    assert.equal(factory.last().options.attempt, 3);
    assert.equal(factory.last().options.attemptCause, 'auto-retry');
    s.disconnect();
  } finally { mock.timers.reset(); }
});

test('a password asked by the desktop during a reconnect is answered from memory, no prompt', async () => {
  mock.timers.enable(FAKE);
  try {
    const { s, factory } = make();
    s.connect(); // no password up front
    factory.last().receive('ready', '$id');
    factory.last().receive('required', 'password');
    assert.equal(s.state, 'authentication');
    s.argvInputs.get('password').value = 'typed-pw';
    s.submitCredentials();
    await live(factory.last());
    factory.last().end(4502);
    mock.timers.tick(RECONNECT_DELAYS_SEC[0] * 1000);
    const t = factory.last();
    t.receive('ready', '$id');
    t.receive('required', 'password');
    assert.notEqual(s.state, 'authentication', 'never shows the sign-in prompt again');
    const blob = t.ops('blob')[0];
    assert.equal(Buffer.from(blob[2], 'base64').toString(), 'typed-pw');
    s.disconnect();
  } finally { mock.timers.reset(); }
});

test('Disconnect during the countdown cancels it, and forgets the password', async () => {
  mock.timers.enable(FAKE);
  try {
    const { s, factory } = await readySession();
    factory.last().end(4503);
    s.disconnect();
    assert.equal(s.state, 'disconnected');
    assert.equal(s.reason, 'user');
    assert.equal(s.hasHeldPassword, false);
    mock.timers.tick(60000);
    assert.equal(factory.made.length, 1, 'no reconnect after Disconnect');
  } finally { mock.timers.reset(); }
});

test('Disconnect while connected never reconnects and forgets the password', async () => {
  mock.timers.enable(FAKE);
  try {
    const { s, factory } = await readySession();
    s.disconnect();
    factory.last().end(1006, '', true); // a late close event after the user's Disconnect
    mock.timers.tick(60000);
    assert.equal(factory.made.length, 1);
    assert.equal(s.state, 'disconnected');
    assert.equal(s.hasHeldPassword, false);
  } finally { mock.timers.reset(); }
});

test('logging out (the tab is disposed) during a countdown never reconnects', async () => {
  mock.timers.enable(FAKE);
  try {
    const { s, factory } = await readySession();
    factory.last().end(4502);
    s.dispose();
    mock.timers.tick(60000);
    assert.equal(factory.made.length, 1);
    assert.equal(s.hasHeldPassword, false);
  } finally { mock.timers.reset(); }
});

test('schedule: 2, 4, 8, 16 s, then every 30 s, for up to 5 minutes; then the plain failed state', async () => {
  mock.timers.enable(FAKE);
  try {
    assert.deepEqual([...RECONNECT_BACKOFF_SEC], [2, 4, 8, 16]);
    assert.equal(RECONNECT_STEADY_SEC, 30);
    assert.equal(RECONNECT_BUDGET_MS, 5 * 60 * 1000);
    const { s, factory } = await readySession();
    factory.last().end(4502);
    const waits = [];
    let elapsed = 0;
    for (;;) {
      if (s.reason !== 'reconnecting') break;
      const n = Number(s.message.match(/Reconnecting in (\d+)…/)[1]);
      waits.push(n);
      const made = factory.made.length;
      mock.timers.tick(n * 1000 - 1);
      assert.equal(factory.made.length, made, 'not before the countdown ends');
      mock.timers.tick(1);
      elapsed += n;
      assert.equal(factory.made.length, made + 1);
      factory.last().end(4503, 'Desktop service is not running.');
    }
    assert.deepEqual(waits.slice(0, 5), [2, 4, 8, 16, 30]);
    assert.ok(waits.slice(4).every((w) => w === 30), `steady 30 s: ${waits}`);
    assert.equal(elapsed, 300, 'stops at the 5-minute budget');
    assert.equal(s.state, 'failed');
    assert.equal(s.reason, 'reconnect-failed');
    assert.doesNotMatch(s.message, JARGON);
    assert.equal(s.connectForm.hidden, false);
    assert.equal(s.connectButton.textContent, 'Reconnect');
    const total = factory.made.length;
    mock.timers.tick(600000);
    assert.equal(factory.made.length, total, 'nothing more after the budget');
    s.connect();
    assert.equal(factory.last().options.password, 'pw-1', 'manual Reconnect still uses the held password');
    s.disconnect();
  } finally { mock.timers.reset(); }
});

test('the tab becoming visible again retries at once', async () => {
  mock.timers.enable(FAKE);
  try {
    const { s, factory } = await readySession();
    factory.last().end(4502); mock.timers.tick(2000); factory.last().end(4503); mock.timers.tick(4000); factory.last().end(4503);
    assert.match(s.message, /Reconnecting in 8…/);
    const made = factory.made.length;
    document.visibilityState = 'hidden'; document.hidden = true; docEvents.dispatch('visibilitychange');
    assert.equal(factory.made.length, made, 'hiding does nothing');
    document.visibilityState = 'visible'; document.hidden = false; docEvents.dispatch('visibilitychange');
    assert.equal(factory.made.length, made + 1, 'retried immediately');
    await live(factory.last());
    assert.equal(s.state, 'ready');
    docEvents.dispatch('visibilitychange');
    assert.equal(factory.made.length, made + 1, 'no retry when nothing is pending');
    s.disconnect();
  } finally { mock.timers.reset(); }
});

test('offline: "Waiting for network…", no retries burned, resumes at once when online', async () => {
  mock.timers.enable(FAKE);
  try {
    const { s, factory } = await readySession();
    online = false; window.dispatch('offline');
    factory.last().end(1006, '', true);
    assert.equal(s.reason, 'waiting-network');
    assert.equal(s.message, 'Waiting for network…');
    assert.equal(s.disconnectButton.hidden, false);
    mock.timers.tick(20 * 60 * 1000); // far past the 5-minute budget
    assert.equal(factory.made.length, 1, 'no attempts while offline');
    online = true; window.dispatch('online');
    assert.equal(factory.made.length, 2, 'retried as soon as the network is back');
    factory.last().end(4503);
    assert.match(s.message, /Reconnecting in 4…/, 'only the one real attempt counted; the offline wait used no retries');
    // Going offline during a countdown pauses it too.
    online = false; window.dispatch('offline');
    assert.equal(s.reason, 'waiting-network');
    mock.timers.tick(60000);
    assert.equal(factory.made.length, 2);
    online = true; window.dispatch('online');
    assert.equal(factory.made.length, 3);
    await live(factory.last());
    assert.equal(s.state, 'ready');
    s.disconnect();
  } finally { online = true; mock.timers.reset(); }
});

test('review: Disconnect while waiting for network leaves disconnected so Reconnect works', async () => {
  mock.timers.enable(FAKE);
  try {
    const { s, factory } = await readySession();
    online = false; window.dispatch('offline');
    factory.last().end(1006, '', true);
    assert.equal(s.reason, 'waiting-network');
    assert.equal(s.tunnel, null);
    s.disconnect();
    assert.equal(s.state, 'disconnected');
    assert.equal(s.reason, 'user');
    assert.equal(s.connectForm.hidden, false, 'Reconnect form is available again');
    assert.equal(s.hasHeldPassword, false);
    const made = factory.made.length;
    online = true; window.dispatch('online');
    mock.timers.tick(60000);
    assert.equal(factory.made.length, made, 'coming online after Disconnect must not auto-retry');
    s.connect();
    assert.equal(factory.made.length, made + 1, 'manual Reconnect still works');
    s.disconnect();
  } finally { online = true; mock.timers.reset(); }
});

test('online/visible events never reconnect after Disconnect, logout, or a stop code', async () => {
  mock.timers.enable(FAKE);
  try {
    const a = await readySession(); a.factory.last().end(4502); a.s.disconnect();
    const b = await readySession(); b.factory.last().end(4502); b.s.dispose();
    const c = await readySession(); c.factory.last().end(4409);
    window.dispatch('online'); docEvents.dispatch('visibilitychange');
    mock.timers.tick(600000);
    assert.equal(a.factory.made.length + b.factory.made.length + c.factory.made.length, 3);
    c.s.dispose();
  } finally { mock.timers.reset(); }
});

test('codes outside the allow-list stop and wait for the user', async () => {
  mock.timers.enable(FAKE);
  try {
    for (const [code, opened, expected, guacStatus] of TABLE) {
      if (expected) continue;
      const { s, factory } = await readySession();
      if (guacStatus) factory.last().receive('error', 'Authentication failure', String(guacStatus));
      factory.last().end(code, '', opened);
      assert.notEqual(s.reason, 'reconnecting', `code ${code}`);
      mock.timers.tick(60000);
      assert.equal(factory.made.length, 1, `code ${code} must not reconnect`);
      s.dispose();
    }
  } finally { mock.timers.reset(); }
});

test('a first connection that fails before the desktop ever showed is not retried (e.g. wrong password)', async () => {
  mock.timers.enable(FAKE);
  try {
    const { s, factory } = make();
    s.connectPassword.value = 'wrong';
    s.connect();
    factory.last().receive('ready', '$id');
    factory.last().receive('error', 'Aborted. See logs.', '519');
    factory.last().end(1011);
    mock.timers.tick(60000);
    assert.equal(factory.made.length, 1);
    assert.equal(s.state, 'failed');
    assert.equal(s.hasHeldPassword, false, 'a password that did not work is not kept');
  } finally { mock.timers.reset(); }
});

// SAA-347 / PR #28 review: openTunnel must drop a prior connection's guacd error so a
// later 1011 is decided from this attempt alone (e.g. stale 0x0301 must not block reconnect).
test('openTunnel clears a stale remoteErrorStatus so a later 1011 can auto-reconnect', async () => {
  mock.timers.enable(FAKE);
  try {
    const { s, factory } = await readySession();
    factory.last().end(4502);
    assert.equal(s.reason, 'reconnecting');
    // Leftover from a previous attempt that openTunnel must not carry into the next one.
    s.remoteError = 'The remote desktop ran into a problem. Click Reconnect to try again.';
    s.remoteErrorStatus = 0x0301;
    mock.timers.tick(RECONNECT_DELAYS_SEC[0] * 1000);
    assert.equal(factory.made.length, 2, 'automatic retry opened a new tunnel');
    assert.equal(s.remoteError, null, 'openTunnel cleared the stale error text');
    assert.equal(s.remoteErrorStatus, undefined, 'openTunnel cleared the stale guacd status');
    factory.last().end(1011); // no new error instruction — decision must not use the old 0x0301
    assert.equal(s.reason, 'reconnecting', '1011 still auto-reconnects after openTunnel reset');
    assert.notEqual(s.state, 'failed');
    s.disconnect();
  } finally { mock.timers.reset(); }
});

test('the password lives only in page memory: no storage, cookies, URL or server copy', async () => {
  for (const file of ['public/js/desktop-session.js', 'public/js/desktop-tunnel.js']) {
    const src = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
    assert.doesNotMatch(src, /localStorage|sessionStorage|indexedDB|document\.cookie|caches\.open|history\.(push|replace)State/, file);
  }
  const url = desktopTunnelUrl({ host: HOST, width: 800, height: 600, location: { protocol: 'http:', host: 'remotehub.test' } });
  assert.doesNotMatch(url, /pw-secret/, 'password never goes into the tunnel URL');
  assert.deepEqual([...new URL(url).searchParams.keys()].sort(), ['dpi', 'height', 'hostId', 'width'], 'URL contains only non-secret connection parameters');
  const { s } = await readySession('pw-secret');
  assert.equal(JSON.stringify(Object.fromEntries(Object.entries(s).filter(([, v]) => typeof v === 'string'))).includes('pw-secret'), false, 'not a public field');
  assert.equal(s.hasHeldPassword, true);
  s.dispose();
  assert.equal(s.hasHeldPassword, false);
});

// ── PR #25 review fixes ──────────────────────────────────────────

test('review: changing the desktop address, port or protocol forgets the password and stops any reconnect', async () => {
  mock.timers.enable(FAKE);
  try {
    for (const change of [{ address: '10.0.0.99' }, { desktop: { ...HOST.desktop, port: 5902 } }, { desktop: { ...HOST.desktop, protocol: 'rdp' } }]) {
      // During a countdown: the countdown stops, nothing is sent anywhere.
      const a = await readySession();
      a.factory.last().end(4502);
      a.s.updateHost({ ...HOST, ...change });
      assert.equal(a.s.hasHeldPassword, false, JSON.stringify(change));
      assert.notEqual(a.s.reason, 'reconnecting');
      assert.doesNotMatch(a.s.message, JARGON);
      mock.timers.tick(600000);
      assert.equal(a.factory.made.length, 1, 'no reconnect to the new endpoint');
      a.s.dispose();
      // While connected: a later drop does not carry the old password to the new endpoint.
      const b = await readySession();
      b.s.updateHost({ ...HOST, ...change });
      assert.equal(b.s.hasHeldPassword, false);
      b.factory.last().end(4502);
      mock.timers.tick(600000);
      assert.equal(b.factory.made.length, 1, 'no automatic reconnect after the endpoint changed');
      b.s.dispose();
    }
    // A rename only keeps everything.
    const c = await readySession();
    c.s.updateHost({ ...HOST, name: 'Renamed' });
    assert.equal(c.s.hasHeldPassword, true);
    c.factory.last().end(4502);
    assert.equal(c.s.reason, 'reconnecting');
    c.s.dispose();
  } finally { mock.timers.reset(); }
});

test('review: editing the endpoint aborts an in-flight automatic retry before the new host applies', async () => {
  mock.timers.enable(FAKE);
  try {
    const { s, factory } = await readySession();
    const first = factory.last();
    first.end(4502);
    mock.timers.tick(2000); // start the first automatic retry
    const retry = factory.last();
    assert.notEqual(retry, first);
    assert.equal(s.autoReconnecting, true);
    assert.equal(s.tunnel, retry);
    assert.equal(retry.options.password, 'pw-1');
    s.updateHost({ ...HOST, address: '10.0.0.99' });
    assert.equal(retry.closed, true, 'old-endpoint tunnel is closed');
    assert.equal(s.tunnel, null);
    assert.equal(s.hasHeldPassword, false, 'credentials for the old endpoint are forgotten');
    assert.equal(s.state, 'disconnected');
    assert.equal(s.reason, 'host-changed');
    assert.equal(s.host.address, '10.0.0.99');
    // Stale ready/close from the aborted retry must not revive the session or keep credentials.
    retry.receive('ready', '$stale');
    retry.receive('size', '0', '800', '600');
    retry.receive('sync', '1');
    await new Promise((r) => setImmediate(r));
    assert.equal(s.state, 'disconnected');
    assert.equal(s.hasHeldPassword, false);
    const made = factory.made.length;
    mock.timers.tick(600000);
    assert.equal(factory.made.length, made, 'no further automatic reconnect to either endpoint');
    s.dispose();
  } finally { mock.timers.reset(); }
});

test('review: an RDP password answered at the prompt is reused from memory on an automatic reconnect', async () => {
  mock.timers.enable(FAKE);
  try {
    const RDP = { ...HOST, desktop: { protocol: 'rdp', port: 3389, username: 'me' } };
    const factory = stubTunnelFactory();
    const s = new DesktopSession({ host: RDP, createTunnel: factory });
    s.mount(document.createElement('div')); s.show();
    s.connect();
    assert.equal(factory.last().options.password, '', 'RDP never sends a password up front');
    factory.last().receive('ready', '$id');
    factory.last().receive('required', 'username', 'password');
    s.argvInputs.get('username').value = 'me';
    s.argvInputs.get('password').value = 'rdp-pw';
    s.submitCredentials();
    await live(factory.last());
    assert.equal(s.hasHeldPassword, true);
    factory.last().end(4502);
    mock.timers.tick(2000);
    const t = factory.last();
    assert.equal(t.options.password, '', 'still not sent up front on the retry');
    t.receive('ready', '$id');
    t.receive('required', 'username', 'password');
    assert.notEqual(s.state, 'authentication', 'no sign-in prompt during the reconnect');
    const sent = t.ops('blob').map(([, , data]) => Buffer.from(data, 'base64').toString());
    assert.deepEqual(sent, ['me', 'rdp-pw']);
    await live(t);
    assert.equal(s.state, 'ready');
    s.disconnect();
    assert.equal(s.hasHeldPassword, false);
  } finally { mock.timers.reset(); }
});

test('review: drawing work from a dropped connection can neither block nor draw into the reconnected one', async () => {
  const factory = stubTunnelFactory();
  const previousImage = globalThis.Image;
  let finishOldImage;
  globalThis.Image = class DelayedTestImage extends previousImage {
    set src(value) {
      if (String(value).includes(Buffer.from('stuck').toString('base64'))) finishOldImage = () => this.onload?.();
      else super.src = value;
    }
  };
  const s = new DesktopSession({ host: HOST, createTunnel: factory });
  s.vncExplain = async () => null;
  s.mount(document.createElement('div')); s.show();
  s.connectPassword.value = 'pw'; s.connect();
  await live(factory.last());
  const oldDisplay = s.display;
  factory.last().receive('png', '14', '0', '0', '0', Buffer.from('stuck').toString('base64')); // a decode that never finishes on the old connection
  mock.timers.enable(FAKE);
  try {
    factory.last().end(4502);
    mock.timers.tick(2000);
  } finally { mock.timers.reset(); }
  const t = factory.last();
  t.receive('ready', '$id');
  t.receive('size', '0', '800', '600'); t.receive('rect', '0', '0', '0', '8', '8'); t.receive('cfill', '14', '0', '0', '0', '0', '255');
  const freshPixels = Buffer.from(JSON.stringify([[[0, 0, 255, 255]]])).toString('base64');
  t.receive('png', '14', '0', '0', '0', freshPixels);
  t.receive('sync', '2');
  await flushDisplay(s);
  assert.equal(s.state, 'ready', 'the new connection is not stuck behind the old decode');
  const newCanvas = s.display.getElement().querySelector('canvas');
  assert.deepEqual(newCanvas.pixel(0, 0), [0, 0, 255, 255], 'the new picture finished painting');
  finishOldImage?.(); // the stale decode finishes late on its detached official display
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((resolve) => oldDisplay.flush(resolve));
  assert.equal(s.display.getElement().parentNode, s.canvas, 'the reconnected display remains mounted');
  assert.notEqual(s.display, oldDisplay, 'the stale display cannot become the new session display');
  assert.deepEqual(newCanvas.pixel(0, 0), [0, 0, 255, 255], 'late old pixels cannot overwrite the new picture');
  s.dispose();
  globalThis.Image = previousImage;
});

test('review: RDP order on auto-reconnect (ready, early sync, then required) keeps reconnecting and reuses the answers, no prompt', async () => {
  mock.timers.enable(FAKE);
  try {
    const RDP = { ...HOST, desktop: { protocol: 'rdp', port: 3389, username: 'me' } };
    const factory = stubTunnelFactory();
    const s = new DesktopSession({ host: RDP, createTunnel: factory });
    s.mount(document.createElement('div')); s.show();
    s.connect();
    const first = factory.last();
    first.receive('ready', '$id');
    first.receive('sync', '0'); // guacd/RDP: a frame-done signal before anything is drawn
    await flushDisplay(s);
    assert.notEqual(s.state, 'ready', 'no "Connected" before the screen size arrived');
    first.receive('required', 'username', 'password');
    s.argvInputs.get('username').value = 'me';
    s.argvInputs.get('password').value = 'rdp-pw';
    s.submitCredentials();
    first.receive('size', '0', '800', '600'); first.receive('rect', '0', '0', '0', '8', '8'); first.receive('cfill', '14', '0', '0', '0', '0', '255'); first.receive('sync', '1'); await flushDisplay(s);
    assert.equal(s.state, 'ready');
    first.end(4502);
    mock.timers.tick(2000);
    const t = factory.last();
    assert.notEqual(t, first, 'reconnected automatically');
    const seen = [];
    s.onChange = () => seen.push(s.state);
    t.receive('ready', '$id');
    t.receive('sync', '0'); // the same early signal on the retry
    await flushDisplay(s);
    t.receive('required', 'username', 'password');
    assert.ok(!seen.includes('authentication') && s.state !== 'authentication', `no sign-in prompt during the reconnect: ${seen.join(' > ')}`);
    assert.ok(!seen.includes('ready'), `no "Connected" before the desktop is drawn: ${seen.join(' > ')}`);
    const sent = t.ops('blob').map(([, , data]) => Buffer.from(data, 'base64').toString());
    assert.deepEqual(sent, ['me', 'rdp-pw'], 'saved answers reused');
    t.receive('size', '0', '800', '600'); t.receive('rect', '0', '0', '0', '8', '8'); t.receive('cfill', '14', '0', '0', '0', '0', '255'); t.receive('sync', '2'); await flushDisplay(s);
    assert.equal(s.state, 'ready');
    s.disconnect();
  } finally { mock.timers.reset(); }
});
