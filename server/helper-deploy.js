// Temporary helper deployment over SSH/SFTP (SAA-299).
//
// For a host without the persistent agent, the Files session can run the same
// Rust binary temporarily, with nothing installed:
//
//  1. detect OS/architecture (`uname -sm` over the session's SSH connection)
//  2. choose the matching helper binary from HELPER_DIR
//  3. upload it over SFTP into a fresh private directory
//     /tmp/remotehub-helper-<random> (0700, created exclusively)
//  4. mint a short-lived single-use token and write it next to the binary (0600)
//  5. run `remotehub-agent --mode temporary --helper-token-file ... --helper-cleanup`
//     over an SSH exec channel
//  6. the helper's control channel is that exec channel (stdin/stdout): it is
//     opened from RemoteHub's existing SSH session, so the host needs no
//     listening port and does not need to reach RemoteHub
//  7. RemoteHub redeems the token in `hello`; the session gains live updates
//  8. on close the channel ends; the helper exits and deletes itself
//  9. RemoteHub then removes anything left over SFTP and confirms the
//     directory is gone
// 10. the token is invalidated (it was already single-use)
//
// Failures at any step remove whatever was uploaded. Secrets (the SSH password,
// the helper token) are never logged or sent to the browser.

import { createHash, randomBytes } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import path from 'node:path';

export const HELPER_DIR_PREFIX = 'remotehub-helper-';
export const HELPER_TMP_BASE = '/tmp';
// The token must be redeemed (the helper's hello answered) within this window.
export const HELPER_TOKEN_TTL_MS = 60_000;
// The helper itself exits if not authenticated within this many seconds.
export const HELPER_TTL_SECS = 60;
// How long a stopping helper may take to exit before its channel is killed.
export const HELPER_STOP_TIMEOUT_MS = 5_000;
// Bound on any single setup command (uname).
export const HELPER_EXEC_TIMEOUT_MS = 10_000;
// Stale-helper sweep: only folders older than this are candidates.
export const HELPER_STALE_SECS = 60 * 60;
// Exactly the names deployHelper creates.
const HELPER_DIR_NAME = /^remotehub-helper-[0-9a-f]{16}$/;
const S_IFMT = 0o170000;
const S_IFDIR = 0o040000;
const S_IFREG = 0o100000;
const S_IFLNK = 0o120000;
const UPLOAD_CHUNK = 32 * 1024;
const UPLOAD_PARALLEL = 16;
const STDERR_TAIL = 2048;

const SUPPORTED = {
  os: { Linux: 'linux', Darwin: 'macos' },
  arch: { x86_64: 'x86_64', amd64: 'x86_64', aarch64: 'aarch64', arm64: 'aarch64' },
};

/** Map `uname -sm` output to a helper platform, or null if unsupported. */
export function parsePlatform(output) {
  const [kernel, machine] = String(output ?? '').trim().split(/\s+/);
  const os = SUPPORTED.os[kernel];
  const arch = SUPPORTED.arch[machine];
  return os && arch ? { os, arch } : null;
}

export function helperBinaryName({ os, arch }) {
  return `remotehub-agent-${os}-${arch}`;
}

/** POSIX single-quote a shell word. */
export function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

/** An error whose `message` is safe to show the user (no secrets, no raw paths of the server). */
export class HelperError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.code = code;
    Object.assign(this, extra);
  }
}

/**
 * Short-lived single-use tokens. Only SHA-256 digests are stored; the raw token
 * lives in the deploy closure and in the helper's token file (which the helper
 * deletes on start).
 */
export function createHelperTokens({ ttlMs = HELPER_TOKEN_TTL_MS, now = Date.now } = {}) {
  const entries = new Map(); // digest -> expiresAt
  const digest = (token) => createHash('sha256').update(String(token)).digest('hex');
  const sweep = () => {
    const at = now();
    for (const [key, expiresAt] of entries) if (expiresAt <= at) entries.delete(key);
  };
  return {
    mint() {
      sweep();
      const token = randomBytes(32).toString('hex');
      entries.set(digest(token), now() + ttlMs);
      return token;
    },
    /** True exactly once per unexpired token; false for unknown, used or expired. */
    consume(token) {
      if (typeof token !== 'string' || !token) return false;
      const key = digest(token);
      const expiresAt = entries.get(key);
      entries.delete(key);
      return expiresAt !== undefined && now() < expiresAt;
    },
    invalidate(token) {
      if (typeof token === 'string') entries.delete(digest(token));
    },
    get size() {
      sweep();
      return entries.size;
    },
  };
}

