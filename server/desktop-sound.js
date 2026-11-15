// Desktop sound from the computer's own RemoteHub agent.
//
// RDP carries sound only when the remote computer's RDP server sends it, and VNC never
// does. The persistent agent (agent/README.md) records what the computer is playing with
// the recorder its sound server ships (`audio.start`), so a Desktop tab hears the computer
// however the picture travels, with no Terminal or Files tab and no password.
//
// One SoundHub per server. Each Desktop tab opens /ws/desktop-sound?hostId=...; the hub
// asks that host's agent to start capture when the first tab listens and to stop when the
// last one leaves, and forwards each 20 ms of PCM to every listening tab as a binary
// frame. Status goes to the tab as JSON text:
//   {type:'format', mimetype}      sound follows in this format
//   {type:'waiting', reason}       no agent connected for this computer (yet)
//   {type:'unavailable', reason}   the agent can't capture sound here; reason says why
// Sound is output only: nothing the tab sends is forwarded to the agent.

export const SOUND_CLOSE = Object.freeze({ ORIGIN: 4403, AUTH: 4401, UNKNOWN_HOST: 4404 });
export const AUDIO_CAPTURE_OP = 'audio.capture';
const MAX_BASE64_CHUNK = 64 * 1024; // 20 ms is 5120 base64 characters; anything far larger is not sound

export class SoundHub {
  constructor({ registry, log = () => {}, startTimeoutMs = 10000, retryMs = 5000 }) {
    this.registry = registry;
    this.log = log;
    this.startTimeoutMs = startTimeoutMs; // an agent busy with a long request may not answer in time
    this.retryMs = retryMs;
    this.hosts = new Map(); // hostId -> { listeners: Set<ws>, state: 'idle'|'starting'|'streaming', mimetype }
    // On connect, wait one tick: the bridge sends the agent its `authenticated` event right
    // after registering it, and the agent ignores requests that arrive before that event.
    registry.observe?.((hostId, connected) => (connected ? setImmediate(() => this.agentConnected(hostId)) : this.agentGone(hostId)));
  }

  // A new agent connection, possibly replacing a live one (the registry closes the old one
  // without a separate "gone"): capture state belongs to a connection, so start afresh.
  agentConnected(hostId) {
    const entry = this.hosts.get(hostId);
    if (entry) { entry.state = 'idle'; entry.agent = null; clearTimeout(entry.retry); }
    this.sync(hostId);
  }

  entry(hostId) {
    let entry = this.hosts.get(hostId);
    if (!entry) { entry = { listeners: new Set(), state: 'idle', mimetype: null }; this.hosts.set(hostId, entry); }
    return entry;
  }

  /** A Desktop tab listening for `hostId`'s sound. */
  attach(ws, hostId) {
    const entry = this.entry(hostId);
    entry.listeners.add(ws);
    ws.on('message', () => {}); // output only: the tab has nothing to say
    ws.on('close', () => { entry.listeners.delete(ws); this.sync(hostId); });
    ws.on('error', () => {});
    if (entry.state === 'streaming') send(ws, { type: 'format', mimetype: entry.mimetype });
    if (entry.state === 'unavailable') send(ws, { type: 'unavailable', reason: entry.reason });
    this.sync(hostId);
  }

  /** Start or stop capture so it runs exactly while someone listens and the agent can capture. */
  sync(hostId) {
    const entry = this.hosts.get(hostId);
    if (!entry) return;
    const agent = this.registry.get(hostId);
    const connected = Boolean(agent && agent.ws.readyState === agent.ws.OPEN);
    if (!entry.listeners.size) {
      if (entry.state !== 'idle' && connected) agent.request('audio.stop', {}, 5000).catch(() => {});
      entry.state = 'idle';
      clearTimeout(entry.retry);
      this.hosts.delete(hostId);
      return;
    }
    if (entry.state !== 'idle') return;
    if (!connected) return this.broadcast(entry, { type: 'waiting', reason: 'no-agent' });
    if (!agent.hello?.operations?.includes(AUDIO_CAPTURE_OP)) {
      return this.unavailable(entry, 'The RemoteHub agent on this computer can’t capture sound yet. Update it to the latest version.');
    }
    entry.state = 'starting';
    entry.agent = agent; // replies from any other (older) connection are ignored
    agent.request('audio.start', {}, this.startTimeoutMs).then((reply) => {
      if (this.hosts.get(hostId) !== entry || entry.agent !== agent || entry.state !== 'starting') return;
      if (reply?.ok && typeof reply.result?.mimetype === 'string') {
        entry.state = 'streaming';
        entry.mimetype = reply.result.mimetype;
        this.log(`desktop sound started host=${hostId}`);
        this.broadcast(entry, { type: 'format', mimetype: entry.mimetype });
      } else {
        this.unavailable(entry, describeFailure(reply?.error?.message));
      }
    }).catch(() => {
      if (this.hosts.get(hostId) !== entry || entry.agent !== agent) return;
      entry.state = 'idle';
      if (this.registry.get(hostId) !== agent) return; // the agent went away; agentGone/agentConnected take it from here
      // Still connected but no answer (busy with a long request, say): tell the tabs, try again.
      this.broadcast(entry, { type: 'unavailable', reason: 'The computer’s RemoteHub agent didn’t answer the sound request. Trying again…' });
      clearTimeout(entry.retry);
      entry.retry = setTimeout(() => { if (this.hosts.get(hostId) === entry && entry.state === 'idle') this.sync(hostId); }, this.retryMs);
      entry.retry.unref?.();
    });
  }

  agentGone(hostId) {
    const entry = this.hosts.get(hostId);
    if (!entry) return;
    entry.state = 'idle';
    entry.agent = null;
    this.broadcast(entry, { type: 'waiting', reason: 'no-agent' });
  }

  /** An unsolicited agent message (`audio` or `audioEnd`). Returns true if it was sound. */
  agentEvent(hostId, message) {
    if (message?.event !== 'audio' && message?.event !== 'audioEnd') return false;
    const entry = this.hosts.get(hostId);
    if (!entry || entry.state !== 'streaming') return true;
    if (message.event === 'audioEnd') {
      this.log(`desktop sound ended host=${hostId}`);
      this.unavailable(entry, describeFailure(message.reason));
      return true;
    }
    if (typeof message.data !== 'string' || message.data.length > MAX_BASE64_CHUNK) return true;
    const pcm = Buffer.from(message.data, 'base64');
    if (!pcm.length) return true;
    for (const ws of entry.listeners) {
      // A tab that can't keep up skips sound rather than buffering it without bound.
      if (ws.readyState === ws.OPEN && ws.bufferedAmount < 256 * 1024) ws.send(pcm, { binary: true });
    }
    return true;
  }

  // Remembered until every tab for this computer leaves; a tab that joins later is told too.
  unavailable(entry, reason) {
    entry.state = 'unavailable';
    entry.reason = reason;
    this.broadcast(entry, { type: 'unavailable', reason });
  }

  broadcast(entry, message) {
    for (const ws of entry.listeners) send(ws, message);
  }
}

function send(ws, message) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
}

// Plain words for why the agent couldn't capture; the agent's own text is kept short.
function describeFailure(detail) {
  const text = String(detail ?? '').trim().slice(0, 200);
  if (/no pipewire or pulseaudio/i.test(text)) return 'No sound system is running for this computer’s signed-in user, so there’s no sound to capture.';
  if (/not available on this platform/i.test(text)) return 'Sound capture isn’t available on this computer’s system yet.';
  return text ? `The computer’s sound stopped: ${text}` : 'The computer’s sound stopped.';
}
