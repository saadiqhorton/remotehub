// One-click install of the persistent RemoteHub agent (SAA-317).
//
// The owner types a computer's SSH password once, in the host dialog. RemoteHub logs in the
// same way ssh-bridge does, uploads the matching agent build into a fresh private folder,
// issues the computer's agent credential, and runs `remotehub-agent install` there. The agent
// copies itself and its token into a per-user location, registers a background service, and
// that service dials back on its own. The temporary folder is removed afterwards, whether or
// not the install worked.
//
// Secrets: the SSH password is held only for the login exchange and then dropped. The raw
// agent token is written only to a 0600 file inside the 0700 folder. It is never logged, never
// returned, and never placed on a command line. A host key follows ssh-bridge's rules: a known
// fingerprint must match; a new one is trusted only when the owner accepted that exact value.

import { randomBytes } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import ssh2 from 'ssh2';
import { AGENT_CLOSE, redactSecrets } from './agent-auth.js';
import { AUTH_TIMEOUT_MS, describeSocketError, describeSshError, fingerprintOf, keyTypeOf, openSocket } from './ssh-bridge.js';
import {
  HELPER_TMP_BASE, HelperError, execText, helperBinaryName, parsePlatform, removeHelperFiles,
  shellQuote, sftpCall, uploadFile, writeExclusive,
} from './helper-deploy.js';

const { Client } = ssh2;

export const INSTALL_DIR_PREFIX = 'remotehub-install-';
// Bounded by the brief: the agent's own installer is given this long, then abandoned.
export const INSTALL_TIMEOUT_MS = 60_000;
// How long the install waits for the agent to dial back in before the response says it has not
// connected yet. The dialog polls the host list every few seconds, so this is a hint, not proof.
export const INSTALL_CONNECT_WAIT_MS = 3_000;
// Last part of the agent's stderr kept for the failure reason.
export const INSTALL_STDERR_TAIL = 2048;
const AGENT_FILE = 'remotehub-agent';
const TOKEN_FILE = 'agent.token';
const REASON_MAX = 300;
const S_IFMT = 0o170000;
const S_IFDIR = 0o040000;

// HTTP status per failure code. 401 is deliberately absent: the browser treats 401 as an expired
// RemoteHub session and signs the owner out, and an SSH login failure is not that.
export const INSTALL_STATUS = {
  busy: 409,
  'hostkey-new': 409,
  'hostkey-mismatch': 409,
  auth: 403,
  timeout: 504,
  network: 502,
  ssh: 502,
  sftp: 502,
  exec: 502,
  unsupported: 400,
  'no-binary': 503,
  deploy: 502,
  'install-rejected': 502,
  'install-failed': 502,
  'install-timeout': 504,
  'not-connected': 502,
  'not-found': 404,
};

const inFlight = new Set();

/**
 * The agent's --server value for this RemoteHub, or null. Only ws:// or wss:// and only the host
 * and port this request arrived on, so an agent can never be pointed at another server.
 * Returns the bare `ws(s)://host[:port]`: the agent adds its own /ws/agent path.
 */
export function agentServerUrl(raw, requestedHost) {
  if (typeof raw !== 'string' || raw.length > 512) return null;
  let url;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'ws:' && url.protocol !== 'wss:') return null;
  if (url.username || url.password) return null;
  if (!requestedHost || url.host.toLowerCase() !== String(requestedHost).toLowerCase()) return null;
  return `${url.protocol}//${url.host}`;
}

const LOOPBACK = /^(localhost|127(?:\.\d{1,3}){3}|\[?::1\]?)$/i;

/**
 * Whether an agent on `targetAddress` could reach `serverUrl`. A RemoteHub opened as localhost
 * names this machine, which another computer can't dial: the agent would never connect.
 */
export function reachableFrom(serverUrl, targetAddress) {
  const server = new URL(serverUrl).hostname;
  return !LOOPBACK.test(server) || LOOPBACK.test(String(targetAddress ?? '').trim());
}

