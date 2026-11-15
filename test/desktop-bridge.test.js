import { test } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { InstructionStream, browserSize, connectionParameters, encode, publicDesktopSettings, validateDesktopSettings } from '../server/desktop-bridge.js';
import { startFakeGuacdSession } from './helpers/fake-guacd-session.js';
import { httpClient, startTestApp } from './helpers/app-harness.js';

/** Server-side guacd desktop bridge (SAA-302). */

const SECRET = 'vnc-Secret-Pw-42';

async function setup({ enabled = true, mode = 'ok', timeouts, extra = {} } = {}) {
  const fake = await startFakeGuacdSession({ mode });
  const logs = [];
  const t = await startTestApp({
    guacd: { enabled, host: '127.0.0.1', port: fake.port, protocol: 'vnc', timeoutMs: 500, cacheMs: 0 },
    ...(timeouts ? { desktopTimeouts: timeouts } : {}),
    ...extra,
  }, { log: (m) => logs.push(m) });
  const client = httpClient(t.base, t.origin);
  const code = (await import('node:fs/promises')).readFile(`${t.dataDir}/SETUP-CODE.txt`, 'utf8');
  assert.equal((await client.request('/api/auth/setup', { method: 'POST', body: { setupCode: (await code).trim(), password: 'owner-password-1' } })).status, 200);
  const host = (await client.request('/api/hosts', { method: 'POST', body: { name: 'box', address: '10.9.8.7', port: 22, username: 'me' } })).body.host;
  return { fake, t, client, host, logs, stop: async () => { await t.stop(); await fake.stop(); } };
}

function connectWs(t, query, cookie, origin = t.origin, { password = SECRET } = {}) {
  const ws = new WebSocket(`${t.base.replace('http', 'ws')}/ws/desktop${query}`, { headers: { Origin: origin, ...(cookie ? { Cookie: cookie } : {}) } });
  const out = { ws, text: '', instructions: [] };
  const parser = new InstructionStream();
  ws.on('open', () => { if (password !== false) ws.send(password ? encode('credentials', 'password', password) : encode('credentials')); });
  ws.on('message', (d) => { out.text += d.toString(); for (const i of parser.push(d.toString())) out.instructions.push(i.elements); });
  out.closed = new Promise((resolve) => ws.on('close', (code, reason) => resolve({ code, reason: reason.toString() })));
  out.unexpected = new Promise((resolve) => ws.on('unexpected-response', (_req, res) => { resolve(res.statusCode); res.destroy(); }));
  ws.on('error', () => {});
  out.until = async (pred, ms = 4000) => { const end = Date.now() + ms; while (!pred()) { if (Date.now() > end) throw new Error(`timeout; got ${out.text.slice(0, 300)}`); await new Promise((r) => setTimeout(r, 10)); } };
  return out;
}

test('InstructionStream: chunks, unicode lengths, malformed input', () => {
  const s = new InstructionStream();
  assert.deepEqual(s.push('4.sy'), []);
  const got = s.push('nc,2.10;1.x,5.héllo;3.a');
  assert.deepEqual(got.map((g) => g.elements), [['sync', '10'], ['x', 'héllo']]);
  assert.equal(got[1].raw, '1.x,5.héllo;');
  assert.deepEqual(s.push('bc;').map((g) => g.elements), [['abc']]);
  assert.deepEqual(new InstructionStream().push(encode('k', '😀a')).map((g) => g.elements), [['k', '😀a']]);
  assert.throws(() => new InstructionStream().push('GET / HTTP/1.1'), /malformed/);
});

