import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { probeVncBackend } from '../server/desktop-discovery.js';
import { startFakeVncServer } from './helpers/fake-vnc-server.js';
import { closedPort, httpClient, startTestApp } from './helpers/app-harness.js';

/**
 * Review (#23 at 98e95f2): discovery must not write a result for a host that changed
 * (address, desktop protocol/port) or was removed while the probes ran.
 */
async function slowApp() {
  const vnc = await startFakeVncServer({ types: [2] });
  const rdpPort = await closedPort();
  const calls = [];
  let release; let started;
  const gate = { opened: null, started: null };
  const arm = () => {
    gate.opened = new Promise((r) => { release = r; });
    gate.started = new Promise((r) => { started = r; });
  };
  arm();
  const probes = {
    rdp: async ({ host, port }) => { calls.push({ backend: 'rdp', host, port }); await gate.opened; return { available: false, reason: 'closed' }; },
    vnc: async (args) => { calls.push({ backend: 'vnc', host: args.host, port: args.port }); started(); await gate.opened; return probeVncBackend({ ...args, host: '127.0.0.1' }); },
  };
  const t = await startTestApp({
    guacd: { enabled: true, host: '127.0.0.1', port: await closedPort(), protocol: 'vnc', timeoutMs: 300, cacheMs: 0 },
    protocolSupport: { check: async () => ({ rdp: true, vnc: true }), known: () => true },
    discoveryIntervalMs: 1,
    discoveryDefaultPorts: { rdp: rdpPort, vnc: vnc.port },
    discoveryProbes: probes,
  });
  const client = httpClient(t.base, t.origin);
  const code = (await readFile(`${t.dataDir}/SETUP-CODE.txt`, 'utf8')).trim();
  await client.request('/api/auth/setup', { method: 'POST', body: { setupCode: code, password: 'owner-password-1' } });
  const host = (await client.request('/api/hosts', { method: 'POST', body: { name: 'pc', address: '127.0.0.1', port: 22, username: 'me' } })).body.host;
  const url = `/api/hosts/${host.id}/desktop`;
  const disk = async () => JSON.parse(await readFile(`${t.dataDir}/remotehub.json`, 'utf8')).hosts.find((h) => h.id === host.id);
  // Start a discovery and wait until the probes are running (held at the gate).
  const startDiscover = async (body) => {
    const p = client.request(`${url}/discover`, { method: 'POST', ...(body ? { body } : {}) });
    await gate.started;
    return p;
  };
  const finish = () => { release(); };
  return { t, client, host, url, vnc, calls, disk, startDiscover, finish, arm, stop: async () => { await t.stop(); await vnc.stop(); } };
}

test('race: address changed mid-discovery -> nothing stale written; new address cannot be confirmed with the old port', async () => {
  const a = await slowApp();
  try {
    const pending = a.startDiscover();
    assert.equal((await a.client.request(`/api/hosts/${a.host.id}`, { method: 'PUT', body: { name: 'pc', address: '127.0.0.9', port: 22, username: 'me' } })).status, 200);
    a.finish();
    const res = await pending;
    assert.equal(res.status, 409, 'stale discovery is reported, not written');
    assert.equal((await a.disk()).desktopDiscovery, undefined, 'no discovery stored for the new address');
    assert.equal((await a.client.request('/api/hosts')).body.hosts[0].desktopDiscovery, null);
    const confirm = await a.client.request(a.url, { method: 'PUT', body: { preference: 'vnc', confirm: { protocol: 'vnc', address: '127.0.0.9', port: a.vnc.port } } });
    assert.equal(confirm.status, 400, 'old port cannot be confirmed for the new address');
    assert.equal((await a.disk()).desktop ?? null, null);
  } finally { await a.stop(); }
});

test('race: desktop saved mid-discovery -> discovery result dropped, saved desktop untouched', async () => {
  const a = await slowApp();
  try {
    const pending = a.startDiscover();
    assert.equal((await a.client.request(a.url, { method: 'PUT', body: { protocol: 'vnc', port: 5999 } })).status, 200);
    a.finish();
    assert.equal((await pending).status, 409);
    const d = await a.disk();
    assert.equal(d.desktopDiscovery, undefined);
    assert.equal(d.desktop.port, 5999);
  } finally { await a.stop(); }
});

test('race: desktop removed mid-discovery -> discovery result dropped', async () => {
  const a = await slowApp();
  try {
    assert.equal((await a.client.request(a.url, { method: 'PUT', body: { protocol: 'vnc', port: a.vnc.port } })).status, 200);
    const pending = a.startDiscover();
    assert.equal((await a.client.request(a.url, { method: 'DELETE' })).status, 200);
    a.finish();
    assert.equal((await pending).status, 409);
    const d = await a.disk();
    assert.equal(d.desktopDiscovery, undefined);
    assert.equal(d.desktop ?? null, null);
  } finally { await a.stop(); }
});

test('race: host deleted mid-discovery -> 404 (not 500), nothing re-created', async () => {
  const a = await slowApp();
  try {
    const pending = a.startDiscover();
    assert.equal((await a.client.request(`/api/hosts/${a.host.id}`, { method: 'DELETE' })).status, 200);
    a.finish();
    const res = await pending;
    assert.equal(res.status, 404);
    assert.equal(await a.disk(), undefined);
  } finally { await a.stop(); }
});

test('unchanged host: discovery is written (control)', async () => {
  const a = await slowApp();
  try {
    const pending = a.startDiscover();
    a.finish();
    const res = await pending;
    assert.equal(res.status, 200);
    assert.equal((await a.disk()).desktopDiscovery.vnc.available, true);
  } finally { await a.stop(); }
});

test('forged port/address in the /discover body is ignored', async () => {
  const a = await slowApp();
  try {
    const forged = await closedPort();
    const pending = a.startDiscover({ port: forged, address: '10.9.9.9', host: '10.9.9.9', ports: { vnc: forged, rdp: forged } });
    a.finish();
    assert.equal((await pending).status, 200);
    assert.ok(a.calls.length > 0);
    assert.ok(a.calls.every((c) => c.port !== forged), `forged port never probed: ${JSON.stringify(a.calls)}`);
    assert.ok(a.calls.every((c) => c.host === '127.0.0.1'), 'only the host record address is probed');
    assert.equal((await a.disk()).desktopDiscovery.vnc.port, a.vnc.port);
  } finally { await a.stop(); }
});

test('missing Origin -> 403 on DELETE /hosts/:id and POST /auth/login too', async () => {
  const a = await slowApp();
  a.finish();
  try {
    const raw = (path, method, body) => fetch(`${a.t.base}${path}`, { method,
      headers: { Cookie: a.client.cookie, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined }).then((r) => r.status);
    assert.equal(await raw(`/api/hosts/${a.host.id}`, 'DELETE'), 403, 'DELETE host, no Origin');
    assert.ok(await a.disk(), 'host still there');
    assert.equal(await raw('/api/auth/login', 'POST', { password: 'owner-password-1' }), 403, 'login, no Origin');
    // With the right Origin both work.
    assert.equal((await a.client.request('/api/auth/login', { method: 'POST', body: { password: 'owner-password-1' } })).status, 200);
    assert.equal((await a.client.request(`/api/hosts/${a.host.id}`, { method: 'DELETE' })).status, 200);
  } finally { await a.stop(); }
});