/**
 * Log in the way ssh-bridge does. A known host key must match. A new one is accepted only when it
 * equals `acceptFingerprint`, and it is then saved. Anything else stops the login before the
 * password is sent, and the refusal carries the fingerprint so the owner can check it.
 * @returns {Promise<import('ssh2').Client>} a logged-in client
 */
export async function connectForInstall({ host, password, acceptFingerprint = null, store, log = () => {} }) {
  let socket;
  try {
    socket = await openSocket(host.address, host.port);
  } catch (err) {
    throw new HelperError('network', describeSocketError(err, host));
  }
  socket.on('error', () => {});

  // The password is held only for this login exchange.
  let secret = password;
  let keyboardAnswered = false;
  let refusal = null;
  const conn = new Client();

  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (error) => {
      if (settled) return;
      settled = true;
      secret = null;
      if (error) {
        try { conn.end(); } catch {}
        try { socket.destroy(); } catch {}
        reject(error);
      } else {
        resolve(conn);
      }
    };

    conn.on('keyboard-interactive', (_name, _instructions, _lang, prompts, answer) => {
      if (keyboardAnswered || !secret) return answer([]);
      keyboardAnswered = true;
      answer(prompts.map((prompt) => (prompts.length === 1 || /pass/i.test(prompt.prompt) ? secret : '')));
    });
    conn.on('ready', () => settle(null));
    conn.on('error', (err) => {
      if (refusal) return settle(new HelperError(refusal.code, refusal.message, refusal.extra));
      const { code, message } = describeSshError(err, host);
      settle(new HelperError(code, message));
    });
    conn.on('close', () => settle(new HelperError('ssh', 'The computer closed the connection during login.')));

    conn.connect({
      sock: socket,
      username: host.username,
      password: secret,
      tryKeyboard: true,
      readyTimeout: AUTH_TIMEOUT_MS,
      hostVerifier: (keyBlob, verify) => {
        const fingerprint = fingerprintOf(keyBlob);
        const keyType = keyTypeOf(keyBlob);
        const known = store.getKnownHost(host.address, host.port);
        if (known) {
          if (known.fingerprint === fingerprint) verify(true);
          else {
            refusal = {
              code: 'hostkey-mismatch',
              message: 'The identity of this computer changed since RemoteHub last connected to it. Nothing was installed.',
            };
            verify(false);
          }
          return;
        }
        if (acceptFingerprint !== fingerprint) {
          refusal = {
            code: 'hostkey-new',
            message: 'First time connecting to this computer. Check its fingerprint before trusting it.',
            extra: { fingerprint, keyType },
          };
          verify(false);
          return;
        }
        // Saved before login, as ssh-bridge does; a failed save is logged and the trust still applies.
        store.setKnownHost(host.address, host.port, { keyType, fingerprint })
          .catch((err) => log(`could not save fingerprint: ${err.message}`))
          .then(() => verify(true));
      },
    });
  });
}

async function openSftp(conn) {
  return new Promise((resolve, reject) => {
    conn.sftp((err, sftp) => {
      if (err) reject(new HelperError('sftp', 'RemoteHub logged in, but this computer would not open a file channel for the install.'));
      else resolve(sftp);
    });
  });
}

async function detectPlatform(conn) {
  const output = await execText(conn, 'uname -sm').catch(() => '');
  const platform = parsePlatform(output);
  if (!platform) {
    throw new HelperError('unsupported', output.trim()
      ? 'The agent can be installed only on Linux and Mac computers. This computer runs a different system.'
      : 'RemoteHub couldn’t tell what system this computer runs, so the agent can’t be installed here.');
  }
  return platform;
}

async function binaryFor(helperDir, platform) {
  const name = helperBinaryName(platform);
  const missing = new HelperError('no-binary', `This RemoteHub server has no agent build for that system (${platform.os}, ${platform.arch}).`);
  if (!helperDir) throw missing;
  const file = path.join(helperDir, name);
  try {
    await fsp.access(file);
  } catch {
    throw missing;
  }
  return file;
}

