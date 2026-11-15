import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DESKTOP_BACKEND_ORDER, NATIVE_NOT_YET, NOT_CHECKED, desktopBackends, selectDesktopBackend } from '../public/js/desktop-auto.js';

/** SAA-306: Auto selection. Fixed order RDP > VNC; native listed but not selectable. */

const up = { available: true };
// Order/availability tests model backends found on ports the owner saved (confirmed);
// the unconfirmed-port rule has its own tests below.
const confirmedBackends = (input) => desktopBackends(input).map((b) => ({ ...b, unconfirmed: false }));
const down = (reason) => ({ available: false, reason });

test('documented order and every availability combination', () => {
  assert.deepEqual(DESKTOP_BACKEND_ORDER, ['rdp', 'vnc', 'nativeStream']);
  for (const rdp of [true, false]) for (const vnc of [true, false]) for (const native of [true, false]) {
    const b = confirmedBackends({ discovery: { rdp: rdp ? up : down('no rdp'), vnc: vnc ? up : down('no vnc') }, capabilities: { desktop: { nativeStream: native } } });
    const pick = selectDesktopBackend(b, 'auto');
    const want = rdp ? 'rdp' : vnc ? 'vnc' : null;
    assert.equal(pick.backend, want, JSON.stringify({ rdp, vnc, native }));
    if (!want) {
      assert.equal(pick.reasons.rdp, 'no rdp');
      assert.equal(pick.reasons.vnc, 'no vnc');
      assert.equal(pick.helper, !native, 'agent/helper path offered only when no agent reports native');
    } else assert.equal(pick.auto, true);
  }
});

