import { test } from 'node:test';
import assert from 'node:assert/strict';
import { X509Certificate } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import WebSocket from 'ws';
import { InstructionStream, encode, publicDesktopSettings, validateDesktopSettings, connectionParameters } from '../server/desktop-bridge.js';
import { RDP_CLOSE, RDP_FIXED_PARAMS, checkCertPin, classifyGuacStatus, isFingerprint, normalizeFingerprint, probeRdpCertificate, rdpParameters, rdpPreflight } from '../server/rdp.js';
import { DESKTOP_CLOSE as CLIENT_CLOSE } from '../public/js/desktop-tunnel.js';
import { DESKTOP_CLOSE } from '../server/desktop-bridge.js';
import { startFakeGuacdSession } from './helpers/fake-guacd-session.js';
import { RDP_FIXTURES, startFakeRdpServer } from './helpers/fake-rdp-server.js';
import { httpClient, startTestApp } from './helpers/app-harness.js';

/** SAA-304: RDP layer (fixed params, TOFU cert pinning, password via required/argv). */

const RDP_PW = 'rdp-Secret-Pw-7731';
// What the Desktop view sends to answer guacd's `required` prompt (argv + blob + end).
const argvAnswer = (stream, name, value) => encode('argv', String(stream), 'text/plain', name) + encode('blob', String(stream), Buffer.from(value).toString('base64')) + encode('end', String(stream));
const fpOf = (n) => normalizeFingerprint(new X509Certificate(RDP_FIXTURES[n].cert).fingerprint256);
const RDP_ARGS = ['VERSION_1_5_0', 'hostname', 'port', 'domain', 'username', 'password', 'security', 'ignore-cert', 'cert-tofu', 'cert-fingerprints',
  'disable-audio', 'enable-audio-input', 'enable-drive', 'enable-printing', 'disable-download', 'disable-upload', 'disable-copy', 'disable-paste',
  'enable-font-smoothing', 'resize-method', 'client-name', 'timeout', 'recording-path', 'gateway-hostname', 'wol-send-packet', 'remote-app'];

test('rdp params: fixed safe set, sound on, microphone off, clipboard on, domain, pin vs ignore-cert; never a password', () => {
  const p = rdpParameters({ protocol: 'rdp', security: 'tls', domain: 'CORP' }, { certFingerprint: fpOf('a') });
  assert.equal(p['disable-audio'], 'false');
  assert.equal(p['enable-audio-input'], 'false');
  assert.equal(p['disable-copy'], 'false');
  assert.equal(p['disable-paste'], 'false');
  for (const k of ['enable-drive', 'enable-printing']) assert.equal(p[k], 'false');
  for (const k of ['disable-download', 'disable-upload']) assert.equal(p[k], 'true');
  assert.equal(p.domain, 'CORP');
  assert.equal(p.security, 'tls');
  assert.equal(p['cert-fingerprints'], fpOf('a'));
  assert.equal(p['ignore-cert'], undefined);
  for (const k of ['password', 'recording-path', 'gateway-hostname', 'wol-send-packet', 'remote-app', 'cert-tofu']) assert.equal(p[k], undefined, k);
  const ign = rdpParameters({ protocol: 'rdp', ignoreCert: true }, { certFingerprint: fpOf('a') });
  assert.equal(ign['ignore-cert'], 'true');
  assert.equal(ign['cert-fingerprints'], undefined);
  assert.ok(Object.isFrozen(RDP_FIXED_PARAMS));
  // A password in the credentials message is never put in `connect` for RDP; VNC unchanged.
  assert.equal(connectionParameters({ address: 'h' }, { protocol: 'rdp', port: 3389 }, { password: RDP_PW }).password, undefined);
  assert.equal(connectionParameters({ address: 'h' }, { protocol: 'vnc', port: 5900 }, { password: 'v' }).password, 'v');
});