/** Run the agent's installer over an exec channel; resolves with its exit code and the stderr tail. */
function runInstallCommand(conn, command, timeoutMs) {
  return new Promise((resolve, reject) => {
    conn.exec(command, (err, stream) => {
      if (err) return reject(new HelperError('exec', 'The computer refused to run the agent installer.'));
      let exitCode = null;
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ exitCode, stdout, stderr, timedOut });
      };
      const timer = setTimeout(() => {
        timedOut = true;
        try { stream.close(); } catch {}
        finish();
      }, timeoutMs);
      stream.stderr?.on('data', (chunk) => { stderr = (stderr + chunk).slice(-INSTALL_STDERR_TAIL); });
      stream.on('data', (chunk) => { stdout = (stdout + chunk).slice(-INSTALL_STDERR_TAIL); });
      stream.on('exit', (code) => { exitCode = code; });
      stream.on('close', finish);
    });
  });
}

/** The agent's own one-line reason: the last non-empty line of `text`, without the `remotehub-agent install:` prefix. */
function lastLine(text) {
  const lines = redactSecrets(text).split('\n').map((line) => line.trim()).filter(Boolean);
  return (lines.pop() || '').replace(/^remotehub-agent\s+\S+:\s*/, '').slice(0, REASON_MAX);
}

function installFailure({ exitCode, stdout, stderr }) {
  const reason = lastLine(stderr) || lastLine(stdout) || `it printed no reason (exit ${exitCode ?? 'unknown'})`;
  if (exitCode === 2) return new HelperError('install-rejected', `The agent didn’t accept the install settings: ${reason}`);
  return new HelperError('install-failed', `The agent couldn’t be installed as a background service on this computer: ${reason}`);
}

async function runInstall({ store, registry, host: hostRef, password, acceptFingerprint, serverUrl, helperDir, log, tmpBase, timeoutMs, connectTimeoutMs, connect }) {
  const hostId = hostRef.id;
  let label = 'unknown';
  let conn = null;
  let sftp = null;
  let dir = null;
  let dirCreated = false;
  let credentialIssued = false;
  let failure = null;
  try {
    const host = store.getHost(hostId);
    if (!host) throw new HelperError('not-found', 'Computer not found.');
    conn = await connect({ host, password, acceptFingerprint, store, log });
    sftp = await openSftp(conn);
    const platform = await detectPlatform(conn);
    label = `${platform.os}-${platform.arch}`;
    const binary = await binaryFor(helperDir, platform);

    // A fresh folder that nothing else can name: mkdir fails if the name is taken.
    dir = `${tmpBase}/${INSTALL_DIR_PREFIX}${randomBytes(8).toString('hex')}`;
    const exe = `${dir}/${AGENT_FILE}`;
    const tokenPath = `${dir}/${TOKEN_FILE}`;
    await sftpCall(sftp, 'mkdir', dir, { mode: 0o700 });
    dirCreated = true;
    const attrs = await sftpCall(sftp, 'lstat', dir);
    if ((attrs.mode & S_IFMT) !== S_IFDIR) throw new HelperError('deploy', 'The install folder could not be created safely on this computer.');
    await sftpCall(sftp, 'chmod', dir, 0o700);
    await uploadFile(sftp, binary, exe, 0o700);

    // The credential is issued only once the agent is on the computer, so a failed upload leaves no key behind.
    const issued = await store.issueAgentCredential(hostId);
    if (!issued) throw new HelperError('not-found', 'Computer not found.');
    credentialIssued = true;
    registry.disconnect(hostId, AGENT_CLOSE.REPLACED, 'credential replaced');
    await writeExclusive(sftp, tokenPath, Buffer.from(`${issued.token}\n`), 0o600);

    const command = [
      'exec', shellQuote(exe), 'install',
      '--server', shellQuote(serverUrl),
      '--host-id', shellQuote(hostId),
      '--token-file', shellQuote(tokenPath),
    ].join(' ');
    const run = await runInstallCommand(conn, command, timeoutMs);
    if (run.timedOut) throw new HelperError('install-timeout', `The computer didn’t finish installing the agent within ${timeoutMs / 1000} seconds.`);
    if (run.exitCode !== 0) throw installFailure(run);
  } catch (error) {
    failure = error instanceof HelperError
      ? error
      : new HelperError('deploy', 'The agent couldn’t be installed on this computer.');
    if (!(error instanceof HelperError)) log(`agent install unexpected failure code=${error?.code ?? 'none'}`);
  }

  // Always: the temporary folder (it holds the token), then the SSH connection.
  if (dirCreated && sftp) {
    const cleaned = await removeHelperFiles(sftp, dir, [TOKEN_FILE, AGENT_FILE]).catch(() => false);
    if (!cleaned) log(`agent install cleanup incomplete host=${hostId}`);
  }
  try { sftp?.end(); } catch {}
  try { conn?.end(); } catch {}

  if (failure && credentialIssued) {
    // Nothing that was issued for this install may stay valid if the install did not finish.
    await store.revokeAgentCredential(hostId).catch(() => {});
    registry.disconnect(hostId, AGENT_CLOSE.REVOKED, 'revoked');
  }
  let connected = false;
  if (!failure) {
    // The install command only starts the service. Note whether it dialled back in, so the
    // response can say so; the dialog keeps polling and shows Connected when it arrives.
    connected = await waitForAgent(registry, hostId, connectTimeoutMs);
  }
  log(`agent install host=${hostId} platform=${label} outcome=${failure ? failure.code : 'installed'}`);
  if (failure) throw failure;
  return { host: store.getHost(hostId), platform: label, connected };
}

