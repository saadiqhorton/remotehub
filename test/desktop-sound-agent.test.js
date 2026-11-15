import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { httpClient, openAgent, openWs, sleep, startTestApp } from './helpers/app-harness.js';
import { SOUND_CLOSE, SoundHub } from '../server/desktop-sound.js';

// Desktop sound from the computer's RemoteHub agent (server/desktop-sound.js): a scripted
// agent registers over the real /ws/agent with a real host credential, and Desktop tabs
// listen on /ws/desktop-sound. No Terminal or Files socket is involved anywhere.

const OWNER_PASSWORD = 'owner-password-123';
const MIMETYPE = 'audio/L16;rate=48000,channels=2';
let env;
let client;

before(async () => {
  env = await startTestApp();
  client = httpClient(env.base, env.origin);
  const setup = await client.request('/api/auth/setup', { method: 'POST', body: { setupCode: env.app.setupCode, password: OWNER_PASSWORD } });
  assert.equal(setup.status, 200);
});
after(async () => { await env.stop(); });

async function hostWithCredential(name = 'Sound box') {
  const created = await client.request('/api/hosts', { method: 'POST', body: { name, address: '127.0.0.1', port: 22, username: 'tester' } });
  const issued = await client.request(`/api/hosts/${created.body.host.id}/agent`, { method: 'POST' });
  assert.equal(issued.status, 201);
  return { host: created.body.host, token: issued.body.token };
}

async function connectAgent(hostId, token, operations = ['fs.list', 'audio.capture']) {
  const agent = openAgent(env.base);
  await agent.opened;
  agent.send({ event: 'hello', protocol: 1, name: 'remotehub-agent', version: '0.2.0', mode: 'persistent', hostId, token, operations });
  await agent.untilControl((m) => m.event === 'authenticated', 'authenticated');
  agent.requests = (op) => agent.control.filter((m) => m.op === op);
  agent.answer = async (op, reply, nth = 1) => {
    await agent.until(() => agent.requests(op).length >= nth, `${op} #${nth}`);
    const request = agent.requests(op)[nth - 1];
    agent.send({ id: request.id, ...reply });
  };
  return agent;
}

const tabHeaders = (origin = env.origin) => ({ Origin: origin, Cookie: client.cookie });
async function openTab(hostId, headers = tabHeaders()) {
  const tab = openWs(env.base, `/ws/desktop-sound?hostId=${encodeURIComponent(hostId)}`, { headers });
  await tab.opened;
  return tab;
}

const pcm = (...samples) => {
  const bytes = Buffer.alloc(samples.length * 2);
  samples.forEach((v, i) => bytes.writeInt16LE(v, i * 2));
  return bytes;
};

test('a tab waits for the agent, then hears it; capture runs only while someone listens', async () => {
  const { host, token } = await hostWithCredential();
  const tab = await openTab(host.id);
  await tab.untilControl((m) => m.type === 'waiting' && m.reason === 'no-agent', 'waiting for an agent');

  const agent = await connectAgent(host.id, token);
  await agent.answer('audio.start', { ok: true, result: { mimetype: MIMETYPE } });
  const ops = agent.control.map((m) => m.event || m.op);
  assert.ok(ops.indexOf('authenticated') < ops.indexOf('audio.start'), 'audio.start comes after authenticated (the agent ignores earlier requests)');
  await tab.untilControl((m) => m.type === 'format' && m.mimetype === MIMETYPE, 'format');

  const sound = pcm(1000, -1000, 2000, -2000);
  agent.send({ event: 'audio', data: sound.toString('base64') });
  await tab.until(() => tab.binaries.length === 1, 'sound reaches the tab');
  assert.deepEqual(tab.binaries[0], sound, 'PCM arrives unchanged, as binary');

  // A second tab joins the running stream: told the format at once, hears the same sound.
  const second = await openTab(host.id);
  await second.untilControl((m) => m.type === 'format', 'format for a late tab');
  agent.send({ event: 'audio', data: sound.toString('base64') });
  await second.until(() => second.binaries.length === 1, 'second tab hears sound');
  assert.equal(agent.requests('audio.start').length, 1, 'one capture serves every tab');

  tab.ws.close();
  await sleep(100);
  assert.equal(agent.requests('audio.stop').length, 0, 'still capturing for the other tab');
  second.ws.close();
  await agent.until(() => agent.requests('audio.stop').length === 1, 'audio.stop when the last tab leaves');
  agent.ws.close();
});

test('the tab learns why there is no sound: old agent, failed start, recorder stopped', async () => {
  const old = await hostWithCredential('Old agent');
  const oldAgent = await connectAgent(old.host.id, old.token, ['fs.list']);
  const oldTab = await openTab(old.host.id);
  await oldTab.untilControl((m) => m.type === 'unavailable' && /Update it/.test(m.reason), 'update hint');
  assert.equal(oldAgent.requests('audio.start').length, 0, 'never asks an agent that cannot capture');

  const idle = await hostWithCredential('Nobody signed in');
  const idleAgent = await connectAgent(idle.host.id, idle.token);
  const idleTab = await openTab(idle.host.id);
  await idleAgent.answer('audio.start', { ok: false, error: { code: 'unsupported', message: 'no PipeWire or PulseAudio sound session is running for this user' } });
  await idleTab.untilControl((m) => m.type === 'unavailable' && /No sound system is running/.test(m.reason), 'plain reason');
  const lateTab = await openTab(idle.host.id);
  await lateTab.untilControl((m) => m.type === 'unavailable', 'a later tab is told too');

  const ends = await hostWithCredential('Recorder stops');
  const endsAgent = await connectAgent(ends.host.id, ends.token);
  const endsTab = await openTab(ends.host.id);
  await endsAgent.answer('audio.start', { ok: true, result: { mimetype: MIMETYPE } });
  await endsTab.untilControl((m) => m.type === 'format', 'format');
  endsAgent.send({ event: 'audioEnd', reason: 'pw-record stopped' });
  await endsTab.untilControl((m) => m.type === 'unavailable' && /pw-record stopped/.test(m.reason), 'stopped reason');
  for (const s of [oldAgent, oldTab, idleAgent, idleTab, lateTab, endsAgent, endsTab]) s.ws.close();
});