test('settings: validation, password kept server-side, public view hides it; params are server-held', () => {
  assert.throws(() => validateDesktopSettings({ protocol: 'ssh' }), /vnc or rdp/);
  assert.throws(() => validateDesktopSettings({ protocol: 'vnc', password: SECRET }), /not stored/);
  const vnc = validateDesktopSettings({ protocol: 'vnc' });
  assert.deepEqual(vnc, { protocol: 'vnc', port: 5900 });
  assert.deepEqual(publicDesktopSettings(vnc), { protocol: 'vnc', port: 5900, username: null });
  assert.equal(connectionParameters({ address: 'a' }, vnc, { password: 'p', hostname: 'evil' }).hostname, 'a', 'only allow-listed credentials are taken');
  const rdp = validateDesktopSettings({ protocol: 'rdp', username: 'u', ignoreCert: true });
  // SAA-304 extended the rdp params (see test/rdp.test.js); the server-held core is unchanged.
  const rdpParams = connectionParameters({ address: '10.0.0.5' }, rdp, { password: SECRET });
  assert.deepEqual({ hostname: rdpParams.hostname, port: rdpParams.port, username: rdpParams.username, security: rdpParams.security, 'ignore-cert': rdpParams['ignore-cert'], 'resize-method': rdpParams['resize-method'] },
    { hostname: '10.0.0.5', port: '3389', username: 'u', security: 'any', 'ignore-cert': 'true', 'resize-method': 'display-update' });
  assert.equal(rdpParams.password, undefined, 'RDP passwords go only through the required/argv prompt');
  assert.deepEqual(browserSize(new URLSearchParams('width=99999&height=abc&dpi=96&hostname=evil&port=1')), { width: 8192, height: 768, dpi: 96 });
});