/** Poll until the registry reports the agent connected, or the deadline passes. */
function waitForAgent(registry, hostId, timeoutMs) {
  if (timeoutMs <= 0) return Promise.resolve(registry.isConnected(hostId));
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const poll = () => {
      if (registry.isConnected(hostId)) return resolve(true);
      if (Date.now() >= deadline) return resolve(false);
      setTimeout(poll, 250).unref?.();
    };
    poll();
  });
}

/**
 * Install the persistent agent on one computer.
 * @param {object} options
 * @param {object} options.store the server Store (host records, known hosts, credentials)
 * @param {object} options.registry the AgentRegistry (drops an agent it replaces or revokes)
 * @param {object} options.host the host record (only `id` is read here; the rest is re-read)
 * @param {string} options.password the SSH password; used for the login exchange only
 * @param {string|null} [options.acceptFingerprint] the fingerprint the owner accepted for a new host key
 * @param {string} options.serverUrl the validated ws(s)://host[:port] the agent should dial
 * @param {string|null} [options.helperDir] HELPER_DIR, holding remotehub-agent-<os>-<arch> builds
 * @param {Function} [options.log] one line per install; never receives a secret
 * @param {string} [options.tmpBase] where the temporary folder is created (default /tmp)
 * @param {number} [options.timeoutMs] limit on the agent's own installer
 * @param {Function} [options.connect] login function, injectable for tests
 * @returns {Promise<{host: object, platform: string}>}
 * @throws {HelperError} with a plain `message` and a `code` (INSTALL_STATUS)
 */
export async function installAgent({
  store,
  registry,
  host,
  password,
  acceptFingerprint = null,
  serverUrl,
  helperDir = null,
  log = () => {},
  tmpBase = HELPER_TMP_BASE,
  timeoutMs = INSTALL_TIMEOUT_MS,
  connectTimeoutMs = INSTALL_CONNECT_WAIT_MS,
  connect = connectForInstall,
}) {
  const hostId = host.id;
  if (inFlight.has(hostId)) throw new HelperError('busy', 'An install is already running on this computer. Wait for it to finish.');
  inFlight.add(hostId);
  try {
    return await runInstall({ store, registry, host, password, acceptFingerprint, serverUrl, helperDir, log, tmpBase, timeoutMs, connectTimeoutMs, connect });
  } finally {
    inFlight.delete(hostId);
  }
}
