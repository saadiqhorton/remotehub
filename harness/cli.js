#!/usr/bin/env node
// SAA-348: one-command private test world.
//   npm run harness up [name]      start SSH test server, Xvfb+xterm+x11vnc, guacd and RemoteHub
//   npm run harness down [name]    stop only the processes recorded for that instance, remove its dir
//   npm run harness status [name]  show instances, their URLs and whether their processes are alive
// Everything an instance owns lives in its own temp folder from mkdtemp (outside the repo), removed by exact path on down. No sudo, no system files, no system services.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import net from 'node:net';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { pickFreePort, loadBlocklist } from './ports.js';
import { startProcess, stopRecorded, isOurs, procStartTime } from './procs.js';
import { preflight, formatIssues } from './preflight.js';
import * as rdpProvider from './providers/rdp.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// All instance files live in the OS temp dir, never in the repo; `down` deletes them.
export const HARNESS_HOME = process.env.HARNESS_HOME ? path.resolve(process.env.HARNESS_HOME) : path.join(os.tmpdir(), `remotehub-harness-${os.userInfo().username}`);
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

class UserError extends Error {}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const secret = () => crypto.randomBytes(12).toString('base64url');

// HARNESS_HOME only holds one small state file per instance (<name>.json, mode 0600).
// Each instance's files live in its own uniquely named mkdtemp dir, recorded in the state
// file and deleted by that exact path; the harness never deletes anything by glob.
function checkName(name) {
  if (!NAME_RE.test(name)) throw new UserError(`Instance name "${name}" must be lowercase letters, digits and dashes (max 32).`);
  return name;
}
export const statePath = (name) => path.join(HARNESS_HOME, `${checkName(name)}.json`);
const dirPrefix = (name) => path.join(os.tmpdir(), `rh-harness-${name}-`);
// Only a dir this harness created for this instance (mkdtemp prefix + 6 chars) may be removed.
export function isOwnInstanceDir(name, dir) {
  const prefix = dirPrefix(name);
  return typeof dir === 'string' && path.resolve(dir) === dir && dir.startsWith(prefix) && /^[A-Za-z0-9]{6}$/.test(dir.slice(prefix.length));
}
function removeInstance(name, state) {
  if (state?.dir && isOwnInstanceDir(name, state.dir)) fs.rmSync(state.dir, { recursive: true, force: true });
  fs.rmSync(statePath(name), { force: true });
  // The harness folder itself goes too once nothing is left in it (rmdir refuses non-empty dirs).
  try { fs.rmdirSync(HARNESS_HOME); } catch { /* not empty or already gone */ }
}

// Every PID `up` starts is also written, one JSON line each, to <instance dir>/pids.jsonl
// the moment it starts, so a crash between start and the state write still leaves a trace.
// `down` stops the union of this list and the state file's list (same {name,pid,startTime}
// records, so a reused PID is still never signalled).
export const pidListPath = (dir) => path.join(dir, 'pids.jsonl');
export function appendPidList(dir, rec) {
  fs.appendFileSync(pidListPath(dir), JSON.stringify({ ...rec, at: new Date().toISOString() }) + '\n', { mode: 0o600 });
}
export function readPidList(dir) {
  try {
    return fs.readFileSync(pidListPath(dir), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
      .map(({ name, pid, startTime }) => ({ name, pid, startTime }));
  } catch { return []; }
}
export function recordsToStop(name, state) {
  const all = [...(state?.processes ?? []), ...(state?.dir && isOwnInstanceDir(name, state.dir) ? readPidList(state.dir) : [])];
  const seen = new Set();
  return all.filter((r) => { const k = `${r.pid}:${r.startTime}`; if (seen.has(k)) return false; seen.add(k); return true; });
}

export function readState(name) {
  try { return JSON.parse(fs.readFileSync(statePath(name), 'utf8')); } catch { return null; }
}
function writeState(name, state) {
  const file = statePath(name);
  fs.writeFileSync(file + '.tmp', JSON.stringify(state, null, 2), { mode: 0o600 });
  fs.renameSync(file + '.tmp', file);
  fs.chmodSync(file, 0o600);
}
function listInstances() {
  try { return fs.readdirSync(HARNESS_HOME).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)).filter((n) => NAME_RE.test(n)); } catch { return []; }
}
function portsInUseByInstances() {
  const taken = new Set();
  for (const n of listInstances()) for (const p of Object.values(readState(n)?.ports ?? {})) taken.add(p);
  return taken;
}

