import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import {
  GUACD_DEFAULTS, createGuacdHealth, encodeInstruction, guacdConfigFromEnv, parseInstruction, probeGuacd, publicDesktopHealth,
} from '../server/guacd.js';
import { startFakeGuacd } from './helpers/fake-guacd.js';
import { httpClient, startTestApp, unusedPort } from './helpers/app-harness.js';

/** guacd sidecar configuration and health (SAA-301). */

const probeConfig = (port, extra = {}) => ({ host: '127.0.0.1', port, protocol: 'rdp', timeoutMs: 500, ...extra });

// Ports 20000-32000 are outside the ephemeral ranges of Linux (32768-60999), macOS and
// Windows (49152-65535), so no concurrently running test file is ever handed this port
// while it is released between the down/hung/recovered steps.
async function reservedRangePort() {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const port = 20_000 + Math.floor(Math.random() * 12_000);
    const probe = net.createServer();
    try {
      await new Promise((resolve, reject) => {
        probe.once('error', reject);
        probe.listen(port, '127.0.0.1', resolve);
      });
      await new Promise((resolve) => probe.close(resolve));
      return port;
    } catch (error) {
      if (error.code !== 'EADDRINUSE') throw error;
    }
  }
  throw new Error('no free port in the reserved range');
}

const closeServer = (server) => (server.listening ? new Promise((resolve) => server.close(() => resolve())) : undefined);

test('config: disabled by default with 127.0.0.1:4822 and rdp; env overrides; bad values fail fast', () => {
  assert.deepEqual(guacdConfigFromEnv({}), { enabled: false, ...GUACD_DEFAULTS });
  assert.deepEqual(GUACD_DEFAULTS, { host: '127.0.0.1', port: 4822, protocol: 'rdp', timeoutMs: 3000, cacheMs: 5000 });
  assert.deepEqual(guacdConfigFromEnv({ GUACD_ENABLED: '1', GUACD_HOST: 'guacd', GUACD_PORT: '14822', GUACD_HEALTH_PROTOCOL: 'vnc', GUACD_HEALTH_TIMEOUT_MS: '750', GUACD_HEALTH_CACHE_MS: '0' }),
    { enabled: true, host: 'guacd', port: 14822, protocol: 'vnc', timeoutMs: 750, cacheMs: 0 });
  for (const on of ['true', 'yes', 'ON']) assert.equal(guacdConfigFromEnv({ GUACD_ENABLED: on }).enabled, true);
  for (const off of ['0', 'false', '', 'nope']) assert.equal(guacdConfigFromEnv({ GUACD_ENABLED: off }).enabled, false);
  assert.throws(() => guacdConfigFromEnv({ GUACD_PORT: '70000' }), /GUACD_PORT/);
  assert.throws(() => guacdConfigFromEnv({ GUACD_PORT: 'abc' }), /GUACD_PORT/);
  assert.throws(() => guacdConfigFromEnv({ GUACD_HOST: 'a b; rm -rf /' }), /GUACD_HOST/);
  assert.throws(() => guacdConfigFromEnv({ GUACD_HEALTH_PROTOCOL: 'rdp;6.select' }), /GUACD_HEALTH_PROTOCOL/);
  assert.throws(() => guacdConfigFromEnv({ GUACD_HEALTH_TIMEOUT_MS: '5' }), /GUACD_HEALTH_TIMEOUT_MS/);
});

test('Guacamole instructions encode and parse, including partial and malformed input', () => {
  assert.equal(encodeInstruction('select', 'rdp'), '6.select,3.rdp;');
  assert.equal(encodeInstruction('x', 'héllo'), '1.x,5.héllo;');
  assert.deepEqual(parseInstruction('4.args,13.VERSION_1_5_0;rest'), { elements: ['args', 'VERSION_1_5_0'], rest: 'rest' });
  assert.equal(parseInstruction('4.args,13.VERS'), null);
  assert.equal(parseInstruction('4'), null);
  assert.throws(() => parseInstruction('HTTP/1.1 400'), /malformed/);
  assert.throws(() => parseInstruction('4.argsX'), /malformed/);
});

