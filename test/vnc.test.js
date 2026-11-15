import { test } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../server/store.js';
import { explainVncFailure, probeVnc } from '../server/vnc.js';
import { capabilitiesWithDesktop, createProtocolSupport, selectDesktopProtocol } from '../server/desktop-protocols.js';
import { encode, InstructionStream } from '../server/desktop-bridge.js';
import { startFakeVncServer } from './helpers/fake-vnc-server.js';
import { startFakeGuacdSession } from './helpers/fake-guacd-session.js';
import { startFakeSshServer } from './helpers/fake-ssh-server.js';
import { httpClient, openTerminal, startTestApp, unusedPort } from './helpers/app-harness.js';
import { makeDocument } from './helpers/fake-dom.js';
import { stubTunnelFactory } from './helpers/desktop-stub-tunnel.js';

/** SAA-305: VNC backend through guacd. */

const VNC_PW = 'vnc-Secret-305';

// ── RFB pre-check ──
test('probeVnc reads RFB version and security types, never authenticates', async () => {
  const cases = [
    [{ mode: 'types', types: [2] }, { status: 'ok', needsPassword: true, supported: true }],
    [{ mode: 'types', types: [1] }, { status: 'ok', needsPassword: false, supported: true }],
    [{ mode: 'types', types: [30] }, { status: 'ok', needsPassword: true, supported: true }],
    [{ mode: 'types', types: [16, 113] }, { status: 'ok', supported: false }],
    [{ mode: 'refuse' }, { status: 'refused', reason: 'Too many security failures' }],
    [{ mode: 'v33', types: [2] }, { status: 'ok', needsPassword: true, rfbVersion: '3.3' }],
    [{ mode: 'not-vnc' }, { status: 'not-vnc' }],
  ];
  for (const [opts, expected] of cases) {
    const fake = await startFakeVncServer(opts);
    try {
      const r = await probeVnc({ host: '127.0.0.1', port: fake.port, timeoutMs: 1000 });
      for (const [k, v] of Object.entries(expected)) assert.deepEqual(r[k], v, `${JSON.stringify(opts)} ${k}`);
      // the client only ever sent its version line, never a security choice or password
      assert.ok(fake.received.every((d) => /^RFB 003\.00[378]\n$/.test(d)) || opts.mode === 'not-vnc', JSON.stringify(fake.received));
    } finally { await fake.stop(); }
  }
  const silent = await startFakeVncServer({ mode: 'silent' });
  try {
    const quiet = await probeVnc({ host: '127.0.0.1', port: silent.port, timeoutMs: 200 });
    assert.equal(quiet.status, 'not-vnc', 'connected but no RFB greeting');
    assert.equal(quiet.silent, true);
    // never connected at all (unroutable address) -> timeout, or unreachable where the network says so at once
    assert.ok(['timeout', 'unreachable'].includes((await probeVnc({ host: '10.255.255.1', port: 59999, timeoutMs: 200 })).status));
  } finally { await silent.stop(); }
  const r = await probeVnc({ host: '127.0.0.1', port: await unusedPort(), timeoutMs: 1000 });
  assert.equal(r.status, 'unreachable');
  // Some hosts (WSL) report an empty port as ECONNRESET instead of ECONNREFUSED.
  assert.ok(['ECONNREFUSED', 'ECONNRESET'].includes(r.code), r.code);
});

test('explainVncFailure gives one plain reason per VNC failure kind', () => {
  const at = { address: 'mac.lan', port: 5900 };
  const reason = (check, extra = {}) => explainVncFailure(check, { ...at, ...extra })?.reason ?? null;
  assert.equal(reason({ status: 'unreachable', code: 'ECONNREFUSED' }), 'vnc-unreachable');
  assert.match(explainVncFailure({ status: 'unreachable', code: 'ECONNREFUSED' }, at).message, /mac\.lan:5900/);
  assert.equal(reason({ status: 'timeout' }), 'vnc-unreachable');
  assert.equal(reason({ status: 'not-vnc' }), 'vnc-not-vnc');
  assert.equal(reason({ status: 'closed' }), 'vnc-refused');
  assert.match(explainVncFailure({ status: 'refused', reason: 'Too many security failures' }, at).message, /turned down the connection/);
  const offered = { status: 'ok', securityTypes: [{ id: 16, name: 'Tight' }], supported: false };
  assert.equal(reason(offered), 'vnc-unsupported-security');
  const pw = { status: 'ok', securityTypes: [{ id: 2, name: 'VNC password' }], supported: true, needsPassword: true };
  assert.match(explainVncFailure(pw, { ...at, passwordGiven: true }).message, /password didn’t work/);
  assert.match(explainVncFailure(pw, { ...at, passwordGiven: false }).message, /needs a password/);
  assert.equal(reason({ status: 'ok', securityTypes: [{ id: 1, name: 'None' }], supported: true, needsPassword: false }), null);
});

