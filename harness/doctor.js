#!/usr/bin/env node
// SAA-348: `npm run doctor`, a read-only check of what this project needs.
// It never installs or changes anything. Each missing piece gets one line (a plain
// sentence) plus an install hint, labelled required or optional.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { preflight, which } from './preflight.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function doctor({ env = process.env, exists = fs.existsSync, nodeVersion = process.versions.node, platform = process.platform, repoRoot = ROOT, userns } = {}) {
  const pre = preflight({ env, exists, nodeVersion, platform, repoRoot, userns });
  const opts = { envPath: env.PATH ?? '', exists, platform };
  const lines = [];
  const ok = (text) => lines.push({ label: 'ok', text, hint: null });
  const bad = (i) => lines.push({ label: i.required ? 'required' : 'optional', text: i.message, hint: i.hint ?? null });
  const parts = (p) => pre.issues.filter((i) => i.part === p);

  if (parts('core').length) parts('core').forEach(bad);
  else ok(`Node.js ${nodeVersion} and the project's packages`);
  ok('SSH test server (built in)');
  const cargo = which('cargo', opts) ?? (exists(path.join(env.HOME ?? '', '.cargo', 'bin', 'cargo')) ? 'home' : null);
  if (cargo) ok('Rust, for the agent tests');
  else bad({ required: false, message: "Agent tests skipped: Rust isn't installed.", hint: 'How to install it: https://rustup.rs' });
  for (const p of ['desktop', 'vnc', 'rdp']) parts(p).forEach(bad);
  if (pre.vnc.ok) ok('VNC test desktop');
  if (pre.rdp.ok) ok('RDP test server (private, no sudo)');

  const coreOk = pre.core.ok;
  const ready = !coreOk ? 'Not ready: install the items marked required.'
    : lines.some((l) => l.label === 'optional') ? 'Ready: tests and the harness will run. Items marked optional are skipped until installed.'
    : 'Ready: everything is installed.';
  return { lines, ready, coreOk };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const { lines, ready, coreOk } = doctor();
  for (const l of lines) {
    console.log(`${l.label.padEnd(9)} ${l.text}`);
    if (l.hint) console.log(`${' '.repeat(10)}${l.hint}`);
  }
  console.log(ready);
  process.exit(coreOk ? 0 : 1);
}