test('probe: up — real handshake sends select and reads args', async () => {
  const fake = await startFakeGuacd({ mode: 'up' });
  try {
    const result = await probeGuacd(probeConfig(fake.port, { protocol: 'vnc' }));
    assert.equal(result.status, 'up');
    assert.equal(result.protocolVersion, 'VERSION_1_5_0');
    assert.deepEqual(fake.requests, ['6.select,3.vnc;']);
    // Reply split into one-character chunks still parses.
    fake.chunked = true;
    assert.equal((await probeGuacd(probeConfig(fake.port))).status, 'up');
  } finally {
    await fake.stop();
  }
});

test('probe: down — refused connection is reported quickly', async () => {
  const port = await unusedPort();
  const started = performance.now();
  const result = await probeGuacd(probeConfig(port, { timeoutMs: 5000 }));
  assert.equal(result.status, 'down');
  assert.match(result.message, /refused the connection/);
  assert.ok(performance.now() - started < 1000, 'no waiting for the timeout');
});

test('probe: hung — accepts but never answers: timeout, socket released', async () => {
  const fake = await startFakeGuacd({ mode: 'hung' });
  try {
    const started = performance.now();
    const result = await probeGuacd(probeConfig(fake.port, { timeoutMs: 300 }));
    const elapsed = Math.round(performance.now() - started);
    assert.equal(result.status, 'timeout');
    assert.match(result.message, /did not answer the handshake within 300 ms/);
    assert.ok(elapsed >= 290 && elapsed < 1500, `elapsed ${elapsed}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(fake.sockets.size, 0, 'probe closed its socket');
  } finally {
    await fake.stop();
  }
});

test('probe: connect that never completes (blackhole address) times out', async () => {
  // 10.255.255.1 is normally unroutable; if the network refuses instead, that is "down".
  const result = await probeGuacd(probeConfig(4822, { host: '10.255.255.1', timeoutMs: 300 }));
  assert.ok(['timeout', 'down'].includes(result.status), result.status);
  assert.ok(result.latencyMs < 1500);
});

test('probe: protocol unavailable, guacd error, and non-guacd replies', async () => {
  const fake = await startFakeGuacd({ mode: 'close' });
  try {
    let result = await probeGuacd(probeConfig(fake.port));
    assert.equal(result.status, 'protocol-unavailable');
    assert.match(result.message, /rdp plugin is probably not installed/);
    fake.mode = 'error';
    result = await probeGuacd(probeConfig(fake.port));
    assert.equal(result.status, 'protocol-unavailable');
    assert.match(result.message, /Protocol not supported/);
    fake.mode = 'garbage';
    assert.equal((await probeGuacd(probeConfig(fake.port))).status, 'bad-response');
    fake.mode = 'flood';
    assert.equal((await probeGuacd(probeConfig(fake.port))).status, 'bad-response');
  } finally {
    await fake.stop();
  }
});

test('health monitor: disabled never opens a socket; cache and single-flight bound probes', async () => {
  let probes = 0;
  const disabled = createGuacdHealth({ ...GUACD_DEFAULTS, enabled: false }, { probe: async () => { probes += 1; return { status: 'up' }; } });
  assert.deepEqual(await disabled.check(), { enabled: false, status: 'disabled', message: 'Desktop is disabled (GUACD_ENABLED is not set).' });
  assert.equal(probes, 0);

  let clock = 1_000;
  let release;
  const health = createGuacdHealth({ ...GUACD_DEFAULTS, enabled: true, cacheMs: 5000 }, {
    now: () => clock,
    probe: () => { probes += 1; return new Promise((resolve) => { release = () => resolve({ status: 'up', message: 'ok', latencyMs: 3 }); }); },
  });
  const many = Promise.all(Array.from({ length: 20 }, () => health.check()));
  await new Promise((resolve) => setImmediate(resolve));
  release();
  const results = await many;
  assert.equal(probes, 1, '20 concurrent checks -> one probe');
  assert.ok(results.every((r) => r.status === 'up' && r.healthy === true));
  await health.check();
  assert.equal(probes, 1, 'cached');
  clock += 5001;
  const again = health.check();
  release();
  await again;
  assert.equal(probes, 2, 'cache expired');
  const fresh = health.check({ fresh: true });
  release();
  await fresh;
  assert.equal(probes, 3, 'fresh bypasses the cache');
  assert.deepEqual(publicDesktopHealth(await health.check()), { enabled: true, status: 'up', healthy: true });
});

test('API: desktop disabled keeps the terminal deployment unchanged and never contacts guacd', async () => {
  // Something listening on the default-looking port must never be touched.
  const trap = await startFakeGuacd({ mode: 'up' });
  const env = await startTestApp({ guacd: { ...GUACD_DEFAULTS, enabled: false, port: trap.port } });
  try {
    const client = httpClient(env.base, env.origin);
    const health = await client.request('/api/health');
    assert.equal(health.status, 200);
    assert.deepEqual(health.body, { ok: true, desktop: { enabled: false, status: 'disabled' } });
    // Older configs without a guacd block behave the same.
    assert.equal(trap.connections, 0);
  } finally {
    await env.stop();
    await trap.stop();
  }
  const legacy = await startTestApp({});
  try {
    const health = await httpClient(legacy.base, legacy.origin).request('/api/health');
    assert.deepEqual(health.body.desktop, { enabled: false, status: 'disabled' });
  } finally {
    await legacy.stop();
  }
});

test('API: health and owner status follow guacd up -> down -> hung -> recovered', async () => {
  const port = await reservedRangePort();
  // Same reply as startFakeGuacd({ mode: 'up' }), on a caller-chosen port.
  const fakeSockets = new Set();
  const fake = net.createServer((socket) => {
    socket.on('error', () => {});
    fakeSockets.add(socket);
    socket.on('close', () => fakeSockets.delete(socket));
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk;
      if (buffer.includes(';')) socket.write('4.args,13.VERSION_1_5_0,8.hostname,4.port,8.password;');
    });
  });
  const held = new Set();
  const hung = net.createServer((s) => { held.add(s); s.on('close', () => held.delete(s)); });
  const backSockets = new Set();
  const back = net.createServer((s) => {
    backSockets.add(s);
    s.on('error', () => {});
    s.on('close', () => backSockets.delete(s));
    s.on('data', () => s.write('4.args,13.VERSION_1_5_0;'));
  });
  const env = await startTestApp({ guacd: { enabled: true, host: '127.0.0.1', port, protocol: 'rdp', timeoutMs: 400, cacheMs: 0 } });
  const client = httpClient(env.base, env.origin);
  try {
    await new Promise((resolve) => fake.listen(port, '127.0.0.1', resolve));
    let health = await client.request('/api/health');
    assert.equal(health.status, 200);
    assert.deepEqual(health.body, { ok: true, desktop: { enabled: true, status: 'up', healthy: true } });
    assert.equal(JSON.stringify(health.body).includes(String(port)), false, 'public health hides the guacd address');

    // Owner status needs a session.
    assert.equal((await client.request('/api/desktop/status')).status, 401);
    await client.request('/api/auth/setup', { method: 'POST', body: { setupCode: env.app.setupCode, password: 'guacd-owner-password' } });
    let status = (await client.request('/api/desktop/status')).body.guacd;
    assert.equal(status.status, 'up');
    assert.equal(status.port, port);
    assert.equal(status.protocolVersion, 'VERSION_1_5_0');

    // Down: guacd stopped.
    for (const s of fakeSockets) s.destroy();
    await closeServer(fake);
    let started = performance.now();
    health = await client.request('/api/health');
    assert.deepEqual(health.body.desktop, { enabled: true, status: 'down', healthy: false });
    assert.ok(performance.now() - started < 1000);
    status = (await client.request('/api/desktop/status?fresh=1')).body.guacd;
    assert.equal(status.status, 'down');
    assert.match(status.message, /refused the connection \(is guacd running\?\)/);

    // Hung: something accepts on the port but never speaks.
    await new Promise((resolve) => hung.listen(port, '127.0.0.1', resolve));
    started = performance.now();
    status = (await client.request('/api/desktop/status?fresh=1')).body.guacd;
    assert.equal(status.status, 'timeout');
    assert.ok(performance.now() - started < 1500, 'bounded by GUACD timeout');
    for (const s of held) s.destroy();
    await closeServer(hung);

    // Recovered: guacd back on the same port.
    await new Promise((resolve) => back.listen(port, '127.0.0.1', resolve));
    status = (await client.request('/api/desktop/status?fresh=1')).body.guacd;
    assert.equal(status.status, 'up');
  } finally {
    for (const s of [...fakeSockets, ...held, ...backSockets]) s.destroy();
    await Promise.all([closeServer(fake), closeServer(hung), closeServer(back)]);
    await env.stop();
  }
});