// ── capability-driven selection ──
test('selectDesktopProtocol: host capability AND guacd plugin, preferred first', () => {
  const host = (desktop) => ({ capabilities: { desktop } });
  assert.deepEqual(selectDesktopProtocol(host({ vnc: true }), { vnc: true, rdp: true }), { protocol: 'vnc' });
  assert.deepEqual(selectDesktopProtocol(host({ vnc: true, rdp: true }), { vnc: true, rdp: true }, 'vnc'), { protocol: 'vnc' });
  assert.deepEqual(selectDesktopProtocol(host({ vnc: true, rdp: true }), { vnc: true, rdp: false }), { protocol: 'vnc' }, 'skips a protocol guacd lacks');
  assert.equal(selectDesktopProtocol(host({ vnc: false }), { vnc: true }, 'vnc').missing, 'capability');
  assert.equal(selectDesktopProtocol(host({ vnc: true }), { vnc: false }, 'vnc').missing, 'plugin');
  assert.equal(selectDesktopProtocol(host({}), { vnc: true }).protocol, null);
  // effective (agent-negotiated) capabilities win over stored ones
  assert.equal(selectDesktopProtocol({ capabilities: { desktop: { vnc: false } }, effectiveCapabilities: { desktop: { vnc: true } } }, {}).protocol, 'vnc');
  // OS names never matter
  assert.equal(selectDesktopProtocol({ os: 'macos', capabilities: { desktop: {} } }, { vnc: true }).protocol, null);
  assert.deepEqual(capabilitiesWithDesktop({ desktop: { rdp: true } }, 'vnc', 'rdp').desktop, { rdp: false, vnc: true });
  assert.deepEqual(capabilitiesWithDesktop({ desktop: { vnc: true } }, null, 'vnc').desktop, { vnc: false });
});

test('createProtocolSupport probes guacd per protocol with a cache', async () => {
  const calls = [];
  let t = 0;
  const support = createProtocolSupport({ enabled: true, host: 'x', port: 1 }, {
    probe: async ({ protocol }) => { calls.push(protocol); return { status: protocol === 'vnc' ? 'up' : 'protocol-unavailable' }; }, now: () => t, cacheMs: 1000,
  });
  assert.equal(support.known('vnc'), undefined);
  assert.deepEqual(await support.check(), { rdp: false, vnc: true });
  await support.check();
  assert.deepEqual(calls.sort(), ['rdp', 'vnc'], 'cached');
  t = 2000;
  await support.check();
  assert.equal(calls.length, 4);
  assert.equal(support.known('vnc'), true);
  assert.deepEqual(await createProtocolSupport({ enabled: false }).check(), { rdp: false, vnc: false });
});

test('SAA-347: guacd being down is not remembered as "plugin missing" (a restarted guacd is usable at once)', async () => {
  let status = 'down';
  const calls = [];
  const support = createProtocolSupport({ enabled: true, host: 'x', port: 1 }, {
    probe: async ({ protocol }) => { calls.push(protocol); return { status: protocol === 'rdp' ? 'protocol-unavailable' : status }; }, now: () => 0, cacheMs: 30_000,
  });
  assert.deepEqual(await support.check(), { rdp: false, vnc: false });
  assert.equal(support.known('vnc'), undefined, 'down says nothing about the VNC plugin');
  assert.equal(support.known('rdp'), false, 'a real refusal is still remembered');
  status = 'up';
  assert.deepEqual(await support.check(), { rdp: false, vnc: true }, 'probed again, not served from cache');
  assert.equal(support.known('vnc'), true);
  assert.deepEqual(calls.sort(), ['rdp', 'vnc', 'vnc']);
});

