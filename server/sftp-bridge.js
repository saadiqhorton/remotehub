import ssh2 from 'ssh2';
import { posix } from 'node:path';
import {
  AUTH_TIMEOUT_MS,
  HOSTKEY_DECISION_TIMEOUT_MS,
  describeSocketError,
  describeSshError,
  fingerprintOf,
  keyTypeOf,
  openSocket,
} from './ssh-bridge.js';
import { reportFromHello } from './host-status.js';
import { DEFAULT_AGENT_PORT, createAgentWatch, readAgentToken } from './agent-watch.js';
import { deployHelper, helperTokens } from './helper-deploy.js';

const { Client } = ssh2;

const OP_TIMEOUT_MS = 30_000;
const MAX_PATH_LENGTH = 4096;
const MAX_ID_LENGTH = 64;
const MAX_QUERY_LENGTH = 255;
const MAX_SEARCH_RESULTS = 200;
const MAX_SEARCH_DIRS = 1000;
const MAX_SEARCH_DEPTH = 32;
const SEARCH_CONCURRENCY = 4;
const CONTROL = /[\u0000-\u001f\u007f]/;
// A file above this size is refused before it is opened, so it is never buffered.
export const MAX_VIEW_BYTES = 256 * 1024;
// Files under the cap are read only up to this window. The rest stays on the host.
export const VIEW_WINDOW_BYTES = 64 * 1024;
// One in-flight transfer chunk. The bridge never concatenates these into a whole-file buffer.
export const TRANSFER_CHUNK_BYTES = 64 * 1024;
const TRANSFER_STALL_MS = 60_000;
const SFTP_EOF = 1;

const S_IFMT = 0o170000;
const S_IFDIR = 0o040000;
const S_IFREG = 0o100000;
const S_IFLNK = 0o120000;
const MUTATIONS = new Set(['mkdir', 'rename', 'move', 'delete']);

function mutationPath(value) {
  if (safePath(value) === null || value === '.') return null;
  if (value.split('/').some((part) => part === '.' || part === '..')) return null;
  const path = posix.normalize(value).replace(/\/+$/, '');
  return path && path !== '/' ? path : null;
}

// A client-supplied path must be absolute and printable before it reaches the SSH server.
// "." is allowed for realpath(".") (resolve the home dir); the server resolves it under the
// user's own credentials. Everything else must start with "/".
export function safePath(value) {
  if (typeof value !== 'string') return null;
  if (value.length === 0 || value.length > MAX_PATH_LENGTH) return null;
  if (value !== '.' && !value.startsWith('/')) return null;
  if (CONTROL.test(value)) return null;
  return value;
}

function typeOf(attrs) {
  if (attrs && typeof attrs.isDirectory === 'function') {
    if (attrs.isDirectory()) return 'dir';
    if (attrs.isSymbolicLink()) return 'symlink';
    if (attrs.isFile()) return 'file';
    return 'other';
  }
  const mode = attrs && typeof attrs.mode === 'number' ? attrs.mode : 0;
  switch (mode & S_IFMT) {
    case S_IFDIR:
      return 'dir';
    case S_IFREG:
      return 'file';
    case S_IFLNK:
      return 'symlink';
    default:
      return 'other';
  }
}

function normalizeAttrs(attrs) {
  const size = attrs && typeof attrs.size === 'number' ? attrs.size : 0;
  const mtime = attrs && typeof attrs.mtime === 'number' ? attrs.mtime : 0;
  const atime = attrs && typeof attrs.atime === 'number' ? attrs.atime : 0;
  const mode = attrs && typeof attrs.mode === 'number' ? attrs.mode : 0;
  return { type: typeOf(attrs), size, mtime: mtime * 1000, atime: atime * 1000, mode: mode & 0o7777 };
}

// Turns one READDIR/STAT attrs blob into the wire shape the browser expects. mtime/atime
// arrive as whole seconds and are promoted to milliseconds; mode keeps only permission bits.
export function normalizeEntry(name, attrs) {
  if (name === '.' || name === '..') return null;
  return { name, ...normalizeAttrs(attrs) };
}

// Maps an SFTP status error to a stable op-level code. Statuses 2 and 3 are common enough
// to deserve their own code; everything else is a generic SFTP failure.
export function describeSftpError(err) {
  const status = err && err.code;
  if (status === 2) return { code: 'not-found', message: 'No such file or directory' };
  if (status === 3) return { code: 'denied', message: 'Permission denied' };
  return { code: 'sftp', message: (err && err.message) || 'RemoteHub couldn’t finish that file action. Try again.' };
}

function safeSize(value) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return null;
  return value;
}

