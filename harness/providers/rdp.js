// RDP provider (SAA-348): a private xrdp + xrdp-sesman per harness instance, with NO sudo.
//
// How it runs unprivileged (Linux only):
//  - `unshare -Ur -m -p -f --kill-child` gives a user namespace where the caller is uid 0,
//    a private mount namespace and a private PID namespace (killing the recorded unshare
//    process kills xrdp, sesman and every desktop session it started).
//  - Inside it, bind mounts replace (for this namespace only) /etc/xrdp, /run/xrdp,
//    /etc/pam.d/xrdp-sesman and /etc/passwd with private copies in the instance dir.
//  - Login is a harness-only user ("rhharness", uid 0 inside the namespace = you outside).
//    Its password is generated per instance and checked by pam_exec against a 0600 file.
//    No real system account or /etc/shadow is used.
//  - Two things a single-ID user namespace refuses are shimmed with a tiny LD_PRELOAD
//    library compiled at `up` time (needs a C compiler): setgroups/initgroups (sesman
//    sets secondary groups) and chown to an unmapped id (xterm's pty chown to group tty).
//  - Port: OS-assigned on 127.0.0.1. Displays: a free block of 10, reserved atomically and re-checked right before launch.
// Nothing outside the instance dir is written, and the system /etc/xrdp, /run/xrdp and any
// other xrdp are never touched.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

export const name = 'rdp';
export const USER = 'rhharness';
const XORG_DRIVER_DIRS = ['/usr/lib/xorg/modules/drivers', '/usr/lib64/xorg/modules/drivers', '/usr/local/lib/xorg/modules/drivers'];
const PAM_EXEC_DIRS = ['/lib/x86_64-linux-gnu/security', '/usr/lib/x86_64-linux-gnu/security', '/lib/aarch64-linux-gnu/security', '/usr/lib/aarch64-linux-gnu/security', '/lib64/security', '/usr/lib64/security', '/lib/security', '/usr/lib/security'];

function guacdHasRdp(guacd, exists) {
  if (!guacd) return false;
  const libDirs = [path.posix.join(path.posix.dirname(path.posix.dirname(guacd)), 'lib'), '/usr/lib/x86_64-linux-gnu', '/usr/lib/aarch64-linux-gnu', '/usr/lib64', '/usr/lib', '/usr/local/lib'];
  return libDirs.some((d) => exists(path.posix.join(d, 'libguac-client-rdp.so')) || exists(path.posix.join(d, 'libguac-client-rdp.so.0')));
}

// Read-only check of what only RDP needs. Returns { ok, issues } where each issue is
// { part, required: false, message, hint }: a plain first sentence plus an install hint.
// Pieces shared with VNC (the remote desktop helper and xterm) are checked by preflight,
// so they are reported once, not here; RDP is simply not ok without them.
export function probe({ tools, platform = process.platform, exists = fs.existsSync, which, userns = canUseUserNamespace } = {}) {
  const issue = (message, hint = null) => ({ part: 'rdp', required: false, message, hint });
  if (platform !== 'linux') return { ok: false, issues: [issue('RDP tests skipped: RDP tests only run on Linux.')] };
  const missing = [];
  if (!exists('/usr/sbin/xrdp') || !exists('/usr/sbin/xrdp-sesman')) missing.push('xrdp');
  if (!XORG_DRIVER_DIRS.some((d) => exists(path.posix.join(d, 'xrdpdev_drv.so')))) missing.push('xorgxrdp');
  if (!PAM_EXEC_DIRS.some((d) => exists(path.posix.join(d, 'pam_exec.so')))) missing.push('pam_exec (part of PAM)');
  const need = { unshare: 'unshare (util-linux)', openssl: 'openssl', cc: 'a C compiler (gcc or clang)' };
  for (const [bin, label] of Object.entries(need)) {
    const found = bin === 'cc' ? (tools?.cc ?? which?.('cc') ?? which?.('gcc') ?? which?.('clang')) : (tools?.[bin] ?? which?.(bin));
    if (!found) missing.push(label);
  }
  const issues = [];
  if (missing.length) issues.push(issue(missing.length === 1 ? "RDP tests skipped: a tool it needs isn't installed." : "RDP tests skipped: some tools it needs aren't installed.", `Install: ${missing.join(', ')}`));
  if (tools?.guacd && !guacdHasRdp(tools.guacd, exists)) issues.push(issue("RDP tests skipped: the remote desktop helper can't do RDP.", 'How to add RDP to it: see deploy/guacd.md'));
  const sharedOk = Boolean(tools?.guacd && tools?.xterm);
  if (issues.length || !sharedOk) return { ok: false, issues };
  if (!userns()) return { ok: false, issues: [issue("RDP tests skipped: this computer doesn't allow the private sandbox RDP tests need.", 'It needs unprivileged user namespaces turned on (an admin setting).')] };
  return { ok: true, issues: [] };
}

