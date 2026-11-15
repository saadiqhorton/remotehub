// Remote sound for one Desktop tab. Two sources feed it raw PCM (audio/L8 or audio/L16):
//  - guacd's sound stream on RDP (see server/desktop-bridge.js BROWSER_AUDIO_TYPES), and
//  - the computer's RemoteHub agent over /ws/desktop-sound (server/desktop-sound.js).
// It plays them through Web Audio like the bundled Guacamole.RawAudioPlayer, with one
// difference: every chunk scheduled for playback is tracked per player, so muting this
// tab, or switching from one source to the other, silences sound already queued.

// Same latency cap as Guacamole.RawAudioPlayer.sync(): never schedule further ahead than this.
export const MAX_SCHEDULE_AHEAD_S = 0.3;
// Pushed sound (the agent) starts this far ahead, to ride out network jitter between chunks.
export const PUSH_START_DELAY_S = 0.06;

function decodeS16le(data) {
  const bytes = new DataView(data);
  const samples = new Int16Array(Math.floor(data.byteLength / 2));
  for (let i = 0; i < samples.length; i++) samples[i] = bytes.getInt16(i * 2, true);
  return samples;
}

export class DesktopAudio {
  constructor({ getContext = () => globalThis.Guacamole?.AudioContextFactory?.getAudioContext?.() ?? null, muted = false } = {}) {
    this.getContext = getContext;
    this.muted = muted;
    this.players = new Set();
  }

  /**
   * A Guacamole audio player for guacd's `stream`, or null if the format or Web Audio is
   * unavailable. `onData` is called once, with the first sound received.
   */
  play(Guac, stream, mimetype, { onData = null } = {}) {
    const player = this.player(Guac, mimetype);
    if (!player) return null;
    const reader = new Guac.ArrayBufferReader(stream);
    let heard = false;
    reader.ondata = (data) => {
      if (!heard) { heard = true; onData?.(); }
      player.schedule(data);
    };
    reader.onend = () => this.players.delete(player);
    return player;
  }

  /** A player fed by `push(arrayBuffer)` (the agent's sound), or null if unavailable. */
  playPcm(Guac, mimetype) {
    const player = this.player(Guac, mimetype, { littleEndian: true });
    if (!player) return null;
    return {
      push: (data) => player.schedule(data, { pushed: true }),
      stop: () => { player.stop(); this.players.delete(player); },
    };
  }

  player(Guac, mimetype, { littleEndian = false } = {}) {
    const format = Guac?.RawAudioFormat?.parse?.(mimetype);
    const context = format && this.getContext();
    if (!context) return null;
    const scale = format.bytesPerSample === 1 ? 128 : 32768;
    const sources = new Set(); // scheduled or playing AudioBufferSourceNodes
    let next = 0; // context time at which the next chunk starts
    const player = {
      sync: () => { next = Math.min(next, context.currentTime + MAX_SCHEDULE_AHEAD_S); },
      schedule: (data, { pushed = false } = {}) => {
        if (this.muted) return; // dropped, not queued: unmuting is live
        const now = context.currentTime;
        if (pushed) {
          // Pushed sound has no sync instruction: start a little ahead after a gap, and skip
          // a chunk rather than let delay build up when sound arrives faster than it plays.
          if (next < now) next = now + PUSH_START_DELAY_S;
          if (next > now + MAX_SCHEDULE_AHEAD_S) return;
        }
        const samples = format.bytesPerSample === 1
          ? new Int8Array(data)
          : littleEndian ? decodeS16le(data) : new Int16Array(data, 0, Math.floor(data.byteLength / 2));
        const frames = Math.floor(samples.length / format.channels);
        if (!frames) return;
        const buffer = context.createBuffer(format.channels, frames, format.rate);
        for (let channel = 0; channel < format.channels; channel++) {
          const out = buffer.getChannelData(channel);
          for (let i = 0, j = channel; i < frames; i++, j += format.channels) out[i] = samples[j] / scale;
        }
        const source = context.createBufferSource();
        source.buffer = buffer;
        source.connect(context.destination);
        source.onended = () => sources.delete(source);
        next = Math.max(next, now);
        source.start(next);
        next += frames / format.rate;
        sources.add(source);
      },
      /** Silence everything this player queued; it resumes at "now", not a stale future time. */
      stop: () => {
        for (const source of sources) {
          try { source.stop(); } catch { /* already ended */ }
          try { source.disconnect(); } catch { /* already disconnected */ }
        }
        sources.clear();
        next = 0;
      },
    };
    this.players.add(player);
    return player;
  }

  /** Mute stops everything already scheduled; new sound is dropped until unmuted. */
  setMuted(muted) {
    this.muted = muted;
    if (muted) this.stopAll();
  }

  stopAll() {
    for (const player of this.players) player.stop();
  }
}
