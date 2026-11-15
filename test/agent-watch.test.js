import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Duplex } from 'node:stream';
import { AGENT_RETRY_MS, AGENT_TOKEN_PATH, createAgentWatch, parseAgentToken, readAgentToken } from '../server/agent-watch.js';

const TOKEN = 'a'.repeat(32) + '0123456789abcdef0123456789abcdef';

// A scripted agent on the far end of the channel. It speaks the SAA-295 wire
// format: newline-delimited JSON, hello on connect, then request/response.
function fakeAgent({ watch = true, protocol = 1, greet = true, token = TOKEN } = {}) {
  const received = [];
  let nextWatch = 1;
  let channel = null;
  const agent = {
    received,
    token,
    opens: 0,
    refuse: false,
    emit(frame) { channel.push(`${JSON.stringify(frame)}\n`); },
    drop() { channel.destroy(); },
    open(done) {
      agent.opens += 1;
      if (agent.refuse) return done(new Error('Connection refused'));
      channel = new Duplex({
        read() {},
        write(chunk, _encoding, callback) {
          for (const line of chunk.toString('utf8').split('\n').filter(Boolean)) {
            const request = JSON.parse(line);
            received.push(request);
            if (request.op === 'hello' && request.params?.token !== agent.token) {
              // Like the real agent: one unauthorized reply, then hang up.
              agent.emit({ id: request.id, ok: false, error: { code: 'unauthorized', message: 'a hello with the local access token is required' } });
              setImmediate(() => channel.destroy());
              continue;
            }
            if (request.op === 'hello') agent.emit({ id: request.id, ok: true, result: { event: 'authenticated', protocol: 1, mode: 'persistent' } });
            if (request.op === 'watchDirectory') {
              if (request.params.path.startsWith('/outside')) agent.emit({ id: request.id, ok: false, error: { code: 'io_error', message: 'path escapes the agent root' } });
              else agent.emit({ id: request.id, ok: true, result: { watchId: nextWatch++, path: request.params.path } });
            }
            if (request.op === 'unwatchDirectory') agent.emit({ id: request.id, ok: true, result: { watchId: request.params.watchId, stopped: true } });
          }
          callback();
        },
      });
      done(null, channel);
      if (greet) agent.emit({ event: 'hello', protocol, name: 'remotehub-agent', version: '0.1.0', mode: 'persistent', capabilities: { files: { watch } } });
    },
  };
  return agent;
}

const tick = () => new Promise((resolve) => setImmediate(resolve));
async function settle() { for (let i = 0; i < 5; i += 1) await tick(); }

function harness(options = {}) {
  const agent = fakeAgent(options);
  const sent = [];
  const logs = [];
  let clock = 0;
  const tokenFile = { value: 'tokenFile' in options ? options.tokenFile : TOKEN, reads: 0 };
  const watch = createAgentWatch({
    open: (done) => agent.open(done),
    readToken: (done) => {
      tokenFile.reads += 1;
      if (tokenFile.value === null) return done(new Error('agent token file not readable'));
      done(null, tokenFile.value);
    },
    send: (message) => sent.push(message),
    log: (line) => logs.push(line),
    now: () => clock,
    onAgent: options.onAgent,
    onAgentLost: options.onAgentLost,
  });
  return { agent, sent, logs, tokenFile, watch, advance: (ms) => { clock += ms; } };
}

test('watch handshakes, subscribes the visible directory, and forwards its events', async () => {
  const { agent, sent, watch } = harness();
  watch.watch('/home/me');
  await settle();
  assert.deepEqual(agent.received.map((r) => r.op), ['hello', 'watchDirectory']);
  assert.deepEqual(agent.received[0].params, { protocol: 1, token: TOKEN });
  assert.deepEqual(sent, [{ t: 'watch-status', s: 'live', source: 'agent', path: '/home/me' }]);

  agent.emit({ event: 'filesystemEvent', watchId: 1, change: 'create', path: '/home/me/new.txt' });
  agent.emit({ event: 'filesystemEvent', watchId: 1, change: 'rename', path: '/home/me/b', from: '/home/me/a' });
  await settle();
  assert.deepEqual(sent.slice(1), [
    { t: 'fs-event', path: '/home/me', change: 'create', name: 'new.txt' },
    { t: 'fs-event', path: '/home/me', change: 'rename', name: 'b', from: 'a' },
  ]);
});