// One registry per server process.
export const helperTokens = createHelperTokens();

// ---- small promise wrappers over ssh2 -------------------------------------------

// The process list can be large on a busy host; past this it counts as unreadable.
const MAX_PS_BYTES = 8 * 1024 * 1024;

/** Run a command and collect stdout. Output beyond `maxBytes` rejects (never silently truncated). */
export function execText(conn, command, timeoutMs = HELPER_EXEC_TIMEOUT_MS, maxBytes = 4096) {
  return new Promise((resolve, reject) => {
    conn.exec(command, (err, stream) => {
      if (err) return reject(new HelperError('exec', 'The computer refused to run a command.'));
      let out = '';
      let tooLong = false;
      const timer = setTimeout(() => { try { stream.close(); } catch {} reject(new HelperError('exec', 'The computer did not answer in time.')); }, timeoutMs);
      stream.on('data', (chunk) => {
        if (tooLong) return;
        out += chunk;
        if (out.length > maxBytes) {
          tooLong = true;
          out = '';
        }
      });
      stream.stderr?.on('data', () => {});
      stream.on('close', () => {
        clearTimeout(timer);
        if (tooLong) reject(new HelperError('exec', 'The computer printed more output than expected.'));
        else resolve(out);
      });
    });
  });
}

export const sftpCall = (sftp, method, ...args) => new Promise((resolve, reject) => {
  sftp[method](...args, (err, value) => (err ? reject(err) : resolve(value)));
});
const isMissing = (err) => err?.code === 2 || err?.code === 'ENOENT';

export async function uploadFile(sftp, localPath, remotePath, mode) {
  const data = await fsp.readFile(localPath);
  await writeExclusive(sftp, remotePath, data, mode);
}

export async function writeExclusive(sftp, remotePath, data, mode) {
  // 'wx' = O_CREAT|O_EXCL: never follows or reuses something already at the path.
  const handle = await sftpCall(sftp, 'open', remotePath, 'wx', { mode });
  try {
    // Keep several writes in flight: one round trip per chunk is slow over real links.
    let nextOffset = 0;
    const worker = async () => {
      while (nextOffset < data.length) {
        const offset = nextOffset;
        const length = Math.min(UPLOAD_CHUNK, data.length - offset);
        nextOffset += length;
        await new Promise((resolve, reject) => sftp.write(handle, data, offset, length, offset, (err) => (err ? reject(err) : resolve())));
      }
    };
    await Promise.all(Array.from({ length: UPLOAD_PARALLEL }, worker));
  } finally {
    await sftpCall(sftp, 'close', handle).catch(() => {});
  }
  // Some servers ignore the mode on open; set it explicitly.
  await sftpCall(sftp, 'chmod', remotePath, mode);
}

/**
 * Remove the helper's files and directory over SFTP; resolves true once the directory is confirmed gone.
 * `names` lists the files inside `dir`; the default is what a temporary helper creates.
 */
export async function removeHelperFiles(sftp, dir, names = ['session-token', 'remotehub-agent']) {
  for (const name of names) {
    await sftpCall(sftp, 'unlink', `${dir}/${name}`).catch(() => {});
  }
  await sftpCall(sftp, 'rmdir', dir).catch(() => {});
  try {
    await sftpCall(sftp, 'lstat', dir);
    return false;
  } catch (err) {
    return isMissing(err);
  }
}

/**
 * Lists the working directory of every process the host lets us see, one
 * `C <path>` line each, then `RH_CWD_OK`. Linux reads /proc/<pid>/cwd; elsewhere
 * (macOS) `lsof -d cwd`. A process of our own user whose cwd cannot be read prints
 * `RH_CWD_UNREADABLE`; no usable source prints `RH_CWD_NONE`. Either keeps every folder.
 */
