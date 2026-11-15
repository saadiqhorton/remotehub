// Live directory watching through the RemoteHub agent (SAA-298).
//
// SFTP stays the source of truth for every listing and file operation. The agent
// is only a notifier: when a host runs the persistent agent, the Files bridge
// opens a channel to it over the *same* authenticated SSH connection (direct-tcpip
// to the agent's loopback port), speaks the SAA-295 control protocol, and turns
// the agent's `filesystemEvent`s for the visible directory into `fs-event`
// messages for the browser. The browser answers any event by quietly re-listing
// the directory over SFTP, so events are idempotent and never add rows on their
// own.
//
// Anything that goes wrong (no agent, old agent without `files.watch`, a path
// outside the agent root, the agent disconnecting) degrades to the existing
// polling path: the browser is told `watch-status: off` and keeps polling.

import { posix } from 'node:path';

export const AGENT_PROTOCOL_VERSION = 1;
// Default loopback port of the persistent agent (`remotehub-agent --listen`).
export const DEFAULT_AGENT_PORT = 8377;
// The agent must greet within this window or the bridge gives up and polls.
export const AGENT_HELLO_TIMEOUT_MS = 5_000;
// A failed agent connection is not retried more often than this.
export const AGENT_RETRY_MS = 30_000;
// Bound one agent frame so a broken peer cannot grow the buffer forever.
const MAX_FRAME_BYTES = 64 * 1024;
// Where the agent writes its per-start loopback token, relative to the SSH
// user's home (the SFTP session's starting directory).
export const AGENT_TOKEN_PATH = '.remotehub/agent-local-token';
// The agent writes 32 random bytes as hex; refuse anything that is not hex of at least that length.
const TOKEN_PATTERN = /^[0-9a-f]{64,256}$/i;
const MAX_TOKEN_FILE_BYTES = 512;

/** Parse the agent token file's contents; returns null if it is not a valid token. */
export function parseAgentToken(contents) {
  const token = String(contents ?? '').trim();
  return TOKEN_PATTERN.test(token) ? token : null;
}

/**
 * Read the agent's loopback token over an open SFTP session. The token is
 * handed to `done` only; it is never logged or sent to the browser.
 * @param {object} sftp ssh2 SFTP wrapper
 * @param {(err: Error|null, token?: string) => void} done
 */
export function readAgentToken(sftp, done, path = AGENT_TOKEN_PATH) {
  let finished = false;
  const finish = (err, token) => {
    if (finished) return;
    finished = true;
    done(err, token);
  };
  sftp.open(path, 'r', (openErr, handle) => {
    if (openErr) return finish(new Error('agent token file not readable'));
    const chunks = [];
    let total = 0;
    const closeWith = (err, token) => sftp.close(handle, () => finish(err, token));
    const step = () => {
      const buf = Buffer.alloc(MAX_TOKEN_FILE_BYTES - total);
      if (buf.length === 0) return closeWith(new Error('agent token file too large'));
      sftp.read(handle, buf, 0, buf.length, total, (readErr, bytesRead) => {
        if (readErr) return closeWith(new Error('agent token file not readable'));
        if (!bytesRead) {
          const token = parseAgentToken(Buffer.concat(chunks).toString('utf8'));
          return token ? closeWith(null, token) : closeWith(new Error('agent token file is malformed'));
        }
        chunks.push(buf.subarray(0, bytesRead));
        total += bytesRead;
        step();
      });
    };
    step();
  });
}

/**
 * @param {object} options
 * @param {(cb: (err: Error|null, stream?: import('node:stream').Duplex) => void) => void} options.open
 *   Opens a byte stream to the agent (in production: ssh2 forwardOut).
 * @param {(cb: (err: Error|null, token?: string) => void) => void} [options.readToken]
 *   Reads the agent's loopback token (in production: over SFTP). Re-read on every
 *   connect, because the agent writes a new token each time it starts.
 * @param {(message: object) => void} options.send  Sends a message to the browser.
 * @param {(line: string) => void} [options.log]
 * @param {() => number} [options.now]
 * @param {'agent'|'helper'} [options.source] Which component serves the watch
 *   (persistent agent or SAA-299 temporary helper); reported in every
 *   `watch-status` so the browser can show which one is live.
 */