test('navigation replaces the watch and drops stale events from the old one', async () => {
  const { agent, sent, watch } = harness();
  watch.watch('/a');
  await settle();
  watch.watch('/b');
  await settle();
  assert.deepEqual(agent.received.slice(2).map((r) => [r.op, r.params]), [
    ['unwatchDirectory', { watchId: 1 }],
    ['watchDirectory', { path: '/b' }],
  ]);
  assert.deepEqual(watch.watching, { watchId: 2, path: '/b' });
  sent.length = 0;
  agent.emit({ event: 'filesystemEvent', watchId: 1, change: 'create', path: '/a/late' });
  agent.emit({ event: 'filesystemEvent', watchId: 2, change: 'delete', path: '/b/x' });
  await settle();
  assert.deepEqual(sent, [{ t: 'fs-event', path: '/b', change: 'delete', name: 'x' }]);

  watch.unwatch();
  await settle();
  assert.deepEqual(agent.received.at(-1), { id: agent.received.at(-1).id, op: 'unwatchDirectory', params: { watchId: 2 } });
  assert.equal(watch.watching, null);
});

test('a watch answered after the browser moved on is released, not reported', async () => {
  const { agent, sent, watch } = harness();
  watch.watch('/a');
  watch.watch('/b'); // both queued before the handshake finishes; only /b is requested
  await settle();
  assert.deepEqual(agent.received.filter((r) => r.op === 'watchDirectory').map((r) => r.params.path), ['/b']);
  assert.deepEqual(sent, [{ t: 'watch-status', s: 'live', source: 'agent', path: '/b' }]);
});

test('unavailable directories, refusals, and disconnects fall back to polling', async () => {
  const { agent, sent, watch } = harness();
  watch.watch('/outside/x');
  await settle();
  assert.deepEqual(sent.at(-1), { t: 'watch-status', s: 'off', source: 'agent', path: '/outside/x', reason: 'path escapes the agent root' });

  watch.watch('/home/me');
  await settle();
  agent.emit({ event: 'filesystemEvent', watchId: 1, change: 'unavailable', path: '/home/me' });
  agent.emit({ event: 'filesystemEvent', watchId: 1, change: 'create', path: '/home/me/after' });
  await settle();
  assert.deepEqual(sent.slice(-2), [
    { t: 'watch-status', s: 'live', source: 'agent', path: '/home/me' },
    { t: 'watch-status', s: 'unavailable', source: 'agent', path: '/home/me' },
  ]);

  watch.watch('/srv');
  await settle();
  agent.drop();
  await settle();
  assert.deepEqual(sent.at(-1), { t: 'watch-status', s: 'off', source: 'agent', path: '/srv', reason: 'agent disconnected' });
  assert.equal(watch.state, 'failed');
});

test('agents without watch support, other protocol versions, or no agent at all mean polling', async () => {
  for (const [options, reason] of [
    [{ watch: false }, 'agent does not support watching'],
    [{ protocol: 2 }, 'agent speaks protocol 2'],
  ]) {
    const { sent, watch } = harness(options);
    watch.watch('/home/me');
    await settle();
    assert.deepEqual(sent, [{ t: 'watch-status', s: 'off', source: 'agent', path: '/home/me', reason }]);
  }

  const { agent, sent, watch, advance } = harness();
  agent.refuse = true;
  watch.watch('/home/me');
  await settle();
  assert.deepEqual(sent, [{ t: 'watch-status', s: 'off', source: 'agent', path: '/home/me', reason: 'Connection refused' }]);
  // Navigation does not hammer a missing agent; it is retried after the backoff.
  watch.watch('/home/me/docs');
  await settle();
  assert.equal(agent.opens, 1);
  assert.equal(sent.at(-1).s, 'off');
  agent.refuse = false;
  advance(AGENT_RETRY_MS);
  watch.watch('/home/me/docs');
  await settle();
  assert.equal(agent.opens, 2);
  assert.deepEqual(sent.at(-1), { t: 'watch-status', s: 'live', source: 'agent', path: '/home/me/docs' });
});

test('close ends the channel and ignores everything after', async () => {
  const { agent, sent, watch } = harness();
  watch.watch('/home/me');
  await settle();
  watch.close();
  watch.watch('/elsewhere');
  await settle();
  assert.equal(watch.state, 'closed');
  assert.equal(agent.opens, 1);
  assert.deepEqual(sent, [{ t: 'watch-status', s: 'live', source: 'agent', path: '/home/me' }]);
});

test('missing token file: no agent channel is opened and the browser keeps polling', async () => {
  const { agent, sent, logs, watch } = harness({ tokenFile: null });
  watch.watch('/home/me');
  await settle();
  assert.equal(agent.opens, 0, 'never connects without a token');
  assert.equal(watch.state, 'failed');
  assert.deepEqual(sent, [{ t: 'watch-status', s: 'off', source: 'agent', path: '/home/me', reason: 'agent token file not readable' }]);
  assert.ok(logs.every((line) => !line.includes(TOKEN)));
});