export const CWD_COMMAND = [
  'if [ -L /proc/self/cwd ]; then',
  '  for p in /proc/[0-9]*; do',
  '    c=$(readlink "$p/cwd" 2>/dev/null) || {',
  // Zombies have no working directory; any other own process we cannot read is a doubt.
  // Processes of OTHER users (normally root) whose cwd we cannot read are skipped on
  // purpose (`[ -O "$p" ]`): helper folders are 0700 and owned by the SSH user, so only
  // that user or root can be inside one. The root-in-folder risk is accepted.
  '      if [ -d "$p" ] && [ -O "$p" ] && ! grep -q "^State:[[:space:]]*Z" "$p/status" 2>/dev/null; then echo RH_CWD_UNREADABLE; fi',
  '      continue',
  '    }',
  "    printf 'C %s\\n' \"$c\"",
  '  done',
  '  echo RH_CWD_OK',
  'elif command -v lsof >/dev/null 2>&1; then',
  '  out=$(lsof -nP -a -d cwd -u "$(id -u)" -Fn 2>/dev/null) || { echo RH_CWD_NONE; exit 0; }',
  "  printf '%s\\n' \"$out\" | sed -n 's/^n/C /p'",
  '  echo RH_CWD_OK',
  'else',
  '  echo RH_CWD_NONE',
  'fi',
].join('\n');

/** Any symlink or multiply-linked non-directory inside `dir`, never following links. */
export function linkCheckCommand(dir) {
  return `find -P ${shellQuote(dir)} -mindepth 1 \\( -type l -o \\( ! -type d -links +1 \\) \\) -print && echo RH_FIND_OK`;
}

/** @returns {string[]|null} process working directories, or null when they cannot all be read */
function parseCwds(output) {
  const lines = output.split('\n');
  if (!lines.includes('RH_CWD_OK') || lines.includes('RH_CWD_UNREADABLE') || lines.includes('RH_CWD_NONE')) return null;
  return lines.filter((line) => line.startsWith('C ')).map((line) => line.slice(2));
}

/**
 * Remove leftovers of earlier helpers that could not clean up (e.g. the SSH
 * connection dropped while the helper was SIGKILLed). A folder in `tmpBase` is
 * removed only if ALL of these hold:
 *  - its name is exactly `remotehub-helper-<16 hex>`;
 *  - lstat (never stat) says it is a real directory, not a symlink;
 *  - it is owned by the SSH user (uid from `id -u` on the host);
 *  - its mtime is older than `staleSecs` by the host's own clock;
 *  - its permissions are private (no group/other bits), as RemoteHub creates it;
 *  - no running process references a path inside it (`ps -ww -A -o args=`);
 *  - no process has its working directory inside it (CWD_COMMAND; if the
 *    working directories cannot be read, every folder is kept);
 *  - it contains only regular files, none of them a link of any kind: a symlink
 *    or a hard link (nlink > 1) inside keeps the folder (checked over SFTP and
 *    with `find -P`, which never follows links). Any subdirectory keeps it too.
 * Any doubt keeps the folder. Sweep errors never block a deploy.
 * @returns {Promise<{removed: string[], kept: {name: string, reason: string}[]}>}
 */