test('rdp settings: username+domain saved, password refused, ignoreCert off by default, pin server-only and kept per port', () => {
  const s = validateDesktopSettings({ protocol: 'rdp', username: 'alice', domain: 'CORP' });
  assert.deepEqual(s, { protocol: 'rdp', port: 3389, username: 'alice', domain: 'CORP', security: 'any', ignoreCert: false });
  assert.throws(() => validateDesktopSettings({ protocol: 'rdp', password: RDP_PW }), /not stored/);
  assert.throws(() => validateDesktopSettings({ protocol: 'rdp', certPin: fpOf('b') }), /learned on first connect/);
  assert.throws(() => validateDesktopSettings({ protocol: 'rdp', domain: 'x\n' }), /domain/);
  const pinned = { ...s, certPin: fpOf('a'), certPinnedAt: '2026-10-13T00:00:00.000Z' };
  assert.equal(validateDesktopSettings({ protocol: 'rdp', username: 'bob' }, pinned).certPin, fpOf('a'), 'edit keeps pin');
  assert.equal(validateDesktopSettings({ protocol: 'rdp', port: 3390 }, pinned).certPin, undefined, 'new port re-learns');
  assert.equal(validateDesktopSettings({ protocol: 'vnc' }, pinned).certPin, undefined);
  assert.deepEqual(publicDesktopSettings(pinned), { protocol: 'rdp', port: 3389, username: 'alice', domain: 'CORP', security: 'any', ignoreCert: false, certPin: fpOf('a'), certPinnedAt: '2026-10-13T00:00:00.000Z' });
});

test('pin logic, fingerprints, status classification, close codes', () => {
  assert.equal(checkCertPin(null, fpOf('a')).action, 'pin');
  assert.equal(checkCertPin(fpOf('a'), fpOf('a')).action, 'match');
  assert.deepEqual(checkCertPin(fpOf('a'), fpOf('b')), { action: 'changed', pin: fpOf('a') });
  assert.throws(() => checkCertPin(null, 'md5:00'));
  assert.ok(isFingerprint(fpOf('a')) && !isFingerprint('sha256:zz'));
  assert.throws(() => normalizeFingerprint('AB:CD'));
  assert.equal(classifyGuacStatus(0x0301), 'auth');
  assert.equal(classifyGuacStatus('771'), 'auth');
  assert.equal(classifyGuacStatus(0x0207), 'target');
  assert.equal(classifyGuacStatus(0x0200), 'server');
  assert.equal(classifyGuacStatus(1), 'unknown');
  assert.equal(CLIENT_CLOSE.CERT_CHANGED, 4409);
  assert.equal(CLIENT_CLOSE.CERT_UNAVAILABLE, 4410);
  assert.equal(DESKTOP_CLOSE.CERT_CHANGED, 4409);
  assert.deepEqual(RDP_CLOSE, { CERT_CHANGED: 4409, CERT_UNAVAILABLE: 4410 });
});

test('certificate probe: reads the TLS cert, fails on no-TLS, non-RDP, unreachable, timeout; sends no credentials', async () => {
  const rdp = await startFakeRdpServer();
  try {
    assert.equal(await probeRdpCertificate({ host: '127.0.0.1', port: rdp.port }), fpOf('a'));
    rdp.cert = 'b';
    assert.equal(await probeRdpCertificate({ host: '127.0.0.1', port: rdp.port }), fpOf('b'));
    assert.equal(rdp.bytesAfterTls, 0, 'nothing sent after the TLS handshake');
    rdp.mode = 'no-tls';
    await assert.rejects(probeRdpCertificate({ host: '127.0.0.1', port: rdp.port }), { code: 'no-tls' });
    rdp.mode = 'not-rdp';
    await assert.rejects(probeRdpCertificate({ host: '127.0.0.1', port: rdp.port }), { code: 'protocol' });
  } finally { await rdp.stop(); }
  await assert.rejects(probeRdpCertificate({ host: '127.0.0.1', port: rdp.port }), { code: 'unreachable' });
  const net = await import('node:net');
  const silent = net.createServer(() => {});
  await new Promise((r) => silent.listen(0, '127.0.0.1', r));
  try { await assert.rejects(probeRdpCertificate({ host: '127.0.0.1', port: silent.address().port, timeoutMs: 200 }), { code: 'timeout' }); }
  finally { silent.close(); }
});