function waitForPort(port, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const sock = net.connect({ port, host: '127.0.0.1' });
      sock.once('connect', () => { sock.destroy(); resolve(); });
      sock.once('error', () => { sock.destroy(); if (Date.now() > deadline) reject(new UserError(`Nothing started listening on port ${port}.`)); else setTimeout(attempt, 200); });
    };
    attempt();
  });
}

// Starts Xvfb and lets it pick a free display itself (-displayfd), so no display is guessed.
// On timeout or spawn failure the detached child is killed so a failed `harness up` leaves no orphan.
export function startXvfb(xvfb, dir, logFile, { timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const out = fs.openSync(logFile, 'a', 0o600);
    let child;
    try {
      child = spawn(xvfb, ['-displayfd', '3', '-nolisten', 'tcp', '-screen', '0', '1024x768x24'], { detached: true, stdio: ['ignore', out, out, 'pipe'], cwd: dir });
    } catch (err) {
      try { fs.closeSync(out); } catch { /* already closed */ }
      reject(err instanceof UserError ? err : new UserError(`Xvfb failed to start: ${err.message}`));
      return;
    }
    fs.closeSync(out);
    let buf = '';
    let settled = false;
    const killChild = () => {
      try { child.kill('SIGKILL'); } catch { /* gone */ }
      try { if (child.pid) process.kill(-child.pid, 'SIGKILL'); } catch { /* process group already gone */ }
    };
    const fail = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      killChild();
      reject(err);
    };
    const timer = setTimeout(() => fail(new UserError('Xvfb did not start (see its log).')), timeoutMs);
    child.once('error', (err) => fail(err instanceof UserError ? err : new UserError(`Xvfb failed to start: ${err.message}`)));
    child.stdio[3]?.on('data', (d) => {
      buf += d;
      if (!buf.includes('\n') || settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdio[3].destroy();
      child.unref();
      resolve({ child, display: Number(buf.trim()) });
    });
    child.once('exit', () => fail(new UserError('Xvfb exited during start (see its log).')));
  });
}

async function request(base, pathName, body) {
  const res = await fetch(base + pathName, { method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: JSON.stringify(body) });
  return res.status;
}