export async function sweepStaleHelpers({ conn, sftp, tmpBase = HELPER_TMP_BASE, staleSecs = HELPER_STALE_SECS, log = () => {} }) {
  const result = { removed: [], kept: [] };
  const keep = (name, reason) => result.kept.push({ name, reason });
  const [uidText, nowText] = (await execText(conn, 'id -u; date +%s')).trim().split(/\s+/);
  const uid = Number(uidText);
  const hostNow = Number(nowText);
  if (!Number.isInteger(uid) || !Number.isInteger(hostNow)) throw new HelperError('sweep', 'Could not read the computer’s user or clock.');

  const listing = await sftpCall(sftp, 'readdir', tmpBase);
  const candidates = [];
  for (const { filename: name } of listing) {
    if (!HELPER_DIR_NAME.test(name)) continue;
    const dir = `${tmpBase}/${name}`;
    // Fresh lstat (readdir attrs can be stale); lstat never follows a symlink.
    let attrs;
    try {
      attrs = await sftpCall(sftp, 'lstat', dir);
    } catch {
      continue;
    }
    if ((attrs.mode & S_IFMT) === S_IFLNK) { keep(name, 'symlink'); continue; }
    if ((attrs.mode & S_IFMT) !== S_IFDIR) { keep(name, 'not a directory'); continue; }
    if (attrs.uid !== uid) { keep(name, 'other owner'); continue; }
    if (hostNow - attrs.mtime < staleSecs) { keep(name, 'fresh'); continue; }
    if (attrs.mode & 0o077) { keep(name, 'shared permissions'); continue; }
    candidates.push({ name, dir });
  }
  // No candidate passed the name/owner/age/not-symlink/0700 checks: skip the
  // process, working-directory and link scans entirely.
  if (!candidates.length) return result;

  // One process listing for all candidates. If it cannot be read, keep everything.
  const processes = await execText(conn, 'ps -ww -A -o args=', HELPER_EXEC_TIMEOUT_MS, MAX_PS_BYTES).catch(() => '');
  if (!processes.trim()) {
    for (const { name } of candidates) keep(name, 'process list unavailable');
    return result;
  }
  // Working directories: a shell sitting in the folder counts as in use.
  const cwds = parseCwds(await execText(conn, CWD_COMMAND, HELPER_EXEC_TIMEOUT_MS, MAX_PS_BYTES).catch(() => ''));
  if (!cwds) {
    for (const { name } of candidates) keep(name, 'working directories unavailable');
    return result;
  }
  for (const { name, dir } of candidates) {
    if (processes.includes(`${dir}/`)) { keep(name, 'in use'); continue; }
    // macOS reports /private/tmp/... for /tmp/...: compare against both spellings.
    const real = await sftpCall(sftp, 'realpath', dir).catch(() => dir);
    const inside = (cwd) => [dir, real].some((d) => cwd === d || cwd.startsWith(`${d}/`));
    if (cwds.some(inside)) { keep(name, 'in use (working directory)'); continue; }
    let entries;
    try {
      entries = await sftpCall(sftp, 'readdir', dir);
    } catch {
      keep(name, 'unreadable');
      continue;
    }
    const children = entries.filter(({ filename }) => filename !== '.' && filename !== '..');
    const kinds = children.map(({ attrs }) => attrs.mode & S_IFMT);
    if (kinds.includes(S_IFLNK)) { keep(name, 'contains a link'); continue; }
    if (kinds.some((kind) => kind !== S_IFREG)) { keep(name, 'unexpected contents'); continue; }
    // SFTP attrs carry no link count: ask the host for hard links (and symlinks again).
    const links = await execText(conn, linkCheckCommand(dir)).catch(() => null);
    if (links === null || !links.split('\n').includes('RH_FIND_OK')) { keep(name, 'link check unavailable'); continue; }
    if (links.trim() !== 'RH_FIND_OK') { keep(name, 'contains a link'); continue; }
    try {
      for (const { filename } of children) await sftpCall(sftp, 'unlink', `${dir}/${filename}`);
      await sftpCall(sftp, 'rmdir', dir);
      result.removed.push(name);
    } catch {
      keep(name, 'could not remove');
    }
  }
  if (result.removed.length) log(`swept ${result.removed.length} stale temporary helper folder(s)`);
  return result;
}

/**
 * Deploy and start a temporary helper.
 * @returns {Promise<object>} handle: { platform, dir, open, readToken, onExit, stop }
 */