// ── server integration ──
async function setup(extra = {}) {
  const guacd = await startFakeGuacdSession();
  const logs = [];
  const t = await startTestApp({ guacd: { enabled: true, host: '127.0.0.1', port: guacd.port, protocol: 'vnc', timeoutMs: 500, cacheMs: 0 }, ...extra }, { log: (m) => logs.push(m) });
  const client = httpClient(t.base, t.origin);
  await client.request('/api/auth/setup', { method: 'POST', body: { setupCode: t.app.setupCode, password: 'owner-password-1' } });
  const addHost = async (name, port = 22) => (await client.request('/api/hosts', { method: 'POST', body: { name, address: '127.0.0.1', port, username: 'tester' } })).body.host;
  return { guacd, t, client, logs, addHost, stop: async () => { await t.stop(); await guacd.stop(); } };
}
function desktopWs(s, hostId, password = VNC_PW) {
  const ws = new WebSocket(`${s.t.base.replace('http', 'ws')}/ws/desktop?hostId=${hostId}`, { headers: { Origin: s.t.origin, Cookie: s.client.cookie } });
  const out = { ws, ops: [] };
  const parser = new InstructionStream();
  ws.on('open', () => ws.send(password ? encode('credentials', 'password', password) : encode('credentials')));
  ws.on('message', (d) => { for (const i of parser.push(d.toString())) out.ops.push(i.elements[0]); });
  ws.on('error', () => {});
  out.closed = new Promise((r) => ws.on('close', (code, reason) => r({ code, reason: reason.toString() })));
  out.ready = async () => { const end = Date.now() + 4000; while (!out.ops.includes('ready')) { if (Date.now() > end) throw new Error('no ready'); await new Promise((r) => setTimeout(r, 10)); } };
  return out;
}

test('PUT desktop records the protocol capability, picks from capabilities when omitted, DELETE clears it', async () => {
  const s = await setup();
  try {
    const host = await s.addHost('mac');
    assert.equal((await s.client.request(`/api/hosts/${host.id}/desktop`, { method: 'PUT', body: {} })).status, 400, 'no capability, no protocol');
    let r = await s.client.request(`/api/hosts/${host.id}/desktop`, { method: 'PUT', body: { protocol: 'vnc', port: 5901 } });
    assert.equal(r.status, 200);
    assert.equal(r.body.host.capabilities.desktop.vnc, true);
    r = await s.client.request(`/api/hosts/${host.id}/desktop`, { method: 'PUT', body: { port: 5902 } });
    assert.equal(r.body.host.desktop.protocol, 'vnc', 'capability-driven pick');
    assert.equal(r.body.host.desktop.port, 5902);
    r = await s.client.request(`/api/hosts/${host.id}/desktop`, { method: 'DELETE' });
    assert.equal(r.body.host.capabilities.desktop.vnc, false);
    const status = await s.client.request('/api/desktop/status');
    assert.deepEqual(status.body.protocols, { rdp: true, vnc: true });
  } finally { await s.stop(); }
});

test('bridge refuses a protocol the host does not offer (4404) or guacd cannot serve (4503)', async () => {
  const s = await setup({ protocolSupport: { check: async () => ({ vnc: false, rdp: true }), known: (p) => (p === 'vnc' ? false : true) } });
  try {
    const host = await s.addHost('box');
    // explicit protocol guacd is known to lack -> 400
    assert.equal((await s.client.request(`/api/hosts/${host.id}/desktop`, { method: 'PUT', body: { protocol: 'vnc' } })).status, 400);
    // saved anyway (older data), capability on, plugin missing -> 4503
    await s.t.app.store.setDesktop(host.id, { protocol: 'vnc', port: 5901 });
    await s.t.app.store.updateHost(host.id, { capabilities: capabilitiesWithDesktop(s.t.app.store.getHost(host.id).capabilities, 'vnc') });
    assert.equal((await desktopWs(s, host.id).closed).code, 4503);
    // capability off -> 4404, and guacd is never contacted
    await s.t.app.store.updateHost(host.id, { capabilities: capabilitiesWithDesktop(s.t.app.store.getHost(host.id).capabilities, null, 'vnc') });
    const before = s.guacd.connections;
    const c = await desktopWs(s, host.id).closed;
    assert.equal(c.code, 4404);
    assert.match(c.reason, /doesn’t offer a VNC desktop/);
    assert.equal(s.guacd.connections, before);
  } finally { await s.stop(); }
});

