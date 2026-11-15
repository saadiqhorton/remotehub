// SAA-348: test harness safety: port picking, PID ownership, preflight messages.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { pickFreePort, parseBlocklist } from '../harness/ports.js';
import { isOurs, procStartTime, stopRecorded } from '../harness/procs.js';
import { preflight } from '../harness/preflight.js';

test('blocklist parses single ports and ranges', () => {
  const b = parseBlocklist({ blockedPorts: [3389, '5900', '5902-5914'] });
  assert.ok(b.has(3389) && b.has(5900) && b.has(5902) && b.has(5914));
  assert.ok(!b.has(5901) && !b.has(5915));
  assert.throws(() => parseBlocklist({ blockedPorts: ['abc'] }), /Bad entry/);
});

test('pickFreePort refuses blocked ports and ports already handed out', async () => {
  const offered = [3389, 5905, 40001, 40001, 40002];
  const blocked = parseBlocklist({ blockedPorts: [3389, '5902-5914'] });
  const taken = new Set();
  const bind = async () => offered.shift();
  assert.equal(await pickFreePort({ blocked, taken, bind }), 40001);
  assert.equal(await pickFreePort({ blocked, taken, bind }), 40002);
});

test('pickFreePort gives up rather than returning a blocked port', async () => {
  await assert.rejects(pickFreePort({ blocked: new Set([3389]), bind: async () => 3389, attempts: 5 }), /free port/);
});

test('pickFreePort returns a real OS-assigned port', async () => {
  const p = await pickFreePort();
  assert.ok(p > 0 && p < 65536);
});

test('stopRecorded never signals a PID whose start time does not match its record', async () => {
  const sent = [];
  const kill = (pid, sig) => sent.push([pid, sig]);
  // pid 4242 exists but started at a different time: someone else's process now.
  const startTimeOf = (pid) => (pid === 4242 ? 'other' : null);
  const res = await stopRecorded([{ name: 'reused', pid: 4242, startTime: 'ours' }, { name: 'gone', pid: 4343, startTime: 'x' }], { kill, startTimeOf, graceMs: 50 });
  assert.deepEqual(sent, []);
  assert.deepEqual(res.stopped, []);
  assert.deepEqual(res.skipped, ['reused', 'gone']);
});

test('stopRecorded refuses records without a start time, pid 1 or a non-number pid', async () => {
  const sent = [];
  await stopRecorded([{ name: 'a', pid: process.pid }, { name: 'b', pid: 1, startTime: procStartTime(1) }, { name: 'c', pid: '123', startTime: '1' }], { kill: (p, s) => sent.push([p, s]), graceMs: 10 });
  assert.deepEqual(sent, []);
});

test('down stops its own recorded process and leaves an unrecorded one running', { skip: process.platform === 'win32' }, async () => {
  const mine = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { detached: true, stdio: 'ignore' });
  const other = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 200));
  const rec = { name: 'mine', pid: mine.pid, startTime: procStartTime(mine.pid) };
  try {
    const res = await stopRecorded([rec]);
    assert.deepEqual(res.stopped, ['mine']);
    assert.equal(isOurs(rec), false);
    assert.ok(procStartTime(other.pid), 'the unrecorded process is still running');
  } finally { other.kill(); try { process.kill(-mine.pid, 'SIGKILL'); } catch {} }
});

const has = (paths) => (p) => paths.some((x) => p === x || p.endsWith(x));

test('preflight: everything present -> core and VNC ok', () => {
  const r = preflight({ env: { PATH: '/bin' }, exists: has(['/bin/Xvfb', '/bin/x11vnc', '/bin/xterm', '/bin/guacd', '/bin/bwrap']), nodeVersion: '22.10.0', platform: 'linux' });
  assert.equal(r.core.ok, true);
  assert.equal(r.vnc.ok, true);
});

test('preflight: old Node or missing npm install -> plain message, nothing started', () => {
  const r = preflight({ env: { PATH: '' }, exists: () => false, nodeVersion: '20.1.0', repoRoot: '/repo', platform: 'linux' });
  assert.equal(r.core.ok, false);
  assert.equal(r.core.message, "The test harness can't start: Node.js is too old.\n    Install Node.js 22.9 or newer from https://nodejs.org (you have 20.1.0).\nThe test harness can't start: the project's packages aren't installed.\n    Run: npm ci\nNothing was started or changed.");
});

test('preflight finds Windows .exe tools', () => {
  const r = preflight({ env: { PATH: 'C:\\t' }, exists: (p) => p.endsWith('x11vnc.exe'), nodeVersion: '22.10.0', platform: 'win32' });
  assert.ok(r.tools.x11vnc);
});

