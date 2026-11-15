import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import WebSocket from 'ws';
import { InstructionStream, browserFixedSize, encode } from '../server/desktop-bridge.js';
import { startFakeGuacdSession } from './helpers/fake-guacd-session.js';
import { httpClient, startTestApp } from './helpers/app-harness.js';

/** SAA-352: the browser may turn RDP resizing OFF (fixed=1); nothing else changes. */

const RDP_ARGS = ['VERSION_1_5_0', 'hostname', 'port', 'username', 'resize-method', 'ignore-cert', 'security'];
const VNC_ARGS = ['VERSION_1_5_0', 'hostname', 'port', 'password'];

async function setup(protocol) {
  const argNames = protocol === 'rdp' ? RDP_ARGS : VNC_ARGS;
  const guacd = await startFakeGuacdSession({ mode: 'ok', argNames });
  const t = await startTestApp({ guacd: { enabled: true, host: '127.0.0.1', port: guacd.port, protocol, timeoutMs: 500, cacheMs: 0 } });
  const client = httpClient(t.base, t.origin);
  const code = (await readFile(`${t.dataDir}/SETUP-CODE.txt`, 'utf8')).trim();
  assert.equal((await client.request('/api/auth/setup', { method: 'POST', body: { setupCode: code, password: 'owner-password-1' } })).status, 200);
  const host = (await client.request('/api/hosts', { method: 'POST', body: { name: 'box', address: '10.9.8.7', port: 22, username: 'me' } })).body.host;
  // ignoreCert skips the certificate preflight, so no real TLS probe is needed for RDP.
  const desktop = protocol === 'rdp'
    ? { protocol: 'rdp', port: 3389, username: 'alice', domain: 'CORP', security: 'tls', ignoreCert: true }
    : { protocol: 'vnc', port: 5909 };
  assert.equal((await client.request(`/api/hosts/${host.id}/desktop`, { method: 'PUT', body: desktop })).status, 200);
  return { guacd, argNames, t, client, host, stop: async () => { await t.stop(); await guacd.stop(); } };
}

/**
 * Opens /ws/desktop with `query` appended, waits for guacd `ready`, and returns the
 * `connect` instruction's values keyed by the argument names guacd listed in `args`.
 */
async function connectParams(s, query = '') {
  const ws = new WebSocket(`${s.t.base.replace('http', 'ws')}/ws/desktop?hostId=${s.host.id}&width=1280&height=720&dpi=96${query}`,
    { headers: { Origin: s.t.origin, Cookie: s.client.cookie } });
  const instructions = [];
  const parser = new InstructionStream();
  ws.on('open', () => ws.send(encode('credentials')));
  ws.on('message', (d) => { for (const i of parser.push(d.toString())) instructions.push(i.elements); });
  ws.on('error', () => {});
  const closed = new Promise((resolve) => ws.on('close', resolve));
  try {
    const end = Date.now() + 4000;
    while (!instructions.some((i) => i[0] === 'ready')) {
      if (Date.now() > end) throw new Error(`timeout waiting for ready; got ${JSON.stringify(instructions)}`);
      await new Promise((r) => setTimeout(r, 10));
    }
    const connect = s.guacd.received.at(-1).find((i) => i[0] === 'connect');
    assert.ok(connect, 'guacd received connect');
    return Object.fromEntries(s.argNames.map((name, index) => [name, connect[index + 1]]));
  } finally {
    ws.close();
    await closed;
  }
}

test('browserFixedSize: only the exact value 1 turns resizing off (URLSearchParams.get: first value wins)', () => {
  assert.equal(browserFixedSize(new URLSearchParams('fixed=1')), true);
  assert.equal(browserFixedSize(new URLSearchParams('')), false, 'absent');
  assert.equal(browserFixedSize(new URLSearchParams('fixed=0')), false);
  assert.equal(browserFixedSize(new URLSearchParams('fixed=true')), false);
  assert.equal(browserFixedSize(new URLSearchParams('fixed=01')), false);
  assert.equal(browserFixedSize(new URLSearchParams('fixed=display-update')), false);
  assert.equal(browserFixedSize(new URLSearchParams('fixed=1&fixed=0')), true, 'first value wins: get() returns "1"');
  assert.equal(browserFixedSize(new URLSearchParams('fixed=0&fixed=1')), false, 'first value wins: get() returns "0"');
});

test('RDP without fixed: guacd gets resize-method display-update', async () => {
  const s = await setup('rdp');
  try {
    const params = await connectParams(s);
    assert.equal(params['resize-method'], 'display-update');
  } finally { await s.stop(); }
});

test('RDP with fixed=1: resize-method is empty and every other connect value matches the default', async () => {
  const s = await setup('rdp');
  try {
    const normal = await connectParams(s);
    const fixed = await connectParams(s, '&fixed=1');
    assert.equal(fixed['resize-method'], '');
    for (const name of ['hostname', 'port', 'username', 'security', 'ignore-cert']) {
      assert.equal(fixed[name], normal[name], name);
    }
    assert.equal(fixed.hostname, '10.9.8.7');
    assert.equal(fixed.port, '3389');
    assert.equal(fixed.username, 'alice');
    assert.equal(fixed.security, 'tls');
    assert.equal(fixed['ignore-cert'], 'true');
  } finally { await s.stop(); }
});

test('RDP with any value other than 1 (0, true, display-update, reconnect, repeated) keeps display-update', async () => {
  const s = await setup('rdp');
  try {
    for (const query of ['&fixed=0', '&fixed=true', '&fixed=display-update', '&fixed=reconnect', '&fixed=0&fixed=1']) {
      const params = await connectParams(s, query);
      assert.equal(params['resize-method'], 'display-update', query);
    }
  } finally { await s.stop(); }
});

test('VNC with fixed=1: connect values are identical to VNC without it (no resize-method param)', async () => {
  const s = await setup('vnc');
  try {
    const normal = await connectParams(s);
    const fixed = await connectParams(s, '&fixed=1');
    assert.deepEqual(fixed, normal);
    assert.equal(fixed['resize-method'], undefined);
    assert.equal(fixed.hostname, '10.9.8.7');
    assert.equal(fixed.port, '5909');
  } finally { await s.stop(); }
});
