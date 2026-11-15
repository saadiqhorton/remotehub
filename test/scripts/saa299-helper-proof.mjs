/**
 * SAA-299 real-run proof: real RemoteHub server deploying the real release
 * `remotehub-agent` as a temporary helper through an SSH server that serves
 * the real filesystem over SFTP and really executes commands, driven from
 * headless Chromium.
 *
 *   node test/scripts/saa299-helper-proof.mjs <agent-binary> <screenshot-dir>
 *
 * Writes screenshots and run-log.json. No secret (SSH password, helper token,
 * owner password) is ever written to the log.
 */
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import ssh2 from 'ssh2';
import { fingerprintOf } from '../../server/ssh-bridge.js';
import { CWD_COMMAND, helperTokens } from '../../server/helper-deploy.js';
import { httpClient, startTestApp } from '../helpers/app-harness.js';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE || 'playwright-core');
const [agentBin, shotDir] = process.argv.slice(2);
assert.ok(agentBin && shotDir, 'usage: saa299-helper-proof.mjs <agent-binary> <screenshot-dir>');

const ROOT = '/tmp/rh299-root';
const HOME = `${ROOT}/home/demo`;
const TMP = `${ROOT}/tmp`; // the host's temp dir for this proof
const BUILDS = `${ROOT}-builds`; // RemoteHub server's HELPER_DIR
const SSH_PASSWORD = 'helper demo pw';
const OWNER_PASSWORD = 'saa299-owner-password';
const log = [];
const serverLog = [];
const secrets = [SSH_PASSWORD, OWNER_PASSWORD];
const note = (step, detail = {}) => { const entry = { at: new Date().toISOString(), step, ...detail }; log.push(entry); console.log(JSON.stringify(entry)); };

fs.rmSync(ROOT, { recursive: true, force: true });
fs.rmSync(BUILDS, { recursive: true, force: true });
fs.mkdirSync(`${HOME}/projects`, { recursive: true });
fs.mkdirSync(TMP, { recursive: true, mode: 0o1777 });
fs.writeFileSync(`${HOME}/readme.md`, '# demo\n');
fs.writeFileSync(`${HOME}/notes.txt`, 'hello\n');
fs.mkdirSync(BUILDS, { recursive: true });
fs.copyFileSync(agentBin, `${BUILDS}/remotehub-agent-linux-x86_64`);

const helperDirs = () => fs.readdirSync(TMP).filter((name) => name.startsWith('remotehub-helper-'));
// Folders planted for the sweep check; later steps only look at folders RemoteHub creates.
const planted = new Map();
const newHelperDirs = () => helperDirs().filter((name) => !planted.has(name));
const sudo = (...args) => execFileSync('sudo', ['-n', ...args], { stdio: 'ignore' });
let inUseProcess = null;
let cwdProcess = null;
let otherOwnerDir = null;