test('vnc-check explains failures without a password ever leaving the server', async () => {
  const s = await setup({ vncCheckIntervalMs: 0 });
  const vnc = await startFakeVncServer({ types: [2] });
  try {
    const host = await s.addHost('vnc', 22);
    await s.client.request(`/api/hosts/${host.id}/desktop`, { method: 'PUT', body: { protocol: 'vnc', port: vnc.port } });
    let r = await s.client.request(`/api/hosts/${host.id}/desktop/vnc-check?password=1`);
    assert.equal(r.body.explanation.reason, 'vnc-auth');
    assert.match(r.body.explanation.message, /password didn’t work/);
    await s.client.request(`/api/hosts/${host.id}/desktop`, { method: 'PUT', body: { protocol: 'vnc', port: await unusedPort() } });
    r = await s.client.request(`/api/hosts/${host.id}/desktop/vnc-check`);
    assert.equal(r.body.explanation.reason, 'vnc-unreachable');
    const rdpHost = await s.addHost('win');
    await s.client.request(`/api/hosts/${rdpHost.id}/desktop`, { method: 'PUT', body: { protocol: 'rdp' } });
    assert.equal((await s.client.request(`/api/hosts/${rdpHost.id}/desktop/vnc-check`)).status, 404);
    // a real VNC session with a password: it reaches guacd, and no log line contains it
    await s.client.request(`/api/hosts/${host.id}/desktop`, { method: 'PUT', body: { protocol: 'vnc', port: vnc.port } });
    const d = desktopWs(s, host.id);
    await d.ready();
    d.ws.close();
    await d.closed;
    assert.ok(s.guacd.received.some((log) => log.some((el) => el[0] === 'connect' && el.includes(VNC_PW))));
    assert.ok(!s.logs.join('\n').includes(VNC_PW), 'password never logged');
    assert.ok(!JSON.stringify(r.body).includes(VNC_PW));
  } finally { await vnc.stop(); await s.stop(); }
});

test('VNC, RDP and terminal sessions run concurrently and independently (RDP w/o real server -> 4410)', async () => {
  const s = await setup();
  const ssh = await startFakeSshServer({ password: 'ssh-pw' });
  try {
    const vncHost = await s.addHost('mac');
    const rdpHost = await s.addHost('win');
    const sshHost = await s.addHost('nas', ssh.port);
    await s.client.request(`/api/hosts/${vncHost.id}/desktop`, { method: 'PUT', body: { protocol: 'vnc', port: 5901 } });
    // No real RDP server here: #20's certificate check must refuse it with 4410 (not loosened).
    await s.client.request(`/api/hosts/${rdpHost.id}/desktop`, { method: 'PUT', body: { protocol: 'rdp', port: await unusedPort() } });
    const term = openTerminal(s.t.base, { headers: { Cookie: s.client.cookie, Origin: s.t.origin } });
    await term.opened;
    term.send({ t: 'connect', hostId: sshHost.id, password: 'ssh-pw', cols: 80, rows: 24 });
    await term.untilControl((m) => m.t === 'hostkey' || (m.t === 'status' && m.s === 'ready'), 'hostkey or ready');
    if (term.control.some((m) => m.t === 'hostkey')) term.send({ t: 'hostkey', accept: true });
    await term.untilControl((m) => m.t === 'status' && m.s === 'ready', 'terminal ready');
    const v = desktopWs(s, vncHost.id);
    const r = desktopWs(s, rdpHost.id, '');
    await v.ready();
    const rdpClose = await r.closed;
    assert.equal(rdpClose.code, 4410, `RDP without a checkable certificate -> 4410 (${rdpClose.reason})`);
    const selects = s.guacd.received.map((log) => log.find((el) => el[0] === 'select')?.[1]).filter(Boolean);
    // The RDP certificate check and the guacd socket run in parallel, so whether guacd saw
    // `select rdp` before the 4410 is timing. What must hold: VNC reached guacd, and the
    // refused RDP session never got as far as `connect`.
    assert.ok(selects.includes('vnc'), JSON.stringify(selects));
    const rdpLogs = s.guacd.received.filter((log) => log.some((el) => el[0] === 'select' && el[1] === 'rdp'));
    assert.ok(rdpLogs.every((log) => !log.some((el) => el[0] === 'connect')), 'refused RDP never sent connect');
    assert.equal(v.ws.readyState, WebSocket.OPEN, 'VNC unaffected by the refused RDP session');
    term.send({ t: 'in', d: 'while-desktops\r' });
    await term.untilOutput('you typed: while-desktops');
    v.ws.close(1000);
    assert.equal((await v.closed).code, 1000);
    term.send({ t: 'in', d: 'after-vnc\r' });
    await term.untilOutput('you typed: after-vnc');
    term.ws.close();
    await term.closed();
  } finally { await ssh.close(); await s.stop(); }
});