async function up(name) {
  const pre = preflight({ repoRoot: ROOT });
  if (!pre.core.ok) throw new UserError(pre.core.message);
  checkName(name);
  const existing = readState(name);
  if (existing && existing.processes.some((p) => isOurs(p))) throw new UserError(`Instance "${name}" is already running. Run: npm run harness down ${name}`);
  if (existing) removeInstance(name, existing);
  fs.mkdirSync(HARNESS_HOME, { recursive: true, mode: 0o700 });
  const dir = fs.mkdtempSync(dirPrefix(name));
  fs.chmodSync(dir, 0o700);
  for (const sub of ['logs', 'data', 'home']) fs.mkdirSync(path.join(dir, sub), { recursive: true, mode: 0o700 });

  const taken = portsInUseByInstances();
  const blocked = loadBlocklist(process.env.HARNESS_BLOCKLIST || path.join(ROOT, '.harness.local.json'));
  const desktop = pre.vnc.ok || pre.rdp.ok;
  const parts = ['ssh', ...(pre.vnc.ok ? ['vnc'] : []), ...(desktop ? ['guacd'] : []), 'web'];
  const ports = {};
  for (const k of parts) ports[k] = await pickFreePort({ taken, blocked });
  const credentials = {
    ownerPassword: secret(),
    ssh: { username: 'tester', password: secret() },
    vnc: { password: secret().slice(0, 8) }, // VNC passwords are limited to 8 characters
  };
  const state = { name, dir, createdAt: new Date().toISOString(), ports, processes: [], credentials, skipped: pre.issues.filter((i) => !i.required) };
  writeState(name, state);
  const log = (n) => path.join(dir, 'logs', `${n}.log`);
  const home = path.join(dir, 'home');
  const baseEnv = { PATH: process.env.PATH, HOME: home, LANG: process.env.LANG ?? 'C.UTF-8' };
  const record = (rec) => { state.processes.push(rec); writeState(name, state); appendPidList(dir, rec); return rec; };

  try {
    // SSH test server
    record(startProcess('ssh', process.execPath, [path.join(ROOT, 'harness', 'ssh-server.js'), String(ports.ssh)], {
      env: { ...baseEnv, HARNESS_SSH_USER: credentials.ssh.username, HARNESS_SSH_PASSWORD: credentials.ssh.password }, cwd: ROOT, logFile: log('ssh'),
    }));

    if (pre.vnc.ok) {
    // Desktop: Xvfb on a display it picks, an xterm to look at, x11vnc in front of it.
    const xv = await startXvfb(pre.tools.Xvfb, dir, log('xvfb'));
    const xrec = { name: 'xvfb', pid: xv.child.pid, startTime: procStartTime(xv.child.pid) };
    record(xrec);
    state.display = xv.display; writeState(name, state);
    const xenv = { ...baseEnv, DISPLAY: `:${xv.display}` };
    record(startProcess('xterm', pre.tools.xterm, ['-geometry', '100x30+20+20', '-T', `RemoteHub harness ${name}`, '-bg', 'navy', '-fg', 'white', '-e', '/bin/sh'], { env: xenv, cwd: home, logFile: log('xterm') }));
    const passFile = path.join(dir, 'vnc.pass');
    fs.writeFileSync(passFile, credentials.vnc.password + '\n', { mode: 0o600 });
    record(startProcess('x11vnc', pre.tools.x11vnc, ['-display', `:${xv.display}`, '-rfbport', String(ports.vnc), '-localhost', '-passwdfile', passFile, '-no6', '-forever', '-shared', '-noxdamage', '-nopw'], { env: xenv, cwd: home, logFile: log('x11vnc') }));

    }

    // RDP: private xrdp in an unprivileged namespace (providers/rdp.js). A failure here
    // skips RDP with one sentence instead of failing the whole instance.
    if (pre.rdp.ok) {
      try {
        const r = await rdpProvider.start({ dir, pickPort: () => pickFreePort({ taken, blocked }), startProcess, lockDir: HARNESS_HOME, cc: pre.tools.cc });
        for (const p of r.processes) record(p);
        ports.rdp = r.ports.rdp; state.displays = r.displays;
        credentials.rdp = { username: r.host.username, password: r.password };
        state.rdpHost = r.host; writeState(name, state);
        await waitForPort(ports.rdp);
      } catch (err) {
        await stopRecorded(state.processes.filter((p) => p.name === 'rdp'));
        state.processes = state.processes.filter((p) => p.name !== 'rdp');
        delete ports.rdp;
        state.skipped.push({ part: 'rdp', required: false, message: "RDP tests skipped: the private RDP server didn't start.", hint: `Details: ${err.message.split('\n')[0]}` });
        writeState(name, state);
      }
    }

    // guacd (serves both VNC and RDP)
    if (desktop) {
    const guacdLib = path.join(path.dirname(path.dirname(pre.tools.guacd)), 'lib');
    record(startProcess('guacd', pre.tools.guacd, ['-f', '-b', '127.0.0.1', '-l', String(ports.guacd), '-L', 'info'], {
      env: { ...baseEnv, ...(fs.existsSync(guacdLib) ? { LD_LIBRARY_PATH: guacdLib } : {}) }, cwd: dir, logFile: log('guacd'),
    }));

    }

    // RemoteHub
    record(startProcess('remotehub', process.execPath, [path.join(ROOT, 'server', 'index.js')], {
      env: { ...baseEnv, HOST: '127.0.0.1', PORT: String(ports.web), DATA_DIR: path.join(dir, 'data'), ...(desktop ? { GUACD_ENABLED: '1', GUACD_HOST: '127.0.0.1', GUACD_PORT: String(ports.guacd) } : {}) },
      cwd: ROOT, logFile: log('remotehub'),
    }));

    for (const k of parts) await waitForPort(ports[k]);

    // Owner account: use the one-time setup code from this instance's own data dir.
    const base = `http://127.0.0.1:${ports.web}`;
    const code = fs.readFileSync(path.join(dir, 'data', 'SETUP-CODE.txt'), 'utf8').trim();
    const status = await request(base, '/api/auth/setup', { setupCode: code, password: credentials.ownerPassword });
    if (status !== 200) throw new UserError(`RemoteHub owner setup failed (HTTP ${status}).`);

    state.urls = { remotehub: base, ssh: `ssh://${credentials.ssh.username}@127.0.0.1:${ports.ssh}`, ...(pre.vnc.ok ? { vnc: `vnc://127.0.0.1:${ports.vnc}` } : {}), ...(desktop ? { guacd: `127.0.0.1:${ports.guacd}` } : {}), ...(ports.rdp ? { rdp: `rdp://${credentials.rdp.username}@127.0.0.1:${ports.rdp}` } : {}) };
    state.ready = true;
    writeState(name, state);
  } catch (err) {
    await stopRecorded(recordsToStop(name, state));
    await rdpProvider.cleanupDisplays({ displays: state.displays, lockDir: HARNESS_HOME });
    removeInstance(name, state);
    throw err;
  }

  console.log(`Harness "${name}" is up.`);
  for (const [k, v] of Object.entries(state.urls)) console.log(`  ${k.padEnd(9)} ${v}`);
  for (const line of formatIssues(state.skipped, '  ')) console.log(line);
  console.log(`  Logins and passwords: ${statePath(name)} (readable only by you)`);
}