test('preflight: pins first use, matches later, fails closed on change, skips only with ignoreCert, legacy rdp without TLS', async () => {
  const host = { id: 'h', address: '127.0.0.1' };
  const saved = [];
  const probe = async () => fpOf('a');
  const p1 = await rdpPreflight({ host, settings: { protocol: 'rdp', port: 1 }, probe, savePin: async (p) => saved.push(p) });
  assert.deepEqual(saved, [fpOf('a')]);
  assert.equal(p1['cert-fingerprints'], fpOf('a'));
  await rdpPreflight({ host, settings: { protocol: 'rdp', port: 1, certPin: fpOf('a') }, probe, savePin: async () => assert.fail('no re-pin') });
  await assert.rejects(rdpPreflight({ host, settings: { protocol: 'rdp', port: 1, certPin: fpOf('b') }, probe, savePin: async () => assert.fail() }), { code: RDP_CLOSE.CERT_CHANGED });
  let probed = false;
  const ign = await rdpPreflight({ host, settings: { protocol: 'rdp', port: 1, ignoreCert: true }, probe: async () => { probed = true; }, savePin: async () => {} });
  assert.equal(probed, false);
  assert.equal(ign['ignore-cert'], 'true');
  const noTls = async () => { throw Object.assign(new Error('no tls'), { code: 'no-tls' }); };
  await assert.rejects(rdpPreflight({ host, settings: { protocol: 'rdp', port: 1, security: 'any' }, probe: noTls, savePin: async () => {} }), { code: RDP_CLOSE.CERT_UNAVAILABLE });
  assert.equal((await rdpPreflight({ host, settings: { protocol: 'rdp', port: 1, security: 'rdp' }, probe: noTls, savePin: async () => {} }))['cert-fingerprints'], undefined);
});

async function setup() {
  const guacd = await startFakeGuacdSession({ mode: 'prompt', argNames: RDP_ARGS });
  const rdp = await startFakeRdpServer();
  const logs = [];
  const t = await startTestApp({ guacd: { enabled: true, host: '127.0.0.1', port: guacd.port, protocol: 'rdp', timeoutMs: 500, cacheMs: 0 } }, { log: (m) => logs.push(m) });
  const client = httpClient(t.base, t.origin);
  const code = (await readFile(`${t.dataDir}/SETUP-CODE.txt`, 'utf8')).trim();
  assert.equal((await client.request('/api/auth/setup', { method: 'POST', body: { setupCode: code, password: 'owner-password-1' } })).status, 200);
  const host = (await client.request('/api/hosts', { method: 'POST', body: { name: 'win', address: '127.0.0.1', port: 22, username: 'me' } })).body.host;
  const put = await client.request(`/api/hosts/${host.id}/desktop`, { method: 'PUT', body: { protocol: 'rdp', port: rdp.port, username: 'alice', domain: 'CORP', security: 'tls' } });
  assert.equal(put.status, 200);
  const responses = [put];
  return { guacd, rdp, t, client, host, logs, responses, stop: async () => { await t.stop(); await guacd.stop(); await rdp.stop(); } };
}

function open(s, { credentialsPassword } = {}) {
  const ws = new WebSocket(`${s.t.base.replace('http', 'ws')}/ws/desktop?hostId=${s.host.id}&width=1280&height=720`, { headers: { Origin: s.t.origin, Cookie: s.client.cookie } });
  const out = { ws, instructions: [], text: '' };
  const parser = new InstructionStream();
  ws.on('open', () => ws.send(credentialsPassword ? encode('credentials', 'password', credentialsPassword) : encode('credentials')));
  ws.on('message', (d) => { out.text += d.toString(); for (const i of parser.push(d.toString())) out.instructions.push(i.elements); });
  ws.on('error', () => {});
  out.closed = new Promise((r) => ws.on('close', (code, reason) => r({ code, reason: reason.toString() })));
  out.until = async (pred, ms = 4000) => { const end = Date.now() + ms; while (!pred()) { if (Date.now() > end) throw new Error(`timeout; got ${out.text.slice(0, 200)}`); await new Promise((r) => setTimeout(r, 10)); } };
  return out;
}
const connectOf = (log) => log.find((i) => i[0] === 'connect');
const valueOf = (log, name) => connectOf(log)[RDP_ARGS.indexOf(name) + 1];