// ── browser view ──
globalThis.document ??= makeDocument();
const { DesktopSession } = await import('../public/js/desktop-session.js');
const { hostActions } = await import('../public/js/host-actions.js');

function view(protocol, explain) {
  const factory = stubTunnelFactory();
  const s = new DesktopSession({ host: { id: 'h', name: 'Mac', address: 'mac.lan', username: 'me', port: 22, desktop: { protocol, port: 5900 } }, createTunnel: factory });
  s.vncExplain = explain;
  s.mount(document.createElement('div'));
  return { s, factory };
}

test('view: a failed VNC session is explained by the pre-check (password flag only, no value)', async () => {
  const asked = [];
  const { s, factory } = view('vnc', async (_host, opts) => { asked.push(opts); return { reason: 'vnc-auth', message: 'That desktop password didn’t work. Enter it again and connect.' }; });
  s.connectPassword.value = 'pw';
  s.connect();
  factory.last().receive('ready', '$id'); // guacd says ready before its VNC client connects
  factory.last().receive('error', 'Aborted. See logs.', '519');
  factory.last().end(1011, 'Desktop connection failed (status 519).');
  assert.equal(s.reason, 'remote-error');
  await new Promise((r) => setImmediate(r));
  assert.equal(s.state, 'failed');
  assert.equal(s.reason, 'vnc-auth');
  assert.equal(s.message, 'That desktop password didn’t work. Enter it again and connect.');
  assert.deepEqual(asked, [{ passwordGiven: true }]);
  // via the required/argv prompt, also counts as a given password
  s.connect();
  factory.last().receive('required', 'password');
  s.argvInputs.get('password').value = 'pw2';
  s.submitCredentials();
  factory.last().end(4503, 'gone');
  await new Promise((r) => setImmediate(r));
  assert.equal(s.reason, 'backend-down', 'only failures (not unavailable) are explained');
  s.connect();
  factory.last().end(1006, '', true);
  await new Promise((r) => setImmediate(r));
  assert.equal(s.reason, 'vnc-auth');
  assert.deepEqual(asked.at(-1), { passwordGiven: false });
  // guacd ending a never-drawn VNC session with a plain 1000 is explained too
  s.connect();
  factory.last().receive('ready', '$id');
  factory.last().end(1000, 'ended');
  await new Promise((r) => setImmediate(r));
  assert.equal(s.state, 'failed');
  assert.equal(s.reason, 'vnc-auth');
  asked.pop();
  // a session that already drew frames is not second-guessed
  s.connect();
  factory.last().receive('ready', '$id');
  factory.last().receive('size', '0', '800', '600');
  factory.last().receive('error', 'Aborted. See logs.', '519');
  factory.last().end(1011);
  await new Promise((r) => setImmediate(r));
  assert.equal(s.reason, 'remote-error');
  assert.equal(asked.length, 2);
});

