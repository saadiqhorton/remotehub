import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import tls from 'node:tls';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../server/store.js';
import { probeRdpBackend, probeVncBackend } from '../server/desktop-discovery.js';
import { discoveryResultLines, hostActions } from '../public/js/host-actions.js';
import { RDP_FIXTURES } from './helpers/fake-rdp-server.js';
import { startFakeVncServer } from './helpers/fake-vnc-server.js';
import { closedPort, httpClient, startTestApp } from './helpers/app-harness.js';

/** SAA-306 server wiring: discover route, desktopBackends in host views, preference/Auto. */

/**
 * SAA-306 first click on a port the owner has not saved: the server answers 400 with
 * needsConfirm { protocol, address, port }; the owner confirms exactly that and saves.
 */
async function confirmedSave(client, url, body) {
  const first = await client.request(url, { method: 'PUT', body });
  if (first.status !== 400 || !first.body?.needsConfirm) return first;
  assert.deepEqual(Object.keys(first.body.needsConfirm).sort(), ['address', 'port', 'protocol']);
  return client.request(url, { method: 'PUT', body: { ...body, confirm: first.body.needsConfirm } });
}

const PIN = `sha256:${'22:'.repeat(31)}22`;
async function capturingRdp() {
  const cap = { preTls: [], postTls: 0 };
  const server = net.createServer((socket) => {
    socket.on('error', () => {});
    socket.once('data', (first) => {
      cap.preTls.push(Buffer.from(first));
      socket.write(Buffer.from([0x03, 0, 0, 0x13, 0x0e, 0xd0, 0, 0, 0x12, 0x34, 0, 0x02, 0, 0x08, 0, 0x01, 0, 0, 0]));
      const t = new tls.TLSSocket(socket, { isServer: true, ...RDP_FIXTURES.b });
      t.on('error', () => {});
      t.on('data', (d) => { cap.postTls += d.length; });
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  cap.port = server.address().port;
  cap.stop = () => new Promise((r) => server.close(() => r()));
  return cap;
}

async function setup({ rdp = true, vnc = true, dataDir, rdpServer: given = null } = {}) {
  const rdpServer = given ?? (rdp ? await capturingRdp() : null);
  const vncServer = vnc ? await startFakeVncServer({ types: [2] }) : null;
  const deadPort = await new Promise((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
  const logs = [];
  const t = await startTestApp({
    guacd: { enabled: true, host: '127.0.0.1', port: deadPort, protocol: 'rdp', timeoutMs: 300, cacheMs: 0 },
    protocolSupport: { check: async () => ({ rdp: true, vnc: true }), known: () => true },
    // Real probes on the real candidate ports; the protocol "defaults" are the in-test fakes
    // (never the real 3389/5900).
    discoveryDefaultPorts: { rdp: rdpServer?.port ?? deadPort, vnc: vncServer?.port ?? deadPort },
    ...(dataDir ? { dataDir } : {}),
    discoveryIntervalMs: 400,
    vncCheckIntervalMs: 5000,
    vncProbe: async () => ({ status: 'ok', securityTypes: [{ id: 2, name: 'VNC Authentication' }], needsPassword: true, supported: true }),
  }, { log: (m) => logs.push(m) });
  const client = httpClient(t.base, t.origin);
  const dir = dataDir ?? t.dataDir;
  const code = (await readFile(`${dir}/SETUP-CODE.txt`, 'utf8')).trim();
  assert.equal((await client.request('/api/auth/setup', { method: 'POST', body: { setupCode: code, password: 'owner-password-1' } })).status, 200);
  const host = dataDir ? (await client.request('/api/hosts')).body.hosts.find((h) => h.name === 'pinned')
    : (await client.request('/api/hosts', { method: 'POST', body: { name: 'pc', address: '127.0.0.1', port: 22, username: 'me' } })).body.host;
  return { t, dir, client, host, logs, rdpServer, vncServer, stop: async () => { await t.stop(); await rdpServer?.stop(); await vncServer?.stop(); } };
}

test('discover: owner-only, finds RDP and VNC, exposes desktopBackends, own rate limit separate from vnc-check', async () => {
  const s = await setup();
  try {
    const anon = httpClient(s.t.base, s.t.origin);
    assert.equal((await anon.request(`/api/hosts/${s.host.id}/desktop/discover`, { method: 'POST' })).status, 401);
    assert.equal((await s.client.request('/api/hosts/nope/desktop/discover', { method: 'POST' })).status, 404);
    const before = (await s.client.request('/api/hosts')).body.hosts[0];
    assert.equal(before.desktopPreference, 'auto');
    assert.equal(before.desktopDiscovery, null);
    assert.ok(Array.isArray(before.desktopBackends));
    const res = await s.client.request(`/api/hosts/${s.host.id}/desktop/discover`, { method: 'POST' });
    assert.equal(res.status, 200);
    assert.equal(res.body.discovery.rdp.available, true);
    assert.equal(res.body.discovery.vnc.available, true);
    const backends = Object.fromEntries(res.body.host.desktopBackends.map((b) => [b.backend, b]));
    assert.deepEqual([backends.rdp.selectable, backends.vnc.selectable, backends.nativeStream.selectable], [true, true, false]);
    assert.equal(backends.rdp.source, 'probe');
    const again = await s.client.request(`/api/hosts/${s.host.id}/desktop/discover`, { method: 'POST' });
    assert.equal(again.status, 429);
    assert.ok(Number(again.headers?.get?.('retry-after') ?? 1) >= 1);
    // vnc-check keeps its own limiter: not blocked by the discovery that just ran.
    await confirmedSave(s.client, `/api/hosts/${s.host.id}/desktop`, { preference: 'vnc' });
    assert.equal((await s.client.request(`/api/hosts/${s.host.id}/desktop/vnc-check`)).status, 200);
    await new Promise((r) => setTimeout(r, 450));
    assert.equal((await s.client.request(`/api/hosts/${s.host.id}/desktop/discover`, { method: 'POST' })).status, 200, 'allowed again after the interval');
    assert.ok(s.logs.some((l) => /desktop discovery host=\S+ rdp=true vnc=true/.test(l)));
  } finally { await s.stop(); }
});

test('discover never sends credentials and never records or updates a pin (with and without an existing pin)', async () => {
  // Seed a data dir: one RDP host already pinned (as a real connection would have done), one never pinned.
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'rh-discover-pin-'));
  const seed = await new Store(dataDir).load();
  const savedPort = await closedPort(); // never the real 3389
  const pinned = await seed.addHost({ name: 'pinned', address: '127.0.0.1', port: 22, username: 'me' });
  await seed.setDesktop(pinned.id, { protocol: 'rdp', port: savedPort, username: 'alice', domain: 'CORP', security: 'any', ignoreCert: false });
  await seed.setDesktopCertPin(pinned.id, PIN);
  const unpinned = await seed.addHost({ name: 'unpinned', address: '127.0.0.1', port: 22, username: 'me' });
  await seed.setDesktop(unpinned.id, { protocol: 'rdp', port: savedPort, username: 'alice', security: 'any', ignoreCert: false });
  const s = await setup({ dataDir });
  try {
    const file = `${s.dir}/remotehub.json`;
    const desktops = async () => Object.fromEntries(JSON.parse(await readFile(file, 'utf8')).hosts.map((h) => [h.name, h.desktop]));
    const before = await desktops();
    assert.equal(before.pinned.certPin, PIN);
    assert.equal(before.unpinned.certPin, undefined);
    for (const id of [pinned.id, unpinned.id]) {
      const res = await s.client.request(`/api/hosts/${id}/desktop/discover`, { method: 'POST' });
      assert.equal(res.status, 200);
      assert.equal(res.body.discovery.rdp.available, true, 'the server presents a different cert than the pin; discovery neither fails nor pins');
    }
    const after = await desktops();
    assert.deepEqual(after.pinned, before.pinned, 'existing pin (and all desktop settings) unchanged');
    assert.deepEqual(after.unpinned, before.unpinned, 'no pin recorded where none existed');
    assert.equal(after.unpinned.certPin, undefined);
    assert.equal(after.unpinned.certPinnedAt, undefined);
    const views = (await s.client.request('/api/hosts')).body.hosts;
    assert.equal(views.find((h) => h.name === 'pinned').desktop.certPin, PIN);
    assert.equal(views.find((h) => h.name === 'unpinned').desktop.certPin, null);
    for (const v of views) assert.ok(!JSON.stringify(v.desktopDiscovery).includes('sha256:'), 'discovery stores no fingerprint');
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(s.rdpServer.preTls.length, 2);
    for (const bytes of s.rdpServer.preTls) {
      assert.equal(bytes.length, 19, 'only the X.224 request before TLS');
      for (const secret of ['alice', 'CORP', 'owner-password-1', 'mstshash']) assert.ok(!bytes.includes(Buffer.from(secret)), secret);
    }
    assert.equal(s.rdpServer.postTls, 0, 'nothing after TLS');
    for (const sent of s.vncServer.received) assert.equal(sent, 'RFB 003.008\n', 'VNC: version only');
  } finally { await s.stop(); }
});

test('preference: Auto picks RDP with the discovered port; explicit VNC; native not selectable; invalid refused; nothing available explains', async () => {
  const s = await setup();
  try {
    await s.client.request(`/api/hosts/${s.host.id}/desktop/discover`, { method: 'POST' });
    const auto = await confirmedSave(s.client, `/api/hosts/${s.host.id}/desktop`, { preference: 'auto', username: 'alice' });
    assert.equal(auto.status, 200);
    assert.deepEqual([auto.body.host.desktop.protocol, auto.body.host.desktop.port, auto.body.host.desktopPreference], ['rdp', s.rdpServer.port, 'auto'], 'Auto uses the discovered port');
    // The save is exactly what discovery found, so discovery is kept (not 'not checked').
    assert.equal(auto.body.host.desktopDiscovery?.rdp?.port, s.rdpServer.port);
    await new Promise((r) => setTimeout(r, 450));
    await s.client.request(`/api/hosts/${s.host.id}/desktop/discover`, { method: 'POST' });
    const vnc = await confirmedSave(s.client, `/api/hosts/${s.host.id}/desktop`, { preference: 'vnc' });
    assert.deepEqual([vnc.body.host.desktop.protocol, vnc.body.host.desktopPreference], ['vnc', 'vnc']);
    const native = await s.client.request(`/api/hosts/${s.host.id}/desktop`, { method: 'PUT', body: { preference: 'nativeStream' } });
    assert.equal(native.status, 400);
    assert.match(native.body.error, /own desktop streaming isn't available yet/, 'nativeStream refused until SAA-311');
    assert.equal((await s.client.request(`/api/hosts/${s.host.id}/desktop`, { method: 'PUT', body: { preference: 'windows' } })).status, 400);
    // An explicit protocol still works exactly as before (SAA-305 path), preference absent.
    assert.equal((await s.client.request(`/api/hosts/${s.host.id}/desktop`, { method: 'PUT', body: { protocol: 'rdp', port: 3390 } })).body.host.desktop.port, 3390);
  } finally { await s.stop(); }
  const none = await setup({ rdp: false, vnc: false });
  try {
    const d = await none.client.request(`/api/hosts/${none.host.id}/desktop/discover`, { method: 'POST' });
    assert.equal(d.body.discovery.rdp.available, false);
    const r = await none.client.request(`/api/hosts/${none.host.id}/desktop`, { method: 'PUT', body: { preference: 'auto' } });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /No remote desktop is available/);
    assert.match(r.body.reasons.rdp, /^Nothing answered when RemoteHub looked for a remote desktop\.$/);
    assert.equal(r.body.helper, true, 'agent/helper path offered');
    const actions = hostActions({ ...d.body.host, desktopServerEnabled: true, desktopProtocols: { rdp: true, vnc: true } });
    assert.match(actions[2].reason, /^No remote desktop is available on this computer\. RDP: Nothing answered when RemoteHub looked/);
    assert.equal(actions[2].reason.match(/[Nn]o remote desktop/g).length, 1, 'tooltip says it once');
  } finally { await none.stop(); }
});

test('host action reason reports what discovery found for an unconfigured host', () => {
  const host = { capabilities: { desktop: {} }, desktopDiscovery: { rdp: { available: true } }, desktopBackends: [
    { backend: 'rdp', selectable: true, reason: '' }, { backend: 'vnc', selectable: false, reason: 'x' }, { backend: 'nativeStream', selectable: false, reason: 'y' }], desktopServerEnabled: true, desktopProtocols: { rdp: true, vnc: true } };
  assert.equal(hostActions(host)[2].reason, 'No remote desktop is available on this computer. Found: RDP (Auto would use RDP).');
  assert.equal(hostActions({ capabilities: { desktop: {} }, desktopServerEnabled: true, desktopProtocols: { rdp: true, vnc: true } })[2].reason, 'No remote desktop is available on this computer.', 'unchanged without discovery');
});

// SAA-306: discovery feeds capabilities so Desktop can be enabled, without
// configuring desktop settings, pinning, or sending credentials; 429 carries Retry-After.
test('discovery feeds effectiveCapabilities (provenance discovery), leaves desktop settings empty; 429 body has retryAfterSeconds; non-owner 401', async () => {
  const s = await setup({ vnc: false });
  try {
    const anon = httpClient(s.t.base, s.t.origin);
    assert.equal((await anon.request(`/api/hosts/${s.host.id}/desktop/discover`, { method: 'POST' })).status, 401);
    assert.equal((await anon.request('/api/hosts')).status, 401, 'non-owner cannot see hosts (or the action)');
    const before = (await s.client.request('/api/hosts')).body.hosts[0];
    assert.notEqual(before.effectiveCapabilities?.desktop?.rdp, true);
    const res = await s.client.request(`/api/hosts/${s.host.id}/desktop/discover`, { method: 'POST' });
    assert.equal(res.body.host.effectiveCapabilities.desktop.rdp, true);
    assert.notEqual(res.body.host.effectiveCapabilities.desktop.vnc, true, 'VNC not found, not fed');
    assert.equal(res.body.host.capabilityProvenance['desktop.rdp'], 'discovery');
    assert.equal(res.body.host.desktop, null, 'no desktop settings written');
    const stored = JSON.parse(await readFile(`${s.dir}/remotehub.json`, 'utf8')).hosts[0];
    assert.equal(stored.desktop, undefined, 'nothing pinned or configured on disk');
    assert.notEqual(stored.capabilities?.desktop?.rdp, true, 'stored capabilities unchanged (per-request only)');
    const actions = hostActions({ ...res.body.host, desktopServerEnabled: true, desktopProtocols: { rdp: true, vnc: true } });
    assert.equal(actions[2].enabled, true, 'Desktop enabled via capabilities');
    assert.equal(actions[2].needsSetup, true);
    assert.equal(actions[2].backend, 'rdp');
    assert.equal(hostActions({ ...res.body.host, desktopServerEnabled: false })[2].enabled, false, 'still needs Desktop on');
    const limited = await s.client.request(`/api/hosts/${s.host.id}/desktop/discover`, { method: 'POST' });
    assert.equal(limited.status, 429);
    assert.ok(limited.body.retryAfterSeconds >= 1);
    for (const sent of s.rdpServer.preTls) for (const secret of ['owner-password-1', 'mstshash']) assert.ok(!sent.includes(Buffer.from(secret)));
  } finally { await s.stop(); }
});

test('Desktop stays disabled for unconfigured hosts without a discovery hit; preference that discovery cannot serve stays disabled', () => {
  const caps = { desktop: {} };
  assert.equal(hostActions({ capabilities: caps, desktopServerEnabled: true })[2].enabled, false);
  const host = { capabilities: caps, effectiveCapabilities: { desktop: { rdp: true } }, desktopServerEnabled: true, desktopPreference: 'vnc',
    desktopDiscovery: { rdp: { available: true } }, desktopBackends: [{ backend: 'rdp', selectable: true, source: 'probe' }, { backend: 'vnc', selectable: false, source: 'probe', reason: 'no' }] };
  assert.equal(hostActions(host)[2].enabled, false, 'preference VNC, only RDP found');
  assert.equal(hostActions({ ...host, desktopPreference: 'auto', desktopProtocols: { rdp: false } })[2].enabled, false, 'guacd lacks the plugin');
});

// SAA-306 (review conditions): preference-only save from discovery goes through the same
// PUT /hosts/:id/desktop route (owner session + Origin), may only pick a backend the last
// discovery found, takes the port from discovery (never the client), stores no credentials,
// and leaves pinning to the real connection (#20 rules).
test('preference save: forged origin 403, no session 401, forged port/address refused, undiscovered backend 400', async () => {
  const s = await setup({ vnc: false });
  try {
    const url = `/api/hosts/${s.host.id}/desktop`;
    // Before any discovery: nothing found, nothing can be chosen.
    const early = await s.client.request(url, { method: 'PUT', body: { preference: 'rdp' } });
    assert.equal(early.status, 400);
    await s.client.request(`/api/hosts/${s.host.id}/desktop/discover`, { method: 'POST' });
    const anon = httpClient(s.t.base, s.t.origin);
    assert.equal((await anon.request(url, { method: 'PUT', body: { preference: 'auto' } })).status, 401, 'no session');
    const forged = await s.client.request(url, { method: 'PUT', body: { preference: 'auto' }, headers: { Origin: 'http://evil.example' } });
    assert.equal(forged.status, 403, 'wrong origin with a valid session cookie');
    for (const body of [{ preference: 'auto', port: 4444 }, { preference: 'rdp', port: String(s.rdpServer.port) }, { preference: 'auto', address: '10.0.0.9' }, { preference: 'auto', host: 'evil' }]) {
      const r = await s.client.request(url, { method: 'PUT', body });
      assert.equal(r.status, 400, JSON.stringify(body));
    }
    const vnc = await s.client.request(url, { method: 'PUT', body: { preference: 'vnc' } });
    assert.equal(vnc.status, 400, 'VNC was not found by the last discovery');
    assert.match(vnc.body.error, /did not find VNC|not available/);
    assert.equal((await s.client.request(url, { method: 'PUT', body: { preference: 'auto', password: 'hunter2' } })).status, 400, 'no credentials stored');
    assert.equal((await s.client.request(url, { method: 'PUT', body: { preference: 'auto', certPin: PIN } })).status, 400, 'pin cannot be set by the client');
    let stored = JSON.parse(await readFile(`${s.dir}/remotehub.json`, 'utf8')).hosts[0];
    assert.equal(stored.desktop, undefined, 'none of the refused requests wrote anything');
    const ok = await confirmedSave(s.client, url, { preference: 'auto' });
    assert.equal(ok.status, 200);
    assert.deepEqual([ok.body.host.desktop.protocol, ok.body.host.desktop.port, ok.body.host.address], ['rdp', s.rdpServer.port, '127.0.0.1'], 'port from discovery, address from the host record');
    stored = JSON.parse(await readFile(`${s.dir}/remotehub.json`, 'utf8')).hosts[0];
    assert.equal(stored.desktop.certPin, undefined, 'no pin written by the save');
    assert.ok(!JSON.stringify(stored).includes('hunter2'));
    assert.equal(stored.capabilities.desktop.rdp, true, 'SAA-305 capability code ran');
  } finally { await s.stop(); }
});

test('preference save keeps #20 pin rules: pin survives same protocol+port, is re-learned when discovery moves the port', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'rh-pref-pin-'));
  const seed = await new Store(dataDir).load();
  const pinned = await seed.addHost({ name: 'pinned', address: '127.0.0.1', port: 22, username: 'me' });
  await seed.setDesktop(pinned.id, { protocol: 'rdp', port: await closedPort(), username: 'alice', security: 'any', ignoreCert: false });
  await seed.setDesktopCertPin(pinned.id, PIN);
  const s = await setup({ dataDir, vnc: false });
  try {
    await s.client.request(`/api/hosts/${pinned.id}/desktop/discover`, { method: 'POST' });
    const pinOf = async () => JSON.parse(await readFile(`${s.dir}/remotehub.json`, 'utf8')).hosts.find((h) => h.id === pinned.id).desktop.certPin;
    assert.equal(await pinOf(), PIN, 'discovery left the pin alone');
    // Discovery found RDP on a different port than the pinned (closed) port: saving moves the port, so per #20 the pin is re-learned.
    const r = await confirmedSave(s.client, `/api/hosts/${pinned.id}/desktop`, { preference: 'rdp' });
    assert.equal(r.status, 200);
    assert.equal(r.body.host.desktop.port, s.rdpServer.port);
    assert.equal(await pinOf(), undefined, 'port changed -> pin dropped, never replaced by the save');
    assert.equal(r.body.host.desktop.username, 'alice', 'other settings kept');
  } finally { await s.stop(); }
  // Same protocol and port: the pin survives (the validator the route uses).
  const dataDir2 = await mkdtemp(path.join(os.tmpdir(), 'rh-pref-pin2-'));
  const store = await new Store(dataDir2).load();
  const h = await store.addHost({ name: 'p', address: '127.0.0.1', port: 22, username: 'me' });
  await store.setDesktop(h.id, { protocol: 'rdp', port: 3390, security: 'any', ignoreCert: false });
  await store.setDesktopCertPin(h.id, PIN);
  const { validateDesktopSettings } = await import('../server/desktop-bridge.js');
  assert.equal(validateDesktopSettings({ protocol: 'rdp', port: 3390 }, store.getHost(h.id).desktop).certPin, PIN, 'same port keeps the pin (the validator the route uses)');
});

// Route-level end to end (review): fake RDP TLS servers listen FIRST, so the pin is seeded
// for the real port; then discover + preference-only first-click PUT through the HTTP route.
async function seededPinnedHost(port) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'rh-e2e-pin-'));
  const seed = await new Store(dataDir).load();
  const h = await seed.addHost({ name: 'pinned', address: '127.0.0.1', port: 22, username: 'me' });
  await seed.setDesktop(h.id, { protocol: 'rdp', port, username: 'alice', security: 'any', ignoreCert: false });
  await seed.setDesktopCertPin(h.id, PIN);
  return { dataDir, id: h.id };
}
const desktopBytes = async (dir, id) => JSON.stringify(JSON.parse(await readFile(`${dir}/remotehub.json`, 'utf8')).hosts.find((h) => h.id === id).desktop);

