// SAA-348: what doctor and `harness up` tell a new user when parts are missing.
// One line per missing piece, only pieces that are really missing, plain first sentence,
// install hint on its own line pointing at deploy/guacd.md (no apt commands).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { preflight, formatIssues } from '../harness/preflight.js';
import { doctor } from '../harness/doctor.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const JARGON = /guacd|plugin|TLS|HARNESS_|GUACD|libguac|apt |sudo/i;
const RDP_FILES = ['/usr/sbin/xrdp', '/usr/sbin/xrdp-sesman', 'xrdpdev_drv.so', 'pam_exec.so', 'libguac-client-rdp.so'];
const BIN = ['Xvfb', 'x11vnc', 'xterm', 'unshare', 'openssl', 'cc'];
// A fake computer: `have` lists what is installed.
function computer(have) {
  const exists = (p) => have.some((h) => (h.startsWith('/') ? p === h : p.endsWith(`/${h}`)));
  return { env: { PATH: '/bin' }, exists, nodeVersion: '22.10.0', platform: 'linux', userns: () => true };
}
const everything = [...BIN.map((b) => `/bin/${b}`), '/bin/guacd', ...RDP_FILES];
const without = (...names) => everything.filter((h) => !names.some((n) => h.endsWith(n)));

test('everything installed: no issues, VNC and RDP ready', () => {
  const r = preflight(computer(everything));
  assert.deepEqual(r.issues, []);
  assert.equal(r.vnc.ok, true); assert.equal(r.rdp.ok, true);
});

test('(a) missing guacd gives exactly one message, covering both VNC and RDP', () => {
  const r = preflight(computer(without('/bin/guacd', 'libguac-client-rdp.so')));
  assert.equal(r.issues.length, 1);
  assert.equal(r.issues[0].message, "Desktop tests skipped: the remote desktop helper isn't installed.");
  assert.equal(r.issues[0].hint, 'How to install it: see deploy/guacd.md');
  assert.equal(r.vnc.ok, false); assert.equal(r.rdp.ok, false);
});

test('(b) only tools that are really missing are listed', () => {
  const r = preflight(computer(without('/bin/x11vnc')));
  assert.equal(r.issues.length, 1);
  assert.equal(r.issues[0].message, "VNC tests skipped: a tool it needs isn't installed.");
  assert.equal(r.issues[0].hint, 'Install: x11vnc');
  assert.equal(r.rdp.ok, true);
  const r2 = preflight(computer(without('xrdpdev_drv.so', '/bin/openssl')));
  assert.equal(r2.issues.length, 1);
  assert.equal(r2.issues[0].message, "RDP tests skipped: some tools it needs aren't installed.");
  assert.equal(r2.issues[0].hint, 'Install: xorgxrdp, openssl');
});

test('(a) a tool both VNC and RDP need is reported once', () => {
  const r = preflight(computer(without('/bin/xterm')));
  assert.equal(r.issues.length, 1);
  assert.equal(r.issues[0].message, "Desktop tests skipped: a tool they need isn't installed.");
  assert.equal(r.issues[0].hint, 'Install: xterm');
});

test('helper without RDP support: one RDP line, VNC still runs', () => {
  const r = preflight(computer(without('libguac-client-rdp.so')));
  assert.equal(r.vnc.ok, true);
  assert.deepEqual(r.issues.map((i) => [i.message, i.hint]), [["RDP tests skipped: the remote desktop helper can't do RDP.", 'How to add RDP to it: see deploy/guacd.md']]);
});

test('no sandbox support and not-Linux are one plain sentence each', () => {
  const r = preflight({ ...computer(everything), userns: () => false });
  assert.deepEqual(r.issues.map((i) => i.message), ["RDP tests skipped: this computer doesn't allow the private sandbox RDP tests need."]);
  const mac = preflight({ ...computer(everything), platform: 'darwin' });
  assert.deepEqual(mac.issues.map((i) => [i.message, i.hint]), [['RDP tests skipped: RDP tests only run on Linux.', null]]);
});

test('(d) first sentences use plain words; hints never suggest apt', () => {
  const cases = [without('/bin/guacd', 'libguac-client-rdp.so'), without('/bin/x11vnc', '/bin/Xvfb'), without('/bin/xterm'), without('libguac-client-rdp.so'), without('/usr/sbin/xrdp')];
  for (const have of cases) {
    for (const i of preflight(computer(have)).issues) {
      assert.doesNotMatch(i.message, JARGON, i.message);
      assert.doesNotMatch(i.hint ?? '', /apt|sudo|libguac/, i.hint);
    }
  }
});