// One active SFTP transfer on the files socket. Downloads are read and uploads are written
// one chunk at a time; the next chunk waits for the browser. Cancel closes the handle and,
// for an upload, removes the partial remote file. Listing and stat keep their own ids.
function createTransferController({ ws, send, sftp, opError, isClosed }) {
  let current = null;

  const touch = (job) => {
    clearTimeout(job.timer);
    job.timer = setTimeout(() => {
      if (current !== job || job.settled) return;
      fail(job, 'timeout', 'The transfer timed out.');
    }, TRANSFER_STALL_MS);
    job.timer.unref?.();
  };

  const release = (job, notify) => {
    if (job.settled) return;
    job.settled = true;
    if (current === job) current = null;
    clearTimeout(job.timer);
    const notifySafe = () => {
      if (!isClosed()) notify();
    };
    const discardUpload = () => {
      if (job.kind === 'upload' && job.discard && job.opened) sftp.unlink(job.path, () => notifySafe());
      else notifySafe();
    };
    if (job.handle) {
      const handle = job.handle;
      job.handle = null;
      sftp.close(handle, () => discardUpload());
      return;
    }
    discardUpload();
  };

  const fail = (job, code, message) => {
    job.discard = job.kind === 'upload';
    release(job, () => send({ t: 'error', id: job.id, code, message }));
  };

  const failErr = (job, err) => {
    const mapped = opError(err, job.path);
    fail(job, mapped.code, mapped.message);
  };

  const succeed = (job) => {
    job.discard = false;
    const { id, loaded, size } = job;
    release(job, () => send({ t: 'transfer', id, phase: 'complete', loaded, size }));
  };

  const cancelJob = (job) => {
    job.discard = job.kind === 'upload';
    const { id, loaded, size } = job;
    release(job, () => send({ t: 'transfer', id, phase: 'cancelled', loaded, size }));
  };

  const arm = (kind, id, path, size) => {
    if (isClosed()) return null;
    if (current && !current.settled) {
      send({ t: 'error', id, code: 'busy', message: 'Another transfer is already running.' });
      return null;
    }
    current = {
      id,
      kind,
      path,
      size,
      loaded: 0,
      handle: null,
      settled: false,
      discard: false,
      opened: false,
      reading: false,
      writing: false,
      finishRequested: false,
      timer: null,
    };
    touch(current);
    return current;
  };

  const readNext = (job) => {
    if (job.settled || current !== job || job.reading || !job.handle) return;
    if (job.loaded >= job.size) return succeed(job);
    job.reading = true;
    touch(job);
    const length = Math.min(TRANSFER_CHUNK_BYTES, job.size - job.loaded);
    const buf = Buffer.alloc(length);
    sftp.read(job.handle, buf, 0, length, job.loaded, (err, bytesRead) => {
      job.reading = false;
      if (job.settled || current !== job) return;
      if (err) {
        if (err.code === SFTP_EOF) {
          if (job.loaded === job.size) return succeed(job);
          return fail(job, 'sftp', 'The file ended before all bytes were transferred.');
        }
        return failErr(job, err);
      }
      const count = bytesRead || 0;
      if (!count) {
        if (job.loaded === job.size) return succeed(job);
        return fail(job, 'sftp', 'The file ended before all bytes were transferred.');
      }
      const slice = Buffer.from(buf.subarray(0, count));
      job.loaded += count;
      touch(job);
      if (ws.readyState === ws.OPEN) ws.send(slice);
      send({ t: 'transfer', id: job.id, phase: 'progress', loaded: job.loaded, size: job.size });
      if (job.loaded >= job.size) succeed(job);
    });
  };

  const finishPut = (job) => {
    if (job.settled || current !== job || job.kind !== 'upload') return;
    if (job.writing) {
      job.finishRequested = true;
      return;
    }
    if (!job.handle) {
      job.finishRequested = true;
      return;
    }
    if (job.loaded !== job.size) return fail(job, 'sftp', 'The upload ended before all bytes were received.');
    succeed(job);
  };

  const startGet = (id, path) => {
    const job = arm('download', id, path, 0);
    if (!job) return;
    sftp.stat(path, (statErr, stats) => {
      if (job.settled) return;
      if (statErr) return failErr(job, statErr);
      if (typeOf(stats) !== 'file') return fail(job, 'not-file', `Not a file: ${path}`);
      job.size = typeof stats.size === 'number' && stats.size > 0 ? stats.size : 0;
      sftp.open(path, 'r', (openErr, handle) => {
        if (job.settled) {
          if (handle) sftp.close(handle, () => {});
          return;
        }
        if (openErr) return failErr(job, openErr);
        job.handle = handle;
        job.opened = true;
        send({ t: 'transfer', id, phase: 'start', kind: 'download', size: job.size, path });
        if (job.size === 0) succeed(job);
      });
    });
  };

  const startPut = (id, path, size) => {
    const job = arm('upload', id, path, size);
    if (!job) return;
    sftp.open(path, 'w', (openErr, handle) => {
      if (job.settled) {
        if (handle) sftp.close(handle, () => sftp.unlink(path, () => {}));
        return;
      }
      if (openErr) return failErr(job, openErr);
      job.handle = handle;
      job.opened = true;
      send({ t: 'transfer', id, phase: 'start', kind: 'upload', size, path });
      if (job.finishRequested) finishPut(job);
    });
  };

  const onBinary = (raw) => {
    const job = current;
    if (!job || job.settled || job.kind !== 'upload') return;
    if (!job.handle || job.writing) {
      fail(job, 'sftp', 'The upload sent a chunk out of order.');
      return;
    }
    const chunk = Buffer.isBuffer(raw) ? Buffer.from(raw) : Buffer.from(raw);
    if (chunk.length === 0) return;
    if (job.loaded + chunk.length > job.size) {
      fail(job, 'sftp', 'The upload sent more bytes than expected.');
      return;
    }
    job.writing = true;
    touch(job);
    const position = job.loaded;
    sftp.write(job.handle, chunk, 0, chunk.length, position, (err) => {
      job.writing = false;
      if (job.settled || current !== job) return;
      if (err) return failErr(job, err);
      job.loaded += chunk.length;
      touch(job);
      send({ t: 'transfer', id: job.id, phase: 'ack', loaded: job.loaded, size: job.size });
      if (job.finishRequested) finishPut(job);
    });
  };

  const onControl = (message, hasId) => {
    if (!hasId(message.id)) return;
    if (message.t === 'get') {
      const path = safePath(message.path);
      if (path === null) {
        send({ t: 'error', id: message.id, code: 'path', message: 'Start the path with /.' });
        return;
      }
      startGet(message.id, path);
      return;
    }
    if (message.t === 'put') {
      const path = safePath(message.path);
      const size = safeSize(message.size);
      if (path === null) {
        send({ t: 'error', id: message.id, code: 'path', message: 'Start the path with /.' });
        return;
      }
      if (size === null) {
        send({ t: 'error', id: message.id, code: 'size', message: 'Upload size must be a whole number of bytes.' });
        return;
      }
      startPut(message.id, path, size);
      return;
    }
    if (message.t === 'put-end') {
      if (!current || current.settled || current.id !== message.id) return;
      finishPut(current);
      return;
    }
    if (message.t === 'ack') {
      if (!current || current.settled || current.id !== message.id || current.kind !== 'download') return;
      readNext(current);
      return;
    }
    if (message.t === 'cancel') {
      if (!current || current.settled || current.id !== message.id) return;
      cancelJob(current);
    }
  };

  return {
    onControl,
    onBinary,
    isActive: () => Boolean(current && !current.settled),
    dispose() {
      if (!current) return;
      clearTimeout(current.timer);
      current.settled = true;
      current.discard = false;
      current = null;
    },
  };
}

