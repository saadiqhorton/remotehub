import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeDocument } from './helpers/fake-dom.js';
import { stubTunnelFactory } from './helpers/desktop-stub-tunnel.js';

/** SAA-306: chooser mounted in the Desktop view (DesktopSession). */

globalThis.document ??= makeDocument();
globalThis.window ??= { addEventListener() {}, removeEventListener() {} };
const { DesktopSession } = await import('../public/js/desktop-session.js');

const walk = (n, out = []) => { if (n && typeof n === 'object') { out.push(n); for (const c of n.children ?? []) walk(c, out); } return out; };
const byClass = (root, cls) => walk(root).filter((n) => n.classes?.has?.(cls));
const backends = (rdp, vnc) => [
  { backend: 'rdp', available: rdp, selectable: rdp, reason: rdp ? '' : 'Nothing answered on port 3389. Check that the remote computer is on and RDP remote desktop is turned on.' },
  { backend: 'vnc', available: vnc, selectable: vnc, reason: vnc ? '' : 'The service on port 5900 is not a VNC server.' },
  { backend: 'nativeStream', available: false, selectable: false, reason: 'Needs the RemoteHub agent.' },
];
const HOST = { id: 'h6', name: 'PC', address: '10.0.0.6', username: 'me', port: 22, desktop: { protocol: 'rdp', port: 3389 }, desktopBackends: backends(true, true), desktopPreference: 'auto' };

function make(extra = {}) {
  const factory = stubTunnelFactory();
  const calls = { pref: [], discover: [], agent: [] };
  const s = new DesktopSession({ host: HOST, createTunnel: factory, clipboard: null,
    setPreference: async (id, p) => { calls.pref.push([id, p]); return { host: { desktop: { protocol: p === 'vnc' ? 'vnc' : 'rdp', port: p === 'vnc' ? 5900 : 3389 }, desktopPreference: p } }; },
    discover: async (id) => { calls.discover.push(id); return { host: { desktopBackends: backends(false, true) } }; },
    onSetUpAgent: (h) => calls.agent.push(h.id), ...extra });
  s.mount(document.createElement('div')); s.show();
  return { s, factory, calls };
}

test('idle view shows the chooser and "Desktop connection: Auto: RDP"; hidden while connecting', () => {
  const { s, factory } = make();
  assert.match(s.backendArea.textContent, /Desktop connection: Auto: RDP/);
  assert.equal(byClass(s.backendArea, 'desktop-backends').length, 1);
  s.connect();
  assert.equal(s.backendArea.children.length, 0, 'not shown while live');
  factory.last().end(1000, '');
  assert.equal(byClass(s.backendArea, 'desktop-backends').length, 1, 'back after the session ends');
});

test('choosing VNC saves the preference and switches the host (password field follows the protocol)', async () => {
  const { s, calls } = make();
  assert.equal(s.connectPassword.hidden, true, 'RDP hides the up-front password');
  await s.chooseBackend('vnc');
  assert.deepEqual(calls.pref, [['h6', 'vnc']]);
  assert.equal(s.host.desktop.protocol, 'vnc');
  assert.equal(s.connectPassword.hidden, false, 'VNC shows it again');
  assert.match(s.backendArea.textContent, /Desktop connection: VNC/);
});

test('Check again runs discovery and re-renders; failures are shown; 401 goes to login', async () => {
  const { s, calls } = make();
  await s.checkBackends();
  assert.deepEqual(calls.discover, ['h6']);
  assert.match(s.backendArea.textContent, /Auto: VNC/, 'RDP gone -> Auto falls back to VNC');
  const busy = make({ discover: async () => { throw Object.assign(new Error('Desktop discovery ran moments ago; try again shortly.'), { status: 429 }); } });
  await busy.s.checkBackends();
  assert.match(busy.s.backendArea.textContent, /ran moments ago/);
  const lost = [];
  const expired = make({ discover: async () => { throw Object.assign(new Error('x'), { status: 401 }); }, onConnectionLost: () => lost.push(1) });
  await expired.s.checkBackends();
  assert.equal(lost.length, 1);
});

test('nothing available: missing-service explanation with per-backend reasons and the agent/helper path', () => {
  const { s, calls } = make({ host: { ...HOST, desktopBackends: backends(false, false) } });
  const text = s.backendArea.textContent;
  assert.match(text, /No remote desktop is available on this computer/);
  assert.match(text, /RDP: Nothing answered on port 3389\. Check that the remote computer is on and RDP remote desktop is turned on\./);
  assert.match(text, /VNC: The service on port 5900 is not a VNC server/);
  const btn = byClass(s.backendArea, 'desktop-setup-agent')[0];
  for (const fn of btn.listeners.get('click')) fn({});
  assert.deepEqual(calls.agent, ['h6']);
});

test('hosts without desktopBackends (older server) render no chooser', () => {
  const { s } = make({ host: { ...HOST, desktopBackends: undefined } });
  assert.equal(s.backendArea.children.length, 0);
});