test('harness up/down with no desktop or namespace tools on PATH: SSH + RemoteHub run, VNC and RDP skipped in one sentence each', async () => {
  const { execFile } = await import('node:child_process');
  const { mkdtempSync, rmSync, existsSync } = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const home = mkdtempSync(path.join(os.tmpdir(), 'rh-harness-test-'));
  // No guacd anywhere: preflight also checks /usr/sbin and /usr/local/sbin, which CI has.
  const env = { ...process.env, PATH: path.dirname(process.execPath), HARNESS_HOME: home, HARNESS_GUACD: path.join(home, 'no-guacd') };
  const run = (...args) => new Promise((resolve) => execFile(process.execPath, ['harness/cli.js', ...args], { env }, (err, stdout, stderr) => resolve({ code: err?.code ?? 0, out: stdout + stderr })));
  try {
    const up = await run('up', 'nodesk');
    assert.equal(up.code, 0, up.out);
    assert.match(up.out, /remotehub +http:\/\/127\.0\.0\.1:\d+/);
    assert.match(up.out, /ssh +ssh:\/\/tester@127\.0\.0\.1:\d+/);
    assert.match(up.out, /^ {2}Desktop tests skipped: the remote desktop helper isn't installed\.$/m);
    assert.doesNotMatch(up.out, /at .*\.js:\d+/);
    const st = await run('status', 'nodesk');
    assert.match(st.out, /nodesk: ready +ssh=up remotehub=up/);
    const { readFileSync } = await import('node:fs');
    const instDir = JSON.parse(readFileSync(path.join(home, 'nodesk.json'), 'utf8')).dir;
    assert.ok(existsSync(instDir));
    assert.match(path.basename(instDir), /^rh-harness-nodesk-[A-Za-z0-9]{6}$/);
    const down = await run('down', 'nodesk');
    assert.match(down.out, /Stopped: ssh, remotehub\./);
    assert.equal(existsSync(instDir), false);
    assert.equal(existsSync(path.join(home, 'nodesk.json')), false);
  } finally {
    await run('down', 'nodesk');
    rmSync(home, { recursive: true, force: true });
  }
});

test('harness up/down leaves the git working tree unchanged', { skip: !process.env.PATH }, async () => {
  const { execFileSync, execFile } = await import('node:child_process');
  const path = await import('node:path');
  const porcelain = () => execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { encoding: 'utf8' });
  const before = porcelain();
  const { mkdtempSync, rmSync } = await import('node:fs');
  const os = await import('node:os');
  const home = mkdtempSync(path.join(os.tmpdir(), 'rh-harness-tree-'));
  const env = { ...process.env, PATH: path.dirname(process.execPath), HARNESS_BLOCKLIST: '', HARNESS_HOME: home };
  const run = (...a) => new Promise((res) => execFile(process.execPath, ['harness/cli.js', ...a], { env }, () => res()));
  await run('up', 'treecheck');
  await run('down', 'treecheck');
  rmSync(home, { recursive: true, force: true });
  assert.equal(porcelain(), before);
});

test('cleanup only deletes the exact mkdtemp dir it recorded, never another path', async () => {
  const os = await import('node:os'); const path = await import('node:path');
  const { isOwnInstanceDir } = await import('../harness/cli.js');
  const t = os.tmpdir();
  assert.equal(isOwnInstanceDir('a', path.join(t, 'rh-harness-a-Ab12Cd')), true);
  for (const bad of [t, '/', path.join(t, 'rh-harness-a-*'), path.join(t, 'rh-harness-a-Ab12Cd/../x'), path.join(t, 'rh-harness-b-Ab12Cd'), path.join(t, 'remotehub-test-Ab12Cd'), 'rh-harness-a-Ab12Cd', null]) {
    assert.equal(isOwnInstanceDir('a', bad), false, String(bad));
  }
});

test('rdp ini edits change only the intended section', async () => {
  const { setIni } = await import('../harness/providers/rdp.js');
  const ini = '[Globals]\nport=3389\n[Xorg]\nport=-1\n';
  assert.equal(setIni(ini, 'port', 'tcp://127.0.0.1:4000', 'Globals'), '[Globals]\nport=tcp://127.0.0.1:4000\n[Xorg]\nport=-1\n');
  assert.equal(setIni('[Sessions]\nX11DisplayOffset=10\n[Logging]\n', 'MaxDisplayNumber', '19', 'Sessions'), '[Sessions]\nX11DisplayOffset=10\nMaxDisplayNumber=19\n[Logging]\n');
});

