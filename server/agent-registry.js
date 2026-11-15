// In-memory connected-agent map. Persistence is the hashed credential on the host;
// "connected" is a live WebSocket and must not be written to disk.

// One MiB of control characters expands to at most six MiB in JSON, plus the bounded request envelope.
const MAX_AGENT_FRAME_BYTES = 7 * 1024 * 1024;

export class AgentRegistry {
  constructor() {
    this.connections = new Map();
    this.nextRequestId = 1;
    this.observers = new Set();
  }

  /** Call `fn(hostId, connected)` whenever a host's agent connects or goes away. */
  observe(fn) {
    this.observers.add(fn);
    return () => this.observers.delete(fn);
  }

  notify(hostId, connected) {
    for (const fn of this.observers) {
      try { fn(hostId, connected); } catch { /* an observer must not break registration */ }
    }
  }

  isConnected(hostId) {
    const current = this.connections.get(hostId);
    return Boolean(current && current.ws.readyState === current.ws.OPEN);
  }

  get(hostId) {
    return this.connections.get(hostId) || null;
  }

  connect(hostId, { ws, credentialId, hello }) {
    const previous = this.connections.get(hostId);
    if (previous && previous.ws !== ws && previous.ws.readyState === previous.ws.OPEN) {
      previous.rejectPending(new Error('Host agent connection was replaced.'));
      previous.ws.close(4002, 'replaced');
    }
    const record = {
      hostId,
      credentialId,
      hello: hello || null,
      connectedAt: new Date().toISOString(),
      ws,
      pending: new Map(),
      request: (op, params = {}, timeoutMs = 15000, { signal } = {}) => new Promise((resolve, reject) => {
        if (signal?.aborted) return reject(new Error('Host agent request cancelled.'));
        if (ws.readyState !== ws.OPEN) return reject(new Error('Host agent is disconnected.'));
        if (record.pending.size >= 64) return reject(new Error('Host agent request limit reached.'));
        const id = `remotehub-${this.nextRequestId++}`;
        let payload;
        try {
          payload = JSON.stringify({ id, op, params });
        } catch (error) {
          return reject(error);
        }
        if (Buffer.byteLength(payload, 'utf8') > MAX_AGENT_FRAME_BYTES) {
          return reject(new Error('Host agent request exceeds the 7 MiB WebSocket frame limit.'));
        }
        let pending;
        const cleanup = () => {
          clearTimeout(pending.timer);
          signal?.removeEventListener('abort', pending.onAbort);
        };
        const settle = (failure, message) => {
          if (record.pending.get(id) !== pending) return false;
          cleanup();
          record.pending.delete(id);
          if (failure) reject(failure);
          else resolve(message);
          return true;
        };
        const sendCancel = () => {
          if (ws.readyState !== ws.OPEN) return;
          try {
            ws.send(JSON.stringify({
              id: `remotehub-cancel-${this.nextRequestId++}`,
              op: 'exec.cancel',
              params: { requestId: id },
            }));
          } catch { /* The agent's WebSocket disconnect path also stops pending work. */ }
        };
        pending = {
          resolve,
          reject,
          signal,
          timer: null,
          onAbort: null,
        };
        pending.timer = setTimeout(() => {
          sendCancel();
          settle(new Error('Host agent request timed out.'));
        }, timeoutMs);
        pending.onAbort = () => {
          sendCancel();
          settle(new Error('Host agent request cancelled.'));
        };
        record.pending.set(id, pending);
        signal?.addEventListener('abort', pending.onAbort, { once: true });
        if (signal?.aborted) {
          pending.onAbort();
          return;
        }
        try {
          ws.send(payload);
        } catch (error) {
          settle(error);
        }
      }),
      resolveRequest: (message) => {
        if (message?.id === undefined || message?.id === null) return false;
        const id = String(message.id);
        const pending = record.pending.get(id);
        if (!pending) return false;
        clearTimeout(pending.timer);
        pending.signal?.removeEventListener('abort', pending.onAbort);
        record.pending.delete(id);
        pending.resolve(message);
        return true;
      },
      rejectPending: (error) => {
        for (const pending of record.pending.values()) {
          clearTimeout(pending.timer);
          pending.signal?.removeEventListener('abort', pending.onAbort);
          pending.reject(error);
        }
        record.pending.clear();
      },
    };
    this.connections.set(hostId, record);
    this.notify(hostId, true);
    return record;
  }

  disconnect(hostId, code = 1000, reason = 'disconnected') {
    const current = this.connections.get(hostId);
    if (!current) return false;
    this.connections.delete(hostId);
    current.rejectPending(new Error(reason || 'Host agent disconnected.'));
    this.notify(hostId, false);
    if (current.ws.readyState === current.ws.OPEN || current.ws.readyState === current.ws.CONNECTING) {
      current.ws.close(code, reason);
    }
    return true;
  }

  release(hostId, ws) {
    const current = this.connections.get(hostId);
    if (current && current.ws === ws) {
      current.rejectPending(new Error('Host agent disconnected.'));
      this.connections.delete(hostId);
      this.notify(hostId, false);
    }
  }

  sockets() {
    return [...this.connections.values()].map((record) => record.ws);
  }

  closeAll(code = 1001, reason = 'Server shutting down') {
    for (const hostId of [...this.connections.keys()]) this.disconnect(hostId, code, reason);
  }
}
