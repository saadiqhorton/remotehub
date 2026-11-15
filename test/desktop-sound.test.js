import { test, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { makeDocument } from './helpers/fake-dom.js';
import { stubTunnelFactory } from './helpers/desktop-stub-tunnel.js';
import { DesktopSession } from '../public/js/desktop-session.js';
import { AgentSoundChannel, desktopSoundUrl } from '../public/js/desktop-sound-channel.js';
import { MAX_SCHEDULE_AHEAD_S, PUSH_START_DELAY_S } from '../public/js/desktop-audio.js';

// Remote sound: guacd's raw PCM stream plays through the tab's DesktopAudio
// (public/js/desktop-audio.js) on the shared Web Audio context. Node has no Web Audio, so
// these tests use a fake context and the real Guacamole stream, parser and format code.

const sessions = [];
let restore = [];
afterEach(() => {
  for (const s of sessions.splice(0)) s.dispose();
  for (const undo of restore.splice(0)) undo();
});

function stubGlobal(name, value) {
  const had = Object.prototype.hasOwnProperty.call(globalThis, name);
  const before = globalThis[name];
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  restore.push(() => { if (had) globalThis[name] = before; else delete globalThis[name]; });
}

function fakeAudio() {
  const Guac = globalThis.Guacamole;
  const sources = [];
  const buffers = [];
  const context = {
    state: 'suspended', currentTime: 0, destination: { name: 'speakers' }, resumes: 0,
    resume() { this.resumes += 1; this.state = 'running'; return Promise.resolve(); },
    createBuffer(channels, frames, rate) {
      const data = Array.from({ length: channels }, () => new Float32Array(frames));
      const buffer = { channels, frames, rate, getChannelData: (i) => data[i] };
      buffers.push(buffer);
      return buffer;
    },
    createBufferSource() {
      const source = { startedAt: null, stopped: false, to: null, connect(to) { this.to = to; }, disconnect() {}, start(at) { this.startedAt = at; }, stop() { this.stopped = true; } };
      sources.push(source);
      return source;
    },
  };
  let contexts = 0;
  const RealFactory = Guac.AudioContextFactory.getAudioContext;
  Guac.AudioContextFactory.getAudioContext = () => { contexts += 1; return context; };
  restore.push(() => { Guac.AudioContextFactory.getAudioContext = RealFactory; });
  return { context, sources, buffers, contexts: () => contexts };
}

function memoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return { getItem: (k) => (map.has(k) ? map.get(k) : null), setItem: (k, v) => map.set(k, String(v)), map };
}

// Little-endian signed 16-bit PCM, base64, as guacd sends it.
const pcm16 = (...samples) => {
  const bytes = Buffer.alloc(samples.length * 2);
  samples.forEach((v, i) => bytes.writeInt16LE(v, i * 2));
  return bytes.toString('base64');
};

// Stands in for the agent sound channel (/ws/desktop-sound); records how the tab drives it.
function fakeChannels() {
  const made = [];
  const create = (options) => {
    const channel = { options, opened: 0, closed: 0, open() { this.opened += 1; }, close() { this.closed += 1; },
      status(status) { options.onStatus(status); }, pcm(bytes) { options.onPcm(bytes); } };
    made.push(channel);
    return channel;
  };
  return { made, create, last: () => made.at(-1), live: () => made.filter((c) => c.opened > c.closed) };
}

async function ready({ protocol = 'vnc', storage = memoryStorage(), channels = fakeChannels() } = {}) {
  globalThis.document = makeDocument();
  stubGlobal('localStorage', storage);
  const factory = stubTunnelFactory();
  const audio = fakeAudio();
  const s = new DesktopSession({
    host: { id: `sound-${protocol}`, name: 'Box', address: 'localhost', desktop: { protocol, port: protocol === 'rdp' ? 3389 : 5900 } },
    createTunnel: factory,
    createSoundChannel: channels.create,
    clipboard: null,
  });
  sessions.push(s);
  s.mount(document.createElement('div')); s.show();
  s.viewport.clientWidth = 800; s.viewport.clientHeight = 600;
  s.connect();
  const t = factory.last();
  t.receive('ready', '$id');
  t.receive('size', '0', '800', '600');
  t.receive('rect', '0', '0', '0', '8', '8');
  t.receive('cfill', '14', '0', '0', '0', '0', '255');
  t.receive('sync', '1');
  await new Promise((resolve) => s.display.flush(resolve));
  return { s, t, audio, storage, channels };
}