/**
 * Bridges one browser WebSocket to one SFTP session on a fresh SSH connection.
 *
 * Browser -> server (JSON text frames):
 *   { t: 'connect', hostId, password }
 *   { t: 'hostkey', accept: boolean }
 *   { t: 'list', id, path }
 *   { t: 'stat', id, path }       (lstat, so symlinks report as symlinks)
 *   { t: 'realpath', id, path }
 *   { t: 'read', id, path }       (bounded text; never the whole of a large file)
 *   { t: 'search', id, path, query } (bounded name search below path; cancel by id)
 *   { t: 'mkdir', id, path }
 *   { t: 'rename' | 'move', id, path, destination } (no replacement)
 *   { t: 'delete', id, path, confirm } (exact basename; directory includes contents)
 *   { t: 'get', id, path }        (stream a download, one chunk per ack)
 *   { t: 'put', id, path, size }  (open an upload; binary frames are the chunks)
 *   { t: 'put-end', id }
 *   { t: 'ack', id }
 *   { t: 'cancel', id }
 * Server -> browser: JSON text frames for control, plus binary frames for download chunks.
 * Exactly one get/put runs at a time. A transfer error stays on that id and leaves the session up.
 */
let nextFilesSession = 1;

export function attachFiles(ws, { store, log, agentPort = DEFAULT_AGENT_PORT, helperDir = null, helperOptions = {}, hostStatus = null }) {
  const sessionId = nextFilesSession++;
  const detachers = new Map(); // source -> detach fn (SAA-300 live host status)
  const agentPresence = (source) => ({
    onAgent: (hello) => {
      if (!hostStatus || !host) return;
      detachers.get(source)?.();
      detachers.set(source, hostStatus.attach(host.id, `files:${sessionId}:${source}`, reportFromHello(hello, source === 'agent' ? 'local' : 'helper')));
    },
    onAgentLost: () => {
      detachers.get(source)?.();
      detachers.delete(source);
    },
  });
  let host = null;
  let socket = null;
  let conn = null;
  let sftp = null;
  let transfers = null;
  let started = false;
  let closed = false;
  let pendingHostKey = null;
  let authTimer = null;
  const pending = new Map();
  let mutationPending = null;
  let agentWatch = null;
  // SAA-299: at most one temporary helper per Files session.
  // { state: 'starting'|'running'|'stopping', promise?, handle? }
  let helper = null;
  let watchPath = null; // directory the browser last asked to watch

  const send = (message) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
  };

  const teardown = () => {
    if (closed) return;
    closed = true;
    clearTimeout(authTimer);
    if (pendingHostKey) {
      clearTimeout(pendingHostKey.timer);
      pendingHostKey.verify(false);
      pendingHostKey = null;
    }
    for (const entry of pending.values()) clearTimeout(entry.timer);
    pending.clear();
    transfers?.dispose();
    transfers = null;
    agentWatch?.close();
    agentWatch = null;
    for (const detach of detachers.values()) detach();
    detachers.clear();
    const endConnection = () => {
      try { sftp?.end(); } catch {}
      try { conn?.end(); } catch {}
      try { socket?.destroy(); } catch {}
    };
    // A temporary helper is stopped and its files removed before the SSH
    // connection closes (SAA-299: cleanup on normal close).
    const running = helper;
    helper = null;
    if (running) {
      Promise.resolve(running.promise ?? running.handle)
        .then((handle) => handle?.stop())
        .catch(() => {})
        .finally(endConnection);
    } else {
      endConnection();
    }
    if (ws.readyState === ws.OPEN) ws.close(1000);
  };

  // Live updates from a persistent agent on the host's loopback port (SAA-298).
  const makePortWatch = () => (agentPort > 0 ? createAgentWatch({
    // The agent listens on the host's loopback; reach it through this SSH session.
    open: (done) => conn.forwardOut('127.0.0.1', 0, '127.0.0.1', agentPort, done),
    // The agent's per-start token, read as this SSH user (file is 0600).
    readToken: (done) => readAgentToken(sftp, done),
    send,
    log,
    ...agentPresence('agent'),
  }) : null);

  const startHelper = () => {
    if (!sftp || closed || helper) return;
    if (!helperDir) {
      send({ t: 'helper-status', s: 'failed', reason: 'Temporary connections are not set up on this RemoteHub server.' });
      return;
    }
    send({ t: 'helper-status', s: 'starting' });
    const starting = { state: 'starting' };
    helper = starting;
    starting.promise = (async () => {
      const root = await new Promise((resolve, reject) => sftp.realpath('.', (err, home) => (err ? reject(err) : resolve(home))));
      return deployHelper({ conn, sftp, helperDir, root, tokens: helperTokens, log, ...helperOptions });
    })().then((handle) => {
      if (closed || helper !== starting) {
        // Teardown (or a stop) raced the deploy: teardown awaits this promise and stops it.
        return handle;
      }
      helper = { state: 'running', handle };
      // Live updates now come from the helper's exec channel.
      agentWatch?.close();
      agentWatch = createAgentWatch({ source: 'helper', open: handle.open, readToken: handle.readToken, send, log, ...agentPresence('helper') });
      send({ t: 'helper-status', s: 'running', platform: `${handle.platform.os}-${handle.platform.arch}` });
      handle.onExit(() => {
        if (helper?.handle === handle && helper.state === 'running') stopHelper('The temporary connection ended.');
      });
      if (watchPath) agentWatch.watch(watchPath);
      return handle;
    }, (error) => {
      if (helper === starting) helper = null;
      if (!closed) send({ t: 'helper-status', s: 'failed', reason: error?.code && error.message ? error.message : 'Could not start the temporary connection.', cleaned: error?.cleaned !== false });
      return null;
    });
  };

  const stopHelper = (reason) => {
    const current = helper;
    if (!current || current.state !== 'running') return;
    current.state = 'stopping';
    send({ t: 'helper-status', s: 'stopping' });
    agentWatch?.close();
    agentWatch = null;
    if (watchPath) send({ t: 'watch-status', s: 'off', source: 'helper', path: watchPath, reason });
    current.handle.stop().then((report) => {
      if (helper === current) helper = null;
      if (closed) return;
      send({ t: 'helper-status', s: 'stopped', cleaned: report.cleaned, reason });
      // Fall back to the persistent agent if there is one, else polling.
      agentWatch = makePortWatch();
      if (watchPath) {
        if (agentWatch) agentWatch.watch(watchPath);
        else send({ t: 'watch-status', s: 'off', path: watchPath, reason: 'live updates are disabled' });
      }
    });
  };

  const fail = (code, message) => {
    if (closed) return;
    send({ t: 'error', code, message });
    teardown();
  };

  const verifyHostKey = (keyBlob, verify) => {
    const fingerprint = fingerprintOf(keyBlob);
    const keyType = keyTypeOf(keyBlob);
    const known = store.getKnownHost(host.address, host.port);

    if (known) {
      if (known.fingerprint === fingerprint) return verify(true);
      log(`host key mismatch for ${host.address}:${host.port}`);
      send({ t: 'hostkey', status: 'mismatch', keyType, fingerprint, expected: known });
      // Report before rejecting: ssh2 emits its own generic error synchronously from verify(false).
      fail('hostkey-mismatch', 'The server identity changed since you last connected.');
      return verify(false);
    }

    send({ t: 'hostkey', status: 'new', keyType, fingerprint });
    pendingHostKey = {
      verify,
      keyType,
      fingerprint,
      timer: setTimeout(() => {
        pendingHostKey = null;
        fail('hostkey-timeout', 'Timed out waiting for you to confirm the server fingerprint.');
        verify(false);
      }, HOSTKEY_DECISION_TIMEOUT_MS),
    };
  };

  const decideHostKey = async (accept) => {
    const pendingKey = pendingHostKey;
    if (!pendingKey) return;
    pendingHostKey = null;
    clearTimeout(pendingKey.timer);
    if (!accept) {
      fail('hostkey-rejected', 'Fingerprint not trusted, so the connection was cancelled.');
      return pendingKey.verify(false);
    }
    try {
      await store.setKnownHost(host.address, host.port, pendingKey);
    } catch (err) {
      log(`could not save fingerprint: ${err.message}`);
    }
    if (closed) return;
    send({ t: 'status', s: 'authenticating' });
    authTimer = setTimeout(() => fail('timeout', 'The server stopped responding during login.'), AUTH_TIMEOUT_MS);
    pendingKey.verify(true);
  };

  const hasId = (id) =>
    typeof id === 'number' || (typeof id === 'string' && id.length <= MAX_ID_LENGTH);

  const opError = (err, path) => {
    const { code, message } = describeSftpError(err);
    // The base message for known statuses is friendlier with the path attached.
    if (code === 'sftp') return { code, message };
    return { code, message: path ? `${message}: ${path}` : message };
  };

  // Runs one op with a fresh pending entry. A late callback after a timeout (or after the
  // id was reused) is dropped because the map no longer points at this entry.
  const runOp = (id, op, path, request = {}) => {
    if (pending.has(id) || (MUTATIONS.has(op) && (mutationPending || transfers?.isActive()))) {
      send({ t: 'error', id, code: 'busy', message: `${op} failed: another operation is running.` });
      return;
    }
    const release = () => {
      pending.delete(id);
      clearTimeout(entry.timer);
      if (mutationPending === entry) mutationPending = null;
    };
    const entry = {
      timer: setTimeout(() => {
        if (pending.get(id) !== entry) return;
        if (entry.onTimeout) return entry.onTimeout();
        release();
        send({ t: 'error', id, code: 'timeout', message: 'RemoteHub couldn’t finish that file action in time. Try again.' });
      }, OP_TIMEOUT_MS),
    };
    pending.set(id, entry);
    if (MUTATIONS.has(op)) mutationPending = entry;
    if (op === 'search') entry.search = true;

    const done = (payload) => {
      if (pending.get(id) !== entry) return;
      release();
      send({ t: 'result', id, op, ...payload });
    };
    const failed = (err) => {
      if (pending.get(id) !== entry) return;
      release();
      const { code, message } = opError(err, path);
      send({ t: 'error', id, code, message: MUTATIONS.has(op) ? `${op} failed: ${message}` : message });
    };
    const refuse = (code, message, extra = {}) => {
      if (pending.get(id) !== entry) return;
      release();
      send({ t: 'error', id, code, message, ...extra });
    };

    // Every awaited step checks ownership: timeout/disconnect/cancel stops further work.
    const call = (method, ...args) => new Promise((resolve, reject) => {
      if (closed || pending.get(id) !== entry) return reject(new Error('Operation ended'));
      sftp[method](...args, (err, value) => {
        if (closed || pending.get(id) !== entry) return reject(new Error('Operation ended'));
        if (err) reject(err);
        else resolve(value);
      });
    });

    if (op === 'search') {
      const query = typeof request.query === 'string' ? request.query.trim() : '';
      if (!query || query.length > MAX_QUERY_LENGTH || CONTROL.test(query) || query.includes('/')) {
        return refuse('query', 'Enter part of a name to search for (no slashes, up to 255 characters).');
      }
      if (!path.startsWith('/')) {
        return refuse('path', 'search failed: start the path with /.');
      }
      const root = path.length > 1 ? path.replace(/\/+$/, '') : path;
      const needle = query.toLowerCase();
      const found = [];
      const NAME_UNSAFE = /[\/\\\u0000-\u001f\u007f]/;
      let scanned = 0;
      let skipped = 0;
      let truncated = false;
      const snapshot = () => ({
        path: root, query, entries: [...found].sort((a, b) => a.path.localeCompare(b.path)),
        truncated, scanned, skipped,
      });
      // Return partial matches on the deadline instead of discarding the whole walk.
      entry.onTimeout = () => {
        truncated = true;
        done({ ...snapshot(), reason: 'timeout' });
      };
      // Read a small batch in parallel to avoid a round trip per directory. Only real
      // directories enter the bounded queue; descendant symlinks are never followed.
      const walk = async () => {
        const queue = [{ dir: root, depth: 0 }];
        while (queue.length && found.length < MAX_SEARCH_RESULTS) {
          if (closed || pending.get(id) !== entry) return;
          const batch = queue.splice(0, Math.min(SEARCH_CONCURRENCY, MAX_SEARCH_DIRS - scanned));
          if (!batch.length) { truncated = true; break; }
          const childrenByDir = await Promise.all(batch.map(async ({ dir, depth }) => {
            try {
              return await call('readdir', dir, { full: true });
            } catch (err) {
              if (depth === 0 || closed || pending.get(id) !== entry) throw err;
              skipped += 1;
              return [];
            }
          }));
          if (closed || pending.get(id) !== entry) return;
          scanned += batch.length;
          for (let index = 0; index < batch.length; index += 1) {
            const { dir, depth } = batch[index];
            for (const child of childrenByDir[index]) {
              const item = normalizeEntry(child.filename, child.attrs);
              if (!item || NAME_UNSAFE.test(item.name)) continue;
              const childPath = dir === '/' ? `/${item.name}` : `${dir}/${item.name}`;
              if (childPath.length > MAX_PATH_LENGTH) { truncated = true; continue; }
              if (item.name.toLowerCase().includes(needle)) {
                found.push({ ...item, path: childPath });
                if (found.length >= MAX_SEARCH_RESULTS) { truncated = true; break; }
              }
              if (item.type === 'dir') {
                if (depth + 1 > MAX_SEARCH_DEPTH || scanned + queue.length >= MAX_SEARCH_DIRS) truncated = true;
                else queue.push({ dir: childPath, depth: depth + 1 });
              }
            }
            if (found.length >= MAX_SEARCH_RESULTS) break;
          }
          // The client can show and open matches without waiting for the entire tree.
          send({ t: 'search-progress', id, ...snapshot() });
        }
      };
      walk()
        .then(() => done(snapshot()))
        .catch((err) => {
          if (closed || pending.get(id) !== entry) return;
          failed(err);
        });
      return;
    }

    if (MUTATIONS.has(op)) {
      const mutate = async () => {
        if (op === 'mkdir') {
          await call('mkdir', path);
        } else if (op === 'rename' || op === 'move') {
          const destination = mutationPath(request.destination);
          if (!destination || destination === path || destination.startsWith(`${path}/`)) {
            return refuse('path', `${op} failed: start the path with / and choose a folder outside the one being moved.`);
          }
          if (op === 'rename' && posix.dirname(destination) !== posix.dirname(path)) {
            return refuse('path', 'rename failed: the new name must stay in the same directory.');
          }
          try {
            await call('lstat', destination);
            return refuse('exists', `${op} failed: the destination already exists: ${destination}`);
          } catch (err) {
            if (err.code !== 2) throw err;
          }
          // Standard SFTP rename has no overwrite flag. Do not use posix-rename.
          await call('rename', path, destination);
        } else {
          if (request.confirm !== posix.basename(path)) {
            return refuse('confirmation', 'delete failed: confirm the exact item name.');
          }
          const targets = [];
          let visited = 0;
          const collect = async (target, depth) => {
            if (++visited > 1000 || depth > 64) throw new Error('Directory exceeds the delete limit (1000 items / 64 levels).');
            const attrs = await call('lstat', target);
            const directory = typeOf(attrs) === 'dir';
            if (directory) {
              const canonical = await call('realpath', target);
              if (canonical === '/') throw new Error('The filesystem root cannot be deleted.');
              const children = await call('readdir', target, { full: true });
              for (const child of children) {
                if (child.filename === '.' || child.filename === '..') continue;
                if (!child.filename || /[\/\\\u0000-\u001f\u007f]/.test(child.filename)) throw new Error('Invalid directory entry.');
                await collect(`${target}/${child.filename}`, depth + 1);
              }
            }
            targets.push({ path: target, directory });
          };
          // Preflight the whole bounded tree before removing anything. lstat keeps
          // symlink entries as unlink targets; their destinations are never traversed.
          await collect(path, 0);
          for (const target of targets) await call(target.directory ? 'rmdir' : 'unlink', target.path);
        }
        done({ path, ...(request.destination ? { destination: request.destination } : {}) });
      };
      mutate().catch(failed);
      return;
    }

    // Stat first. Anything over the cap is refused before open, so those bytes never
    // enter this process or the browser. Smaller files are read only up to the window.
    const readBounded = () => {
      sftp.stat(path, (statErr, stats) => {
        if (pending.get(id) !== entry) return;
        if (statErr) return failed(statErr);
        if (typeOf(stats) !== 'file') return refuse('not-file', `Not a file: ${path}`);
        const size = typeof stats.size === 'number' && stats.size > 0 ? stats.size : 0;
        if (size > MAX_VIEW_BYTES) {
          return refuse('too-large', `This file is over the view limit: ${path}`, { size });
        }
        sftp.open(path, 'r', (openErr, handle) => {
          if (pending.get(id) !== entry) {
            if (handle) sftp.close(handle, () => {});
            return;
          }
          if (openErr) return failed(openErr);
          const want = Math.min(size, VIEW_WINDOW_BYTES);
          const finish = (slice) => {
            sftp.close(handle, () => {
              if (pending.get(id) !== entry) return;
              if (slice.includes(0)) return refuse('binary', `This file is not text: ${path}`);
              done({ text: slice.toString('utf8'), truncated: size > slice.length, size });
            });
          };
          if (want === 0) return finish(Buffer.alloc(0));
          const buf = Buffer.alloc(want);
          const pull = (offset) => {
            if (pending.get(id) !== entry) {
              sftp.close(handle, () => {});
              return;
            }
            if (offset >= want) return finish(buf.subarray(0, offset));
            sftp.read(handle, buf, offset, want - offset, offset, (readErr, bytesRead) => {
              if (pending.get(id) !== entry) {
                sftp.close(handle, () => {});
                return;
              }
              if (readErr) {
                if (readErr.code === SFTP_EOF) return finish(buf.subarray(0, offset));
                return sftp.close(handle, () => failed(readErr));
              }
              if (!bytesRead) return finish(buf.subarray(0, offset));
              pull(offset + bytesRead);
            });
          };
          pull(0);
        });
      });
    };

    if (op === 'list') {
      // full: true keeps each entry's attrs (and leaves . / .. in place) so normalization
      // and filtering stay in this bridge rather than depending on ssh2's default filter.
      sftp.readdir(path, { full: true }, (err, list) => {
        if (err) return failed(err);
        const entries = list
          .map((item) => normalizeEntry(item.filename, item.attrs))
          .filter(Boolean)
          .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
        done({ entries });
      });
      return;
    }
    if (op === 'stat') {
      sftp.lstat(path, (err, stats) => {
        if (err) return failed(err);
        done({ entry: normalizeAttrs(stats) });
      });
      return;
    }
    if (op === 'read') {
      readBounded();
      return;
    }
    sftp.realpath(path, (err, absolute) => {
      if (err) return failed(err);
      done({ path: absolute });
    });
  };

  const start = async ({ hostId, password }) => {
    host = store.getHost(hostId);
    if (!host) return fail('host', 'That computer no longer exists.');
    if (typeof password !== 'string' || !password || password.length > 1024) {
      return fail('auth', 'Enter the SSH password for this machine.');
    }

    send({ t: 'status', s: 'connecting' });
    try {
      socket = await openSocket(host.address, host.port);
    } catch (err) {
      return fail('network', describeSocketError(err, host));
    }
    if (closed) return socket.destroy();
    socket.on('error', () => {});

    // The password is only held for the duration of the login exchange.
    let secret = password;
    let keyboardAnswered = false;
    conn = new Client();

    conn.on('keyboard-interactive', (_name, _instructions, _lang, prompts, finish) => {
      if (keyboardAnswered || !secret) return finish([]);
      keyboardAnswered = true;
      finish(prompts.map((prompt) => (prompts.length === 1 || /pass/i.test(prompt.prompt) ? secret : '')));
    });

    conn.on('ready', () => {
      secret = null;
      clearTimeout(authTimer);
      conn.sftp((err, stream) => {
        if (err) return fail('sftp', 'Logged in, but the server refused to open SFTP.');
        if (closed) return stream.end();
        sftp = stream;
        transfers = createTransferController({
          ws,
          send,
          sftp: stream,
          opError,
          isClosed: () => closed,
        });
        agentWatch = makePortWatch();
        send({ t: 'status', s: 'ready' });
        if (helperDir) send({ t: 'helper-status', s: 'available' });
        log(`files session opened: ${host.username}@${host.address}:${host.port}`);
        // ssh2 drops its own error listener once the channel is ready, so without this a
        // fatal SFTP protocol error is an unhandled 'error' event and would crash the process.
        stream.on('error', (err) => fail('sftp', 'RemoteHub couldn’t finish that file transfer. Try again.'));
        stream.on('close', () => {
          if (closed) return;
          send({ t: 'closed', reason: 'The Files connection ended.' });
          teardown();
        });
      });
    });

    conn.on('error', (err) => {
      secret = null;
      const { code, message } = describeSshError(err, host);
      fail(code, message);
    });

    conn.on('close', () => {
      secret = null;
      if (closed) return;
      send({ t: 'closed', reason: 'The connection was closed by the server.' });
      teardown();
    });

    conn.connect({
      sock: socket,
      username: host.username,
      password: secret,
      tryKeyboard: true,
      hostVerifier: verifyHostKey,
      readyTimeout: HOSTKEY_DECISION_TIMEOUT_MS + AUTH_TIMEOUT_MS,
      keepaliveInterval: 15_000,
      keepaliveCountMax: 4,
    });

    // Known hosts skip the confirmation step, so the login clock starts right away.
    if (store.getKnownHost(host.address, host.port)) {
      send({ t: 'status', s: 'authenticating' });
      authTimer = setTimeout(() => fail('timeout', 'The server stopped responding during login.'), AUTH_TIMEOUT_MS);
    }
  };

  // Dropping the entry makes every in-flight callback of the walk a no-op.
  const cancelSearch = (id) => {
    const entry = pending.get(id);
    clearTimeout(entry.timer);
    pending.delete(id);
    send({ t: 'error', id, code: 'cancelled', message: 'Search cancelled.' });
  };

  const handleOp = (op) => (message) => {
    if (!hasId(message.id)) return;
    // Ops before the session is ready are silently dropped, like pre-connect messages.
    if (!sftp) return;
    const path = MUTATIONS.has(op) ? mutationPath(message.path) : safePath(message.path);
    if (path === null) {
      send({
        t: 'error',
        id: message.id,
        code: 'path',
        message: `${op} failed: start the path with /.${MUTATIONS.has(op) ? ' Use a full path without . or .. in it.' : ''}`,
      });
      return;
    }
    runOp(message.id, op, path, message);
  };

  ws.on('message', (raw, isBinary) => {
    if (closed) return;
    if (isBinary) {
      if (!transfers) return;
      const chunk = Buffer.isBuffer(raw) ? raw : Buffer.concat(Array.isArray(raw) ? raw : [Buffer.from(raw)]);
      transfers.onBinary(chunk);
      return;
    }
    let message;
    try {
      message = JSON.parse(raw.toString('utf8'));
    } catch {
      return fail('protocol', 'Malformed message from browser.');
    }
    switch (message?.t) {
      case 'connect':
        if (started) return;
        started = true;
        start(message).catch((err) => fail('internal', `Unexpected error: ${err.message}`));
        break;
      case 'hostkey':
        decideHostKey(message.accept === true);
        break;
      case 'list':
        handleOp('list')(message);
        break;
      case 'stat':
        handleOp('stat')(message);
        break;
      case 'realpath':
        handleOp('realpath')(message);
        break;
      case 'read':
        handleOp('read')(message);
        break;
      case 'search':
        handleOp('search')(message);
        break;
      case 'mkdir':
      case 'rename':
      case 'move':
      case 'delete':
        handleOp(message.t)(message);
        break;
      case 'watch': {
        if (!sftp) return;
        const path = safePath(message.path);
        if (path === null || path === '.') return;
        watchPath = path;
        if (!agentWatch) {
          // A helper being started or stopped reports its own status when ready.
          if (!helper) send({ t: 'watch-status', s: 'off', path, reason: 'live updates are disabled' });
          return;
        }
        agentWatch.watch(path);
        break;
      }
      case 'unwatch':
        watchPath = null;
        agentWatch?.unwatch();
        break;
      case 'helper-start':
        startHelper();
        break;
      case 'helper-stop':
        stopHelper('Stopped from RemoteHub.');
        break;
      case 'get':
      case 'put':
      case 'put-end':
      case 'ack':
      case 'cancel':
        if (message.t === 'cancel' && hasId(message.id) && pending.get(message.id)?.search) {
          cancelSearch(message.id);
          break;
        }
        if (!transfers || !hasId(message.id)) return;
        if (mutationPending && (message.t === 'get' || message.t === 'put')) {
          send({ t: 'error', id: message.id, code: 'busy', message: 'A file action is still running.' });
          return;
        }
        transfers.onControl(message, hasId);
        break;
      default:
        break;
    }
  });

  ws.on('close', teardown);
  ws.on('error', teardown);
}
