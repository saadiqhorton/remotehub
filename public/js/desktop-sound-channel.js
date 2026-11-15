// The Desktop tab's line to the computer's own sound, recorded by its RemoteHub agent
// (server/desktop-sound.js). Status arrives as JSON text, sound as binary PCM.
// While the tab wants sound the channel stays open and reopens after a drop, so sound
// resumes on its own when the agent (or RemoteHub) comes back.

export const SOUND_CHANNEL_RETRY_MS = 3000;
// Close codes that retrying cannot fix (server/desktop-sound.js SOUND_CLOSE).
const FINAL_CLOSES = new Set([4401, 4403, 4404]);

export function desktopSoundUrl(hostId, location = globalThis.location) {
  if (!location?.host) throw new Error('Desktop sound needs a page location');
  const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${scheme}//${location.host}/ws/desktop-sound?${new URLSearchParams({ hostId })}`;
}

export class AgentSoundChannel {
  constructor({ hostId, onStatus = () => {}, onPcm = () => {}, WebSocketImpl = globalThis.WebSocket, location = globalThis.location, retryMs = SOUND_CHANNEL_RETRY_MS }) {
    Object.assign(this, { hostId, onStatus, onPcm, WebSocketImpl, location, retryMs });
    this.socket = null;
    this.wanted = false;
    this.retryTimer = null;
  }

  open() {
    this.wanted = true;
    if (this.socket || this.retryTimer) return;
    let url;
    try { url = desktopSoundUrl(this.hostId, this.location); }
    catch { return this.onStatus({ type: 'closed', code: 0 }); } // no page address: retrying can't help
    let socket;
    try { socket = new this.WebSocketImpl(url); }
    catch { return this.retry(); }
    socket.binaryType = 'arraybuffer';
    this.socket = socket;
    socket.onmessage = (event) => {
      if (this.socket !== socket) return;
      if (typeof event.data === 'string') {
        let status;
        try { status = JSON.parse(event.data); } catch { return; }
        if (status && typeof status.type === 'string') this.onStatus(status);
      } else if (event.data instanceof ArrayBuffer) {
        this.onPcm(event.data);
      }
    };
    socket.onclose = (event) => {
      if (this.socket !== socket) return;
      this.socket = null;
      if (!this.wanted) return;
      if (FINAL_CLOSES.has(event?.code)) return this.onStatus({ type: 'closed', code: event.code });
      this.onStatus({ type: 'waiting', reason: 'reconnecting' });
      this.retry();
    };
    socket.onerror = () => {};
  }

  retry() {
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => { this.retryTimer = null; if (this.wanted) this.open(); }, this.retryMs);
    this.retryTimer.unref?.(); // never the only thing keeping a process alive (tests, Node)
  }

  close() {
    this.wanted = false;
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
    const socket = this.socket;
    this.socket = null;
    if (socket) { try { socket.close(1000); } catch { /* already closed */ } }
  }
}