const pointer = (s) => s.pane.dispatchEvent({ type: 'pointerdown', preventDefault() {}, stopPropagation() {} });

test('a sound stream is accepted, decoded to the right samples, and played back to back', async () => {
  const { s, t, audio } = await ready();
  assert.equal(s.soundButton.hidden, false, 'every desktop can have sound (RDP or its agent), so the toggle shows');
  t.receive('audio', '3', 'audio/L16;rate=44100,channels=2');
  assert.deepEqual(t.ops('ack').at(-1), ['ack', '3', 'OK', '0'], 'Guacamole accepts the stream');
  t.receive('blob', '3', pcm16(16384, -16384, 0, 32767));
  assert.equal(audio.buffers.length, 1);
  const [buffer] = audio.buffers;
  assert.deepEqual([buffer.channels, buffer.frames, buffer.rate], [2, 2, 44100]);
  assert.deepEqual([...buffer.getChannelData(0)], [0.5, 0], 'left channel, interleaved samples split');
  assert.deepEqual([...buffer.getChannelData(1)], [-0.5, 32767 / 32768], 'right channel');
  assert.equal(audio.sources[0].to, audio.context.destination);
  assert.equal(audio.sources[0].startedAt, 0);
  t.receive('blob', '3', pcm16(1, 1, 1, 1));
  assert.equal(audio.sources[1].startedAt, 2 / 44100, 'the next chunk starts where the last ends');
  assert.equal(s.soundButton.hidden, false);
  assert.equal(s.soundButton.textContent, 'Sound on');
  assert.equal(s.pane.getAttribute('data-sound'), '');
});

test('muting stops sound already scheduled, drops new sound, and is remembered in this browser', async () => {
  const { s, t, audio, storage } = await ready();
  t.receive('audio', '3', 'audio/L16;rate=100,channels=1');
  for (let i = 0; i < 5; i++) t.receive('blob', '3', pcm16(...Array(10).fill(1000))); // 0.5 s queued ahead
  assert.equal(audio.sources.length, 5);
  assert.equal(audio.sources.some((x) => x.stopped), false);
  s.soundButton.dispatchEvent({ type: 'click' });
  assert.equal(s.soundButton.textContent, 'Sound off');
  assert.equal(storage.map.get('rh-desktop-sound'), 'off');
  assert.ok(audio.sources.every((x) => x.stopped), 'every queued chunk is stopped at once');
  t.receive('blob', '3', pcm16(...Array(10).fill(1000)));
  assert.equal(audio.sources.length, 5, 'nothing new plays or piles up while muted');
  s.soundButton.dispatchEvent({ type: 'click' });
  assert.equal(storage.map.get('rh-desktop-sound'), 'on');
  audio.context.currentTime = 0.05;
  t.receive('blob', '3', pcm16(...Array(10).fill(1000)));
  assert.equal(audio.sources.length, 6);
  assert.equal(audio.sources[5].startedAt, 0.05, 'unmuted sound starts now, not after the stopped queue');
});

test('sync caps how far ahead sound is scheduled, like Guacamole’s own player', async () => {
  const { t, audio } = await ready();
  t.receive('audio', '3', 'audio/L16;rate=100,channels=1');
  for (let i = 0; i < 10; i++) t.receive('blob', '3', pcm16(...Array(10).fill(1))); // 1 s queued
  t.receive('sync', '2');
  await new Promise((resolve) => setTimeout(resolve, 20)); // Guacamole syncs audio after the display flush
  t.receive('blob', '3', pcm16(...Array(10).fill(1)));
  assert.equal(audio.sources.at(-1).startedAt, 0.3);
});

test('disconnecting stops any sound still queued', async () => {
  const { s, t, audio } = await ready();
  t.receive('audio', '3', 'audio/L16;rate=100,channels=1');
  t.receive('blob', '3', pcm16(...Array(10).fill(1)));
  s.disconnect();
  assert.equal(audio.sources[0].stopped, true);
});