test('an agent that drops and comes back resumes sound for the open tab', async () => {
  const { host, token } = await hostWithCredential('Flaky');
  const tab = await openTab(host.id);
  const first = await connectAgent(host.id, token);
  await first.answer('audio.start', { ok: true, result: { mimetype: MIMETYPE } });
  await tab.untilControl((m) => m.type === 'format', 'format');
  first.ws.close();
  await tab.until(() => tab.control.filter((m) => m.type === 'waiting').length === 2, 'waiting again after the drop');
  const second = await connectAgent(host.id, token);
  await second.answer('audio.start', { ok: true, result: { mimetype: MIMETYPE } });
  await tab.until(() => tab.control.filter((m) => m.type === 'format').length === 2, 'format again');
  second.send({ event: 'audio', data: pcm(5, 5).toString('base64') });
  await tab.until(() => tab.binaries.length === 1, 'sound again');
  tab.ws.close(); second.ws.close();
});

test('a replacement agent connection (same computer, while the old one is live) restarts sound', async () => {
  const { host, token } = await hostWithCredential('Replaced');
  const tab = await openTab(host.id);
  const first = await connectAgent(host.id, token);
  await first.answer('audio.start', { ok: true, result: { mimetype: MIMETYPE } });
  await tab.untilControl((m) => m.type === 'format', 'format');
  const replacement = await connectAgent(host.id, token); // the old socket is closed as replaced
  await replacement.answer('audio.start', { ok: true, result: { mimetype: MIMETYPE } });
  await tab.until(() => tab.control.filter((m) => m.type === 'format').length === 2, 'format again from the replacement');
  replacement.send({ event: 'audio', data: pcm(9, 9).toString('base64') });
  await tab.until(() => tab.binaries.length === 1, 'sound from the replacement');
  tab.ws.close(); replacement.ws.close();
});

test('sound is output only: nothing a tab sends reaches the agent', async () => {
  const { host, token } = await hostWithCredential('Output only');
  const agent = await connectAgent(host.id, token);
  const tab = await openTab(host.id);
  await agent.answer('audio.start', { ok: true, result: { mimetype: MIMETYPE } });
  await tab.untilControl((m) => m.type === 'format', 'format');
  const before = agent.control.length;
  tab.sendRaw(JSON.stringify({ id: 'x', op: 'exec.run', params: { executable: 'id', args: [] } }));
  tab.sendRaw(Buffer.from([1, 2, 3, 4]));
  await sleep(150);
  assert.equal(agent.control.length, before, 'the agent received nothing from the tab');
  tab.ws.close(); agent.ws.close();
});

test('refusals: foreign Origin, no login, unknown computer, logout', async () => {
  const { host } = await hostWithCredential('Guarded');
  const foreign = openWs(env.base, `/ws/desktop-sound?hostId=${host.id}`, { headers: tabHeaders('http://evil.example') });
  assert.equal(await foreign.closedWithCode(), SOUND_CLOSE.ORIGIN);
  const anonymous = openWs(env.base, `/ws/desktop-sound?hostId=${host.id}`, { headers: { Origin: env.origin } });
  assert.equal(await anonymous.closedWithCode(), SOUND_CLOSE.AUTH);
  const unknown = openWs(env.base, '/ws/desktop-sound?hostId=nope', { headers: tabHeaders() });
  assert.equal(await unknown.closedWithCode(), SOUND_CLOSE.UNKNOWN_HOST);

  const tab = await openTab(host.id);
  const closed = tab.closedWithCode();
  assert.equal((await client.request('/api/auth/logout', { method: 'POST' })).status, 200);
  assert.equal(await closed, SOUND_CLOSE.AUTH, 'logging out ends sound too');
});

test('an agent that does not answer the sound request in time: the tab is told, and the hub tries again', async () => {
  // A fake registry and agent: the first audio.start times out (agent busy), the second succeeds.
  const sent = [];
  const agent = { ws: { readyState: 1, OPEN: 1 }, hello: { operations: ['audio.capture'] }, calls: [],
    request(op) {
      this.calls.push(op);
      if (op !== 'audio.start') return Promise.resolve({ ok: true, result: {} });
      return this.calls.filter((c) => c === 'audio.start').length === 1
        ? Promise.reject(new Error('Host agent request timed out.'))
        : Promise.resolve({ ok: true, result: { mimetype: MIMETYPE } });
    } };
  const registry = { get: () => agent, observe() {} };
  const hub = new SoundHub({ registry, startTimeoutMs: 50, retryMs: 50 });
  const listeners = {};
  const tab = { readyState: 1, OPEN: 1, bufferedAmount: 0, on: (event, fn) => { listeners[event] = fn; }, send: (data) => sent.push(JSON.parse(data)) };
  hub.attach(tab, 'busy-host');
  await sleep(20);
  assert.match(sent.at(-1)?.reason ?? '', /didn’t answer the sound request/, 'the tab is told instead of staying silent');
  await sleep(120);
  assert.equal(agent.calls.filter((c) => c === 'audio.start').length, 2, 'one retry');
  assert.deepEqual(sent.at(-1), { type: 'format', mimetype: MIMETYPE }, 'sound starts on the retry');
  listeners.close();
  assert.equal(agent.calls.at(-1), 'audio.stop');
});