export function canUseUserNamespace() {
  const r = spawnSync('unshare', ['-Ur', '-m', '-p', '-f', 'true'], { stdio: 'ignore', timeout: 5000 });
  return r.status === 0;
}

const xSocket = (xDir, d) => path.join(xDir, '.X11-unix', `X${d}`);
const xLock = (xDir, d) => path.join(xDir, `.X${d}-lock`);

// True when no display in [start, start+size) has an X socket or lock file under xDir.
export function displayBlockFree(start, size = 10, xDir = '/tmp', exists = fs.existsSync) {
  for (let d = start; d < start + size; d++) if (exists(xSocket(xDir, d)) || exists(xLock(xDir, d))) return false;
  return true;
}

// Reserves the lowest free block of `size` X displays from `from` (default 200). The
// reservation is a marker file created atomically (O_EXCL) in `lockDir`, so instances
// started at the same moment never get the same block. Returns [first, last].
export function pickDisplayRange({ lockDir, xDir = '/tmp', size = 10, from = 200, exists = fs.existsSync } = {}) {
  fs.mkdirSync(lockDir, { recursive: true, mode: 0o700 });
  for (let start = from; start + size <= 1000; start += size) {
    if (!displayBlockFree(start, size, xDir, exists)) continue;
    try { fs.closeSync(fs.openSync(path.join(lockDir, `displays-${start}.lock`), 'wx', 0o600)); } catch { continue; }
    return [start, start + size - 1];
  }
  throw new Error('No free block of X displays.');
}

export function releaseDisplays({ displays, lockDir }) {
  if (Array.isArray(displays) && Number.isInteger(displays[0]) && lockDir) fs.rmSync(path.join(lockDir, `displays-${displays[0]}.lock`), { force: true });
}

// Reserve, then check the block again immediately before the RDP server is launched. If
// another X server took a display in between, release the block and move to the next
// one. (Xorg itself is started later by xrdp-sesman at login; sesman also skips any
// display in its range whose socket or lock exists, so a late collision costs a display,
// not a crash.) `beforeRecheck` is a test hook.
export function reserveDisplaysForLaunch({ lockDir, xDir = '/tmp', size = 10, exists = fs.existsSync, beforeRecheck } = {}) {
  let from = 200;
  for (;;) {
    const range = pickDisplayRange({ lockDir, xDir, size, from, exists });
    beforeRecheck?.(range);
    if (displayBlockFree(range[0], size, xDir, exists)) return range;
    releaseDisplays({ displays: range, lockDir });
    from = range[0] + size;
  }
}

// After the instance stopped: wait for its X servers to remove their own files, then
// remove any that a killed X server left behind. Exact paths only, only for this
// instance's displays, only files owned by the current user whose lock pid is gone.
export async function cleanupDisplays({ displays, lockDir, waitMs = 5000, xDir = '/tmp' }) {
  if (!Array.isArray(displays) || displays.length !== 2) return [];
  const [a, b] = displays.map(Number);
  if (!Number.isInteger(a) || !Number.isInteger(b) || a < 200 || b > 999 || b - a > 20) return [];
  const files = [];
  for (let d = a; d <= b; d++) files.push([d, xSocket(xDir, d), xLock(xDir, d)]);
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline && files.some(([, s, l]) => fs.existsSync(s) || fs.existsSync(l))) await new Promise((r) => setTimeout(r, 100));
  const removed = [];
  const uid = process.getuid?.();
  for (const [, sock, lock] of files) {
    let lockPid = null;
    try { lockPid = Number(fs.readFileSync(lock, 'utf8').trim()); } catch { /* no lock */ }
    if (lockPid) { try { process.kill(lockPid, 0); continue; } catch { /* dead: stale */ } }
    for (const f of [sock, lock]) {
      try { if (fs.lstatSync(f).uid === uid) { fs.rmSync(f, { force: true }); removed.push(f); } } catch { /* absent */ }
    }
  }
  releaseDisplays({ displays: [a, b], lockDir });
  return removed;
}