test('a browser that turned sound off starts muted and plays nothing', async () => {
  const { s, t, audio } = await ready({ storage: memoryStorage({ 'rh-desktop-sound': 'off' }) });
  assert.equal(s.soundOn, false);
  t.receive('audio', '3', 'audio/L16;rate=100,channels=1');
  t.receive('blob', '3', pcm16(1, 2, 3));
  assert.equal(audio.sources.length, 0);
});

test('blocked storage still plays sound', async () => {
  const { s } = await ready({ storage: { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } } });
  assert.equal(s.soundOn, true);
  s.toggleSound();
  assert.equal(s.soundOn, false, 'the toggle still works for this page');
});

test('an unsupported sound format is refused', async () => {
  const { t, audio } = await ready();
  t.receive('audio', '4', 'audio/ogg');
  assert.deepEqual(t.ops('ack').at(-1), ['ack', '4', 'BAD TYPE', '783']);
  t.receive('blob', '4', 'AAAA');
  assert.equal(audio.sources.length, 0);
});

test('a click unlocks suspended sound on any desktop, unless sound is off', async () => {
  for (const protocol of ['rdp', 'vnc']) {
    const { s, audio } = await ready({ protocol });
    assert.equal(s.pane.getAttribute('data-sound'), '', `${protocol}: the Sound toggle's place is reserved from the start`);
    pointer(s);
    assert.equal(audio.context.resumes, 1, `${protocol}: a user gesture resumes the suspended context`);
    pointer(s);
    assert.equal(audio.context.resumes, 1, 'only while suspended');
    s.dispose(); sessions.splice(sessions.indexOf(s), 1);
  }
  const muted = await ready({ storage: memoryStorage({ 'rh-desktop-sound': 'off' }) });
  pointer(muted.s);
  assert.equal(muted.audio.contexts(), 0, 'sound off: nothing is created');
});

// ── the computer's own sound through its RemoteHub agent ─────────────────────────

test('a ready desktop asks for its agent sound, and the button says why there is none', async () => {
  const { s, channels } = await ready();
  assert.equal(channels.live().length, 1, 'one agent sound channel, opened when the desktop is ready');
  assert.equal(channels.last().options.hostId, s.host.id);
  assert.equal(s.soundButton.textContent, 'Sound on', 'nothing known yet');
  channels.last().status({ type: 'waiting', reason: 'no-agent' });
  assert.equal(s.soundButton.textContent, 'No sound');
  assert.match(s.soundButton.getAttribute('aria-label'), /RemoteHub agent isn’t connected/);
  channels.last().status({ type: 'unavailable', reason: 'No sound system is running for this computer’s signed-in user, so there’s no sound to capture.' });
  assert.match(s.soundButton.title, /No sound system is running/);
});

test('agent PCM is decoded as little-endian regardless of browser byte order', async () => {
  const { audio, channels } = await ready();
  channels.last().status({ type: 'format', mimetype: 'audio/L16;rate=100,channels=1' });
  // Deliberately use bytes instead of pcm16() so the expected byte order is explicit.
  const bytes = new Uint8Array([0x34, 0x12, 0xcc, 0xed]);
  channels.last().pcm(bytes.buffer);
  assert.deepEqual([...audio.buffers[0].getChannelData(0)], [0x1234 / 32768, -0x1234 / 32768]);
});

test('agent sound plays through the tab, ahead by a jitter margin and never far behind', async () => {
  const { t, audio, channels } = await ready();
  channels.last().status({ type: 'format', mimetype: 'audio/L16;rate=100,channels=1' });
  audio.context.currentTime = 1;
  const chunk = () => new Uint8Array(Buffer.from(pcm16(...Array(5).fill(16384)), 'base64')).buffer; // 50 ms
  channels.last().pcm(chunk());
  assert.equal(audio.sources.length, 1);
  assert.equal(audio.sources[0].startedAt, 1 + PUSH_START_DELAY_S, 'starts a little ahead to ride out jitter');
  assert.deepEqual([...audio.buffers[0].getChannelData(0)], [0.5, 0.5, 0.5, 0.5, 0.5]);
  for (let i = 0; i < 20; i++) channels.last().pcm(chunk()); // a burst: 1 s of sound at once
  const latest = Math.max(...audio.sources.map((x) => x.startedAt));
  assert.ok(latest <= 1 + MAX_SCHEDULE_AHEAD_S, `a burst is trimmed, never queued far ahead (latest ${latest})`);
  assert.ok(audio.sources.length < 21, 'the excess was dropped');
  assert.equal(t.ops('audio').length, 0, 'nothing is ever sent back toward the computer');
});