test('rdp end to end: first use pins, password only via required/argv once, frames flow, nothing stored or logged', async () => {
  const s = await setup();
  try {
    const c = open(s, { credentialsPassword: RDP_PW }); // a password here must be ignored for RDP
    await c.until(() => c.instructions.some((i) => i[0] === 'required' && i[1] === 'password'));
    const log = s.guacd.received.at(-1);
    assert.equal(valueOf(log, 'password'), '', 'connect carries no password');
    assert.equal(valueOf(log, 'cert-fingerprints'), fpOf('a'));
    assert.equal(valueOf(log, 'ignore-cert'), '');
    assert.equal(valueOf(log, 'cert-tofu'), '');
    assert.equal(valueOf(log, 'domain'), 'CORP');
    assert.equal(valueOf(log, 'username'), 'alice');
    assert.equal(valueOf(log, 'disable-audio'), 'false', 'remote sound on');
    assert.equal(valueOf(log, 'enable-audio-input'), 'false', 'microphone never');
    assert.deepEqual(log.find((i) => i[0] === 'audio'), ['audio', 'audio/L8', 'audio/L16'], 'handshake offers the formats the browser plays');
    assert.equal(valueOf(log, 'disable-copy'), 'false');
    assert.equal(valueOf(log, 'hostname'), '127.0.0.1');
    assert.deepEqual(log.find((i) => i[0] === 'size'), ['size', '1280', '720', '96']);
    c.ws.send(argvAnswer(1, 'password', RDP_PW));
    c.ws.send(argvAnswer(2, 'password', 'second-try')); // second answer is dropped
    await c.until(() => c.instructions.some((i) => i[0] === 'img'));
    const argvs = log.filter((i) => i[0] === 'argv');
    assert.equal(argvs.length, 1, 'argv forwarded once');
    assert.equal(Buffer.from(log.find((i) => i[0] === 'blob' && i[1] === '1')[1 + 1], 'base64').toString(), RDP_PW);
    assert.ok(!log.some((i) => i[0] === 'blob' && i[1] === '2'));
    c.ws.close();
    await c.closed;
    const view = await s.client.request(`/api/hosts`);
    s.responses.push(view);
    const desk = view.body.hosts[0].desktop;
    assert.equal(desk.certPin, fpOf('a'));
    assert.ok(desk.certPinnedAt);
    assert.equal(desk.domain, 'CORP');
    const fs = await import('node:fs');
    const dataText = fs.readdirSync(s.t.dataDir).filter((f) => f.endsWith('.json')).map((f) => fs.readFileSync(`${s.t.dataDir}/${f}`, 'utf8')).join('\n');
    assert.ok(dataText.includes(fpOf('a')), 'pin persisted in the data file');
    // Reconnect asks again (fresh required prompt; nothing remembered).
    const again = open(s);
    await again.until(() => again.instructions.some((i) => i[0] === 'required'));
    assert.equal(valueOf(s.guacd.received.at(-1), 'password'), '');
    again.ws.close();
    await again.closed;
    const files = (await import('node:fs')).readdirSync(s.t.dataDir);
    for (const f of files) {
      const text = await readFile(`${s.t.dataDir}/${f}`, 'utf8').catch(() => '');
      assert.ok(!text.includes(RDP_PW), `password absent from ${f}`);
    }
    assert.ok(!s.logs.join('\n').includes(RDP_PW), 'password absent from logs');
    for (const r of s.responses) assert.ok(!JSON.stringify(r.body).includes(RDP_PW), 'password absent from responses');
    assert.ok(s.logs.some((l) => l.includes('pinned on first use')));
  } finally { await s.stop(); }
});

