// Tool checks (SAA-348). Nothing is installed or changed. The core (Node + project
// dependencies + the built-in SSH test server) is required; the VNC desktop and RDP are
// optional. Each missing piece is reported once, with a plain sentence and a hint line.
import fs from 'node:fs';
import path from 'node:path';
import { probe as rdpProbe } from './providers/rdp.js';

export function which(cmd, { envPath = process.env.PATH ?? '', exists = fs.existsSync, platform = process.platform } = {}) {
  if (cmd.includes('/') || cmd.includes('\\')) return exists(cmd) ? cmd : null;
  const exts = platform === 'win32' ? ['.exe', '.cmd', ''] : [''];
  const paths = platform === 'win32' ? path.win32 : path.posix;
  for (const dir of envPath.split(paths.delimiter).filter(Boolean)) {
    for (const ext of exts) { const full = paths.join(dir, cmd + ext); if (exists(full)) return full; }
  }
  return null;
}

export function findGuacd({ env = process.env, exists = fs.existsSync, platform = process.platform } = {}) {
  if (env.HARNESS_GUACD) return exists(env.HARNESS_GUACD) ? env.HARNESS_GUACD : null;
  return which('guacd', { envPath: env.PATH ?? '', exists, platform }) ?? ['/usr/sbin/guacd', '/usr/local/sbin/guacd'].find((p) => exists(p)) ?? null;
}

// Returns { core, vnc, rdp, issues, tools }. Each issue is one missing piece:
// { part, required, message, hint } with a plain first sentence and a separate hint line.
export function preflight({ env = process.env, exists = fs.existsSync, nodeVersion = process.versions.node, platform = process.platform, repoRoot, userns } = {}) {
  const opts = { envPath: env.PATH ?? '', exists, platform };
  const issues = [];
  const [major, minor] = nodeVersion.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 9)) issues.push({ part: 'core', required: true, message: "The test harness can't start: Node.js is too old.", hint: `Install Node.js 22.9 or newer from https://nodejs.org (you have ${nodeVersion}).` });
  if (repoRoot && !exists(path.join(repoRoot, 'node_modules', 'ssh2'))) issues.push({ part: 'core', required: true, message: "The test harness can't start: the project's packages aren't installed.", hint: 'Run: npm ci' });
  const core = { ok: issues.length === 0 };
  if (!core.ok) core.message = formatIssues(issues).join('\n') + '\nNothing was started or changed.';

  const tools = { Xvfb: which('Xvfb', opts), x11vnc: which('x11vnc', opts), xterm: which('xterm', opts), guacd: findGuacd({ env, exists, platform }), unshare: which('unshare', opts), openssl: which('openssl', opts), cc: which('cc', opts) ?? which('gcc', opts) ?? which('clang', opts) };
  // Shared by VNC and RDP: reported once.
  if (!tools.guacd) issues.push({ part: 'desktop', required: false, message: "Desktop tests skipped: the remote desktop helper isn't installed.", hint: 'How to install it: see deploy/guacd.md' });
  if (!tools.xterm) issues.push({ part: 'desktop', required: false, message: "Desktop tests skipped: a tool they need isn't installed.", hint: 'Install: xterm' });
  const vncOnly = ['Xvfb', 'x11vnc'].filter((t) => !tools[t]);
  if (vncOnly.length) issues.push({ part: 'vnc', required: false, message: vncOnly.length === 1 ? "VNC tests skipped: a tool it needs isn't installed." : "VNC tests skipped: some tools it needs aren't installed.", hint: `Install: ${vncOnly.join(', ')}` });
  const vnc = { ok: Boolean(tools.guacd && tools.xterm && !vncOnly.length) };
  const r = rdpProbe({ tools, platform, exists, which: (b) => which(b, opts), ...(userns ? { userns } : {}) });
  issues.push(...r.issues);
  return { core, vnc, rdp: { ok: r.ok }, issues, tools };
}

// Message lines for the terminal: the sentence, then the hint indented on its own line.
export function formatIssues(issues, indent = '') {
  const out = [];
  for (const i of issues) {
    out.push(`${indent}${i.message}`);
    if (i.hint) out.push(`${indent}    ${i.hint}`);
  }
  return out;
}