test('view: RDP failures and stale explanations are left alone', async () => {
  let calls = 0;
  const rdp = view('rdp', async () => { calls += 1; return { reason: 'vnc-auth', message: 'x' }; });
  rdp.s.connect();
  rdp.factory.last().receive('error', 'Login failed', '769');
  rdp.factory.last().end(1011);
  await new Promise((r) => setImmediate(r));
  assert.equal(rdp.s.reason, 'remote-error');
  assert.equal(calls, 0);
  let release;
  const slow = view('vnc', () => new Promise((r) => { release = () => r({ reason: 'vnc-unreachable', message: 'late' }); }));
  slow.s.connect();
  slow.factory.last().end(1006, '', true);
  slow.s.connect(); // user retried before the explanation came back
  release();
  await new Promise((r) => setImmediate(r));
  assert.equal(slow.s.state, 'connecting');
});

test('hostActions: Desktop needs the protocol capability and the guacd plugin', () => {
  const base = { desktop: { protocol: 'vnc', port: 5900 }, desktopServerEnabled: true };
  assert.match(hostActions({ ...base, capabilities: { desktop: { vnc: false } } })[2].reason, /doesn’t offer a VNC desktop/);
  assert.equal(hostActions({ ...base, capabilities: { desktop: { vnc: false } } })[2].enabled, false);
  assert.equal(hostActions({ ...base, capabilities: { desktop: { vnc: true } } })[2].enabled, true);
  assert.equal(hostActions({ ...base, capabilities: { desktop: { vnc: true } }, desktopProtocols: { vnc: false, rdp: true } })[2].enabled, false);
  assert.match(hostActions({ ...base, capabilities: { desktop: { vnc: true } }, desktopProtocols: { vnc: false } })[2].reason, /can’t open VNC desktops/);
  assert.equal(hostActions({ ...base, capabilities: { desktop: { vnc: false } }, effectiveCapabilities: { desktop: { vnc: true } } })[2].enabled, true);
});

