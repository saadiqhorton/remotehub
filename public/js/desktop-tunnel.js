// RemoteHub adapter for the official Apache Guacamole 1.6.0 Tunnel API.
// The server's bridge requires a credentials instruction as the first WebSocket frame,
// while Guacamole.WebSocketTunnel uses a separate UUID/protocol handshake. This adapter
// preserves RemoteHub's credentials-first contract and delegates instruction parsing to
// Apache's Guacamole.Parser and all protocol behavior to Guacamole.Client.
export const DESKTOP_CLOSE = Object.freeze({ NORMAL: 1000, REMOTE_ERROR: 1011, AUTH: 4401, ORIGIN: 4403, UNAVAILABLE: 4404, CERT_CHANGED: 4409, CERT_UNAVAILABLE: 4410, BACKEND_LOST: 4502, BACKEND_DOWN: 4503 });

export function desktopTunnelUrl({ host, width, height, dpi = 96, fixed = false, traceId, attempt, attemptCause, location = globalThis.location }) {
  if (!location?.host) throw new Error('Desktop tunnel needs a page location');
  const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const params = new URLSearchParams({ hostId: host.id, width: String(Math.round(width)), height: String(Math.round(height)), dpi: String(dpi) });
  if (fixed) params.set('fixed', '1');
  if (typeof traceId === 'string' && /^[a-z0-9-]{8,64}$/i.test(traceId)) params.set('traceId', traceId);
  if (Number.isSafeInteger(attempt) && attempt > 0) params.set('attempt', String(attempt));
  if (['user', 'auto-retry', 'resize-fallback'].includes(attemptCause)) params.set('attemptCause', attemptCause);
  return `${scheme}//${location.host}/ws/desktop?${params}`;
}

// This factory returns a true Apache Tunnel subclass instance while resolving the
// official base class only when needed. Other modules can import this file before
// index.html's classic vendor script has initialized globalThis.Guacamole.
export function RemoteHubTunnel(options = {}) {
  const Guac = options.Guac ?? globalThis.Guacamole;
  if (!Guac?.Tunnel) throw new Error('Apache Guacamole common-js must be loaded before creating a desktop tunnel');

  class AdapterTunnel extends Guac.Tunnel {
    constructor({ url, WebSocketImpl = globalThis.WebSocket, password = '' }) {
      super();
      // Guacamole.Tunnel installs abstract no-op methods as own properties, so restore
      // this adapter's concrete methods after initializing the official tunnel state.
      for (const name of ['connect', 'disconnect', 'sendMessage']) this[name] = AdapterTunnel.prototype[name].bind(this);
      this.url = url;
      this.password = password;
      this.WebSocketImpl = WebSocketImpl;
      this.Guac = Guac;
      this.socket = null;
      this.opened = false;
      this.localCloseMetadata = null;
      this.onclose = null; // RemoteHub lifecycle metadata, in addition to Tunnel's status callbacks.
      this.onrawinstruction = null; // observation hook; Guacamole.Client remains the instruction owner.
    }

    connect() {
      if (this.socket) return;
      const socket = new this.WebSocketImpl(this.url);
      this.socket = socket;
      this.setState(this.Guac.Tunnel.State.CONNECTING);
      socket.onopen = () => {
        if (this.socket !== socket) return;
        this.opened = true;
        const password = this.password;
        this.password = '';
        socket.send(password
          ? this.Guac.Parser.toInstruction(['credentials', 'password', password])
          : this.Guac.Parser.toInstruction(['credentials']));
        this.setState(this.Guac.Tunnel.State.OPEN);
      };
      const parser = new this.Guac.Parser();
      parser.oninstruction = (opcode, args) => {
        if (opcode === 'error' || opcode === 'disconnect') this.remoteClosing = true;
        const accepted = this.onrawinstruction?.(opcode, args);
        if (accepted !== false) this.oninstruction?.(opcode, args);
      };
      socket.onmessage = (event) => {
        try {
          if (typeof event.data !== 'string') throw new Error('Desktop tunnel received a binary frame');
          parser.receive(event.data);
        } catch (error) {
          this.onerror?.(new this.Guac.Status(this.Guac.Status.Code.CLIENT_BAD_REQUEST, error?.message || 'Malformed Guacamole instruction'));
          // Browser WebSocket.close() rejects reserved protocol codes (including 1007).
          // Preserve RemoteHub's public 1007 meaning while using a valid private wire code.
          this.localCloseMetadata = { code: 1007, reason: 'Malformed Guacamole instruction', opened: this.opened === true };
          this.close(3000, 'malformed instruction');
        }
      };
      socket.onerror = () => this.onerror?.(new this.Guac.Status(this.Guac.Status.Code.UPSTREAM_NOT_FOUND, 'Desktop connection error'));
      socket.onclose = (event) => {
        if (this.socket !== socket) return;
        this.socket = null;
        const metadata = this.localCloseMetadata || { code: event.code, reason: event.reason || '', opened: this.opened === true };
        this.localCloseMetadata = null;
        this.setState(this.Guac.Tunnel.State.CLOSED);
        if (event.code !== 1000) {
          const code = event.code === 1011 ? this.Guac.Status.Code.SERVER_ERROR
            : event.code === 1006 ? this.Guac.Status.Code.UPSTREAM_NOT_FOUND
              : this.Guac.Status.Code.CLIENT_BAD_REQUEST;
          this.onerror?.(new this.Guac.Status(code, event.reason || 'Desktop connection closed'));
        }
        this.onclose?.(metadata);
      };
    }

    sendMessage(...elements) {
      if (this.remoteClosing && elements[0] === 'disconnect') return;
      if (this.socket?.readyState === 1) this.socket.send(this.Guac.Parser.toInstruction(elements));
    }

    disconnect() {
      // Guacamole.Client disconnects itself as soon as it parses an `error` instruction.
      // The bridge sends its authoritative 1011/4409/etc close immediately afterward;
      // do not send a competing `disconnect` frame or close the socket first.
      if (this.remoteClosing) return;
      this.close(1000, 'client disconnect');
    }

    close(code = 1000, reason = 'client disconnect') {
      const socket = this.socket;
      this.password = '';
      if (!socket) return;
      try { socket.close(code, reason); } catch { /* already closed */ }
    }
  }

  return new AdapterTunnel(options);
}

export function createWebSocketTunnel(options) {
  return new RemoteHubTunnel({ url: desktopTunnelUrl(options), password: options.password });
}
