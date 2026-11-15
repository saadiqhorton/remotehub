/**
 * SAA-298 real-run proof: real RemoteHub server + real remotehub-agent binary
 * watching a real directory + an SSH server that serves that directory over SFTP
 * and forwards direct-tcpip to the agent, driven from headless Chromium.
 *
 *   node test/scripts/saa298-live-proof.mjs <agent-binary> <screenshot-dir>
 *
 * Writes screenshots and a JSON log of what the page showed at each step.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { createRequire } from 'node:module';
import ssh2 from 'ssh2';
import { fingerprintOf } from '../../server/ssh-bridge.js';
import { httpClient, startTestApp } from '../helpers/app-harness.js';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE || 'playwright-core');
const [agentBin, shotDir] = process.argv.slice(2);
assert.ok(agentBin && shotDir, 'usage: saa298-live-proof.mjs <agent-binary> <screenshot-dir>');

const ROOT = '/tmp/rh298-root';
const HOME = `${ROOT}/home/demo`;
const AGENT_PORT = 18398;
// The agent writes its per-start token into the demo user's home, where the
// SSH server below lets RemoteHub read it over SFTP like a real sshd would.
const TOKEN_FILE = `${HOME}/.remotehub/agent-local-token`;
const SSH_PASSWORD = 'live demo pw';
const OWNER_PASSWORD = 'saa298-owner-password';
const log = [];
const note = (step, detail) => { const entry = { at: new Date().toISOString(), step, ...detail }; log.push(entry); console.log(JSON.stringify(entry)); };

fs.rmSync(ROOT, { recursive: true, force: true });
fs.mkdirSync(`${HOME}/projects`, { recursive: true });
fs.writeFileSync(`${HOME}/readme.md`, '# demo\n');
fs.writeFileSync(`${HOME}/notes.txt`, 'hello\n');

// ---- real agent -----------------------------------------------------------
const agent = spawn(agentBin, ['--mode', 'persistent', '--listen', `127.0.0.1:${AGENT_PORT}`, '--root', ROOT, '--local-token-file', TOKEN_FILE], { stdio: ['ignore', 'ignore', 'pipe'] });
let agentLog = '';
agent.stderr.on('data', (chunk) => { agentLog += chunk; });
note('agent-started', { pid: agent.pid });
await new Promise((resolve, reject) => {
  const deadline = Date.now() + 5000;
  const tryConnect = () => {
    const socket = net.connect(AGENT_PORT, '127.0.0.1', () => { socket.destroy(); resolve(); });
    socket.on('error', () => (Date.now() > deadline ? reject(new Error('agent did not listen')) : setTimeout(tryConnect, 100)));
  };
  tryConnect();
});

// ---- token checks against the real agent (the token value itself is never printed) ----
const tokenStat = fs.statSync(TOKEN_FILE);
const agentToken = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
assert.equal(tokenStat.mode & 0o777, 0o600, 'token file is 0600');
assert.equal(fs.statSync(path.dirname(TOKEN_FILE)).mode & 0o777, 0o700, 'token dir is 0700');
assert.match(agentToken, /^[0-9a-f]{64}$/, '32 random bytes, hex');
const rawExchange = (lines) => new Promise((resolve, reject) => {
  const socket = net.connect(AGENT_PORT, '127.0.0.1');
  let data = '';
  socket.on('data', (chunk) => { data += chunk; });
  socket.on('connect', () => socket.write(lines.map((line) => `${JSON.stringify(line)}\n`).join('')));
  socket.on('error', reject);
  socket.on('close', () => resolve(data.split('\n').filter(Boolean).map((line) => JSON.parse(line))));
  setTimeout(() => socket.destroy(), 1500);
});
const ping = { id: 2, op: 'ping' };
const missingReply = await rawExchange([{ id: 1, op: 'hello', params: { protocol: 1 } }, ping]);
const wrongReply = await rawExchange([{ id: 1, op: 'hello', params: { protocol: 1, token: `${agentToken.slice(0, -1)}${agentToken.endsWith('0') ? '1' : '0'}` } }, ping]);
const rightReply = await rawExchange([{ id: 1, op: 'hello', params: { protocol: 1, token: agentToken } }, ping]);
assert.equal(missingReply.length, 2, 'hello event + one refusal, then closed');
assert.equal(missingReply[1].error.code, 'unauthorized');
assert.equal(wrongReply.length, 2);
assert.equal(wrongReply[1].error.code, 'unauthorized');
assert.equal(rightReply[1].result.event, 'authenticated');
assert.equal(rightReply[2].result.pong, true);
note('token-checks', {
  tokenFileMode: (tokenStat.mode & 0o777).toString(8),
  tokenDirMode: (fs.statSync(path.dirname(TOKEN_FILE)).mode & 0o777).toString(8),
  tokenLength: agentToken.length,
  missingToken: missingReply[1].error.code,
  wrongToken: wrongReply[1].error.code,
  rightToken: `${rightReply[1].result.event}, ping ok=${rightReply[2].ok}`,
});

// ---- SSH server over the real directory ------------------------------------
const { Server, utils } = ssh2;
const keys = utils.generateKeyPairSync('ed25519');
const inside = (p) => { const resolved = path.posix.resolve(HOME, p || '.'); return resolved === ROOT || resolved.startsWith(`${ROOT}/`) ? resolved : null; };
const attrsOf = (st) => ({ mode: st.mode, size: st.size, uid: st.uid, gid: st.gid, atime: Math.floor(st.atimeMs / 1000), mtime: Math.floor(st.mtimeMs / 1000) });
const sshServer = new Server({ hostKeys: [keys.private] }, (client) => {
  client.on('authentication', (ctx) => (ctx.method === 'password' && ctx.password === SSH_PASSWORD ? ctx.accept() : ctx.reject(['password'])));
  client.on('ready', () => {
    client.on('tcpip', (accept, reject, info) => {
      // Stand-in for sshd forwarding to the host's loopback agent port.
      if (info.destPort !== 8377) return reject();
      const channel = accept();
      const socket = net.connect(AGENT_PORT, '127.0.0.1');
      channel.pipe(socket).pipe(channel);
      socket.on('error', () => channel.destroy());
      channel.on('close', () => socket.destroy());
    });
    client.on('session', (acceptSession) => {
      acceptSession().on('sftp', (accept) => {
        const sftp = accept();
        const handles = new Map();
        let next = 1;
        const fail = (id, err) => sftp.status(id, err?.code === 'ENOENT' ? 2 : err?.code === 'EACCES' ? 3 : 4, err?.message || 'Failure');
        const guard = (id, p, fn) => { const real = inside(p); if (!real) return sftp.status(id, 3, 'Permission denied'); try { fn(real); } catch (err) { fail(id, err); } };
        sftp.on('REALPATH', (id, p) => guard(id, p, (real) => { fs.statSync(real); sftp.name(id, [{ filename: real, longname: real, attrs: {} }]); }));
        sftp.on('STAT', (id, p) => guard(id, p, (real) => sftp.attrs(id, attrsOf(fs.statSync(real)))));
        sftp.on('LSTAT', (id, p) => guard(id, p, (real) => sftp.attrs(id, attrsOf(fs.lstatSync(real)))));
        sftp.on('OPENDIR', (id, p) => guard(id, p, (real) => {
          const names = fs.readdirSync(real).map((name) => ({ filename: name, longname: name, attrs: attrsOf(fs.lstatSync(path.join(real, name))) }));
          const handle = Buffer.alloc(4); handle.writeUInt32BE(next++);
          handles.set(handle.toString('hex'), { names, sent: false });
          sftp.handle(id, handle);
        }));
        sftp.on('READDIR', (id, handle) => {
          const found = handles.get(handle.toString('hex'));
          if (!found) return sftp.status(id, 4, 'Invalid handle');
          if (found.sent) return sftp.status(id, 1, 'End of file');
          found.sent = true;
          sftp.name(id, found.names);
        });
        // Read-only file access, enough for RemoteHub to read the agent token file.
        sftp.on('OPEN', (id, p, flags) => guard(id, p, (real) => {
          if (flags & utils.sftp.OPEN_MODE.WRITE) return sftp.status(id, 3, 'Permission denied');
          const fd = fs.openSync(real, 'r');
          const handle = Buffer.alloc(4); handle.writeUInt32BE(next++);
          handles.set(handle.toString('hex'), { fd });
          sftp.handle(id, handle);
        }));
        sftp.on('READ', (id, handle, offset, length) => {
          const found = handles.get(handle.toString('hex'));
          if (found?.fd === undefined) return sftp.status(id, 4, 'Invalid handle');
          const buf = Buffer.alloc(Math.min(length, 32 * 1024));
          const n = fs.readSync(found.fd, buf, 0, buf.length, offset);
          if (n === 0) return sftp.status(id, 1, 'End of file');
          sftp.data(id, buf.subarray(0, n));
        });
        sftp.on('FSTAT', (id, handle) => {
          const found = handles.get(handle.toString('hex'));
          if (found?.fd === undefined) return sftp.status(id, 4, 'Invalid handle');
          sftp.attrs(id, attrsOf(fs.fstatSync(found.fd)));
        });
        sftp.on('CLOSE', (id, handle) => {
          const found = handles.get(handle.toString('hex'));
          if (found?.fd !== undefined) fs.closeSync(found.fd);
          handles.delete(handle.toString('hex'));
          sftp.status(id, 0);
        });
        sftp.on('MKDIR', (id, p) => guard(id, p, (real) => { fs.mkdirSync(real); sftp.status(id, 0); }));
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

// ---- RemoteHub ---------------------------------------------------------------
const env = await startTestApp({ agentPort: 8377 });
const client = httpClient(env.base, env.origin);
await client.request('/api/auth/setup', { method: 'POST', body: { setupCode: env.app.setupCode, password: OWNER_PASSWORD } });
const created = await client.request('/api/hosts', { method: 'POST', body: { name: 'Live demo', address: '127.0.0.1', port: sshPort, username: 'demo' } });
await env.app.store.setKnownHost('127.0.0.1', sshPort, { keyType: 'ssh-ed25519', fingerprint: fingerprintOf(utils.parseKey(keys.public).getPublicSSH()) });
note('servers-up', { remotehub: env.base, sshPort, agentPort: AGENT_PORT, root: ROOT, hostId: created.body.host.id });

// ---- browser -------------------------------------------------------------------
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || `${process.env.HOME}/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome` });
const page = await browser.newPage({ viewport: { width: 1200, height: 760 } });
const frames = [];
page.on('websocket', (ws) => ws.on('framereceived', ({ payload }) => {
  try { const m = JSON.parse(payload); if (m.t === 'watch-status' || m.t === 'fs-event') frames.push(m); } catch {}
}));
const rowNames = () => page.$$eval('.files-pane.active .files-row .files-name', (nodes) => nodes.map((node) => node.textContent));
const shoot = async (name, step) => {
  const file = path.join(shotDir, name);
  await page.screenshot({ path: file });
  const names = await rowNames();
  const live = await page.$eval('.files-pane.active .files-live', (node) => !node.hidden).catch(() => false);
  note(step, { screenshot: file, rows: names, liveBadge: live });
  return names;
};
// Poll the rendered rows from Node (the page CSP forbids eval-style predicates).
const waitRows = async (predicate, label, timeout = 3000) => {
  const deadline = Date.now() + timeout;
  for (;;) {
    const names = await rowNames();
    if (predicate(names)) return names;
    if (Date.now() > deadline) throw new Error(`timed out: ${label}; rows: ${names.join(', ')}`);
    await page.waitForTimeout(25);
  }
};

try {
  await page.goto(env.base);
  await page.fill('#auth-password', OWNER_PASSWORD);
  await page.press('#auth-password', 'Enter');
  await page.getByRole('button', { name: 'Files' }).first().click();
  await page.fill('input[aria-label^="SSH password"]', SSH_PASSWORD);
  await page.press('input[aria-label^="SSH password"]', 'Enter');
  await waitRows((names) => names.includes('readme.md'), 'initial listing', 10000);
  await page.waitForSelector('.files-pane.active .files-live:not([hidden])', { timeout: 5000 });
  await page.waitForTimeout(400);
  await shoot('01-live-initial.png', 'initial listing, live badge on');

  let t0 = Date.now();
  fs.writeFileSync(`${HOME}/created-on-host.txt`, 'made outside RemoteHub\n');
  await waitRows((names) => names.includes('created-on-host.txt'), 'external create');
  note('external create visible', { ms: Date.now() - t0 });
  await shoot('02-after-external-create.png', 'after `echo > created-on-host.txt` on the host');

  t0 = Date.now();
  fs.renameSync(`${HOME}/created-on-host.txt`, `${HOME}/renamed-on-host.txt`);
  await waitRows((names) => names.includes('renamed-on-host.txt') && !names.includes('created-on-host.txt'), 'external rename');
  note('external rename visible', { ms: Date.now() - t0 });
  await shoot('03-after-external-rename.png', 'after `mv created-on-host.txt renamed-on-host.txt` on the host');

  t0 = Date.now();
  fs.unlinkSync(`${HOME}/renamed-on-host.txt`);
  await waitRows((names) => !names.includes('renamed-on-host.txt'), 'external delete');
  note('external delete visible', { ms: Date.now() - t0 });
  await shoot('04-after-external-delete.png', 'after `rm renamed-on-host.txt` on the host');

  // Rename and delete through RemoteHub's own Files UI while live.
  const pane = page.locator('.files-pane.active');
  t0 = Date.now();
  await pane.locator('.files-row', { hasText: 'notes.txt' }).first().click();
  await pane.locator('[data-files-action="Rename"]').first().click();
  await pane.locator('.files-mutation-form input').fill('notes-renamed.txt');
  await pane.locator('.files-mutation-form input').press('Enter');
  await waitRows((names) => names.includes('notes-renamed.txt') && !names.includes('notes.txt'), 'UI rename');
  await page.waitForTimeout(500);
  const afterUiRename = await rowNames();
  assert.equal(new Set(afterUiRename).size, afterUiRename.length, 'no duplicate rows after UI rename');
  assert.ok(fs.existsSync(`${HOME}/notes-renamed.txt`) && !fs.existsSync(`${HOME}/notes.txt`));
  assert.ok(await page.$eval('.files-pane.active .files-live', (node) => !node.hidden), 'still live after UI rename');
  note('UI rename visible', { ms: Date.now() - t0 });
  await shoot('04a-after-ui-rename.png', 'renamed notes.txt -> notes-renamed.txt through the Files UI');

  t0 = Date.now();
  await pane.locator('.files-row', { hasText: 'notes-renamed.txt' }).first().click();
  await pane.locator('[data-files-action="Delete"]').first().click();
  await pane.locator('.files-mutation-form input').fill('notes-renamed.txt');
  await pane.locator('.files-mutation-form input').press('Enter');
  await waitRows((names) => !names.includes('notes-renamed.txt'), 'UI delete');
  await page.waitForTimeout(500);
  const afterUiDelete = await rowNames();
  assert.equal(new Set(afterUiDelete).size, afterUiDelete.length, 'no duplicate rows after UI delete');
  assert.ok(!fs.existsSync(`${HOME}/notes-renamed.txt`));
  assert.ok(afterUiDelete.includes('readme.md') && afterUiDelete.includes('projects'), 'other rows untouched');
  assert.ok(await page.$eval('.files-pane.active .files-live', (node) => !node.hidden), 'still live after UI delete');
  note('UI delete visible', { ms: Date.now() - t0 });
  await shoot('04b-after-ui-delete.png', 'deleted notes-renamed.txt through the Files UI (typed confirmation)');

  // Burst: 20 files at once; must end with exactly 20 new rows (no duplicates).
  t0 = Date.now();
  for (let i = 0; i < 20; i += 1) fs.writeFileSync(`${HOME}/burst-${String(i).padStart(2, '0')}.log`, `${i}\n`);
  await waitRows((names) => names.filter((n) => n.startsWith('burst-')).length === 20, 'burst');
  await page.waitForTimeout(500);
  const afterBurst = await rowNames();
  assert.equal(new Set(afterBurst).size, afterBurst.length, 'no duplicate rows');
  note('burst visible', { ms: Date.now() - t0, burstRows: afterBurst.filter((n) => n.startsWith('burst-')).length, duplicates: afterBurst.length - new Set(afterBurst).size });
  await shoot('05-after-burst-20-files.png', 'after creating 20 files at once on the host');
  for (let i = 0; i < 20; i += 1) fs.unlinkSync(`${HOME}/burst-${String(i).padStart(2, '0')}.log`);
  await waitRows((names) => !names.some((n) => n.startsWith('burst-')), 'burst cleanup');

  // Navigate into projects: the watch follows.
  await page.locator('.files-pane.active .files-row', { hasText: 'projects' }).first().dblclick();
  await page.waitForFunction(() => document.querySelector('.files-pane.active .files-crumbs')?.textContent.includes('projects'));
  await page.waitForTimeout(400);
  fs.writeFileSync(`${HOME}/projects/plan.md`, 'plan\n');
  fs.writeFileSync(`${HOME}/should-not-matter.txt`, 'parent dir change\n');
  await waitRows((names) => names.includes('plan.md'), 'create in new dir');
  await shoot('06-navigated-into-projects-live.png', 'navigated into projects; created plan.md on the host');

  // Agent stops: badge goes away, polling takes over (5 s).
  agent.kill('SIGTERM');
  await page.waitForSelector('.files-pane.active .files-live[hidden]', { state: 'attached', timeout: 5000 });
  await page.waitForTimeout(300);
  await shoot('07-agent-stopped-polling.png', 'agent process stopped; live badge gone, polling fallback');
  t0 = Date.now();
  fs.writeFileSync(`${HOME}/projects/after-agent-stop.txt`, 'seen by polling\n');
  await waitRows((names) => names.includes('after-agent-stop.txt'), 'polling fallback', 15000);
  note('polling fallback visible', { ms: Date.now() - t0 });
  await shoot('08-polling-picked-up-change.png', 'change made after the agent stopped, picked up by polling');
  note('frames', { watchStatus: frames.filter((m) => m.t === 'watch-status'), fsEventCount: frames.filter((m) => m.t === 'fs-event').length, sampleEvents: frames.filter((m) => m.t === 'fs-event').slice(0, 6) });
  assert.ok(!agentLog.includes(agentToken), 'agent stderr never contains the token');
  note('agent-stderr-has-no-token', { checked: true, lines: agentLog.trim().split('\n') });
} finally {
  fs.writeFileSync(path.join(shotDir, 'run-log.json'), JSON.stringify({ log, agentStderr: agentLog }, null, 2));
  await browser.close();
  if (agent.exitCode === null && agent.signalCode === null) agent.kill('SIGTERM');
  await env.stop();
  sshServer.close();
}