test('authenticated desktop: handshake uses server-held host params, relays frames both ways, no secrets leak', async () => {
  const s = await setup();
  try {
    const refused = await s.client.request(`/api/hosts/${s.host.id}/desktop`, { method: 'PUT', body: { protocol: 'vnc', port: 5909, password: SECRET } });
    assert.equal(refused.status, 400, 'a password in the settings body is rejected');
    const saved = await s.client.request(`/api/hosts/${s.host.id}/desktop`, { method: 'PUT', body: { protocol: 'vnc', port: 5909 } });
    assert.equal(saved.status, 200);
    assert.deepEqual(saved.body.host.desktop, { protocol: 'vnc', port: 5909, username: null });
    assert.ok(!JSON.stringify((await s.client.request('/api/hosts')).body).includes(SECRET));
    const c = connectWs(s.t, `?hostId=${s.host.id}&width=800&height=600&dpi=96&hostname=evil.example&port=1`, s.client.cookie);
    await c.until(() => c.instructions.some((i) => i[0] === 'sync'));
    assert.deepEqual(c.instructions.map((i) => i[0]), ['ready', 'size', 'img', 'blob', 'end', 'sync']);
    assert.ok(!c.text.includes(SECRET), 'password never reaches the browser');
    c.ws.send(encode('select', 'rdp') + encode('connect', 'x') + encode('sync', '1234') + encode('mouse', '1', '2', '0'));
    const log = s.fake.received[0];
    await new Promise((r) => setTimeout(r, 100));
    const ops = log.map((i) => i[0]);
    assert.deepEqual(ops, ['select', 'size', 'audio', 'video', 'image', 'connect', 'sync', 'mouse'], 'browser select/connect are dropped');
    assert.deepEqual(log[0], ['select', 'vnc']);
    assert.deepEqual(log[1], ['size', '800', '600', '96']);
    assert.deepEqual(log[2], ['audio', 'audio/L8', 'audio/L16'], 'handshake offers the sound formats the browser plays');
    assert.deepEqual(log[5], ['connect', 'VERSION_1_5_0', '10.9.8.7', '5909', SECRET]);
    c.ws.send(encode('disconnect'));
    assert.equal((await c.closed).code, 1000);
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(s.fake.sockets.size, 0, 'guacd socket closed');
    assert.ok(!s.logs.join('\n').includes(SECRET), 'password never logged');
    const dataFile = (await import('node:fs')).readFileSync(`${s.t.dataDir}/remotehub.json`, 'utf8');
    assert.ok(!dataFile.includes(SECRET) && !/"password"\s*:\s*"[^$]/.test(JSON.stringify(JSON.parse(dataFile).hosts)), 'no desktop password in the data file');
    // A second connection must supply its own password; the first one was not kept.
    const again = connectWs(s.t, `?hostId=${s.host.id}`, s.client.cookie, s.t.origin, { password: '' });
    await again.until(() => again.instructions.some((i) => i[0] === 'ready'));
    assert.deepEqual(s.fake.received[1][5], ['connect', 'VERSION_1_5_0', '10.9.8.7', '5909', ''], 'no remembered password');
    again.ws.close();
  } finally { await s.stop(); }
});

test('mid-session: only allow-listed opcodes reach guacd, and size is clamped like the handshake', async () => {
  const s = await setup();
  try {
    await s.client.request(`/api/hosts/${s.host.id}/desktop`, { method: 'PUT', body: { protocol: 'vnc' } });
    const c = connectWs(s.t, `?hostId=${s.host.id}&width=999999&height=999999&dpi=99999`, s.client.cookie);
    await c.until(() => c.instructions.some((i) => i[0] === 'ready'));
    const allowed = [['mouse', '10', '20', '1'], ['key', '65', '1'], ['sync', '1234'], ['ack', '1', 'OK', '0'],
      ['clipboard', '5', 'text/plain'], ['blob', '5', 'aGk='], ['end', '5'], ['nop']];
    const blocked = [['select', 'rdp'], ['connect', 'x'], ['args', 'x'], ['audio', 'audio/L16'], ['video'], ['image', 'image/png'],
      ['file', '7', 'text/plain', 'x'], ['pipe', '8', 'text/plain', 'p'], ['bogus-op', '1']];
    c.ws.send([...blocked, ...allowed].map((i) => encode(...i)).join('')
      + encode('size', '999999', '999999', '99999') + encode('size', '10', '-5') + encode('size', '1280', '720', '96'));
    const log = s.fake.received[0];
    await c.until(() => log.filter((i) => i[0] === 'size').length >= 4);
    const after = log.slice(log.findIndex((i) => i[0] === 'connect') + 1);
    assert.deepEqual(log[1], ['size', '8192', '8192', '384'], 'handshake size clamped');
    assert.deepEqual(after, [...allowed, ['size', '8192', '8192', '384'], ['size', '320', '768'], ['size', '1280', '720', '96']]);
    c.ws.send(encode('disconnect'));
    assert.equal((await c.closed).code, 1000);
    assert.ok(s.logs.some((l) => /dropped=9/.test(l)), 'drops are counted in the close log');
  } finally { await s.stop(); }
});

test('remote sound: guacd audio streams reach the browser and its acks reach guacd; the microphone stays blocked', async () => {
  const s = await setup({ mode: 'audio' });
  try {
    await s.client.request(`/api/hosts/${s.host.id}/desktop`, { method: 'PUT', body: { protocol: 'vnc' } });
    const c = connectWs(s.t, `?hostId=${s.host.id}&width=800&height=600`, s.client.cookie);
    await c.until(() => c.instructions.some((i) => i[0] === 'sync' && i[1] === '2'));
    const ops = c.instructions.map((i) => i[0]);
    assert.deepEqual(c.instructions.find((i) => i[0] === 'audio'), ['audio', '3', 'audio/L16;rate=44100,channels=2']);
    assert.deepEqual(ops.slice(ops.indexOf('audio'), ops.indexOf('audio') + 3), ['audio', 'blob', 'end']);
    c.ws.send(encode('ack', '3', 'OK', '0') + encode('audio', '9', 'audio/L16;rate=44100,channels=1'));
    const log = s.fake.received[0];
    await c.until(() => log.some((i) => i[0] === 'ack'));
    await new Promise((r) => setTimeout(r, 100));
    assert.deepEqual(log.find((i) => i[0] === 'ack'), ['ack', '3', 'OK', '0'], 'the browser accepts the sound stream');
    assert.equal(log.filter((i) => i[0] === 'audio').length, 1, 'only the handshake audio line; a browser audio (microphone) stream is dropped');
    c.ws.send(encode('disconnect'));
    assert.equal((await c.closed).code, 1000);
  } finally { await s.stop(); }
});

test('argv: only for names guacd listed in required, once each; refused stream bodies dropped', async () => {
  const s = await setup();
  try {
    await s.client.request(`/api/hosts/${s.host.id}/desktop`, { method: 'PUT', body: { protocol: 'vnc' } });
    const c = connectWs(s.t, `?hostId=${s.host.id}`, s.client.cookie, s.t.origin, { password: '' });
    await c.until(() => c.instructions.some((i) => i[0] === 'ready'));
    const argv = (stream, name, value) => encode('argv', stream, 'text/plain', name) + encode('blob', stream, Buffer.from(value).toString('base64')) + encode('end', stream);
    c.ws.send(argv('1', 'password', 'too-early'));        // before any required
    await new Promise((r) => setTimeout(r, 50));
    for (const sock of s.fake.sockets) sock.write(encode('required', 'password'));
    await c.until(() => c.instructions.some((i) => i[0] === 'required'));
    c.ws.send(argv('2', 'hostname', 'evil.example') + argv('3', 'port', '1') + argv('4', 'password', 'right-pw') + argv('5', 'password', 'again') + encode('nop'));
    const log = s.fake.received[0];
    await c.until(() => log.some((i) => i[0] === 'nop'));
    const after = log.slice(log.findIndex((i) => i[0] === 'connect') + 1);
    assert.deepEqual(after, [['argv', '4', 'text/plain', 'password'], ['blob', '4', Buffer.from('right-pw').toString('base64')], ['end', '4'], ['nop']]);
    assert.ok(!JSON.stringify(log).includes('evil.example'));
    c.ws.send(encode('disconnect'));
    await c.closed;
    assert.ok(s.logs.some((l) => /dropped=12/.test(l)), s.logs.join('\n'));
    assert.ok(!s.logs.join('\n').includes('right-pw'));
  } finally { await s.stop(); }
});

test('binary frame -> 1003, malformed instruction -> 1007', async () => {
  const s = await setup();
  try {
    await s.client.request(`/api/hosts/${s.host.id}/desktop`, { method: 'PUT', body: { protocol: 'vnc' } });
    const a = connectWs(s.t, `?hostId=${s.host.id}`, s.client.cookie);
    await a.until(() => a.instructions.some((i) => i[0] === 'ready'));
    a.ws.send(Buffer.from([1, 2, 3]), { binary: true });
    assert.equal((await a.closed).code, 1003);
    const b = connectWs(s.t, `?hostId=${s.host.id}`, s.client.cookie);
    await b.until(() => b.instructions.some((i) => i[0] === 'ready'));
    b.ws.send('GET / HTTP/1.1;');
    assert.equal((await b.closed).code, 1007);
  } finally { await s.stop(); }
});

test('a password stored by an older build is stripped from the data file on load', async () => {
  const fs = await import('node:fs/promises');
  const os = await import('node:os');
  const { Store } = await import('../server/store.js');
  const dir = await fs.mkdtemp(`${os.tmpdir()}/rh-strip-`);
  await fs.writeFile(`${dir}/remotehub.json`, JSON.stringify({ version: 2, owner: null, knownHosts: {}, hosts: [{ id: 'h', name: 'n', address: 'a', port: 22, username: 'u', desktop: { protocol: 'vnc', port: 5900, password: SECRET } }] }));
  const store = await new Store(dir).load();
  await store.writing;
  assert.equal(store.getHost('h').desktop.password, undefined);
  assert.ok(!(await fs.readFile(`${dir}/remotehub.json`, 'utf8')).includes(SECRET));
  await fs.rm(dir, { recursive: true, force: true });
});

test('unauthenticated / expired / logged-out sessions get 4401; bad origin is refused; origin checked', async () => {
  const s = await setup();
  try {
    await s.client.request(`/api/hosts/${s.host.id}/desktop`, { method: 'PUT', body: { protocol: 'vnc' } });
    assert.equal((await connectWs(s.t, `?hostId=${s.host.id}`, null).closed).code, 4401);
    assert.equal((await connectWs(s.t, `?hostId=${s.host.id}`, 'rh_session=forged').closed).code, 4401);
    assert.equal((await connectWs(s.t, `?hostId=${s.host.id}`, s.client.cookie, 'http://evil.example').closed).code, 4403);
    const live = connectWs(s.t, `?hostId=${s.host.id}`, s.client.cookie);
    await live.until(() => live.instructions.some((i) => i[0] === 'ready'));
    await s.client.request('/api/auth/logout', { method: 'POST' });
    assert.equal((await live.closed).code, 4401, 'logout closes the live desktop');
    assert.equal(s.fake.connections, 1, 'only the authenticated attempt reached guacd');
  } finally { await s.stop(); }
});

test('flag off: 4503 and zero guacd connections; unknown host / no desktop: 4404', async () => {
  const off = await setup({ enabled: false });
  try {
    await off.client.request(`/api/hosts/${off.host.id}/desktop`, { method: 'PUT', body: { protocol: 'vnc' } });
    for (let i = 0; i < 3; i += 1) assert.equal((await connectWs(off.t, `?hostId=${off.host.id}`, off.client.cookie).closed).code, 4503);
    assert.equal(off.fake.connections, 0);
  } finally { await off.stop(); }
  const on = await setup();
  try {
    assert.equal((await connectWs(on.t, '?hostId=nope', on.client.cookie).closed).code, 4404);
    assert.equal((await connectWs(on.t, `?hostId=${on.host.id}`, on.client.cookie).closed).code, 4404, 'host without desktop settings');
    assert.equal(on.fake.connections, 0);
  } finally { await on.stop(); }
});

test('failures: guacd down, hung, rejected credentials, killed mid-session, server shutdown', async () => {
  const s = await setup({ timeouts: { connectMs: 500, handshakeMs: 400, idleMs: 60000 } });
  try {
    await s.client.request(`/api/hosts/${s.host.id}/desktop`, { method: 'PUT', body: { protocol: 'vnc' } });
    const q = `?hostId=${s.host.id}`;
    s.fake.mode = 'hung';
    let t0 = performance.now();
    assert.equal((await connectWs(s.t, q, s.client.cookie).closed).code, 4503);
    assert.ok(performance.now() - t0 < 2000, 'handshake timeout applies');
    s.fake.mode = 'reject';
    const bad = connectWs(s.t, q, s.client.cookie);
    assert.equal((await bad.closed).code, 1011);
    assert.ok(bad.instructions.some((i) => i[0] === 'error'), 'browser sees guacd error');
    s.fake.mode = 'ok';
    const live = connectWs(s.t, q, s.client.cookie);
    await live.until(() => live.instructions.some((i) => i[0] === 'ready'));
    s.fake.dropAll();
    assert.equal((await live.closed).code, 4502, 'guacd crashing mid-session is 4502, not a normal close');
    const ended = connectWs(s.t, q, s.client.cookie);
    await ended.until(() => ended.instructions.some((i) => i[0] === 'ready'));
    for (const sock of s.fake.sockets) sock.end('10.disconnect;');
    assert.equal((await ended.closed).code, 1000, 'guacd-initiated disconnect is a normal end');
    const noCreds = connectWs(s.t, q, s.client.cookie, s.t.origin, { password: false });
    noCreds.ws.on('open', () => noCreds.ws.send(encode('mouse', '1', '1', '0')));
    assert.equal((await noCreds.closed).code, 1008, 'first message must be credentials');
    const silent = connectWs(s.t, q, s.client.cookie, s.t.origin, { password: false });
    assert.equal((await silent.closed).code, 4503, 'no credentials -> handshake timeout');
    const live2 = connectWs(s.t, q, s.client.cookie);
    await live2.until(() => live2.instructions.some((i) => i[0] === 'ready'));
    s.t.app.closeDesktops();
    assert.equal((await live2.closed).code, 1001);
    await s.fake.stop();
    t0 = performance.now();
    assert.equal((await connectWs(s.t, q, s.client.cookie).closed).code, 4503, 'guacd not running');
    assert.ok(!s.logs.join('\n').includes(SECRET));
  } finally { await s.t.stop(); }
});

test('foreign Origin with the real Host: closed with 4403, desktop count unchanged; same-origin still works', async () => {
  const s = await setup({ extra: { maxDesktops: 1 } });
  try {
    await s.client.request(`/api/hosts/${s.host.id}/desktop`, { method: 'PUT', body: { protocol: 'vnc' } });
    // ws sends the server's real Host header; only the Origin is foreign.
    for (let i = 0; i < 3; i++) {
      const foreign = connectWs(s.t, `?hostId=${s.host.id}`, s.client.cookie, 'http://evil.example');
      const statusOrClose = await Promise.race([foreign.closed.then((c) => c.code), foreign.unexpected.then((st) => `HTTP ${st}`)]);
      assert.equal(statusOrClose, 4403);
    }
    assert.equal(s.fake.connections, 0, 'no refused attempt reached guacd');
    // With MAX_DESKTOPS=1, a slot taken by a refused attempt would make this 503.
    const live = connectWs(s.t, `?hostId=${s.host.id}`, s.client.cookie);
    await live.until(() => live.instructions.some((i) => i[0] === 'ready'));
    assert.equal(s.fake.connections, 1);
    // The one slot is now really in use: a second same-origin desktop gets 503 (count is 1, not 4).
    assert.equal(await connectWs(s.t, `?hostId=${s.host.id}`, s.client.cookie).unexpected, 503);
    live.ws.close();
  } finally { await s.stop(); }
});

/** SAA-346: guacd-silence watchdog and server keep-alive. */
function busyWait(ms) { const end = Date.now() + ms; while (Date.now() < end) { /* simulate a process/host stall */ } }

test('SAA-346 watchdog: a stall longer than idleMs does not close a healthy session with 4503', async () => {
  const s = await setup({ timeouts: { connectMs: 500, handshakeMs: 400, idleMs: 300 } });
  try {
    await s.client.request(`/api/hosts/${s.host.id}/desktop`, { method: 'PUT', body: { protocol: 'vnc' } });
    const c = connectWs(s.t, `?hostId=${s.host.id}`, s.client.cookie);
    await c.until(() => c.instructions.some((i) => i[0] === 'sync'));
    const [guacdSide] = s.fake.sockets;
    const beat = setInterval(() => guacdSide.write(encode('nop')), 50); // guacd's own keep-alive
    await new Promise((r) => setTimeout(r, 400));
    // Stall in the check phase so the next loop turn runs timers before it reads the
    // socket data that arrived meanwhile - what a host freeze looks like to the server.
    await new Promise((r) => setImmediate(() => { guacdSide.write(encode('nop')); busyWait(700); r(); }));
    await new Promise((r) => setTimeout(r, 500));
    clearInterval(beat);
    assert.equal(c.ws.readyState, WebSocket.OPEN, `closed: ${s.logs.join(' | ')}`);
    assert.ok(!s.logs.some((l) => /code=4503/.test(l)));
    c.ws.close();
  } finally { await s.stop(); }
});

test('SAA-346 watchdog: real guacd silence still closes with 4503 and logs what each side last sent (opcodes only)', async () => {
  const s = await setup({ timeouts: { connectMs: 500, handshakeMs: 400, idleMs: 300 } });
  try {
    await s.client.request(`/api/hosts/${s.host.id}/desktop`, { method: 'PUT', body: { protocol: 'vnc' } });
    const c = connectWs(s.t, `?hostId=${s.host.id}`, s.client.cookie);
    await c.until(() => c.instructions.some((i) => i[0] === 'sync'));
    c.ws.send(encode('sync', '1234'));
    const closed = await c.closed;
    assert.equal(closed.code, 4503);
    assert.match(closed.reason, /stopped responding/);
    const line = s.logs.find((l) => /watchdog: guacd silent/.test(l));
    assert.match(line, /last sync\); browser last sync \d+ms ago/);
    assert.ok(!s.logs.join('\n').includes(SECRET));
  } finally { await s.stop(); }
});
