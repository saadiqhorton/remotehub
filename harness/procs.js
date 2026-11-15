// Process bookkeeping (SAA-348): the harness only signals processes recorded in its own
// state file. A record is {name, pid, startTime}; the start time guards against a PID
// that was reused by someone else's process after ours exited. Linux reads /proc,
// macOS asks ps, Windows asks PowerShell. If the start time can't be read, the process
// is treated as not ours and left alone.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

export function procStartTime(pid, platform = process.platform) {
  if (!Number.isInteger(pid) || pid <= 1) return null;
  try {
    if (platform === 'linux') {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
    }
    if (platform === 'win32') {
      // Harness tests intentionally restrict PATH to Node. PID ownership still needs
      // the operating system's PowerShell, independent of optional desktop tools.
      const powershell = process.env.SystemRoot ? path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : 'powershell';
      const r = spawnSync(powershell, ['-NoProfile', '-Command', `(Get-Process -Id ${pid}).StartTime.Ticks`], { encoding: 'utf8', windowsHide: true });
      return r.status === 0 && r.stdout.trim() ? r.stdout.trim() : null;
    }
    const r = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8' });
    return r.status === 0 && r.stdout.trim() ? r.stdout.trim() : null;
  } catch { return null; }
}

export function isOurs(rec, startTimeOf = procStartTime) {
  return Number.isInteger(rec?.pid) && rec.pid > 1 && Boolean(rec.startTime) && startTimeOf(rec.pid) === rec.startTime;
}

// Each process gets its own process group (detached) so helpers it starts stop with it.
export function startProcess(name, cmd, args, { env, cwd, logFile }) {
  const out = fs.openSync(logFile, 'a', 0o600);
  const child = spawn(cmd, args, { env, cwd, detached: true, windowsHide: true, stdio: ['ignore', out, out] });
  fs.closeSync(out);
  child.unref();
  return { name, pid: child.pid, startTime: procStartTime(child.pid) };
}

function defaultKill(pid, sig) {
  if (process.platform === 'win32') {
    const taskkill = process.env.SystemRoot ? path.join(process.env.SystemRoot, 'System32', 'taskkill.exe') : 'taskkill';
    spawnSync(taskkill, ['/PID', String(pid), '/T', ...(sig === 'SIGKILL' ? ['/F'] : [])], { windowsHide: true });
    return;
  }
  try { process.kill(-pid, sig); } catch { process.kill(pid, sig); }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Stops only the given records, and only while each one is still the same process.
export async function stopRecorded(records, { graceMs = 3000, kill = defaultKill, startTimeOf = procStartTime } = {}) {
  const ours = (r) => isOurs(r, startTimeOf);
  const live = records.filter(ours);
  const skipped = records.filter((r) => !live.includes(r)).map((r) => r.name);
  const signal = (sig) => {
    for (const r of live) {
      if (!ours(r)) continue;
      try { kill(r.pid, sig); } catch { /* already gone */ }
    }
  };
  signal('SIGTERM');
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline && live.some(ours)) await sleep(100);
  if (live.some(ours)) signal('SIGKILL');
  return { stopped: live.map((r) => r.name), skipped };
}