// Rewrites the first `key=` line of an ini (or of a given [section]) to `value`.
export function setIni(text, key, value, section = null) {
  const lines = text.split('\n');
  let current = null; let done = false;
  for (let i = 0; i < lines.length; i++) {
    const sec = /^\[(.+)\]\s*$/.exec(lines[i]);
    if (sec) {
      if (!done && section && current === section) { lines.splice(i, 0, `${key}=${value}`); done = true; break; }
      current = sec[1]; continue;
    }
    if (!done && (!section || current === section) && new RegExp(`^#?${key}=`).test(lines[i])) { lines[i] = `${key}=${value}`; done = true; if (!section) break; }
  }
  if (!done && section) lines.push(`${key}=${value}`);
  return lines.join('\n');
}

const SHIM = `#define _GNU_SOURCE
#include <grp.h>
#include <errno.h>
#include <dlfcn.h>
#include <unistd.h>
#include <sys/types.h>
/* A single-ID user namespace refuses setgroups and chown to unmapped ids; the harness session does not need either. */
int setgroups(size_t n, const gid_t *l) { (void)n; (void)l; return 0; }
int initgroups(const char *u, gid_t g) { (void)u; (void)g; return 0; }
int fchown(int fd, uid_t u, gid_t g) { static int (*real)(int, uid_t, gid_t); if (!real) real = dlsym(RTLD_NEXT, "fchown"); int r = real(fd, u, g); if (r && errno == EINVAL) return 0; return r; }
int chown(const char *p, uid_t u, gid_t g) { static int (*real)(const char *, uid_t, gid_t); if (!real) real = dlsym(RTLD_NEXT, "chown"); int r = real(p, u, g); if (r && errno == EINVAL) return 0; return r; }
`;

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', ...opts });
  if (r.status !== 0) throw new Error(`${cmd} failed: ${(r.stderr || r.stdout || '').trim().split('\n').pop()}`);
  return r.stdout;
}

const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

// Prepares and starts the private xrdp. Returns { processes, ports, displays, host, password }.
export async function start(opts) {
  const displays = [];
  try { return await startInner(opts, displays); } catch (err) {
    if (displays.length) fs.rmSync(path.join(opts.lockDir, `displays-${displays[0]}.lock`), { force: true });
    throw err;
  }
}