export function createAgentWatch({ open, readToken = (done) => done(null, null), send, log = () => {}, now = Date.now, source = 'agent', onAgent = () => {}, onAgentLost = () => {} }) {
  let stream = null;
  let state = 'idle'; // idle | connecting | handshake | ready | failed | closed
  let lastFailure = 0;
  let buffer = '';
  let nextId = 1;
  let helloTimer = null;
  let token = null; // this connection's agent token; never logged
  const requests = new Map(); // agent request id -> { op, path }
  let desired = null; // directory the browser wants watched
  let current = null; // { watchId, path } confirmed by the agent

  let greeting = null; // the agent's hello frame, kept until the handshake completes
  let announced = false; // onAgent fired and onAgentLost not yet
  const lost = () => {
    if (!announced) return;
    announced = false;
    try { onAgentLost(); } catch {}
  };
  const status = (s, extra = {}) => send({ t: 'watch-status', s, source, ...extra });

  const request = (op, params, meta) => {
    const id = nextId++;
    requests.set(id, { op, ...meta });
    const frame = params ? { id, op, params } : { id, op };
    try {
      stream.write(`${JSON.stringify(frame)}\n`);
    } catch {
      fail('write failed');
    }
  };

  const fail = (reason) => {
    if (state === 'closed') return;
    const wasLive = Boolean(current) || state === 'ready';
    clearTimeout(helloTimer);
    state = 'failed';
    lastFailure = now();
    current = null;
    requests.clear();
    buffer = '';
    const dead = stream;
    stream = null;
    token = null;
    try { dead?.destroy(); } catch {}
    lost();
    log(`agent watch unavailable: ${reason}`);
    if (desired || wasLive) status('off', { path: desired, reason });
  };

  const applyDesired = () => {
    if (state !== 'ready') return;
    if (current && current.path === desired) return;
    if (current) {
      request('unwatchDirectory', { watchId: current.watchId }, {});
      current = null;
    }
    if (desired) request('watchDirectory', { path: desired }, { path: desired });
  };

  const onFrame = (frame) => {
    if (frame.event === 'hello') {
      if (state !== 'handshake') return;
      if (frame.protocol !== AGENT_PROTOCOL_VERSION) return fail(`agent speaks protocol ${frame.protocol}`);
      if (frame.capabilities?.files?.watch !== true) return fail('agent does not support watching');
      // A temporary helper must say so; a persistent agent must not pretend to be one.
      if ((source === 'helper') !== (frame.mode === 'temporary')) return fail(`unexpected ${frame.mode} agent`);
      greeting = frame;
      const params = { protocol: AGENT_PROTOCOL_VERSION };
      if (token) params.token = token;
      request('hello', params, {});
      return;
    }
    if (frame.event === 'filesystemEvent') {
      if (!current || frame.watchId !== current.watchId) return; // stale or foreign watch
      if (frame.change === 'unavailable') {
        const path = current.path;
        current = null;
        status('unavailable', { path });
        return;
      }
      if (!['create', 'delete', 'modify', 'rename'].includes(frame.change)) return;
      const message = { t: 'fs-event', path: current.path, change: frame.change };
      if (typeof frame.path === 'string') message.name = posix.basename(frame.path.replaceAll('\\', '/'));
      if (typeof frame.from === 'string') message.from = posix.basename(frame.from.replaceAll('\\', '/'));
      send(message);
      return;
    }
    const pendingRequest = requests.get(frame.id);
    if (!pendingRequest) return;
    requests.delete(frame.id);
    if (pendingRequest.op === 'hello') {
      if (frame.ok !== true) {
        return fail(frame.error?.code === 'unauthorized' ? 'agent rejected the token' : frame.error?.message || 'agent refused the handshake');
      }
      clearTimeout(helloTimer);
      state = 'ready';
      log('agent watch ready');
      if (greeting) {
        announced = true;
        try { onAgent(greeting); } catch {}
      }
      applyDesired();
      return;
    }
    if (pendingRequest.op === 'watchDirectory') {
      if (pendingRequest.path !== desired) {
        // The browser navigated away while this was in flight; drop it.
        if (frame.ok === true) request('unwatchDirectory', { watchId: frame.result.watchId }, {});
        return;
      }
      if (frame.ok === true && Number.isInteger(frame.result?.watchId)) {
        current = { watchId: frame.result.watchId, path: pendingRequest.path };
        status('live', { path: pendingRequest.path });
      } else {
        status('off', { path: pendingRequest.path, reason: frame.error?.message || 'watch refused' });
      }
    }
  };

  const connect = () => {
    if (state === 'connecting' || state === 'handshake' || state === 'ready' || state === 'closed') return;
    if (state === 'failed' && now() - lastFailure < AGENT_RETRY_MS) {
      if (desired) status('off', { path: desired, reason: 'agent unavailable' });
      return;
    }
    state = 'connecting';
    readToken((tokenErr, freshToken) => {
      if (state === 'closed') return;
      if (tokenErr) return fail(tokenErr.message || 'agent token unavailable');
      token = freshToken || null;
      openChannel();
    });
  };

  const openChannel = () => {
    open((err, opened) => {
      if (state === 'closed') {
        try { opened?.destroy(); } catch {}
        return;
      }
      if (err || !opened) return fail(err?.message || 'no agent channel');
      stream = opened;
      state = 'handshake';
      helloTimer = setTimeout(() => fail('agent did not greet'), AGENT_HELLO_TIMEOUT_MS);
      helloTimer.unref?.();
      stream.on('data', (chunk) => {
        if (stream !== opened) return;
        buffer += chunk.toString('utf8');
        if (buffer.length > MAX_FRAME_BYTES && !buffer.includes('\n')) return fail('oversized agent frame');
        let index;
        while ((index = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, index).trim();
          buffer = buffer.slice(index + 1);
          if (!line) continue;
          let frame;
          try {
            frame = JSON.parse(line);
          } catch {
            continue;
          }
          if (frame && typeof frame === 'object') onFrame(frame);
          if (stream !== opened) return;
        }
      });
      stream.on('error', () => { if (stream === opened) fail('agent channel error'); });
      stream.on('close', () => { if (stream === opened) fail('agent disconnected'); });
    });
  };

  return {
    /** Watch `path` (absolute SFTP path), replacing any previous watch. */
    watch(path) {
      if (state === 'closed') return;
      desired = path;
      if (state === 'ready') applyDesired();
      else connect();
    },
    /** Stop watching (navigation to a non-directory view, tab hidden). */
    unwatch() {
      desired = null;
      if (state === 'ready' && current) {
        request('unwatchDirectory', { watchId: current.watchId }, {});
      }
      current = null;
    },
    /** Tear down the agent channel; the agent drops all watches on disconnect. */
    close() {
      if (state === 'closed') return;
      clearTimeout(helloTimer);
      state = 'closed';
      lost();
      desired = null;
      current = null;
      try { stream?.end(); } catch {}
      try { stream?.destroy(); } catch {}
      stream = null;
      token = null;
    },
    get state() {
      return state;
    },
    get watching() {
      return current ? { ...current } : null;
    },
  };
}