test('e2e A: pin seeded for the fake RDP port; discover on that port + first-click PUT leaves the pin byte-identical', async () => {
  const rdp = await capturingRdp();
  const { dataDir, id } = await seededPinnedHost(rdp.port);
  const s = await setup({ dataDir, vnc: false, rdpServer: rdp });
  try {
    const before = await desktopBytes(s.dir, id);
    assert.match(before, new RegExp(`"port":${rdp.port}`));
    assert.ok(before.includes(PIN));
    const d = await s.client.request(`/api/hosts/${id}/desktop/discover`, { method: 'POST' });
    assert.equal(d.status, 200);
    assert.equal(d.body.discovery.rdp.port, rdp.port, 'discovered on the same port');
    assert.equal(await desktopBytes(s.dir, id), before, 'discover: pin bytes unchanged');
    const r = await s.client.request(`/api/hosts/${id}/desktop`, { method: 'PUT', body: { preference: 'auto' } });
    assert.equal(r.status, 200);
    assert.equal(r.body.host.desktop.certPin, PIN);
    const after = JSON.parse(await desktopBytes(s.dir, id));
    const was = JSON.parse(before);
    assert.equal(after.certPin, was.certPin, 'pin byte-identical');
    assert.equal(after.certPinnedAt, was.certPinnedAt);
    assert.deepEqual([after.protocol, after.port, after.username], ['rdp', rdp.port, 'alice']);
    assert.equal(rdp.postTls, 0, 'discovery sent nothing after TLS');
  } finally { await s.stop(); }
});