test('display blocks: concurrent reservations never overlap, and busy displays are skipped', async () => {
  const { pickDisplayRange } = await import('../harness/providers/rdp.js');
  const { mkdtempSync, rmSync } = await import('node:fs'); const os = await import('node:os'); const path = await import('node:path');
  const lockDir = mkdtempSync(path.join(os.tmpdir(), 'rh-harness-disp-'));
  try {
    const busy = (p) => p === path.join('/tmp', '.X11-unix', 'X203');
    const a = pickDisplayRange({ lockDir, exists: busy });
    const b = pickDisplayRange({ lockDir, exists: busy });
    assert.deepEqual(a, [210, 219]);
    assert.deepEqual(b, [220, 229]);
  } finally { rmSync(lockDir, { recursive: true, force: true }); }
});

test('display cleanup refuses ranges it did not reserve', async () => {
  const { cleanupDisplays } = await import('../harness/providers/rdp.js');
  for (const bad of [undefined, [0, 99], [100, 150], [200, 260], ['a', 'b'], [0, 1]]) {
    assert.deepEqual(await cleanupDisplays({ displays: bad, waitMs: 0 }), []);
  }
});

// SAA-348 (#27): plain Node version message before npm test/start/harness/doctor.
test('node-check: plain sentence for an old Node, nothing for a new one', async () => {
  const { nodeVersionProblem } = await import('../harness/node-check.js');
  assert.equal(nodeVersionProblem('20.19.2'), 'RemoteHub needs Node 22.9 or newer. You have 20.19.2.');
  assert.equal(nodeVersionProblem('v22.8.1'), 'RemoteHub needs Node 22.9 or newer. You have 22.8.1.');
  for (const v of ['22.9.0', '22.23.3', '23.0.0', '24.1.0']) assert.equal(nodeVersionProblem(v), '', v);
});

test('node-check runs first in every npm script that needs Node 22.9', async () => {
  const fs = await import('node:fs');
  const { scripts } = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  for (const k of ['test', 'start', 'dev', 'reset-owner', 'harness', 'doctor', 'test:clean', 'guacd:check']) {
    assert.ok(scripts[k].startsWith('node harness/node-check.js && '), k);
  }
});

test('harness down stops the union of the state list and the instance pid list, once each', async () => {
  const fs = await import('node:fs'); const os = await import('node:os'); const path = await import('node:path');
  const { appendPidList, readPidList, recordsToStop } = await import('../harness/cli.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-harness-pidtest-'));
  try {
    const a = { name: 'ssh', pid: 111, startTime: 's1' }; const b = { name: 'xvfb', pid: 222, startTime: 's2' };
    appendPidList(dir, a); appendPidList(dir, b);
    assert.deepEqual(readPidList(dir), [a, b]);
    // State lost b (e.g. crash before the state write): down still finds it, and a only once.
    assert.deepEqual(recordsToStop('pidtest', { dir, processes: [a] }), [a, b]);
    // A dir that isn't this instance's own mkdtemp dir is never read.
    assert.deepEqual(recordsToStop('other', { dir, processes: [a] }), [a]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('startXvfb timeout terminates the hung child process', { skip: process.platform === 'win32' }, async () => {
  const fs = await import('node:fs'); const os = await import('node:os'); const path = await import('node:path');
  const { startXvfb } = await import('../harness/cli.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-harness-xvfb-'));
  const marker = path.join(dir, 'pid.txt');
  // Real executable: startXvfb passes Xvfb flags; ignore them and never write a display on fd 3.
  const hang = path.join(dir, 'fake-xvfb');
  fs.writeFileSync(hang, '#!/bin/sh\necho $$ > ' + JSON.stringify(marker) + '\nexec sleep 9999\n');
  fs.chmodSync(hang, 0o700);
  const logFile = path.join(dir, 'xvfb.log');
  try {
    await assert.rejects(startXvfb(hang, dir, logFile, { timeoutMs: 300 }), /Xvfb did not start/);
    assert.ok(fs.existsSync(marker), 'hang fixture should have started before timeout');
    const pid = Number(fs.readFileSync(marker, 'utf8'));
    await new Promise((r) => setTimeout(r, 150));
    let alive = true;
    try { process.kill(pid, 0); } catch { alive = false; }
    assert.equal(alive, false, `hung Xvfb stand-in pid ${pid} must be killed on timeout`);
  } finally {
    try { if (fs.existsSync(marker)) process.kill(Number(fs.readFileSync(marker, 'utf8')), 'SIGKILL'); } catch { /* already gone */ }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