test('wrong token is rejected by the agent and the session falls back to polling', async () => {
  const wrong = TOKEN.slice(0, -1) + '1';
  const { agent, sent, logs, watch } = harness({ tokenFile: wrong });
  watch.watch('/home/me');
  await settle();
  assert.deepEqual(agent.received.map((r) => r.op), ['hello'], 'nothing but the refused hello reaches the agent');
  assert.equal(watch.state, 'failed');
  assert.deepEqual(sent, [{ t: 'watch-status', s: 'off', source: 'agent', path: '/home/me', reason: 'agent rejected the token' }]);
  const everything = JSON.stringify(sent) + logs.join('\n');
  assert.ok(!everything.includes(wrong) && !everything.includes(TOKEN), 'tokens never reach logs or the browser');
});

test('missing token in hello is rejected by an agent that requires one', async () => {
  const { agent, sent, watch } = harness({ tokenFile: '' });
  watch.watch('/x');
  await settle();
  assert.equal(agent.received[0].params.token, undefined);
  assert.equal(sent.at(-1).s, 'off');
  assert.equal(sent.at(-1).reason, 'agent rejected the token');
});

test('right token goes live, and the token is re-read on every reconnect (agent restarts rotate it)', async () => {
  const { agent, sent, logs, tokenFile, watch, advance } = harness();
  watch.watch('/home/me');
  await settle();
  assert.equal(sent.at(-1).s, 'live');
  assert.equal(tokenFile.reads, 1);

  // Agent restarts with a fresh token.
  const rotated = 'b'.repeat(64);
  agent.token = rotated;
  tokenFile.value = rotated;
  agent.drop();
  await settle();
  advance(AGENT_RETRY_MS);
  watch.watch('/home/me');
  await settle();
  assert.equal(tokenFile.reads, 2);
  assert.equal(agent.received.filter((r) => r.op === 'hello').at(-1).params.token, rotated);
  assert.equal(sent.at(-1).s, 'live');
  const everything = JSON.stringify(sent) + logs.join('\n');
  assert.ok(!everything.includes(TOKEN) && !everything.includes(rotated));
});

test('parseAgentToken accepts only hex tokens of at least 32 bytes', () => {
  assert.equal(parseAgentToken(`${TOKEN}\n`), TOKEN);
  assert.equal(parseAgentToken(TOKEN.slice(0, 62)), null);
  assert.equal(parseAgentToken('z'.repeat(64)), null);
  assert.equal(parseAgentToken(''), null);
  assert.equal(parseAgentToken('a'.repeat(300)), null);
});

test('readAgentToken reads the file through SFTP and validates it', async () => {
  const fakeSftp = (files) => ({
    closed: 0,
    open(path, mode, cb) {
      assert.equal(mode, 'r');
      if (!(path in files)) return cb(new Error('No such file'));
      cb(null, { path });
    },
    read(handle, buf, off, len, pos, cb) {
      const data = Buffer.from(files[handle.path]);
      const n = Math.max(0, Math.min(len, data.length - pos, 7)); // small reads exercise the loop
      data.copy(buf, off, pos, pos + n);
      cb(null, n);
    },
    close(_handle, cb) { this.closed += 1; cb(); },
  });
  const read = (sftp) => new Promise((resolve) => readAgentToken(sftp, (err, token) => resolve({ err, token })));

  const ok = fakeSftp({ [AGENT_TOKEN_PATH]: `${TOKEN}\n` });
  assert.deepEqual(await read(ok), { err: null, token: TOKEN });
  assert.equal(ok.closed, 1);

  const missing = await read(fakeSftp({}));
  assert.equal(missing.err.message, 'agent token file not readable');

  const bad = fakeSftp({ [AGENT_TOKEN_PATH]: 'not-a-token' });
  const malformed = await read(bad);
  assert.equal(malformed.err.message, 'agent token file is malformed');
  assert.ok(!malformed.err.message.includes('not-a-token'));
  assert.equal(bad.closed, 1);
});

test('watch announces the agent after the handshake and withdraws it on drop or close (SAA-300)', async () => {
  const events = [];
  const { agent, watch } = harness({ onAgent: (hello) => events.push(['up', hello.mode, hello.version]), onAgentLost: () => events.push(['down']) });
  watch.watch('/home/me');
  await settle();
  assert.deepEqual(events, [['up', 'persistent', '0.1.0']]);
  agent.drop();
  await settle();
  assert.deepEqual(events, [['up', 'persistent', '0.1.0'], ['down']]);
  watch.close();
  assert.equal(events.length, 2, 'no second withdrawal for an agent already gone');
});

test('a rejected handshake never announces the agent (SAA-300)', async () => {
  const events = [];
  const { watch } = harness({ tokenFile: 'b'.repeat(64), onAgent: () => events.push('up'), onAgentLost: () => events.push('down') });
  watch.watch('/home/me');
  await settle();
  assert.deepEqual(events, []);
  watch.close();
});