// ---- planted leftovers for the stale-helper sweep ------------------------------------
// SAA299_PLANT=none: measure helper starts on a host with no leftovers at all.
const PLANT = process.env.SAA299_PLANT !== 'none';
const startTimings = [];
if (PLANT) {
  const now = Date.now() / 1000;
  const plant = (label, hexChar, ageSecs, setup) => {
    const name = `remotehub-helper-${hexChar.repeat(16)}`;
    const full = `${TMP}/${name}`;
    setup(full);
    planted.set(name, label);
    return { name, full, age: ageSecs, when: now - ageSecs };
  };
  fs.mkdirSync(`${ROOT}/precious`, { recursive: true });
  fs.writeFileSync(`${ROOT}/precious/keep.txt`, 'must survive\n');
  // Stale, own, idle, plain files only: must be swept.
  const stale = plant('stale', 'a', 2 * 3600, (d) => {
    fs.mkdirSync(d, { mode: 0o700 });
    fs.writeFileSync(`${d}/remotehub-agent`, 'old binary');
  });
  fs.utimesSync(stale.full, stale.when, stale.when);
  // Stale but containing a symlink to a precious file: whole folder kept.
  const withSymlink = plant('contains-symlink', 'f', 2 * 3600, (d) => {
    fs.mkdirSync(d, { mode: 0o700 });
    fs.writeFileSync(`${d}/remotehub-agent`, 'old binary');
    fs.symlinkSync(`${ROOT}/precious/keep.txt`, `${d}/escape`);
  });
  fs.utimesSync(withSymlink.full, withSymlink.when, withSymlink.when);
  // Stale but containing a hard link (nlink 2) to a precious file: whole folder kept.
  const withHardlink = plant('contains-hardlink', '1', 2 * 3600, (d) => {
    fs.mkdirSync(d, { mode: 0o700 });
    fs.linkSync(`${ROOT}/precious/keep.txt`, `${d}/remotehub-agent`);
  });
  fs.utimesSync(withHardlink.full, withHardlink.when, withHardlink.when);
  // Stale, idle binary, but a process has its working directory inside: kept.
  const cwdInUse = plant('cwd-in-use', '2', 2 * 3600, (d) => {
    fs.mkdirSync(d, { mode: 0o700 });
    fs.writeFileSync(`${d}/remotehub-agent`, 'old binary');
  });
  cwdProcess = spawn('sleep', ['600'], { cwd: cwdInUse.full, stdio: 'ignore' });
  fs.utimesSync(cwdInUse.full, cwdInUse.when, cwdInUse.when);
  // Fresh, own: must be kept.
  plant('fresh', 'b', 0, (d) => { fs.mkdirSync(d, { mode: 0o700 }); fs.writeFileSync(`${d}/remotehub-agent`, 'new binary'); });
  // Old, own, in use by a running helper process: must be kept.
  const inUse = plant('in-use', 'c', 3 * 3600, (d) => {
    fs.mkdirSync(d, { mode: 0o700 });
    fs.copyFileSync(agentBin, `${d}/remotehub-agent`);
    fs.chmodSync(`${d}/remotehub-agent`, 0o700);
  });
  inUseProcess = spawn(`${inUse.full}/remotehub-agent`, ['--mode', 'temporary', '--root', HOME], { stdio: ['pipe', 'ignore', 'ignore'] });
  fs.utimesSync(inUse.full, inUse.when, inUse.when);
  // Old symlink named like a helper folder, pointing at a real directory: must be kept, never followed.
  const linked = plant('symlink', 'e', 3 * 3600, (d) => fs.symlinkSync(`${ROOT}/precious`, d));
  fs.lutimesSync(linked.full, linked.when, linked.when);
  // Old folder owned by another user (nobody): must be kept.
  try {
    const other = plant('other-owner', 'd', 3 * 3600, (d) => {
      fs.mkdirSync(d, { mode: 0o755 });
      fs.writeFileSync(`${d}/remotehub-agent`, 'someone else');
    });
    fs.utimesSync(other.full, other.when, other.when);
    sudo('chown', '-R', '65534:65534', other.full);
    otherOwnerDir = other.full;
  } catch {
    planted.delete(`remotehub-helper-${'d'.repeat(16)}`);
  }
}
const describePlanted = () => Object.fromEntries([...planted].map(([name, label]) => {
  const full = `${TMP}/${name}`;
  let state = 'gone';
  try {
    const st = fs.lstatSync(full);
    state = `${st.isSymbolicLink() ? 'symlink' : 'dir'} uid=${st.uid} age=${Math.round((Date.now() / 1000 - st.mtimeMs / 1000) / 60)}min`;
  } catch {}
  return [label, state];
}));
const modeOf = (p) => (fs.statSync(p).mode & 0o7777).toString(8);

