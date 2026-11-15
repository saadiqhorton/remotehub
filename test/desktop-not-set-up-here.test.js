// Review ruling (PR #26): RemoteHub's own missing desktop helper is not the remote computer's fault.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hostActions } from '../public/js/host-actions.js';

const HERE = 'Remote desktop isn’t set up in this copy of RemoteHub yet. You can still connect with the terminal.';
const REMOTE = 'No remote desktop is available on this computer.';
const base = { capabilities: { terminal: { ssh: true }, desktop: {} } };
const desk = (h) => hostActions(h)[2];
const term = (h) => hostActions(h)[0];

test('helper missing or Desktop off: says this copy of RemoteHub, terminal still works', () => {
  for (const h of [
    { ...base, desktopServerEnabled: false, desktopProtocols: { rdp: true, vnc: true } },
    { ...base, desktopServerEnabled: false, desktopProtocols: null },
    { ...base, desktopServerEnabled: true, desktopProtocols: { rdp: false, vnc: false } },
  ]) {
    assert.equal(desk(h).reason, HERE);
    assert.equal(desk(h).enabled, false);
    assert.equal(term(h).enabled, true);
  }
});

test('helper present and discovery found nothing: says the remote computer has none', () => {
  const ok = { desktopServerEnabled: true, desktopProtocols: { rdp: true, vnc: true } };
  assert.equal(desk({ ...base, ...ok }).reason, REMOTE);
  const probed = { ...base, ...ok, desktopDiscovery: { rdp: { available: false }, vnc: { available: false } }, desktopBackends: [
    { backend: 'rdp', available: false, selectable: false, reason: 'Nothing answered on port 3389. Check that the remote computer is on and RDP remote desktop is turned on.' },
    { backend: 'vnc', available: false, selectable: false, reason: 'Nothing answered on port 5900. Check that the remote computer is on and VNC remote desktop is turned on.' },
    { backend: 'nativeStream', available: false, selectable: false, reason: 'Needs the RemoteHub agent installed on this computer.' }] };
  assert.equal(desk(probed).reason, `${REMOTE} RDP: Nothing answered on port 3389. Check that the remote computer is on and RDP remote desktop is turned on. VNC: Nothing answered on port 5900. Check that the remote computer is on and VNC remote desktop is turned on.`);
  assert.ok(!desk(probed).reason.includes(HERE));
  // Only one plugin missing is not "not set up": the remote-computer wording stays.
  assert.equal(desk({ ...base, desktopServerEnabled: true, desktopProtocols: { rdp: false, vnc: true } }).reason, REMOTE);
});
