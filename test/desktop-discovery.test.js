import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import tls from 'node:tls';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { Store } from '../server/store.js';
import { DISCOVERY_DEFAULT_PORTS, createDiscoveryLimiter, discoverDesktopBackends, discoveryPortsFor, probeRdpBackend, probeVncBackend } from '../server/desktop-discovery.js';
import { closedPort } from './helpers/app-harness.js';
import { startFakeVncServer } from './helpers/fake-vnc-server.js';
import { RDP_FIXTURES } from './helpers/fake-rdp-server.js';

/** SAA-306: desktop backend discovery. Never sends credentials, never touches the pin. */

// RDP endpoint that records every byte the client sends, before and after TLS.
async function capturingRdp({ mode = 'tls' } = {}) {
  const cap = { preTls: [], postTls: 0, connections: 0 };
  const server = net.createServer((socket) => {
    cap.connections += 1;
    socket.on('error', () => {});
    socket.once('data', (first) => {
      cap.preTls.push(Buffer.from(first));
      socket.write(Buffer.from([0x03, 0, 0, 0x13, 0x0e, 0xd0, 0, 0, 0x12, 0x34, 0, mode === 'no-tls' ? 0x03 : 0x02, 0, 0x08, 0, mode === 'no-tls' ? 0x02 : 0x01, 0, 0, 0]));
      if (mode === 'no-tls') return socket.end();
      const t = new tls.TLSSocket(socket, { isServer: true, ...RDP_FIXTURES.a });
      t.on('error', () => {});
      t.on('data', (d) => { cap.postTls += d.length; });
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  cap.port = server.address().port;
  cap.stop = () => new Promise((r) => server.close(() => r()));
  return cap;
}
const X224_CR = Buffer.from([0x03, 0, 0, 0x13, 0x0e, 0xe0, 0, 0, 0, 0, 0, 0x01, 0, 0x08, 0, 0x03, 0, 0, 0]);
const SECRETS = ['rdp-Secret-Pw-7731', 'alice', 'CORP'];
// Never probe the real 3389/5900 (other users' desktops on shared boxes): VNC is a fake probe
// and the RDP default port is the in-test server's own port.
const noVnc = async ({ port }) => ({ available: false, port, reason: 'test: VNC not probed' });

test('RDP discovery sends only the X.224 negotiation request: no username, cookie, domain or password; nothing after TLS', async () => {
  const rdp = await capturingRdp();
  try {
    const host = { address: '127.0.0.1', desktop: { protocol: 'rdp', port: rdp.port, username: 'alice', domain: 'CORP' } };
    const found = await discoverDesktopBackends({ host, defaultPorts: { rdp: rdp.port, vnc: 1 }, probes: { vnc: noVnc } });
    assert.equal(found.rdp.available, true);
    assert.equal(found.rdp.tls, true);
    assert.equal(found.rdp.port, rdp.port, 'saved desktop port is probed');
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(rdp.preTls.length, 1);
    assert.deepEqual(rdp.preTls[0], X224_CR, 'exactly the 19-byte X.224 CR (no mstshash cookie, no routing token)');
    for (const s of SECRETS) assert.ok(!rdp.preTls[0].includes(Buffer.from(s)), `no ${s} before TLS`);
    assert.equal(rdp.postTls, 0, 'no application data after the TLS handshake');
    assert.ok(!JSON.stringify(found).includes('sha256:'), 'discovery result carries no fingerprint to pin');
  } finally { await rdp.stop(); }
});

test('discovery never records or updates a certificate pin (existing pin and no pin): data file byte-identical', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'rh-discovery-'));
  const rdp = await capturingRdp();
  try {
    const store = await new Store(dataDir).load();
    const pinned = await store.addHost({ name: 'pinned', address: '127.0.0.1', port: 22, username: 'me' });
    await store.setDesktop(pinned.id, { protocol: 'rdp', port: rdp.port, security: 'any', ignoreCert: false });
    await store.setDesktopCertPin(pinned.id, `sha256:${'11:'.repeat(31)}11`);
    const unpinned = await store.addHost({ name: 'unpinned', address: '127.0.0.1', port: 22, username: 'me' });
    await store.setDesktop(unpinned.id, { protocol: 'rdp', port: rdp.port, security: 'any', ignoreCert: false });
    const file = path.join(dataDir, 'remotehub.json');
    const before = await readFile(file, 'utf8');
    for (const id of [pinned.id, unpinned.id]) {
      const result = await discoverDesktopBackends({ host: store.getHost(id), defaultPorts: { rdp: rdp.port, vnc: 1 }, probes: { vnc: noVnc } });
      assert.equal(result.rdp.available, true, 'the presented cert differs from the stored pin, yet discovery neither fails nor pins');
    }
    assert.equal(await readFile(file, 'utf8'), before, 'data file untouched');
    const reloaded = await new Store(dataDir).load();
    assert.equal(reloaded.getHost(pinned.id).desktop.certPin, `sha256:${'11:'.repeat(31)}11`, 'existing pin unchanged');
    assert.equal(reloaded.getHost(unpinned.id).desktop.certPin, undefined, 'no pin created');
    assert.equal(reloaded.getHost(unpinned.id).desktop.certPinnedAt, undefined);
    assert.equal(store.getHost(unpinned.id).desktop.certPin, undefined, 'in-memory host not mutated');
  } finally { await rdp.stop(); await rm(dataDir, { recursive: true, force: true }); }
});

test('RDP results: no-TLS server is RDP (legacy only); refused, timeout, not-RDP map to reasons', async () => {
  const noTls = await capturingRdp({ mode: 'no-tls' });
  try {
    const r = await probeRdpBackend({ host: '127.0.0.1', port: noTls.port });
    assert.equal(r.available, true);
    assert.equal(r.tls, false);
  } finally { await noTls.stop(); }
  const refused = await probeRdpBackend({ host: '127.0.0.1', port: noTls.port });
  assert.equal(refused.available, false);
  assert.match(refused.reason, /^Nothing answered when RemoteHub looked for a remote desktop\.$/);
  const silent = net.createServer(() => {});
  await new Promise((r) => silent.listen(0, '127.0.0.1', r));
  try {
    const t = await probeRdpBackend({ host: '127.0.0.1', port: silent.address().port, timeoutMs: 150 });
    assert.equal(t.reason, 'No answer in time from the RDP remote desktop.');
  } finally { silent.close(); }
  const http = net.createServer((s) => s.once('data', () => s.end('HTTP/1.1 400 Bad Request\r\n\r\n')));
  await new Promise((r) => http.listen(0, '127.0.0.1', r));
  try { assert.match((await probeRdpBackend({ host: '127.0.0.1', port: http.address().port })).reason, /^Something answered, but it isn't an RDP remote desktop.$/); }
  finally { http.close(); }
});

test('injectable probes, default ports, hung/throwing probes, no OS input (fake probes: no network)', async () => {
  const calls = [];
  const probe = (name, result) => async (args) => { calls.push([name, args]); return result; };
  const host = { address: '10.0.0.9', os: 'windows' };
  const found = await discoverDesktopBackends({ host, probes: { rdp: probe('rdp', { available: false, reason: 'x' }), vnc: probe('vnc', { available: true }) }, now: () => 0 });
  assert.deepEqual(calls.map(([n, a]) => [n, a.port]), [['rdp', DISCOVERY_DEFAULT_PORTS.rdp], ['vnc', DISCOVERY_DEFAULT_PORTS.vnc]]);
  for (const [, args] of calls) assert.deepEqual(Object.keys(args).sort(), ['host', 'port', 'timeoutMs'], 'probes get only address, port and timeout (no credentials, no OS)');
  assert.deepEqual(found.vnc, { available: true, port: 5900, reason: '', checkedAt: '1970-01-01T00:00:00.000Z', tried: [{ port: 5900, available: true, reason: '' }] });
  const t0 = performance.now();
  const hung = await discoverDesktopBackends({ host, timeoutMs: 50, probes: { rdp: () => new Promise(() => {}), vnc: async () => { throw new Error('boom secret'); } } });
  assert.ok(performance.now() - t0 < 2000);
  assert.equal(hung.rdp.reason, 'No answer in time from the RDP remote desktop.');
  assert.equal(hung.vnc.available, false);
  assert.ok(!hung.vnc.reason.includes('secret'), 'probe error text is not echoed');
  await assert.rejects(discoverDesktopBackends({ host: {} }), /address/);
});

// Review (3): each protocol on its default port AND the owner-saved port AND
// DESKTOP_DISCOVERY_PORTS (server config); never from the request.
test('ports: default + owner-saved + configured are all probed, deduped, saved first; result is the first available', async () => {
  const host = { address: '10.0.0.9', desktop: { protocol: 'vnc', port: 15901 } };
  assert.deepEqual(discoveryPortsFor('vnc', host, { extraPorts: { vnc: 5901 } }), [15901, 5901, 5900]);
  assert.deepEqual(discoveryPortsFor('rdp', host, { extraPorts: { vnc: 5901 } }), [3389], 'saved VNC port is not used for RDP');
  assert.deepEqual(discoveryPortsFor('vnc', { address: 'x', desktop: { protocol: 'vnc', port: 5900 } }), [5900], 'deduped');
  const seen = [];
  const vnc = async ({ port }) => { seen.push(port); return port === 5901 ? { available: true, port } : { available: false, port, reason: `down ${port}` }; };
  const rdp = async ({ port }) => ({ available: false, port, reason: 'x' });
  const r = await discoverDesktopBackends({ host, extraPorts: { vnc: 5901 }, probes: { rdp, vnc } });
  assert.deepEqual(seen.sort((a, b) => a - b), [5900, 5901, 15901]);
  assert.equal(r.vnc.available, true);
  assert.equal(r.vnc.port, 5901, 'first available candidate');
  assert.deepEqual(r.vnc.tried.map((t) => [t.port, t.available]), [[15901, false], [5901, true], [5900, false]]);
  const allDown = await discoverDesktopBackends({ host, probes: { rdp, vnc: async ({ port }) => ({ available: false, port, reason: `down ${port}` }) } });
  assert.equal(allDown.vnc.reason, 'down 15901', 'highest-priority (saved) failure is reported');
  // RDP: a TLS candidate wins over a no-TLS one regardless of order.
  const rdpHost = { address: 'x', desktop: { protocol: 'rdp', port: 3390 } };
  const mixed = await discoverDesktopBackends({ host: rdpHost, probes: { vnc: noVnc, rdp: async ({ port }) => ({ available: true, port, tls: port === 3389 }) } });
  assert.deepEqual([mixed.rdp.port, mixed.rdp.tls], [3389, true]);
  // The real probes go only to these candidate ports (here: in-test servers).
  const real = await startFakeVncServer({ types: [2] });
  const dead = await closedPort();
  try {
    const got = await discoverDesktopBackends({ host: { address: '127.0.0.1', desktop: { protocol: 'vnc', port: real.port } }, defaultPorts: { rdp: dead, vnc: dead } });
    assert.deepEqual([got.vnc.available, got.vnc.port, got.rdp.available], [true, real.port, false]);
  } finally { await real.stop(); }
});

test('limiter: one discovery per host per interval', () => {
  let t = 1000;
  const lim = createDiscoveryLimiter({ intervalMs: 500, now: () => t });
  assert.equal(lim.take('a').ok, true);
  const again = lim.take('a');
  assert.equal(again.ok, false);
  assert.equal(again.retryAfterMs, 500);
  assert.equal(lim.take('b').ok, true);
  t += 500;
  assert.equal(lim.take('a').ok, true);
  lim.forget('a');
  assert.equal(lim.take('a').ok, true);
});

test('VNC discovery (SAA-305 RFB check): only the version is sent, never a security type or password', async () => {
  const vnc = await startFakeVncServer({ types: [2] });
  try {
    const r = await probeVncBackend({ host: '127.0.0.1', port: vnc.port });
    assert.deepEqual([r.available, r.note], [true, 'Asks for a password.']);
    await new Promise((res) => setTimeout(res, 50));
    assert.deepEqual(vnc.received, ['RFB 003.008\n'], 'client sent only its version string');
    for (const s of SECRETS) assert.ok(!vnc.received.join('').includes(s));
  } finally { await vnc.stop(); }
  const none = await startFakeVncServer({ types: [1] });
  try { assert.equal((await probeVncBackend({ host: '127.0.0.1', port: none.port })).note, undefined); } finally { await none.stop(); }
  const unsupported = await startFakeVncServer({ types: [5] });
  try { assert.match((await probeVncBackend({ host: '127.0.0.1', port: unsupported.port })).reason, /^The VNC remote desktop uses a sign-in method RemoteHub doesn’t support.$/); } finally { await unsupported.stop(); }
  const refuse = await startFakeVncServer({ mode: 'refuse' });
  // Review (2): a VNC server that refuses the check connection is NOT available.
  try {
    const r = await probeVncBackend({ host: '127.0.0.1', port: refuse.port });
    assert.equal(r.available, false);
    assert.match(r.reason, /turned RemoteHub away/);
  } finally { await refuse.stop(); }
  const http = await startFakeVncServer({ mode: 'not-vnc' });
  try { assert.match((await probeVncBackend({ host: '127.0.0.1', port: http.port })).reason, /^Something answered, but it isn’t a VNC remote desktop.$/); } finally { await http.stop(); }
  assert.match((await probeVncBackend({ host: '127.0.0.1', port: http.port })).reason, /^Nothing answered when RemoteHub looked for a remote desktop\.$/);
});

test('default discovery probes both RDP and VNC for real', async () => {
  const rdp = await capturingRdp();
  const vnc = await startFakeVncServer({ types: [2] });
  try {
    const found = await discoverDesktopBackends({ host: { address: '127.0.0.1' }, defaultPorts: { rdp: rdp.port, vnc: vnc.port } });
    assert.equal(found.rdp.available, true);
    assert.equal(found.vnc.available, true);
  } finally { await rdp.stop(); await vnc.stop(); }
});