test('rdp: changed certificate fails closed with 4409 before guacd gets connect; owner reset re-pins; address change clears', async () => {
  const s = await setup();
  try {
    const first = open(s);
    await first.until(() => first.instructions.some((i) => i[0] === 'required'));
    first.ws.close();
    await first.closed;
    s.rdp.cert = 'b';
    const before = s.guacd.received.length;
    const bad = open(s);
    assert.equal((await bad.closed).code, 4409);
    const newLogs = s.guacd.received.slice(before);
    assert.ok(newLogs.every((log) => !connectOf(log)), 'guacd never received connect');
    assert.equal((await s.client.request('/api/hosts')).body.hosts[0].desktop.certPin, fpOf('a'), 'pin unchanged');
    assert.ok(s.logs.some((l) => l.includes('CHANGED')));
    // An edit cannot overwrite the pin.
    assert.equal((await s.client.request(`/api/hosts/${s.host.id}/desktop`, { method: 'PUT', body: { protocol: 'rdp', port: s.rdp.port, certPin: fpOf('b') } })).status, 400);
    // Owner-only reset (unauthenticated is refused).
    const anon = httpClient(s.t.base, s.t.origin);
    assert.equal((await anon.request(`/api/hosts/${s.host.id}/desktop/cert-pin`, { method: 'DELETE' })).status, 401);
    const reset = await s.client.request(`/api/hosts/${s.host.id}/desktop/cert-pin`, { method: 'DELETE' });
    assert.equal(reset.status, 200);
    assert.equal(reset.body.host.desktop.certPin, null);
    const after = open(s);
    await after.until(() => after.instructions.some((i) => i[0] === 'required'));
    assert.equal(valueOf(s.guacd.received.at(-1), 'cert-fingerprints'), fpOf('b'));
    after.ws.close();
    await after.closed;
    assert.equal((await s.client.request('/api/hosts')).body.hosts[0].desktop.certPin, fpOf('b'));
    await s.client.request(`/api/hosts/${s.host.id}`, { method: 'PUT', body: { name: 'win', address: '127.0.0.2', port: 22, username: 'me' } });
    assert.equal((await s.client.request('/api/hosts')).body.hosts[0].desktop.certPin, null, 'new address re-learns');
  } finally { await s.stop(); }
});

test('rdp: auth error from guacd -> error forwarded then 1011; no TLS -> 4410; ignoreCert skips probe and is off by default', async () => {
  const s = await setup();
  try {
    s.guacd.mode = 'reject-auth';
    const bad = open(s);
    assert.equal((await bad.closed).code, 1011);
    const err = bad.instructions.find((i) => i[0] === 'error');
    assert.equal(classifyGuacStatus(err[2]), 'auth');
    s.guacd.mode = 'prompt';
    s.rdp.mode = 'no-tls';
    const noTls = open(s);
    assert.equal((await noTls.closed).code, 4410);
    const probesBefore = s.rdp.probes;
    await s.client.request(`/api/hosts/${s.host.id}/desktop`, { method: 'PUT', body: { protocol: 'rdp', port: s.rdp.port, ignoreCert: true } });
    const ign = open(s);
    await ign.until(() => ign.instructions.some((i) => i[0] === 'required'));
    assert.equal(s.rdp.probes, probesBefore, 'no probe with ignoreCert');
    assert.equal(valueOf(s.guacd.received.at(-1), 'ignore-cert'), 'true');
    ign.ws.close();
    await ign.closed;
    const off = await s.client.request(`/api/hosts/${s.host.id}/desktop`, { method: 'PUT', body: { protocol: 'rdp', port: s.rdp.port, ignoreCert: false } });
    assert.equal(off.body.host.desktop.ignoreCert, false);
  } finally { await s.stop(); }
});