test('native stream: listed when an agent reports it, never selectable (SAA-311)', () => {
  const b = confirmedBackends({ capabilities: { desktop: { nativeStream: true } } });
  const native = b.find((x) => x.backend === 'nativeStream');
  assert.deepEqual([native.available, native.selectable, native.reason], [true, false, NATIVE_NOT_YET]);
  assert.equal(selectDesktopBackend(b, 'auto').backend, null);
  const explicit = selectDesktopBackend(b, 'nativeStream');
  assert.equal(explicit.backend, null);
  assert.match(explicit.reason, /own desktop streaming isn't available yet/);
});

test('explicit choice wins when available, fails with a reason otherwise; unknown preference = auto', () => {
  const b = confirmedBackends({ discovery: { rdp: up, vnc: up } });
  assert.deepEqual(selectDesktopBackend(b, 'vnc'), { backend: 'vnc', auto: false });
  const noVnc = confirmedBackends({ discovery: { rdp: up, vnc: down('VNC refused on 5900') } });
  const r = selectDesktopBackend(noVnc, 'vnc');
  assert.equal(r.backend, null);
  assert.match(r.reason, /VNC is not available: VNC refused on 5900/);
  assert.equal(selectDesktopBackend(b, 'ssh').backend, 'rdp');
  assert.equal(selectDesktopBackend(undefined).backend, null);
});

test('guacd plugin missing or Desktop off makes a backend unavailable; configured capability counts as offered', () => {
  const b = confirmedBackends({ discovery: { rdp: up, vnc: up }, guacdProtocols: { rdp: false } });
  assert.equal(selectDesktopBackend(b).backend, 'vnc');
  assert.equal(b[0].reason, 'Remote desktop isn’t set up in this copy of RemoteHub yet. You can still connect with the terminal.');
  assert.doesNotMatch(b[0].reason, /add-on|required|missing|This RemoteHub/);
  const off = confirmedBackends({ discovery: { rdp: up }, guacdEnabled: false });
  assert.equal(off[0].reason, 'Remote desktop isn’t set up in this copy of RemoteHub yet. You can still connect with the terminal.');
  const configured = confirmedBackends({ capabilities: { desktop: { vnc: true } } });
  assert.equal(configured[1].source, 'configured');
  assert.equal(selectDesktopBackend(configured).backend, 'vnc');
  assert.equal(confirmedBackends({ guacdProtocols: { rdp: undefined }, discovery: { rdp: up } })[0].available, true, 'unknown plugin state counts as present');
});

test('selection never reads the OS', () => {
  const src = readFileSync(new URL('../public/js/desktop-auto.js', import.meta.url), 'utf8');
  assert.ok(!/\b(os|platform|windows|macos|darwin|linux)\b/i.test(src.replace(/^\/\/.*$/gm, '')), 'no OS names in code');
  const a = confirmedBackends({ discovery: { rdp: down('x'), vnc: up }, capabilities: { os: 'windows', desktop: {} } });
  assert.equal(selectDesktopBackend(a).backend, 'vnc', 'a Windows host without RDP still gets VNC');
});

// SAA-306 real run: a configured backend whose latest probe found nothing is unavailable.
test('latest probe overrides saved settings', async () => {
  const { desktopBackends: db, selectDesktopBackend: sel } = await import('../public/js/desktop-auto.js');
  const caps = { desktop: { vnc: true } };
  const down = db({ capabilities: caps, discovery: { vnc: { available: false, reason: 'Nothing answered on port 15901. Check that the remote computer is on and VNC remote desktop is turned on.' } } });
  const vnc = down.find((b) => b.backend === 'vnc');
  assert.equal(vnc.available, false);
  assert.match(vnc.reason, /15901/);
  const picked = sel(down, 'auto');
  assert.equal(picked.backend, null);
  assert.equal(picked.helper, true);
  assert.equal(db({ capabilities: caps }).find((b) => b.backend === 'vnc').source, 'configured');
});

// Review (1): RDP without TLS is listed but Auto never picks it; an explicit pick may.
test('RDP without TLS is unsupported: plain-language reason, not available, Auto skips it, explicit pick refused with the same message', async () => {
  const { NO_TLS_RDP } = await import('../public/js/desktop-auto.js');
  assert.equal(NO_TLS_RDP, "RemoteHub can't open a remote desktop on this computer. Try VNC instead.");
  assert.doesNotMatch(NO_TLS_RDP, /TLS|pin|certificate/i, 'no jargon');
  const saved = { protocol: 'rdp', port: 3389 };
  const b = desktopBackends({ discovery: { rdp: { available: true, port: 3389, tls: false }, vnc: down('no vnc') }, saved });
  const rdp = b.find((x) => x.backend === 'rdp');
  assert.deepEqual([rdp.available, rdp.selectable, rdp.insecure, rdp.reason], [false, false, true, NO_TLS_RDP]);
  const auto = selectDesktopBackend(b, 'auto');
  assert.equal(auto.backend, null, 'Auto skips it');
  assert.equal(auto.reasons.rdp, NO_TLS_RDP);
  const explicit = selectDesktopBackend(b, 'rdp');
  assert.deepEqual([explicit.backend, explicit.reason], [null, NO_TLS_RDP], 'explicit pick refused with the same message');
  const both = desktopBackends({ discovery: { rdp: { available: true, port: 3389, tls: false }, vnc: { available: true, port: 5901 } }, saved: { protocol: 'vnc', port: 5901 } });
  assert.equal(selectDesktopBackend(both, 'auto').backend, 'vnc', 'Auto falls through to VNC');
});

// Review ruling: found ONLY on a port the owner did not save -> shown, never auto-chosen,
// usable only with a confirmation naming that exact port.
test('unconfirmed port: listed available, never chosen by Auto, needs a matching confirmation', () => {
  const b = desktopBackends({ discovery: { rdp: down('no rdp'), vnc: { available: true, port: 15901 } } });
  const vnc = b.find((x) => x.backend === 'vnc');
  assert.deepEqual([vnc.available, vnc.selectable, vnc.unconfirmed, vnc.port], [true, true, true, 15901]);
  assert.match(vnc.note, /found; you’ll be asked to confirm/);
  const auto = selectDesktopBackend(b, 'auto');
  assert.equal(auto.backend, null, 'never auto-chosen');
  assert.deepEqual(auto.needsConfirm, { protocol: 'vnc', port: 15901 });
  assert.equal(auto.reason, 'VNC was found in a place you haven’t used for this computer before. Confirm it to use it.');
  assert.equal(selectDesktopBackend(b, 'vnc').backend, null, 'explicit pick also needs confirmation');
  assert.equal(selectDesktopBackend(b, 'auto', { confirm: { protocol: 'vnc', port: 15901 } }).backend, 'vnc');
  assert.equal(selectDesktopBackend(b, 'vnc', { confirm: { protocol: 'vnc', port: 15901 } }).backend, 'vnc');
  assert.equal(selectDesktopBackend(b, 'auto', { confirm: { protocol: 'vnc', port: 5900 } }).backend, null, 'wrong port does not confirm');
  assert.equal(selectDesktopBackend(b, 'auto', { confirm: { protocol: 'rdp', port: 15901 } }).backend, null, 'wrong protocol does not confirm');
  // Saved port found -> confirmed, Auto may choose it; saved port down but default up -> unconfirmed.
  const saved = desktopBackends({ discovery: { vnc: { available: true, port: 15901 } }, saved: { protocol: 'vnc', port: 15901 } });
  assert.equal(selectDesktopBackend(saved, 'auto').backend, 'vnc');
  const moved = desktopBackends({ discovery: { vnc: { available: true, port: 5900 } }, saved: { protocol: 'vnc', port: 15901 } });
  assert.equal(selectDesktopBackend(moved, 'auto').backend, null);
  // RDP on default port while the owner saved VNC: unconfirmed for RDP (both protocols covered).
  const rdpDefault = desktopBackends({ discovery: { rdp: { available: true, port: 3389, tls: true }, vnc: down('x') }, saved: { protocol: 'vnc', port: 15901 } });
  assert.deepEqual(selectDesktopBackend(rdpDefault, 'auto').needsConfirm, { protocol: 'rdp', port: 3389 });
});

// Review (ui-07): no discovery data for a protocol reads "not checked", never "not found".
test('a protocol with no discovery data says "not checked", not "No ... server was found"', () => {
  const list = desktopBackends({ discovery: null, capabilities: { desktop: { rdp: true } }, saved: { protocol: 'rdp', port: 3389 } });
  const vnc = list.find((b) => b.backend === 'vnc');
  assert.equal(vnc.reason, NOT_CHECKED);
  assert.match(vnc.reason, /not checked/);
  for (const b of list) assert.doesNotMatch(b.reason, /server was found/);
  assert.equal(list.find((b) => b.backend === 'rdp').available, true);
  // A real negative probe still says why.
  const probed = desktopBackends({ discovery: { vnc: { available: false, reason: 'Nothing answered on port 5901. Check that the remote computer is on and VNC remote desktop is turned on.' } } });
  assert.match(probed.find((b) => b.backend === 'vnc').reason, /Nothing answered on port \d+\. Check that the remote computer is on/);
  // Probed with no reason given still falls back to the "not found" wording.
  assert.match(desktopBackends({ discovery: { vnc: { available: false } } }).find((b) => b.backend === 'vnc').reason, /No VNC remote desktop was found/);
});