// ---- SSH server over the real filesystem, with real exec -------------------------
const { Server, utils } = ssh2;
const keys = utils.generateKeyPairSync('ed25519');
const children = new Map(); // pid -> { child, command, exitCode }
const uploadedTokens = []; // captured only to prove reuse fails; never logged
const inside = (p) => { const resolved = path.posix.resolve(HOME, p || '.'); return resolved === ROOT || resolved.startsWith(`${ROOT}/`) ? resolved : null; };
const attrsOf = (st) => ({ mode: st.mode, size: st.size, uid: st.uid, gid: st.gid, atime: Math.floor(st.atimeMs / 1000), mtime: Math.floor(st.mtimeMs / 1000) });
const HELPER_COMMAND = /^exec '([^']+)\/remotehub-agent' --mode temporary --root '([^']+)' --helper-token-file '([^']+)' --helper-cleanup --helper-ttl (\d+)$/;
const sshServer = new Server({ hostKeys: [keys.private] }, (client) => {
  client.on('authentication', (ctx) => (ctx.method === 'password' && ctx.password === SSH_PASSWORD ? ctx.accept() : ctx.reject(['password'])));
  client.on('ready', () => {
    client.on('tcpip', (_accept, reject) => reject()); // no persistent agent on this host
    client.on('session', (acceptSession) => {
      const session = acceptSession();
      session.on('exec', (accept, reject, info) => {
        // Like sshd, run the command with the user's shell; this proof only allows what RemoteHub sends.
        const linkCheck = /^find -P '\/tmp\/rh299-root\/tmp\/remotehub-helper-[0-9a-f]{16}' -mindepth 1 /.test(info.command);
        if (!['uname -sm', 'id -u; date +%s', 'ps -ww -A -o args=', CWD_COMMAND].includes(info.command) && !linkCheck && !HELPER_COMMAND.test(info.command)) return reject();
        const channel = accept();
        const child = spawn('sh', ['-c', info.command], { cwd: HOME, stdio: ['pipe', 'pipe', 'pipe'] });
        const record = { child, command: info.command, exitCode: null, stderr: '' };
        children.set(child.pid, record);
        child.stdout.pipe(channel, { end: false });
        child.stderr.on('data', (chunk) => { record.stderr += chunk; channel.stderr.write(chunk); });
        channel.on('data', (chunk) => child.stdin.write(chunk));
        channel.on('end', () => child.stdin.end());
        channel.on('close', () => { if (record.exitCode === null) child.stdin.destroy(); });
        child.stdin.on('error', () => {});
        child.on('close', (code, signal) => {
          record.exitCode = code ?? signal;
          try { channel.exit(code ?? 1); channel.end(); } catch {}
        });
      });
      session.on('sftp', (accept) => {
        const sftp = accept();
        const handles = new Map();
        let next = 1;
        const fail = (id, err) => sftp.status(id, err?.code === 'ENOENT' ? 2 : err?.code === 'EACCES' ? 3 : 4, err?.message || 'Failure');
        const guard = (id, p, fn) => { const real = inside(p); if (!real) return sftp.status(id, 3, 'Permission denied'); try { fn(real); } catch (err) { fail(id, err); } };
        const newHandle = (value) => { const handle = Buffer.alloc(4); handle.writeUInt32BE(next++); handles.set(handle.toString('hex'), value); return handle; };
        sftp.on('REALPATH', (id, p) => guard(id, p, (real) => { fs.statSync(real); sftp.name(id, [{ filename: real, longname: real, attrs: {} }]); }));
        sftp.on('STAT', (id, p) => guard(id, p, (real) => sftp.attrs(id, attrsOf(fs.statSync(real)))));
        sftp.on('LSTAT', (id, p) => guard(id, p, (real) => sftp.attrs(id, attrsOf(fs.lstatSync(real)))));
        sftp.on('SETSTAT', (id, p, attrs) => guard(id, p, (real) => { if (attrs.mode !== undefined) fs.chmodSync(real, attrs.mode & 0o7777); sftp.status(id, 0); }));
        sftp.on('OPENDIR', (id, p) => guard(id, p, (real) => {
          const names = fs.readdirSync(real).map((name) => ({ filename: name, longname: name, attrs: attrsOf(fs.lstatSync(path.join(real, name))) }));
          sftp.handle(id, newHandle({ names, sent: false }));
        }));
        sftp.on('READDIR', (id, handle) => {
          const found = handles.get(handle.toString('hex'));
          if (!found?.names) return sftp.status(id, 4, 'Invalid handle');
          if (found.sent) return sftp.status(id, 1, 'End of file');
          found.sent = true;
          sftp.name(id, found.names);
        });
        sftp.on('OPEN', (id, p, flags, attrs) => guard(id, p, (real) => {
          const { OPEN_MODE } = utils.sftp;
          let fsFlags = 'r';
          if (flags & OPEN_MODE.WRITE) fsFlags = (flags & OPEN_MODE.EXCL) ? 'wx' : 'w';
          const fd = fs.openSync(real, fsFlags, attrs?.mode ?? 0o644);
          sftp.handle(id, newHandle({ fd, path: real, chunks: [] }));
        }));
        sftp.on('READ', (id, handle, offset, length) => {
          const found = handles.get(handle.toString('hex'));
          if (found?.fd === undefined) return sftp.status(id, 4, 'Invalid handle');
          const buf = Buffer.alloc(Math.min(length, 32 * 1024));
          const n = fs.readSync(found.fd, buf, 0, buf.length, offset);
          if (n === 0) return sftp.status(id, 1, 'End of file');
          sftp.data(id, buf.subarray(0, n));
        });
        sftp.on('WRITE', (id, handle, offset, data) => {
          const found = handles.get(handle.toString('hex'));
          if (found?.fd === undefined) return sftp.status(id, 4, 'Invalid handle');
          fs.writeSync(found.fd, data, 0, data.length, offset);
          if (found.path.endsWith('/session-token')) found.chunks.push(Buffer.from(data));
          sftp.status(id, 0);
        });
        sftp.on('CLOSE', (id, handle) => {
          const found = handles.get(handle.toString('hex'));
          if (found?.fd !== undefined) {
            fs.closeSync(found.fd);
            if (found.chunks.length) uploadedTokens.push(Buffer.concat(found.chunks).toString().trim());
          }
          handles.delete(handle.toString('hex'));
          sftp.status(id, 0);
        });
        sftp.on('MKDIR', (id, p, attrs) => guard(id, p, (real) => { fs.mkdirSync(real, { mode: attrs?.mode ?? 0o755 }); sftp.status(id, 0); }));
        sftp.on('RENAME', (id, from, to) => guard(id, from, (a) => guard(id, to, (b) => { fs.renameSync(a, b); sftp.status(id, 0); })));
        sftp.on('REMOVE', (id, p) => guard(id, p, (real) => { fs.unlinkSync(real); sftp.status(id, 0); }));
        sftp.on('RMDIR', (id, p) => guard(id, p, (real) => { fs.rmdirSync(real); sftp.status(id, 0); }));
      });
    });
  });
  client.on('error', () => {});
});
await new Promise((resolve) => sshServer.listen(0, '127.0.0.1', resolve));
const sshPort = sshServer.address().port;