test('formatIssues puts the hint on its own indented line', () => {
  assert.deepEqual(formatIssues([{ message: 'A.', hint: 'B' }, { message: 'C.', hint: null }], '  '), ['  A.', '      B', '  C.']);
});

test('(c) doctor: optional labels and the Ready line agree', () => {
  const some = doctor({ ...computer(without('/bin/guacd', 'libguac-client-rdp.so')), repoRoot: '/r', exists: (p) => p.endsWith('ssh2') || computer(without('/bin/guacd', 'libguac-client-rdp.so')).exists(p) });
  const labels = some.lines.map((l) => l.label);
  assert.ok(labels.includes('optional'));
  assert.ok(!labels.includes('required'));
  assert.equal(some.ready, 'Ready: tests and the harness will run. Items marked optional are skipped until installed.');
  const all = doctor({ ...computer(everything), repoRoot: '/r', exists: (p) => p.endsWith('ssh2') || p.endsWith('/bin/cargo') || computer(everything).exists(p) });
  assert.ok(all.lines.every((l) => l.label === 'ok'), JSON.stringify(all.lines));
  assert.equal(all.ready, 'Ready: everything is installed.');
  const broken = doctor({ ...computer(everything), nodeVersion: '20.1.0', repoRoot: '/r' });
  assert.ok(broken.lines.some((l) => l.label === 'required'));
  assert.equal(broken.ready, 'Not ready: install the items marked required.');
  assert.equal(broken.coreOk, false);
});

test('(c) doctor: one line per missing piece (guacd missing -> one line)', () => {
  const c = computer(without('/bin/guacd', 'libguac-client-rdp.so'));
  const d = doctor({ ...c, repoRoot: '/r', exists: (p) => p.endsWith('ssh2') || p.endsWith('/bin/cargo') || c.exists(p) });
  const notOk = d.lines.filter((l) => l.label !== 'ok');
  assert.equal(notOk.length, 1);
  assert.equal(notOk[0].text, "Desktop tests skipped: the remote desktop helper isn't installed.");
  assert.equal(notOk[0].hint, 'How to install it: see deploy/guacd.md');
});

const run = (env, ...args) => new Promise((resolve) => execFile(process.execPath, [path.join(ROOT, 'harness/cli.js'), ...args], { env, cwd: ROOT }, (err, stdout, stderr) => resolve({ code: err?.code ?? 0, out: stdout + stderr })));

test('(e) down removes the harness folder once it is empty, and keeps it while another instance remains', async () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-harness-home-'));
  const home = path.join(parent, 'remotehub-harness-test');
  // Unique names so a parallel suite run cannot collide on the same instance id.
  const one = `one-${process.pid}-${Date.now().toString(36)}`;
  const two = `two-${process.pid}-${Date.now().toString(36)}`;
  const env = { ...process.env, PATH: path.dirname(process.execPath), HARNESS_HOME: home, HARNESS_BLOCKLIST: '' };
  try {
    const up1 = await run(env, 'up', one);
    assert.equal(up1.code, 0, up1.out);
    const up2 = await run(env, 'up', two);
    assert.equal(up2.code, 0, up2.out);
    await run(env, 'down', one);
    assert.ok(fs.existsSync(home), 'kept while the second instance is still up');
    await run(env, 'down', two);
    assert.equal(fs.existsSync(home), false, 'removed once empty');
  } finally {
    await run(env, 'down', one); await run(env, 'down', two);
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test('harness up with nothing but Node: each missing piece once, plain words, hint lines', async () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-harness-home-'));
  // HARNESS_GUACD points at nothing: preflight also looks in /usr/sbin and /usr/local/sbin
  // regardless of PATH, so a runner with a system guacd (CI installs one) isn't "nothing but Node".
  const env = { ...process.env, PATH: path.dirname(process.execPath), HARNESS_HOME: path.join(parent, 'h'), HARNESS_BLOCKLIST: '', HARNESS_GUACD: path.join(parent, 'no-guacd') };
  try {
    const up = await run(env, 'up', 'bare');
    assert.equal(up.code, 0, up.out);
    const lines = up.out.split('\n');
    const skips = lines.filter((l) => /^ {2}\S.* skipped: /.test(l));
    assert.equal(skips.filter((l) => l.includes('remote desktop helper')).length, 1);
    assert.equal(new Set(skips).size, skips.length);
    for (const l of skips) assert.doesNotMatch(l, JARGON, l);
    assert.ok(lines.includes('      How to install it: see deploy/guacd.md'));
    assert.doesNotMatch(up.out, /apt |libguac|HARNESS_GUACD/);
  } finally {
    await run(env, 'down', 'bare');
    fs.rmSync(parent, { recursive: true, force: true });
  }
});