test('e2e B: discovery finds RDP on a different port; first-click PUT moves the port, pin dropped and not replaced', async () => {
  const oldRdp = await capturingRdp();
  const newRdp = await capturingRdp();
  assert.notEqual(oldRdp.port, newRdp.port);
  const { dataDir, id } = await seededPinnedHost(oldRdp.port);
  await oldRdp.stop(); // the RDP service moved: only the new port answers
  const s = await setup({ dataDir, vnc: false, rdpServer: newRdp });
  try {
    const before = await desktopBytes(s.dir, id);
    assert.ok(before.includes(PIN));
    const d = await s.client.request(`/api/hosts/${id}/desktop/discover`, { method: 'POST' });
    assert.equal(d.body.discovery.rdp.port, newRdp.port);
    assert.equal(await desktopBytes(s.dir, id), before, 'discover alone never touches the pin');
    const r = await confirmedSave(s.client, `/api/hosts/${id}/desktop`, { preference: 'rdp' });
    assert.equal(r.status, 200);
    assert.equal(r.body.host.desktop.certPin, null);
    const after = JSON.parse(await desktopBytes(s.dir, id));
    assert.equal(after.port, newRdp.port, 'port from the discovery result');
    assert.equal(after.certPin, undefined, 'pin dropped');
    assert.equal(after.certPinnedAt, undefined, 'and not replaced');
    assert.ok(!(await readFile(`${s.dir}/remotehub.json`, 'utf8')).includes('sha256:'), 'no fingerprint anywhere on disk');
  } finally { await s.stop(); }
});