// ---- RemoteHub ------------------------------------------------------------------
const env = await startTestApp({ agentPort: 8377, helperDir: BUILDS, helperOptions: { tmpBase: TMP } }, { log: (line) => serverLog.push(String(line)) });
const client = httpClient(env.base, env.origin);
await client.request('/api/auth/setup', { method: 'POST', body: { setupCode: env.app.setupCode, password: OWNER_PASSWORD } });
const created = await client.request('/api/hosts', { method: 'POST', body: { name: 'Helper demo', address: '127.0.0.1', port: sshPort, username: 'demo' } });
await env.app.store.setKnownHost('127.0.0.1', sshPort, { keyType: 'ssh-ed25519', fingerprint: fingerprintOf(utils.parseKey(keys.public).getPublicSSH()) });
note('servers-up', { remotehub: env.base, sshPort, hostRoot: ROOT, hostTmp: TMP, helperBuild: `remotehub-agent-linux-x86_64 (${fs.statSync(`${BUILDS}/remotehub-agent-linux-x86_64`).size} bytes)` });

// ---- browser --------------------------------------------------------------------
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || `${process.env.HOME}/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome` });
let page = await browser.newPage({ viewport: { width: 1280, height: 760 } });
const frames = [];
const trackFrames = (p) => p.on('websocket', (ws) => ws.on('framereceived', ({ payload }) => {
  try { const m = JSON.parse(payload); if (['watch-status', 'helper-status'].includes(m.t)) frames.push(m); } catch {}
}));
trackFrames(page);
const pane = () => page.locator('.files-pane.active');
const rowNames = () => page.$$eval('.files-pane.active .files-row .files-name', (nodes) => nodes.map((node) => node.textContent));
const ui = async () => ({
  rows: await rowNames(),
  liveBadge: await page.$eval('.files-pane.active .files-live', (n) => (n.hidden ? null : n.textContent)).catch(() => null),
  helperChip: await page.$eval('.files-pane.active .files-helper', (n) => (n.hidden ? null : n.textContent)).catch(() => null),
  helperButton: await page.$eval('.files-pane.active .files-helper-toggle', (n) => (n.hidden ? null : n.textContent)).catch(() => null),
  footer: await page.$eval('.files-pane.active .files-foot-status', (n) => n.textContent).catch(() => null),
});
const shoot = async (name, step, extra = {}) => {
  const file = path.join(shotDir, name);
  await page.screenshot({ path: file });
  note(step, { screenshot: file, ...(await ui()), ...extra });
};
const waitFor = async (check, label, timeout = 10000) => {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out: ${label}; ui: ${JSON.stringify(await ui())}`);
    await new Promise((r) => setTimeout(r, 25));
  }
};
const helperChildren = () => [...children.values()].filter((r) => HELPER_COMMAND.test(r.command));
const openFiles = async () => {
  await page.goto(env.base);
  if (await page.locator('#auth-password').count()) {
    await page.fill('#auth-password', OWNER_PASSWORD);
    await page.press('#auth-password', 'Enter');
  }
  await page.getByRole('button', { name: 'Files' }).first().click();
  await page.fill('input[aria-label^="SSH password"]', SSH_PASSWORD);
  await page.press('input[aria-label^="SSH password"]', 'Enter');
  await waitFor(async () => (await rowNames()).includes('readme.md'), 'listing');
};
const startHelper = async () => {
  const started = Date.now();
  await pane().locator('.files-helper-toggle').click();
  await waitFor(async () => (await ui()).liveBadge === 'Live · temporary helper', 'helper live', 20000);
  startTimings.push(Date.now() - started);
};
const onDisk = (dir) => {
  const full = `${TMP}/${dir}`;
  return {
    dir: `${dir} (mode ${modeOf(full)})`,
    files: fs.readdirSync(full).map((name) => `${name} (mode ${modeOf(`${full}/${name}`)})`),
  };
};

let t0;
try {
  // 1. No agent on the host: polling, with the helper offered.
  await openFiles();
  await page.waitForTimeout(500);
  await shoot('01-no-agent-helper-offered.png', 'Files open, no persistent agent: polling, "Start temporary helper" offered', { helperDirsOnHost: helperDirs() });
  assert.equal((await ui()).liveBadge, null);

  note('planted before first deploy', { planted: describePlanted() });

  // 2. Start the helper (the stale sweep runs first).
  t0 = Date.now();
  await startHelper();
  const afterSweep = describePlanted();
  if (PLANT) note('after sweep + deploy', {
    planted: afterSweep,
    preciousTargetIntact: fs.readFileSync(`${ROOT}/precious/keep.txt`, 'utf8') === 'must survive\n',
    preciousLinkCount: fs.statSync(`${ROOT}/precious/keep.txt`).nlink,
    cwdProcessAlive: cwdProcess?.exitCode === null,
    inUseProcessAlive: inUseProcess?.exitCode === null,
    serverLog: serverLog.filter((l) => /swept|sweep/.test(l)),
  });
  if (PLANT) {
  assert.equal(afterSweep.stale, 'gone', 'stale folder swept');
  assert.match(afterSweep.fresh, /^dir /);
  assert.match(afterSweep['in-use'], /^dir /);
  assert.match(afterSweep.symlink, /^symlink /);
  assert.match(afterSweep['contains-symlink'], /^dir /);
  assert.ok(fs.lstatSync(`${TMP}/remotehub-helper-${'f'.repeat(16)}/escape`).isSymbolicLink(), 'symlink inside kept');
  assert.match(afterSweep['contains-hardlink'], /^dir /);
  assert.equal(fs.statSync(`${ROOT}/precious/keep.txt`).nlink, 2, 'hard link inside kept');
  assert.match(afterSweep['cwd-in-use'], /^dir /);
  assert.equal(cwdProcess.exitCode, null);
  if (planted.has(`remotehub-helper-${'d'.repeat(16)}`)) assert.match(afterSweep['other-owner'], /^dir uid=65534/);
  assert.ok(fs.existsSync(`${ROOT}/precious/keep.txt`));
  assert.equal(inUseProcess.exitCode, null);
  }
  const startMs = Date.now() - t0;
  const [dir1] = newHelperDirs();
  const run1 = helperChildren()[0];
  const tokenCount = uploadedTokens.length;
  const argv = fs.readFileSync(`/proc/${(await waitFor(() => findHelperPid(run1.child.pid), 'helper pid'))}/cmdline`, 'utf8').split('\0').filter(Boolean);
  assert.ok(!uploadedTokens.some((tok) => argv.join(' ').includes(tok)), 'token not in argv');
  note('helper started', { ms: startMs, onHost: onDisk(dir1), helperArgv: argv.map((a) => a.replace(TMP, '$TMP')), tokenFileStillOnDisk: fs.existsSync(`${TMP}/${dir1}/session-token`) });
  assert.equal(fs.existsSync(`${TMP}/${dir1}/session-token`), false, 'helper deleted its token file');
  await shoot('02-helper-live.png', 'temporary helper running: badge "Live · temporary helper", chip with platform');

  // 3. Live updates through the helper.
  t0 = Date.now();
  fs.writeFileSync(`${HOME}/created-on-host.txt`, 'made outside RemoteHub\n');
  await waitFor(async () => (await rowNames()).includes('created-on-host.txt'), 'create via helper');
  note('external create visible via helper', { ms: Date.now() - t0 });
  await shoot('03-helper-live-create.png', 'after creating a file on the host');
  t0 = Date.now();
  fs.renameSync(`${HOME}/created-on-host.txt`, `${HOME}/renamed-on-host.txt`);
  await waitFor(async () => { const r = await rowNames(); return r.includes('renamed-on-host.txt') && !r.includes('created-on-host.txt'); }, 'rename via helper');
  note('external rename visible via helper', { ms: Date.now() - t0 });
  t0 = Date.now();
  fs.unlinkSync(`${HOME}/renamed-on-host.txt`);
  await waitFor(async () => !(await rowNames()).includes('renamed-on-host.txt'), 'delete via helper');
  note('external delete visible via helper', { ms: Date.now() - t0 });
  await shoot('04-helper-live-rename-delete.png', 'after renaming then deleting it on the host');

  // 4. Token reuse fails.
  const token1 = uploadedTokens[tokenCount - 1];
  note('token reuse', { usedTokenRedeemsAgain: helperTokens.consume(token1), tokenSha256Prefix: createHash('sha256').update(token1).digest('hex').slice(0, 12) });

  // 5. Normal stop from the UI: helper exits, RemoteHub confirms cleanup.
  t0 = Date.now();
  await pane().locator('.files-helper-toggle').click();
  await waitFor(async () => (await ui()).helperButton === 'Start temporary helper', 'helper stopped');
  await waitFor(() => run1.exitCode !== null, 'helper process exited');
  note('helper stopped from UI', { ms: Date.now() - t0, exitCode: run1.exitCode, dirStillOnHost: fs.existsSync(`${TMP}/${dir1}`), helperDirsOnHost: newHelperDirs(), helperStderr: run1.stderr.trim().split('\n') });
  assert.equal(run1.exitCode, 0);
  assert.equal(fs.existsSync(`${TMP}/${dir1}`), false);
  await shoot('05-helper-stopped-removed.png', 'helper stopped from the UI; removed from the host; polling again');

  // 6. Failure: the helper process is killed (SIGKILL, so it cannot clean up). RemoteHub removes its files.
  await startHelper();
  const [dir2] = newHelperDirs();
  const run2 = helperChildren()[1];
  const pid2 = await waitFor(() => findHelperPid(run2.child.pid), 'helper pid 2');
  await page.waitForTimeout(300);
  process.kill(pid2, 'SIGKILL'); // our own child process
  await waitFor(async () => (await ui()).helperButton === 'Start temporary helper', 'stopped after crash');
  await waitFor(() => !fs.existsSync(`${TMP}/${dir2}`), 'cleanup after crash');
  note('helper killed -9; RemoteHub cleaned up', { exit: run2.exitCode, dirStillOnHost: fs.existsSync(`${TMP}/${dir2}`), helperDirsOnHost: newHelperDirs() });
  await shoot('06-helper-crashed-cleaned.png', 'helper process killed with SIGKILL; RemoteHub removed its files and fell back to polling');

  // 7. Close the session while the helper runs: closing the tab tears it down.
  await startHelper();
  const [dir3] = newHelperDirs();
  const run3 = helperChildren()[2];
  await shoot('07-helper-live-before-close.png', 'helper running again, about to close the browser tab');
  await page.close();
  await waitFor(() => run3.exitCode !== null, 'helper exits when the session closes', 15000);
  await waitFor(() => !fs.existsSync(`${TMP}/${dir3}`), 'cleanup on session close', 15000);
  note('session closed with helper running', { exitCode: run3.exitCode, dirStillOnHost: fs.existsSync(`${TMP}/${dir3}`), helperDirsOnHost: newHelperDirs() });

  // 8. Real binary refuses a wrong / stale token and still removes itself.
  const manualDir = `${TMP}/remotehub-helper-manualcheck`;
  fs.mkdirSync(manualDir, { mode: 0o700 });
  fs.copyFileSync(agentBin, `${manualDir}/remotehub-agent`);
  fs.chmodSync(`${manualDir}/remotehub-agent`, 0o700);
  fs.writeFileSync(`${manualDir}/session-token`, `${'ab'.repeat(32)}\n`, { mode: 0o600 });
  const manual = spawn(`${manualDir}/remotehub-agent`, ['--mode', 'temporary', '--root', HOME, '--helper-token-file', `${manualDir}/session-token`, '--helper-cleanup'], { stdio: ['pipe', 'pipe', 'pipe'] });
  let manualOut = '';
  manual.stdout.on('data', (c) => { manualOut += c; });
  manual.stdin.write(`${JSON.stringify({ id: 1, op: 'hello', params: { protocol: 1, token: token1 } })}\n`);
  const manualExit = await new Promise((resolve) => manual.on('close', resolve));
  const reply = JSON.parse(manualOut.trim().split('\n')[1]);
  note('real helper given a stale token', { reply: reply.error?.code, exitCode: manualExit, dirStillOnHost: fs.existsSync(manualDir) });
  assert.equal(reply.error.code, 'unauthorized');
  assert.equal(manualExit, 3);

  // 9. A fresh tab: still clean, and the persistent-agent path is unaffected.
  page = await browser.newPage({ viewport: { width: 1280, height: 760 } });
  trackFrames(page);
  await openFiles();
  await page.waitForTimeout(400);
  await shoot('08-new-session-nothing-left.png', 'new session after everything: no helper directories on the host', { helperDirsOnHost: newHelperDirs(), leftoverProcesses: helperChildren().filter((r) => r.exitCode === null).length });
  assert.deepEqual(newHelperDirs(), []);

  note('frames', { helperStatus: frames.filter((m) => m.t === 'helper-status'), watchStatus: frames.filter((m) => m.t === 'watch-status') });
  note('server-log', { lines: serverLog.filter((l) => /helper|agent/i.test(l)) });
  const everything = JSON.stringify(log);
  for (const secret of [...secrets, ...uploadedTokens]) assert.ok(!everything.includes(secret) && !serverLog.join('\n').includes(secret), 'no secret in the run log or server log');
  note('helper-start-timings', { plantedLeftovers: PLANT, ms: startTimings });
  note('secrets-check', { checked: secrets.length + uploadedTokens.length, leaked: 0 });
} finally {
  fs.writeFileSync(path.join(shotDir, 'run-log.json'), JSON.stringify({ log }, null, 2));
  await browser.close();
  for (const { child, exitCode } of children.values()) if (exitCode === null) child.kill('SIGTERM'); // own children only
  if (inUseProcess && inUseProcess.exitCode === null) inUseProcess.kill('SIGTERM'); // own child
  if (cwdProcess && cwdProcess.exitCode === null) cwdProcess.kill('SIGTERM'); // own child
  if (otherOwnerDir) { try { sudo('rm', '-rf', otherOwnerDir); } catch {} }
  await env.stop();
  sshServer.close();
}

/** `sh -c "exec ..."` replaces the shell, so the helper has the shell's pid. */
function findHelperPid(pid) {
  try {
    const cmd = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8');
    return cmd.includes('remotehub-agent') ? pid : null;
  } catch {
    return null;
  }
}
