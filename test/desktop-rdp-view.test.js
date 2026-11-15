import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeDocument } from './helpers/fake-dom.js';
import { stubTunnelFactory } from './helpers/desktop-stub-tunnel.js';

/** SAA-304 Desktop view: RDP password via prompt only, 4409 trust flow, 4410 state. */

globalThis.document ??= makeDocument();
globalThis.window ??= { addEventListener() {}, removeEventListener() {} };
const { DesktopSession, CLOSE_STATES } = await import('../public/js/desktop-session.js');
const { DESKTOP_CLOSE } = await import('../public/js/desktop-tunnel.js');
const { DESKTOP_CLOSE: SERVER_CLOSE } = await import('../server/desktop-bridge.js');

const RDP_HOST = { id: 'r1', name: 'Win', address: '10.0.0.9', username: 'me', port: 22, desktop: { protocol: 'rdp', port: 3389, username: 'alice', certPin: 'sha256:aa' } };
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');

function make(extra = {}) {
  const factory = stubTunnelFactory();
  const lost = [];
  const resets = [];
  const s = new DesktopSession({
    host: RDP_HOST, createTunnel: factory, clipboard: null,
    onConnectionLost: () => lost.push(1),
    resetCertPin: async (id) => { resets.push(id); return { host: { ...RDP_HOST, desktop: { ...RDP_HOST.desktop, certPin: null } } }; },
    ...extra,
  });
  s.mount(document.createElement('div'));
  s.show();
  return { s, factory, lost, resets };
}

test('close tables: 4409/4410 on server, tunnel and view', () => {
  assert.deepEqual({ ...DESKTOP_CLOSE }, { ...SERVER_CLOSE });
  assert.equal(DESKTOP_CLOSE.CERT_CHANGED, 4409);
  assert.equal(DESKTOP_CLOSE.CERT_UNAVAILABLE, 4410);
  assert.equal(CLOSE_STATES[4409][0], 'failed');
  assert.equal(CLOSE_STATES[4409][1], 'cert-changed');
  assert.equal(CLOSE_STATES[4410][0], 'unavailable');
  assert.equal(CLOSE_STATES[4410][1], 'cert-check-failed');
});

test('RDP: no up-front password; password answered once through the required prompt', () => {
  const { s, factory } = make();
  assert.equal(s.connectPassword.hidden, true, 'up-front password field hidden for RDP');
  s.connectPassword.value = 'should-not-be-sent';
  s.connect();
  assert.equal(factory.last().options.password, '', 'no password in credentials for RDP');
  const t = factory.last();
  t.receive('ready', '$id');
  t.receive('required', 'password');
  assert.equal(s.state, 'authentication');
  s.argvInputs.get('password').value = 'Rdp-Pw-1';
  s.submitCredentials();
  assert.equal(t.ops('argv').length, 1);
  assert.deepEqual(t.ops('blob')[0].slice(2), [b64('Rdp-Pw-1')]);
  assert.equal(s.argvInputs.size, 0, 'prompt fields dropped after answering');
  // Reconnect asks again: a fresh connection, no password carried over.
  s.disconnect();
  s.connect();
  assert.equal(factory.last().options.password, '');
  factory.last().receive('ready', '$id2');
  factory.last().receive('required', 'password');
  assert.equal(s.argvInputs.get('password').value ?? '', '');
});

test('4409: failed + cert-changed explanation + Trust button; trusting resets pin then reconnects', async () => {
  const { s, factory, resets } = make();
  s.connect();
  assert.equal(s.trustCertButton.hidden, true);
  factory.last().end(4409, 'This computer looks different from last time. If you expected that, click “Trust this computer again”.');
  assert.equal(s.state, 'failed');
  assert.equal(s.reason, 'cert-changed');
  assert.equal(s.pane.getAttribute('data-reason'), 'cert-changed');
  assert.match(s.statusText.textContent, /looks different from the last time/);
  assert.equal(s.trustCertButton.hidden, false);
  const before = factory.made.length;
  await s.trustNewCertificate();
  assert.deepEqual(resets, ['r1']);
  assert.equal(factory.made.length, before + 1, 'reconnected after reset');
  assert.equal(s.state, 'connecting');
  assert.equal(s.trustCertButton.hidden, true);
  assert.equal(s.host.desktop.certPin, null);
});

test('4409 trust: refused when not in cert-changed state; 401 goes to login; other errors stay failed', async () => {
  const { s, resets } = make();
  await s.trustNewCertificate();
  assert.deepEqual(resets, [], 'no reset outside the cert-changed state');
  const unauth = make({ resetCertPin: async () => { throw Object.assign(new Error('Your session expired.'), { status: 401 }); } });
  unauth.s.connect();
  unauth.factory.last().end(4409, '');
  await unauth.s.trustNewCertificate();
  assert.equal(unauth.s.reason, 'login');
  assert.equal(unauth.lost.length, 1);
  const broken = make({ resetCertPin: async () => { throw Object.assign(new Error('Host not found.'), { status: 404 }); } });
  broken.s.connect();
  broken.factory.last().end(4409, '');
  const made = broken.factory.made.length;
  await broken.s.trustNewCertificate();
  assert.equal(broken.s.state, 'failed');
  assert.match(broken.s.statusText.textContent, /couldn’t trust this computer again/);
  assert.equal(broken.factory.made.length, made, 'no reconnect when the reset failed');
});

test('4410: unavailable with explanation and the server detail; no trust button', () => {
  const { s, factory } = make();
  s.connect();
  factory.last().end(4410, 'RemoteHub can’t open a remote desktop on this computer. Try VNC instead.');
  assert.equal(s.state, 'unavailable');
  assert.equal(s.reason, 'cert-check-failed');
  assert.equal(s.statusText.textContent, 'RemoteHub can’t open a remote desktop on this computer. Try VNC instead.', 'server sentence shown as-is');
  assert.equal(s.trustCertButton.hidden, true);
  assert.equal(s.connectForm.hidden, false, 'Reconnect offered');
});

test('VNC unchanged: up-front password still sent', () => {
  const { s, factory } = make({ host: { ...RDP_HOST, desktop: { protocol: 'vnc', port: 5900 } } });
  assert.ok(!s.connectPassword.hidden);
  s.connectPassword.value = 'vnc-pw';
  s.connect();
  assert.equal(factory.last().options.password, 'vnc-pw');
});