test('store load: a host saved with desktop settings before SAA-305 gains that protocol capability', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rh-vnc-'));
  try {
    await fs.writeFile(path.join(dir, 'remotehub.json'), JSON.stringify({ version: 2, hosts: [
      { id: 'a', name: 'mac', address: '10.0.0.2', port: 22, username: 'me', desktop: { protocol: 'vnc', port: 5900 } },
      { id: 'b', name: 'nas', address: '10.0.0.3', port: 22, username: 'me' },
    ] }));
    const store = await new Store(dir).load();
    assert.equal(store.getHost('a').capabilities.desktop.vnc, true);
    assert.equal(store.getHost('a').capabilities.desktop.rdp, false);
    assert.equal(store.getHost('b').capabilities.desktop.vnc, false);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('vnc-check: owner-only, saved address/port only, 3 s timeout, per-host rate limit', async () => {
  const s = await setup();
  const silent = await startFakeVncServer({ mode: 'silent' });
  const decoy = await startFakeVncServer({ types: [1] });
  try {
    const host = await s.addHost('quiet');
    const other = await s.addHost('other');
    await s.client.request(`/api/hosts/${host.id}/desktop`, { method: 'PUT', body: { protocol: 'vnc', port: silent.port } });
    await s.client.request(`/api/hosts/${other.id}/desktop`, { method: 'PUT', body: { protocol: 'vnc', port: silent.port } });
    // no session / bogus session -> 401, and nothing is dialed
    for (const cookie of ['', 'rh_session=forged']) {
      const r = await fetch(`${s.t.base}/api/hosts/${host.id}/desktop/vnc-check`, { headers: { Origin: s.t.origin, ...(cookie ? { Cookie: cookie } : {}) } });
      assert.equal(r.status, 401, `cookie=${cookie || 'none'}`);
    }
    assert.equal(silent.received.length + silent.sockets.size, 0);
    // a supplied address/port is ignored: the decoy is never contacted, the silent saved one is
    const started = performance.now();
    const r = await s.client.request(`/api/hosts/${host.id}/desktop/vnc-check?host=127.0.0.1&address=127.0.0.1&port=${decoy.port}`);
    const took = Math.round(performance.now() - started);
    assert.equal(r.status, 200);
    assert.equal(r.body.check.status, 'not-vnc', 'silent server: connected, no greeting');
    assert.ok(took >= 2900 && took < 4500, `bounded by the 3 s timeout (${took} ms)`);
    assert.equal(decoy.received.length, 0, 'decoy never dialed');
    // second check on the same host within 5 s -> 429; another host is independent
    const again = await s.client.request(`/api/hosts/${host.id}/desktop/vnc-check`);
    assert.equal(again.status, 429);
    const otherCheck = s.client.request(`/api/hosts/${other.id}/desktop/vnc-check`);
    assert.notEqual((await otherCheck).status, 429);
  } finally { await silent.stop(); await decoy.stop(); await s.stop(); }
});

test('merge with #20: capability-driven desktop PUT keeps RDP cert-pin rules; address change and owner reset clear it', async () => {
  const s = await setup();
  const pin = 'sha256:' + Array(32).fill('ab').join(':');
  const pinOf = () => s.t.app.store.getHost(win.id).desktop?.certPin ?? null;
  const win = await s.addHost('win');
  try {
    await s.client.request(`/api/hosts/${win.id}/desktop`, { method: 'PUT', body: { protocol: 'rdp', port: 3389 } });
    await s.t.app.store.setDesktopCertPin(win.id, pin);
    // PUT without a protocol (capability pick) on the same port keeps the pin and records the capability
    let r = await s.client.request(`/api/hosts/${win.id}/desktop`, { method: 'PUT', body: { port: 3389 } });
    assert.equal(r.status, 200);
    assert.equal(r.body.host.desktop.protocol, 'rdp');
    assert.equal(r.body.host.capabilities.desktop.rdp, true);
    assert.equal(pinOf(), pin);
    // the browser may never set a pin
    assert.equal((await s.client.request(`/api/hosts/${win.id}/desktop`, { method: 'PUT', body: { port: 3389, certPin: pin } })).status, 400);
    // a port change drops it (#20 rule, via validateDesktopSettings)
    await s.client.request(`/api/hosts/${win.id}/desktop`, { method: 'PUT', body: { port: 3390 } });
    assert.equal(pinOf(), null);
    // address change clears it (#20, PUT /api/hosts/:id)
    await s.t.app.store.setDesktopCertPin(win.id, pin);
    await s.client.request(`/api/hosts/${win.id}`, { method: 'PUT', body: { name: 'win', address: '127.0.0.2', port: 22, username: 'me' } });
    assert.equal(pinOf(), null);
    // owner-only pin reset route still there
    await s.t.app.store.setDesktopCertPin(win.id, pin);
    const anon = await fetch(`${s.t.base}/api/hosts/${win.id}/desktop/cert-pin`, { method: 'DELETE', headers: { Origin: s.t.origin } });
    assert.equal(anon.status, 401);
    assert.equal((await s.client.request(`/api/hosts/${win.id}/desktop/cert-pin`, { method: 'DELETE' })).status, 200);
    assert.equal(pinOf(), null);
  } finally { await s.stop(); }
});

test('view: a 4403 Origin refusal keeps its own sentence, with or without a password (no VNC check)', async () => {
  const asked = [];
  const ORIGIN = 'RemoteHub didn’t accept this page’s address. Open RemoteHub from its usual address, or ask whoever set it up to add this address.';
  for (const pw of ['', 'pw']) {
    const { s, factory } = view('vnc', async (_h, opts) => { asked.push(opts); return { reason: 'vnc-auth', message: 'This desktop needs a password.' }; });
    s.connectPassword.value = pw;
    s.connect();
    factory.last().end(4403, 'origin not allowed');
    await new Promise((r) => setImmediate(r));
    assert.equal(s.message, ORIGIN, `password ${pw ? 'given' : 'empty'}`);
    assert.notEqual(s.reason, 'vnc-auth');
  }
  assert.deepEqual(asked, [], 'the VNC check is never asked after a RemoteHub close code');
});

test('view: 4410 client text matches the server sentence exactly (no "try VNC instead")', async () => {
  const { readFileSync } = await import('node:fs');
  const server = readFileSync(new URL('../server/rdp.js', import.meta.url), 'utf8');
  const SENT = 'RemoteHub couldn’t reach this computer’s remote desktop. Click Reconnect to try again.';
  const { s, factory } = view('rdp', async () => null);
  s.connect(); factory.last().end(4410, '');
  assert.equal(s.message, SENT, 'page sentence when the server gives no reason');
  assert.ok(server.includes(SENT));
  assert.doesNotMatch(readFileSync(new URL('../public/js/desktop-session.js', import.meta.url), 'utf8'), /try VNC instead/);
});

test('view: a 4502 before the first picture still asks the VNC check', async () => {
  const asked = [];
  const { s, factory } = view('vnc', async (_h, opts) => { asked.push(opts); return { reason: 'vnc-auth', message: 'That desktop password didn’t work. Enter it again and connect.' }; });
  s.connect();
  factory.last().end(4502, 'lost');
  await new Promise((r) => setImmediate(r));
  assert.equal(asked.length, 1, 'VNC check asked after 4502');
  assert.equal(s.message, 'That desktop password didn’t work. Enter it again and connect.');
});

test('view: a 4503 does not ask the VNC check (unavailable state)', async () => {
  const asked = [];
  const { s, factory } = view('vnc', async () => { asked.push(1); return { reason: 'vnc-auth', message: 'x' }; });
  s.connect();
  factory.last().end(4503, 'gone');
  await new Promise((r) => setImmediate(r));
  assert.equal(asked.length, 0);
  assert.equal(s.reason, 'backend-down');
});


test('vnc-check refuses a foreign Origin with 403 and never dials (SAA-346)', async () => {
  const s = await setup({ vncCheckIntervalMs: 0 });
  const vnc = await startFakeVncServer({ types: [2] });
  try {
    const host = await s.addHost('mac');
    await s.client.request(`/api/hosts/${host.id}/desktop`, { method: 'PUT', body: { protocol: 'vnc', port: vnc.port } });
    const evil = await s.client.request(`/api/hosts/${host.id}/desktop/vnc-check`, { headers: { Origin: 'http://evil.example' } });
    assert.equal(evil.status, 403);
    assert.equal(vnc.received.length, 0, 'not dialed');
    const same = await s.client.request(`/api/hosts/${host.id}/desktop/vnc-check`);
    assert.equal(same.status, 200);
    const none = await fetch(`${s.t.base}/api/hosts/${host.id}/desktop/vnc-check`, { headers: { Cookie: s.client.cookie } });
    assert.equal(none.status, 200, 'no Origin header (same-origin GET / curl) still allowed, like other routes');
  } finally { await vnc.stop(); await s.stop(); }
});

test('SAA-346 view: while the pre-check runs, the failure says it is finding out why; restored if the check has nothing', async () => {
  let release;
  const { s, factory } = view('vnc', () => new Promise((r) => { release = r; }));
  s.connectPassword.value = 'pw';
  s.connect();
  factory.last().receive('ready', '$id');
  factory.last().receive('error', 'Aborted. See logs.', '519');
  factory.last().end(1011, 'Desktop connection failed (status 519).');
  assert.equal(s.state, 'failed');
  assert.equal(s.reason, 'remote-error');
  assert.equal(s.message, 'The remote desktop ran into a problem. Click Reconnect to try again. Finding out why…', 'plain words, never guacd text');
  release(null);
  await new Promise((r) => setImmediate(r));
  assert.equal(s.message, 'The remote desktop ran into a problem. Click Reconnect to try again.', 'suffix removed when the pre-check has nothing');
  // and with an answer it is replaced by the plain reason
  s.connect();
  factory.last().receive('ready', '$id');
  factory.last().end(1011, 'Desktop connection failed (status 519).');
  assert.match(s.message, /Finding out why…$/);
  release({ reason: 'vnc-auth', message: 'That desktop password didn’t work. Enter it again and connect.' });
  await new Promise((r) => setImmediate(r));
  assert.equal(s.message, 'That desktop password didn’t work. Enter it again and connect.');
});