test('when RDP itself delivers sound, the agent copy stops so nothing plays twice', async () => {
  const { s, t, audio, channels } = await ready({ protocol: 'rdp' });
  const agent = channels.last();
  agent.status({ type: 'format', mimetype: 'audio/L16;rate=100,channels=1' });
  agent.pcm(new Uint8Array(Buffer.from(pcm16(1, 1, 1), 'base64')).buffer);
  assert.equal(audio.sources.length, 1);
  t.receive('audio', '3', 'audio/L16;rate=100,channels=1');
  assert.equal(agent.closed, 0, 'an open RDP stream alone proves nothing (stock xrdp opens one that never sends sound)');
  t.receive('blob', '3', pcm16(2, 2, 2));
  assert.equal(agent.closed, 1, 'RDP sound arrived: the agent channel closes');
  assert.equal(audio.sources[0].stopped, true, 'and its queued sound stops');
  assert.equal(s.soundButton.textContent, 'Sound on');
  assert.equal(channels.live().length, 0);
});

test('mute closes the agent channel (the computer stops recording); unmute reopens it', async () => {
  const { s, channels } = await ready();
  s.soundButton.dispatchEvent({ type: 'click' });
  assert.equal(channels.live().length, 0, 'muted: no channel');
  s.soundButton.dispatchEvent({ type: 'click' });
  assert.equal(channels.live().length, 1, 'unmuted: a fresh channel');
  assert.equal(channels.made.length, 2);
});

test('disconnecting or closing the tab closes the agent channel', async () => {
  const first = await ready();
  first.s.disconnect();
  assert.equal(first.channels.live().length, 0);
  const second = await ready();
  second.s.dispose(); sessions.splice(sessions.indexOf(second.s), 1);
  assert.equal(second.channels.live().length, 0);
});

// ── AgentSoundChannel ─────────────────────────────────────────────────────────

class FakeSocket {
  static made = [];
  constructor(url) { this.url = url; this.closedWith = null; FakeSocket.made.push(this); }
  close(code) { this.closedWith = code; }
}

test('the sound channel reads status and PCM, reconnects after a drop, and stops for good on refusals', () => {
  FakeSocket.made = [];
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const seen = [];
    const pcmSeen = [];
    const channel = new AgentSoundChannel({ hostId: 'h 1', WebSocketImpl: FakeSocket, location: { protocol: 'https:', host: 'hub.test' },
      onStatus: (status) => seen.push(status), onPcm: (data) => pcmSeen.push(data) });
    assert.equal(desktopSoundUrl('h 1', { protocol: 'https:', host: 'hub.test' }), 'wss://hub.test/ws/desktop-sound?hostId=h+1');
    channel.open();
    const [socket] = FakeSocket.made;
    assert.equal(socket.binaryType, 'arraybuffer');
    socket.onmessage({ data: JSON.stringify({ type: 'format', mimetype: 'audio/L16;rate=48000,channels=2' }) });
    socket.onmessage({ data: new ArrayBuffer(8) });
    socket.onmessage({ data: 'not json' });
    assert.deepEqual(seen, [{ type: 'format', mimetype: 'audio/L16;rate=48000,channels=2' }]);
    assert.equal(pcmSeen.length, 1);
    socket.onclose({ code: 1006 });
    assert.deepEqual(seen.at(-1), { type: 'waiting', reason: 'reconnecting' });
    mock.timers.tick(3000);
    assert.equal(FakeSocket.made.length, 2, 'reopened after a drop');
    FakeSocket.made[1].onclose({ code: 4401 });
    mock.timers.tick(10000);
    assert.equal(FakeSocket.made.length, 2, 'a refusal (logged out) is final');
    assert.deepEqual(seen.at(-1), { type: 'closed', code: 4401 });
    channel.open();
    channel.close();
    assert.equal(FakeSocket.made.at(-1).closedWith, 1000);
    FakeSocket.made.at(-1).onclose({ code: 1000 });
    mock.timers.tick(10000);
    assert.equal(FakeSocket.made.length, 3, 'closing on purpose never reopens');
  } finally { mock.timers.reset(); }
});