// Real port selection (no probe override): saved port > DESKTOP_DISCOVERY_PORTS > defaults.
test('discovery port selection end to end: server-configured discovery port is probed and saved by first click', async () => {
  const { parseDiscoveryPorts } = await import('../server/desktop-discovery.js');
  assert.deepEqual({ ...parseDiscoveryPorts('vnc=15901, rdp:13389') }, { vnc: 15901, rdp: 13389 });
  assert.deepEqual({ ...parseDiscoveryPorts('') }, {});
  for (const bad of ['vnc=0', 'ssh=22', 'vnc=99999', 'vnc']) assert.throws(() => parseDiscoveryPorts(bad), /DESKTOP_DISCOVERY_PORTS/);
  const vnc = await startFakeVncServer({ types: [2] });
  const dead = await new Promise((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
  const t = await startTestApp({
    guacd: { enabled: true, host: '127.0.0.1', port: dead, protocol: 'vnc', timeoutMs: 300, cacheMs: 0 },
    protocolSupport: { check: async () => ({ rdp: true, vnc: true }), known: () => true },
    discoveryPorts: { vnc: vnc.port, rdp: dead },
  }, { log: () => {} });
  try {
    const client = httpClient(t.base, t.origin);
    const code = (await readFile(`${t.dataDir}/SETUP-CODE.txt`, 'utf8')).trim();
    await client.request('/api/auth/setup', { method: 'POST', body: { setupCode: code, password: 'owner-password-1' } });
    const host = (await client.request('/api/hosts', { method: 'POST', body: { name: 'pc', address: '127.0.0.1', port: 22, username: 'me' } })).body.host;
    const d = await client.request(`/api/hosts/${host.id}/desktop/discover`, { method: 'POST' });
    assert.deepEqual([d.body.discovery.vnc.available, d.body.discovery.vnc.port], [true, vnc.port], 'configured VNC port probed');
    assert.deepEqual([d.body.discovery.rdp.available, d.body.discovery.rdp.port], [false, dead]);
    const r = await confirmedSave(client, `/api/hosts/${host.id}/desktop`, { preference: 'auto' });
    assert.deepEqual([r.status, r.body.host.desktop.protocol, r.body.host.desktop.port], [200, 'vnc', vnc.port]);
    for (const sent of vnc.received) assert.equal(sent, 'RFB 003.008\n');
  } finally { await t.stop(); await vnc.stop(); }
});

test('result lines: configured host whose VNC went away shows the probe reason and the agent/helper path', async () => {
  const { discoveryResultLines } = await import('../public/js/host-actions.js');
  const host = { desktop: { protocol: 'vnc', port: 15901 }, desktopDiscovery: { vnc: { available: false } }, desktopBackends: [
    { backend: 'rdp', available: false, selectable: false, reason: 'Nothing answered on port 3389. Check that the remote computer is on and RDP remote desktop is turned on.' },
    { backend: 'vnc', available: false, selectable: false, reason: 'Nothing answered on port 15901. Check that the remote computer is on and VNC remote desktop is turned on.' },
    { backend: 'nativeStream', available: false, selectable: false, reason: 'Needs the RemoteHub agent installed on this computer.' }] };
  const lines = discoveryResultLines(host);
  assert.ok(lines.includes('VNC: Nothing answered on port 15901. Check that the remote computer is on and VNC remote desktop is turned on.'));
  assert.ok(lines.some((l) => l === 'No remote desktop found. Turn on remote desktop on that computer, or install the RemoteHub agent on it.'));
});

// ── Review fixes ────────────────────────────────────────────────────────
async function app(extra = {}) {
  const t = await startTestApp({
    guacd: { enabled: true, host: '127.0.0.1', port: await closedPort(), protocol: 'vnc', timeoutMs: 300, cacheMs: 0 },
    protocolSupport: { check: async () => ({ rdp: true, vnc: true }), known: () => true },
    discoveryIntervalMs: 1,
    ...extra,
  });
  const client = httpClient(t.base, t.origin);
  const code = (await readFile(`${t.dataDir}/SETUP-CODE.txt`, 'utf8')).trim();
  await client.request('/api/auth/setup', { method: 'POST', body: { setupCode: code, password: 'owner-password-1' } });
  const host = (await client.request('/api/hosts', { method: 'POST', body: { name: 'pc', address: '127.0.0.1', port: 22, username: 'me' } })).body.host;
  const url = `/api/hosts/${host.id}/desktop`;
  const discover = () => client.request(`${url}/discover`, { method: 'POST' });
  const put = (body) => client.request(url, { method: 'PUT', body });
  return { t, client, host, url, discover, put };
}
async function noTlsRdp() {
  const server = net.createServer((socket) => {
    socket.on('error', () => {});
    socket.once('data', () => { socket.write(Buffer.from([0x03, 0, 0, 0x13, 0x0e, 0xd0, 0, 0, 0x12, 0x34, 0, 0x03, 0, 0x08, 0, 0x02, 0, 0, 0])); socket.end(); });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { port: server.address().port, stop: () => new Promise((r) => server.close(() => r())) };
}

test('Review: RDP without TLS is unsupported: Auto, explicit pick and explicit settings all refused (400, same plain message); nothing saved', async () => {
  const { NO_TLS_RDP } = await import('../public/js/desktop-auto.js');
  const rdp = await noTlsRdp();
  const a = await app({ discoveryDefaultPorts: { rdp: rdp.port, vnc: await closedPort() } });
  try {
    const d = await a.discover();
    assert.deepEqual([d.body.discovery.rdp.available, d.body.discovery.rdp.tls], [true, false]);
    const entry = d.body.host.desktopBackends.find((b) => b.backend === 'rdp');
    assert.deepEqual([entry.insecure, entry.available, entry.selectable, entry.reason], [true, false, false, NO_TLS_RDP]);
    assert.notEqual(d.body.host.effectiveCapabilities?.desktop?.rdp, true, 'does not enable Desktop');
    // Host card (UI): Desktop stays disabled and the card shows the plain message.
    const desktopAction = hostActions({ ...d.body.host, desktopServerEnabled: true, desktopProtocols: { rdp: true, vnc: true } })[2];
    assert.equal(desktopAction.enabled, false);
    assert.ok(discoveryResultLines(d.body.host).some((l) => l === `RDP: ${NO_TLS_RDP}`), discoveryResultLines(d.body.host).join(' | '));
    const confirm = { protocol: 'rdp', address: '127.0.0.1', port: rdp.port };
    const auto = await a.put({ preference: 'auto', confirm });
    assert.equal(auto.status, 400, 'Auto never picks it');
    assert.equal(auto.body.reasons.rdp, NO_TLS_RDP);
    for (const body of [{ preference: 'rdp' }, { preference: 'rdp', confirm }]) {
      const r = await a.put(body);
      assert.deepEqual([r.status, r.body.error], [400, NO_TLS_RDP], JSON.stringify(body));
    }
    const settings = await a.put({ protocol: 'rdp', port: rdp.port });
    assert.deepEqual([settings.status, settings.body.error], [400, NO_TLS_RDP], 'explicit settings save refused too');
    const disk = JSON.parse(await readFile(`${a.t.dataDir}/remotehub.json`, 'utf8')).hosts[0];
    assert.equal(disk.desktop ?? null, null, 'nothing saved');
  } finally { await a.t.stop(); await rdp.stop(); }
});

test('review (3): discovery checks the owner-saved port and the default; saved port found -> Auto without confirmation', async () => {
  const vnc = await startFakeVncServer({ types: [2] });
  const a = await app({ discoveryDefaultPorts: { rdp: await closedPort(), vnc: await closedPort() } });
  try {
    assert.equal((await a.put({ protocol: 'vnc', port: vnc.port })).status, 200, 'owner saves the VNC port (explicit settings path)');
    const d = await a.discover();
    assert.deepEqual([d.body.discovery.vnc.available, d.body.discovery.vnc.port], [true, vnc.port]);
    assert.equal(d.body.discovery.vnc.tried.length, 2, 'saved and default port both checked');
    assert.equal(d.body.host.desktopBackends.find((b) => b.backend === 'vnc').unconfirmed, false);
    const r = await a.put({ preference: 'auto' });
    assert.deepEqual([r.status, r.body.host.desktop.port], [200, vnc.port], 'saved port: no confirmation needed');
    // ?port= in the query or body never selects what is probed.
    const q = await a.client.request(`${a.url}/discover?port=5900&vnc=5900`, { method: 'POST', body: { port: 5900, ports: { vnc: 5900 } } });
    assert.ok(q.body.discovery.vnc.tried.every((x) => x.port !== 5900), 'request cannot add a port');
  } finally { await a.t.stop(); await vnc.stop(); }
});

test('Review ruling: found only on an unsaved port -> needs confirmation of exact address:port (VNC and RDP)', async () => {
  const vnc = await startFakeVncServer({ types: [2] });
  const rdp = await capturingRdp();
  const a = await app({ discoveryDefaultPorts: { rdp: rdp.port, vnc: vnc.port } });
  try {
    await a.discover();
    const none = await a.put({ preference: 'auto' });
    assert.equal(none.status, 400, 'Auto never chooses an unsaved port');
    assert.deepEqual(none.body.needsConfirm, { protocol: 'rdp', address: '127.0.0.1', port: rdp.port }, 'RDP first (fixed order)');
    const vncPick = await a.put({ preference: 'vnc' });
    assert.deepEqual(vncPick.body.needsConfirm, { protocol: 'vnc', address: '127.0.0.1', port: vnc.port }, 'explicit pick needs it too');
    const bad = [
      { protocol: 'rdp', address: '10.0.0.5', port: rdp.port },
      { protocol: 'rdp', address: '127.0.0.1', port: rdp.port + 1 },
      { protocol: 'vnc', address: '127.0.0.1', port: rdp.port },
      { protocol: 'rdp', address: '127.0.0.1', port: String(rdp.port) },
      'yes', true, null,
    ];
    for (const confirm of bad) assert.equal((await a.put({ preference: 'auto', confirm })).status, 400, JSON.stringify(confirm));
    assert.equal((await a.put({ protocol: 'rdp', confirm: none.body.needsConfirm })).status, 400, 'confirm only with a preference');
    assert.equal(JSON.parse(await readFile(`${a.t.dataDir}/remotehub.json`, 'utf8')).hosts[0].desktop, undefined, 'nothing saved by refused requests');
    const okVnc = await a.put({ preference: 'vnc', confirm: vncPick.body.needsConfirm });
    assert.deepEqual([okVnc.status, okVnc.body.host.desktop.protocol, okVnc.body.host.desktop.port], [200, 'vnc', vnc.port]);
    await a.discover(); // the VNC save changed the saved port and cleared discovery
    assert.equal((await a.put({ preference: 'vnc', confirm: vncPick.body.needsConfirm })).body.host?.desktop?.port, vnc.port, 'saved VNC port: confirm still accepted');
    const okRdp = await a.put({ preference: 'auto', confirm: none.body.needsConfirm });
    assert.deepEqual([okRdp.status, okRdp.body.host.desktop.protocol, okRdp.body.host.desktop.port], [200, 'rdp', rdp.port]);
    await a.discover();
    assert.equal((await a.put({ preference: 'auto' })).status, 200, 'once saved, Auto may use it without confirming again');
  } finally { await a.t.stop(); await vnc.stop(); await rdp.stop(); }
});

test('review (5)(6): password/certPin refused on every path; nativeStream 400 (SAA-311); protocol vs preference disagree 400', async () => {
  const vnc = await startFakeVncServer({ types: [2] });
  const a = await app({ discoveryDefaultPorts: { rdp: await closedPort(), vnc: vnc.port } });
  try {
    for (const body of [{ password: 'x' }, { protocol: 'vnc', password: 'x' }, { preference: 'auto', password: 'x' }, { certPin: PIN }, { protocol: 'rdp', certPin: PIN }, { preference: 'rdp', certPin: PIN }]) {
      const r = await a.put(body);
      assert.equal(r.status, 400, JSON.stringify(body));
      assert.match(r.body.error, 'password' in body ? /passwords are not stored/ : /remembers this computer's identity on first connect/);
    }
    const native = await a.put({ preference: 'nativeStream' });
    assert.equal(native.status, 400);
    assert.match(native.body.error, /own desktop streaming isn't available yet/);
    assert.equal((await a.put({ preference: 'rdp', protocol: 'vnc' })).status, 400);
    assert.equal((await a.put({ preference: 'auto', protocol: 'vnc' })).status, 400);
    const agree = await a.put({ preference: 'vnc', protocol: 'vnc', port: vnc.port });
    assert.deepEqual([agree.status, agree.body.host.desktopPreference], [200, 'vnc']);
    const stored = await readFile(`${a.t.dataDir}/remotehub.json`, 'utf8');
    const hostJson = JSON.stringify(JSON.parse(stored).hosts);
    assert.ok(!/password/i.test(hostJson), 'no password field on any host');
    assert.ok(!stored.includes(PIN), 'client pin never stored');
  } finally { await a.t.stop(); await vnc.stop(); }
});

test('review (4): desktop save is one atomic store write (settings + capabilities + preference), rolled back on failure', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'rh-atomic-'));
  const store = await new Store(dataDir).load();
  const h = await store.addHost({ name: 'p', address: '127.0.0.1', port: 22, username: 'me' });
  let saves = 0;
  const realSave = store.save.bind(store);
  store.save = async () => { saves += 1; return realSave(); };
  await store.saveDesktopChoice(h.id, { desktop: { protocol: 'vnc', port: 5901 }, capabilities: { ...store.getHost(h.id).capabilities, desktop: { vnc: true } }, preference: 'auto' });
  assert.equal(saves, 1, 'exactly one write');
  const disk = JSON.parse(await readFile(`${dataDir}/remotehub.json`, 'utf8')).hosts[0];
  assert.deepEqual([disk.desktop.port, disk.capabilities.desktop.vnc, disk.desktopPreference], [5901, true, 'auto']);
  store.save = async () => { throw new Error('disk full'); };
  await assert.rejects(store.saveDesktopChoice(h.id, { desktop: { protocol: 'rdp', port: 3390 }, capabilities: {}, preference: 'rdp' }), /disk full/);
  const mem = store.getHost(h.id);
  assert.deepEqual([mem.desktop.protocol, mem.desktop.port, mem.desktopPreference, mem.capabilities.desktop.vnc], ['vnc', 5901, 'auto', true], 'all-or-nothing in memory too');
  const src = await readFile(new URL('../server/app.js', import.meta.url), 'utf8');
  const route = src.slice(src.indexOf("api.put('/hosts/:id/desktop'"), src.indexOf("api.delete('/hosts/:id/desktop'"));
  assert.equal((route.match(/await store\./g) || []).length, 1, 'the PUT route writes the store exactly once');
});

test('review (8): deleting a host forgets its discovery limiter slot', async () => {
  const forgotten = [];
  const limiter = { take: () => ({ ok: true }), forget: (id) => forgotten.push(id) };
  const a = await app({ discoveryLimiter: limiter, discoveryDefaultPorts: { rdp: await closedPort(), vnc: await closedPort() } });
  try {
    await a.discover();
    assert.equal((await a.client.request(`/api/hosts/${a.host.id}`, { method: 'DELETE' })).status, 200);
    assert.deepEqual(forgotten, [a.host.id]);
  } finally { await a.t.stop(); }
});

// Re-review: a new address is a different machine; its discovery results are dropped so a
// confirmation can never pair the new address with a port found on the old one.
test('changing the host address clears desktopDiscovery; a confirm for the new address is refused until rediscovered', async () => {
  const vnc = await startFakeVncServer({ types: [2] });
  const a = await app({ discoveryDefaultPorts: { rdp: await closedPort(), vnc: vnc.port } });
  try {
    const d = await a.discover();
    assert.equal(d.body.discovery.vnc.available, true);
    const edit = await a.client.request(`/api/hosts/${a.host.id}`, { method: 'PUT', body: { name: 'pc', address: 'localhost', port: 22, username: 'me' } });
    assert.equal(edit.status, 200);
    assert.equal(edit.body.host.desktopDiscovery, null, 'cleared in the view');
    const disk = JSON.parse(await readFile(`${a.t.dataDir}/remotehub.json`, 'utf8')).hosts[0];
    assert.equal(disk.desktopDiscovery, undefined, 'cleared on disk');
    const forged = await a.put({ preference: 'vnc', confirm: { protocol: 'vnc', address: 'localhost', port: vnc.port } });
    assert.equal(forged.status, 400, 'old-machine port cannot be confirmed for the new address');
    assert.equal(disk.desktop, undefined);
    // Same-address edits keep discovery.
    await a.discover();
    const same = await a.client.request(`/api/hosts/${a.host.id}`, { method: 'PUT', body: { name: 'renamed', address: 'localhost', port: 22, username: 'me' } });
    assert.equal(same.body.host.desktopDiscovery?.vnc?.available, true);
  } finally { await a.t.stop(); await vnc.stop(); }
});

// Review: changing the saved desktop port (any protocol) also clears discovery.
test('changing the saved desktop port clears desktopDiscovery (same write); unchanged port keeps it; removing settings clears it', async () => {
  const vnc = await startFakeVncServer({ types: [2] });
  const rdp = await capturingRdp();
  const a = await app({ discoveryDefaultPorts: { rdp: rdp.port, vnc: vnc.port } });
  const disk = async () => JSON.parse(await readFile(`${a.t.dataDir}/remotehub.json`, 'utf8')).hosts[0];
  try {
    assert.equal((await a.put({ protocol: 'vnc', port: vnc.port })).status, 200);
    await a.discover();
    // Same protocol and port: discovery kept.
    const same = await a.put({ protocol: 'vnc', port: vnc.port, username: 'bob' });
    assert.equal(same.body.host.desktopDiscovery?.vnc?.available, true, 'unchanged port keeps discovery');
    // VNC port changed -> cleared.
    const moved = await a.put({ protocol: 'vnc', port: vnc.port + 1 });
    assert.equal(moved.body.host.desktopDiscovery, null);
    assert.equal((await disk()).desktopDiscovery, undefined);
    // Protocol changed to RDP on a port discovery did NOT find -> cleared.
    await a.discover();
    assert.equal((await a.put({ protocol: 'rdp', port: rdp.port + 1 })).body.host.desktopDiscovery, null, 'RDP saved port differing from discovery clears it');
    // Protocol changed to exactly the discovered RDP port -> kept.
    await a.discover();
    assert.equal((await a.put({ protocol: 'rdp', port: rdp.port })).body.host.desktopDiscovery?.rdp?.available, true, 'save equal to discovery keeps it');
    await a.put({ protocol: 'rdp', port: rdp.port + 2 });
    // A confirmation can't reuse the cleared result.
    assert.equal((await a.put({ preference: 'vnc', confirm: { protocol: 'vnc', address: '127.0.0.1', port: vnc.port } })).status, 400);
    // First-click save (confirmed) of exactly what discovery found keeps discovery,
    // and the saved backend is no longer 'unconfirmed'.
    await a.client.request(`${a.url}`, { method: 'DELETE' });
    await a.discover();
    const first = await a.put({ preference: 'vnc', confirm: { protocol: 'vnc', address: '127.0.0.1', port: vnc.port } });
    assert.deepEqual([first.status, first.body.host.desktop.port, first.body.host.desktopDiscovery?.vnc?.port], [200, vnc.port, vnc.port]);
    const vncEntry = first.body.host.desktopBackends.find((b) => b.backend === 'vnc');
    assert.deepEqual([vncEntry.available, vncEntry.unconfirmed, vncEntry.note], [true, false, '']);
    assert.ok(!JSON.stringify((await disk()).desktopDiscovery).includes('sha256'), 'kept discovery holds no pin');
    // Removing desktop settings clears it.
    await a.discover();
    assert.equal((await a.client.request(a.url, { method: 'DELETE' })).body.host.desktopDiscovery, null);
    assert.equal((await disk()).desktopDiscovery, undefined);
  } finally { await a.t.stop(); await vnc.stop(); await rdp.stop(); }
});

// Review: a valid cookie with NO Origin must be refused like a wrong Origin.
test('discover and desktop save: missing Origin -> 403, wrong Origin -> 403, correct Origin -> 200', async () => {
  const vnc = await startFakeVncServer({ types: [2] });
  const a = await app({ discoveryDefaultPorts: { rdp: await closedPort(), vnc: vnc.port } });
  const raw = (path, method, origin, body) => fetch(`${a.t.base}${path}`, { method,
    headers: { Cookie: a.client.cookie, ...(origin ? { Origin: origin } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined }).then((r) => r.status);
  try {
    const save = { protocol: 'vnc', port: vnc.port };
    assert.equal(await raw(`${a.url}/discover`, 'POST', null), 403, 'discover, no Origin');
    assert.equal(await raw(`${a.url}/discover`, 'POST', 'http://evil.example'), 403, 'discover, wrong Origin');
    assert.equal(await raw(a.url, 'PUT', null, save), 403, 'save, no Origin');
    assert.equal(await raw(a.url, 'PUT', 'http://evil.example', save), 403, 'save, wrong Origin');
    const disk = JSON.parse(await readFile(`${a.t.dataDir}/remotehub.json`, 'utf8')).hosts[0];
    assert.equal(disk.desktop ?? null, null, 'refused requests changed nothing');
    assert.equal(disk.desktopDiscovery, undefined, 'refused discover did not probe/store');
    assert.equal(await raw(`${a.url}/discover`, 'POST', a.t.origin), 200, 'discover, correct Origin');
    assert.equal(await raw(a.url, 'PUT', a.t.origin, save), 200, 'save, correct Origin');
    // Same shared check guards the other state-changing API routes (e.g. logout).
    assert.equal(await raw('/api/auth/logout', 'POST', null), 403);
    // GET is unaffected.
    assert.equal(await raw('/api/hosts', 'GET', null), 200);
  } finally { await a.t.stop(); await vnc.stop(); }
});