async function down(name) {
  checkName(name);
  const state = readState(name);
  if (!state) {
    console.log(`Harness "${name}" is not running.`);
    return;
  }
  const { stopped, skipped } = await stopRecorded(recordsToStop(name, state));
  await rdpProvider.cleanupDisplays({ displays: state.displays, lockDir: HARNESS_HOME });
  removeInstance(name, state);
  console.log(`Harness "${name}" is down. Stopped: ${stopped.join(', ') || 'nothing'}${skipped.length ? `. Already gone (left alone): ${skipped.join(', ')}` : ''}.`);
}

function status(name) {
  const names = name ? [name] : listInstances();
  if (!names.length) { console.log('No harness instances.'); return; }
  for (const n of names) {
    const s = readState(n);
    if (!s) { console.log(`${n}: not running`); continue; }
    const procs = s.processes.map((p) => `${p.name}=${isOurs(p) ? 'up' : 'DOWN'}`).join(' ');
    console.log(`${n}: ${s.ready ? 'ready' : 'starting'}  ${procs}`);
    for (const [k, v] of Object.entries(s.urls ?? {})) console.log(`  ${k.padEnd(9)} ${v}`);
  }
}

export async function main(argv) {
  const [cmd, name = 'default'] = argv;
  if (cmd === 'up') return up(name);
  if (cmd === 'down') return down(name);
  if (cmd === 'status') return status(argv[1]);
  throw new UserError('Usage: npm run harness -- up|down|status [name]');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(err instanceof UserError ? err.message : `Harness error: ${err.message}`);
    process.exit(1);
  });
}
