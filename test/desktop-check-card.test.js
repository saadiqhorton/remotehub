// Review ruling 4 (PR #26): the "Check desktop options" card. Hosts use 127.0.0.2 only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { desktopBackends } from '../public/js/desktop-auto.js';
import { discoveryResultLines } from '../public/js/host-actions.js';

const NEW = 'Remote desktop isn’t set up in this copy of RemoteHub yet. You can still connect with the terminal.';
const OLD_OFF = 'Remote desktop is turned off in this RemoteHub.';
const vncUp = { available: true, port: 15901 };
const rdpDown = { available: false, port: 3389, reason: 'Nothing answered on port 3389. Check that the remote computer is on and RDP remote desktop is turned on.' };
const card = (opts) => {
  const desktopDiscovery = { vnc: vncUp, rdp: rdpDown };
  const host = { address: '127.0.0.2', desktopDiscovery, desktopBackends: desktopBackends({ discovery: desktopDiscovery, ...opts }) };
  return discoveryResultLines(host);
};

for (const [label, opts] of [
  ['Desktop off on the server (guacd not enabled)', { guacdEnabled: false }],
  ['guacd without the VNC plugin', { guacdProtocols: { vnc: false, rdp: false } }],
]) {
  test(`check card, ${label}: says this copy of RemoteHub, never "${OLD_OFF}"`, () => {
    const lines = card(opts);
    assert.equal(lines.filter((l) => l.includes(NEW)).length, 1, lines.join('\n'));
    assert.ok(lines.includes('This computer has a remote desktop, but RemoteHub can’t open it yet.'), lines.join('\n'));
    for (const l of lines) assert.ok(!l.includes(OLD_OFF), l);
  });
  test(`check card, ${label}: a found VNC is never followed by "No remote desktop found"`, () => {
    const lines = card(opts);
    const vnc = lines.findIndex((l) => l.startsWith('This computer has a remote desktop'));
    assert.ok(vnc >= 0, lines.join('\n'));
    assert.ok(!lines.slice(vnc + 1).some((l) => l.startsWith('No remote desktop found')), lines.join('\n'));
  });
}

test('check card, nothing found anywhere: still says "No remote desktop found"', () => {
  const desktopDiscovery = { vnc: { available: false, port: 5900, reason: 'x' }, rdp: rdpDown };
  const lines = discoveryResultLines({ address: '127.0.0.2', desktopDiscovery, desktopBackends: desktopBackends({ discovery: desktopDiscovery }) });
  assert.ok(lines.at(-1).startsWith('No remote desktop found'), lines.join('\n'));
});

test('check card: a single not-set-up RDP with no scan results never says "No remote desktop found"', () => {
  const host = { address: '127.0.0.2', desktopBackends: [{ backend: 'rdp', available: false, selectable: false, reason: NEW }] };
  const lines = discoveryResultLines(host);
  assert.ok(!lines.some((l) => l.includes('No remote desktop found')), lines.join('\n'));
  assert.equal(lines.filter((l) => l === NEW).length, 1, lines.join('\n'));
});

test('rdp.js 4410 fallback matches the page sentence exactly', async () => {
  const { readFileSync } = await import('node:fs');
  const rdp = readFileSync(new URL('../server/rdp.js', import.meta.url), 'utf8');
  assert.ok(!rdp.includes('RemoteHub can’t open a remote desktop on this computer right now.'));
  assert.equal(rdp.split('RemoteHub couldn’t reach this computer’s remote desktop. Click Reconnect to try again.').length - 1 >= 2, true);
});
