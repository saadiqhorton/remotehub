import net from 'node:net';
import { createHash } from 'node:crypto';
import ssh2 from 'ssh2';

const { Client } = ssh2;

export const TCP_CONNECT_TIMEOUT_MS = 10_000;
export const HOSTKEY_DECISION_TIMEOUT_MS = 90_000;
export const AUTH_TIMEOUT_MS = 30_000;

// OpenSSH-style fingerprint of the raw host key blob, e.g. "SHA256:uNiVztksCsDhcc0u9e8BujQXVUpKZIDTMczCvj3tD2s".
export function fingerprintOf(keyBlob) {
  return `SHA256:${createHash('sha256').update(keyBlob).digest('base64').replace(/=+$/, '')}`;
}

// The host key blob starts with a length-prefixed algorithm name (RFC 4253 §6.6).
export function keyTypeOf(keyBlob) {
  if (!Buffer.isBuffer(keyBlob) || keyBlob.length < 4) return 'unknown';
  const length = keyBlob.readUInt32BE(0);
  if (length < 1 || length > 64 || 4 + length > keyBlob.length) return 'unknown';
  return keyBlob.toString('latin1', 4, 4 + length);
}

function clampSize(cols, rows) {
  const clamp = (value, min, max, fallback) =>
    Number.isInteger(value) ? Math.min(max, Math.max(min, value)) : fallback;
  return { cols: clamp(cols, 2, 500, 120), rows: clamp(rows, 2, 300, 32) };
}

export function openSocket(address, port) {
  return new Promise((resolve, reject) => {
    // SSH/SFTP is request-response: disable Nagle so each small SFTP packet goes out
    // immediately instead of waiting on the peer's delayed ACK (~40ms per round trip).
    const socket = net.connect({ host: address, port, noDelay: true });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(Object.assign(new Error('TCP connect timed out'), { code: 'ETIMEDOUT' }));
    }, TCP_CONNECT_TIMEOUT_MS);
    socket.once('connect', () => {
      clearTimeout(timer);
      socket.removeAllListeners('error');
      resolve(socket);
    });
    socket.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

export function describeSocketError(err, host) {
  const where = `${host.address}:${host.port}`;
  switch (err.code) {
    case 'ECONNREFUSED':
    case 'ECONNRESET': // WSL and some kernels report an empty port this way
      return 'Nothing answered when RemoteHub tried to connect to this computer.';
    case 'ETIMEDOUT':
    case 'EHOSTUNREACH':
    case 'ENETUNREACH':
      return `Couldn't reach ${where} within ${TCP_CONNECT_TIMEOUT_MS / 1000} seconds. Is the machine on?`;
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return `Couldn't find a machine named ${host.address} on the network.`;
    default:
      return `Couldn't connect to ${where} (${err.code || err.message}).`;
  }
}

export function describeSshError(err, host) {
  if (err.level === 'client-authentication') {
    return { code: 'auth', message: 'The server rejected that username and password.' };
  }
  if (err.level === 'client-timeout') {
    return { code: 'timeout', message: 'The server stopped responding during login.' };
  }
  // ssh2 sometimes surfaces a TCP refusal after connect() as a client error with a socket code.
  if (host && (err.code === 'ECONNREFUSED' || err.code === 'ECONNRESET'
    || /ECONNREFUSED|ECONNRESET/.test(String(err.message || '')))) {
    return { code: 'network', message: describeSocketError({ code: err.code || 'ECONNRESET' }, host) };
  }
  return { code: 'ssh', message: `SSH error: ${err.message}` };
}

/**
 * Bridges one browser WebSocket to one SSH shell.
 *
 * Browser -> server (JSON text frames):
 *   { t: 'connect', hostId, password, cols, rows }
 *   { t: 'hostkey', accept: boolean }
 *   { t: 'in', d: string }
 *   { t: 'resize', cols, rows }
 * Server -> browser: JSON text frames for control messages, binary frames for terminal output.
 */
export function attachTerminal(ws, { store, log }) {
  let host = null;
  let socket = null;
  let conn = null;
  let shell = null;
  let started = false;
  let closed = false;
  let pendingHostKey = null;
  let authTimer = null;

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
    try { shell?.end(); } catch {}
    try { conn?.end(); } catch {}
    try { socket?.destroy(); } catch {}
    if (ws.readyState === ws.OPEN) ws.close(1000);
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
    const pending = pendingHostKey;
    if (!pending) return;
    pendingHostKey = null;
    clearTimeout(pending.timer);
    if (!accept) {
      fail('hostkey-rejected', 'Fingerprint not trusted, so the connection was cancelled.');
      return pending.verify(false);
    }
    try {
      await store.setKnownHost(host.address, host.port, pending);
    } catch (err) {
      log(`could not save fingerprint: ${err.message}`);
    }
    if (closed) return;
    send({ t: 'status', s: 'authenticating' });
    authTimer = setTimeout(() => fail('timeout', 'The server stopped responding during login.'), AUTH_TIMEOUT_MS);
    pending.verify(true);
  };

  const start = async ({ hostId, password, cols, rows }) => {
    host = store.getHost(hostId);
    if (!host) return fail('host', 'That computer no longer exists.');
    if (typeof password !== 'string' || !password || password.length > 1024) {
      return fail('auth', 'Enter the SSH password for this machine.');
    }
    const size = clampSize(cols, rows);

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
      conn.shell({ term: 'xterm-256color', cols: size.cols, rows: size.rows }, (err, channel) => {
        if (err) return fail('shell', 'Logged in, but the server refused to open a shell.');
        if (closed) return channel.end();
        shell = channel;
        send({ t: 'status', s: 'ready' });
        log(`session opened: ${host.username}@${host.address}:${host.port}`);
        const forward = (chunk) => {
          if (ws.readyState === ws.OPEN) ws.send(chunk, { binary: true });
        };
        channel.on('data', forward);
        channel.stderr.on('data', forward);
        channel.on('close', () => {
          if (closed) return;
          send({ t: 'closed', reason: 'The remote shell exited.' });
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

  ws.on('message', (raw, isBinary) => {
    if (isBinary || closed) return;
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
      case 'in':
        if (shell && typeof message.d === 'string') shell.write(message.d);
        break;
      case 'resize': {
        if (!shell) return;
        const size = clampSize(message.cols, message.rows);
        shell.setWindow(size.rows, size.cols, 0, 0);
        break;
      }
      default:
        break;
    }
  });

  ws.on('close', teardown);
  ws.on('error', teardown);
}
