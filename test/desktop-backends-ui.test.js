import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeDocument } from './helpers/fake-dom.js';

/** SAA-306: Advanced chooser and missing-service explanation (standalone UI pieces). */

globalThis.document ??= makeDocument();
const { createBackendChooser, describeSelection, missingServiceExplanation } = await import('../public/js/desktop-backends.js');
const { desktopBackends, selectDesktopBackend } = await import('../public/js/desktop-auto.js');

const walk = (node, out = []) => { if (node && typeof node === 'object') { out.push(node); for (const c of node.children ?? []) walk(c, out); } return out; };
const find = (root, pred) => walk(root).filter(pred);
const option = (root, b) => find(root, (n) => n.getAttribute?.('data-backend') === b && n.tagName?.toLowerCase() === 'label')[0];
const radio = (label) => label.children.find((c) => c.tagName?.toLowerCase() === 'input');

test('chooser lists Auto + every backend with availability and reasons; unavailable disabled', () => {
  const backends = desktopBackends({ discovery: { rdp: { available: true, port: 3389 }, vnc: { available: false, reason: 'Nothing answered on port 5900. Check that the remote computer is on and VNC remote desktop is turned on.' } }, capabilities: { desktop: { nativeStream: true } }, saved: { protocol: 'rdp', port: 3389 } });
  const picked = [];
  const root = createBackendChooser({ backends, preference: 'auto', onSelect: (p) => picked.push(p) });
  assert.match(root.textContent, /Desktop connection/);
  assert.match(option(root, 'auto').textContent, /Auto \(recommended\).*uses RDP/);
  assert.equal(radio(option(root, 'auto')).getAttribute('checked'), '');
  assert.match(option(root, 'rdp').textContent, /available/);
  assert.equal(radio(option(root, 'rdp')).getAttribute('disabled'), null);
  assert.match(option(root, 'vnc').textContent, /port 5900/);
  assert.equal(radio(option(root, 'vnc')).getAttribute('disabled'), '');
  assert.equal(option(root, 'nativeStream'), undefined, 'RemoteHub stream is hidden until it can be used');
  assert.doesNotMatch(root.textContent ?? '', /Remote Hub|Native|coming soon/);
  for (const fn of radio(option(root, 'rdp')).listeners.get('change')) fn({});
  assert.deepEqual(picked, ['rdp']);
});

test('Check again button calls back and shows progress', () => {
  let n = 0;
  const root = createBackendChooser({ backends: [], onCheckAgain: () => n++ });
  const btn = find(root, (x) => x.getAttribute?.('class')?.includes?.('desktop-backend-recheck') || x.className?.includes?.('desktop-backend-recheck'))[0];
  for (const fn of btn.listeners.get('click')) fn({});
  assert.equal(n, 1);
  const busy = createBackendChooser({ backends: [], onCheckAgain: () => {}, checking: true });
  assert.match(busy.textContent, /Checking…/);
  assert.match(option(busy, 'auto').textContent, /nothing available/);
});

test('missing service explanation: per-backend reasons and the optional agent/helper path; markup-safe', () => {
  const backends = desktopBackends({ discovery: { rdp: { available: false, reason: '<img src=x onerror=alert(1)>' }, vnc: { available: false, reason: 'VNC detection is not enabled yet.' } } });
  const sel = selectDesktopBackend(backends);
  let setup = 0;
  const node = missingServiceExplanation(sel, { onSetUpAgent: () => setup++ });
  assert.match(node.textContent, /No remote desktop is available/);
  assert.match(node.textContent, /RDP: <img src=x onerror=alert\(1\)>/, 'reason kept as plain text');
  assert.ok(!find(node, (x) => x.tagName?.toLowerCase() === 'img').length, 'no element injected');
  assert.match(node.textContent, /RemoteHub agent|temporary helper/);
  const btn = find(node, (x) => x.tagName?.toLowerCase() === 'button')[0];
  for (const fn of btn.listeners.get('click')) fn({});
  assert.equal(setup, 1);
  const withAgent = missingServiceExplanation(selectDesktopBackend(desktopBackends({ capabilities: { desktop: { nativeStream: true } } })));
  assert.ok(!/temporary helper/.test(withAgent.textContent), 'no helper pitch when an agent is already connected');
  assert.equal(missingServiceExplanation({ backend: 'rdp' }), null);
});

test('describeSelection', () => {
  assert.equal(describeSelection({ backend: 'rdp', auto: true }), 'Auto: RDP');
  assert.equal(describeSelection({ backend: 'vnc', auto: false }), 'VNC');
  assert.equal(describeSelection({ backend: null }), '');
});

test('chooser: RDP without TLS shows the plain message and cannot be picked; unconfirmed ports in the note', async () => {
  const { NO_TLS_RDP } = await import('../public/js/desktop-auto.js');
  const backends = desktopBackends({ discovery: { rdp: { available: true, port: 3389, tls: false }, vnc: { available: true, port: 15901 } }, saved: { protocol: 'rdp', port: 3389 } });
  const picks = [];
  const root = createBackendChooser({ backends, preference: 'auto', onSelect: (p) => picks.push(p) });
  assert.ok(option(root, 'rdp').textContent.includes(NO_TLS_RDP));
  assert.doesNotMatch(option(root, 'rdp').textContent, /TLS|pin/);
  assert.equal(radio(option(root, 'rdp')).getAttribute('disabled'), '', 'RDP radio disabled');
  assert.deepEqual(picks, []);
  assert.match(option(root, 'vnc').textContent, /found; you’ll be asked to confirm before first use/);
  assert.match(option(root, 'auto').textContent, /nothing available/, 'Auto picks neither');
});