export async function deployHelper({ conn, sftp, helperDir, root, tokens = helperTokens, log = () => {}, tmpBase = HELPER_TMP_BASE, ttlSecs = HELPER_TTL_SECS, sweep = {} }) {
  if (!helperDir) throw new HelperError('disabled', 'Temporary connections are not set up on this RemoteHub server.');
  const platform = parsePlatform(await execText(conn, 'uname -sm'));
  if (!platform) throw new HelperError('unsupported', 'A temporary connection isn\u2019t available for this computer\u2019s system yet. It works on Linux and Mac computers.');
  const binary = path.join(helperDir, helperBinaryName(platform));
  try {
    await fsp.access(binary);
  } catch {
    throw new HelperError('no-binary', `This RemoteHub server has no ${helperBinaryName(platform)} helper build.`);
  }
  try {
    await sweepStaleHelpers({ conn, sftp, tmpBase, log, ...sweep });
  } catch {
    log('stale temporary helper sweep skipped');
  }

  const dir = `${tmpBase}/${HELPER_DIR_PREFIX}${randomBytes(8).toString('hex')}`;
  const exe = `${dir}/remotehub-agent`;
  const tokenPath = `${dir}/session-token`;
  let token = null;
  let created = false;
  const abort = async (error) => {
    tokens.invalidate(token);
    token = null;
    const cleaned = created ? await removeHelperFiles(sftp, dir).catch(() => false) : true;
    log(`temporary helper deploy failed (${error.code || 'error'}); cleanup ${cleaned ? 'confirmed' : 'incomplete'}`);
    if (error instanceof HelperError) {
      error.cleaned = cleaned;
      throw error;
    }
    throw new HelperError('deploy', 'Could not upload the temporary connection to the computer.', { cleaned });
  };

  let channel;
  try {
    await sftpCall(sftp, 'mkdir', dir, { mode: 0o700 }); // fails if the name exists
    created = true;
    const attrs = await sftpCall(sftp, 'lstat', dir);
    if (!attrs.isDirectory?.() && (attrs.mode & 0o170000) !== 0o040000) throw new HelperError('deploy', 'The helper directory could not be created safely.');
    await sftpCall(sftp, 'chmod', dir, 0o700);
    await uploadFile(sftp, binary, exe, 0o700);
    token = tokens.mint();
    await writeExclusive(sftp, tokenPath, Buffer.from(`${token}\n`), 0o600);
    const command = [
      'exec', shellQuote(exe), '--mode', 'temporary', '--root', shellQuote(root),
      '--helper-token-file', shellQuote(tokenPath), '--helper-cleanup', '--helper-ttl', String(ttlSecs),
    ].join(' ');
    channel = await new Promise((resolve, reject) => conn.exec(command, (err, stream) => (err ? reject(new HelperError('exec', 'The computer refused to start the temporary connection.')) : resolve(stream))));
  } catch (error) {
    return abort(error);
  }
  log(`temporary helper started (${platform.os}-${platform.arch})`);

  let exited = false;
  let exitCode = null;
  let stderrTail = '';
  const exitWaiters = [];
  channel.stderr?.on('data', (chunk) => { stderrTail = (stderrTail + chunk).slice(-STDERR_TAIL); });
  channel.on('exit', (code) => { exitCode = code; });
  channel.on('close', () => {
    exited = true;
    for (const waiter of exitWaiters.splice(0)) waiter();
  });
  const whenExited = () => (exited ? Promise.resolve() : new Promise((resolve) => exitWaiters.push(resolve)));
  let opened = false;
  let stopping = null;

  return {
    platform,
    dir,
    /** One-shot: the helper's control channel. */
    open(done) {
      if (opened || exited) return done(new Error('the temporary connection has ended'));
      opened = true;
      done(null, channel);
    },
    /** Redeem the single-use token for the hello; fails if expired or already used. */
    readToken(done) {
      if (!token || !tokens.consume(token)) return done(new Error('helper token expired or already used'));
      done(null, token);
    },
    onExit(callback) {
      whenExited().then(callback);
    },
    get exited() {
      return exited;
    },
    get stderrTail() {
      return stderrTail;
    },
    /** End the session, wait for the helper to exit, then confirm cleanup. */
    stop() {
      if (stopping) return stopping;
      stopping = (async () => {
        if (!exited) {
          try { channel.end(); } catch {}
          let timer;
          await Promise.race([whenExited(), new Promise((resolve) => { timer = setTimeout(resolve, HELPER_STOP_TIMEOUT_MS); })]);
          clearTimeout(timer);
          if (!exited) {
            try { channel.signal?.('KILL'); } catch {}
            try { channel.close(); } catch {}
          }
        }
        tokens.invalidate(token);
        token = null;
        const cleaned = await removeHelperFiles(sftp, dir).catch(() => false);
        log(`temporary helper stopped${exitCode === null ? '' : ` (exit ${exitCode})`}; cleanup ${cleaned ? 'confirmed' : 'incomplete'}`);
        return { cleaned, exitCode };
      })();
      return stopping;
    },
  };
}