async function startInner({ dir, pickPort, startProcess, lockDir, cc = 'cc' }, displays) {
  const R = path.join(dir, 'rdp');
  for (const sub of ['etc', 'run/sockdir', 'pam', 'home', 'logs']) fs.mkdirSync(path.join(R, sub), { recursive: true, mode: 0o700 });
  fs.chmodSync(path.join(R, 'run', 'sockdir'), 0o1777);

  // Private /etc/xrdp: copy what we can read; keys and certs are generated fresh.
  for (const f of fs.readdirSync('/etc/xrdp', { withFileTypes: true })) {
    const src = path.join('/etc/xrdp', f.name);
    if (['cert.pem', 'key.pem', 'rsakeys.ini'].includes(f.name)) continue;
    try { fs.cpSync(src, path.join(R, 'etc', f.name), { recursive: true, dereference: true }); } catch { /* unreadable: not needed */ }
  }
  run('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '7', '-subj', '/CN=remotehub-harness', '-keyout', path.join(R, 'etc', 'key.pem'), '-out', path.join(R, 'etc', 'cert.pem')]);
  if (fs.existsSync('/usr/bin/xrdp-keygen')) spawnSync('/usr/bin/xrdp-keygen', ['xrdp', path.join(R, 'etc', 'rsakeys.ini')], { stdio: 'ignore' });

  const port = await pickPort();
  let xrdpIni = fs.readFileSync(path.join(R, 'etc', 'xrdp.ini'), 'utf8');
  xrdpIni = setIni(xrdpIni, 'port', `tcp://127.0.0.1:${port}`, 'Globals');
  xrdpIni = setIni(xrdpIni, 'certificate', '/etc/xrdp/cert.pem', 'Globals');
  xrdpIni = setIni(xrdpIni, 'key_file', '/etc/xrdp/key.pem', 'Globals');
  xrdpIni = setIni(xrdpIni, 'LogFile', path.join(R, 'logs', 'xrdp.log'), 'Logging');
  fs.writeFileSync(path.join(R, 'etc', 'xrdp.ini'), xrdpIni);
  let sesIni = fs.readFileSync(path.join(R, 'etc', 'sesman.ini'), 'utf8');
  sesIni = setIni(sesIni, 'EnableUserWindowManager', 'false', 'Globals');
  sesIni = setIni(sesIni, 'TerminalServerUsers', 'remotehub-harness-no-such-group', 'Security');
  sesIni = setIni(sesIni, 'LogFile', path.join(R, 'logs', 'sesman.log'), 'Logging');
  fs.writeFileSync(path.join(R, 'etc', 'sesman.ini'), sesIni);

  // LD_PRELOAD shim for the two calls a single-ID user namespace refuses.
  fs.writeFileSync(path.join(R, 'shim.c'), SHIM);
  run(cc, ['-shared', '-fPIC', '-o', path.join(R, 'shim.so'), path.join(R, 'shim.c'), '-ldl']);
  const shim = path.join(R, 'shim.so');

  // Desktop: one xterm. Its working dir is the harness user's home (inside the instance).
  fs.writeFileSync(path.join(R, 'etc', 'startwm.sh'), `#!/bin/sh\ncd ${q(path.join(R, 'home'))}\nexec env LD_PRELOAD=${q(shim)} xterm -geometry 100x30+20+20 -bg darkgreen -fg white -T 'RemoteHub harness RDP' -e /bin/sh\n`, { mode: 0o755 });

  // Harness-only login: pam_exec checks the generated password; no real account is used.
  const password = crypto.randomBytes(12).toString('base64url');
  fs.writeFileSync(path.join(R, 'password'), password, { mode: 0o600 });
  fs.writeFileSync(path.join(R, 'check-password.sh'), `#!/bin/sh\nIFS= read -r pw\n[ "$PAM_USER" = ${USER} ] && [ "$pw" = "$(cat ${q(path.join(R, 'password'))})" ]\n`, { mode: 0o700 });
  fs.writeFileSync(path.join(R, 'pam', 'xrdp-sesman'), [
    `auth required pam_exec.so expose_authtok quiet ${path.join(R, 'check-password.sh')}`,
    'auth required pam_permit.so', 'account required pam_permit.so', 'session optional pam_permit.so', 'password required pam_permit.so', '',
  ].join('\n'));
  const passwd = fs.readFileSync('/etc/passwd', 'utf8').split('\n').filter((l) => l && !l.startsWith(`${USER}:`));
  fs.writeFileSync(path.join(R, 'pam', 'passwd'), [`${USER}:x:0:0:RemoteHub harness:${path.join(R, 'home')}:/bin/sh`, ...passwd, ''].join('\n'));

  const inner = path.join(R, 'inner.sh');
  fs.writeFileSync(inner, [
    '#!/bin/sh',
    `mount --bind ${q(path.join(R, 'etc'))} /etc/xrdp || exit 90`,
    `mount --bind ${q(path.join(R, 'run'))} /run/xrdp || exit 91`,
    `mount --bind ${q(path.join(R, 'pam', 'xrdp-sesman'))} /etc/pam.d/xrdp-sesman || exit 92`,
    `mount --bind ${q(path.join(R, 'pam', 'passwd'))} /etc/passwd || exit 93`,
    // PID 1 of the private PID namespace: on SIGTERM, ask everything in it to stop so the
    // X servers remove their own sockets, then exit (the kernel reaps the rest).
    "trap 'kill -TERM -1 2>/dev/null; i=0; while [ $i -lt 30 ] && kill -0 -1 2>/dev/null; do sleep 0.1; i=$((i+1)); done; exit 0' TERM INT",
    `LD_PRELOAD=${q(shim)} /usr/sbin/xrdp-sesman -n &`,
    'sleep 1',
    '/usr/sbin/xrdp -n &',
    'while :; do wait; done',
    '',
  ].join('\n'), { mode: 0o700 });

  // Displays are reserved and re-checked last, right before launch, to keep the window
  // in which another X server could take one as small as possible.
  const [d0, d1] = reserveDisplaysForLaunch({ lockDir });
  displays.push(d0, d1);
  let ini = fs.readFileSync(path.join(R, 'etc', 'sesman.ini'), 'utf8');
  ini = setIni(ini, 'X11DisplayOffset', String(d0), 'Sessions');
  ini = setIni(ini, 'MaxDisplayNumber', String(d1), 'Sessions');
  fs.writeFileSync(path.join(R, 'etc', 'sesman.ini'), ini);
  const rec = startProcess('rdp', 'unshare', ['-Ur', '-m', '-p', '-f', '--kill-child=SIGTERM', '/bin/sh', inner], { env: { PATH: process.env.PATH, HOME: path.join(R, 'home'), LANG: process.env.LANG ?? 'C.UTF-8' }, cwd: R, logFile: path.join(dir, 'logs', 'rdp.log') });
  return { processes: [rec], ports: { rdp: port }, displays: [d0, d1], password, host: { protocol: 'rdp', port, username: USER, security: 'any', ignoreCert: true } };
}
