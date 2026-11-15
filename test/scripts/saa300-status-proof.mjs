/**
 * SAA-300 real-run proof: agent capability negotiation and host status.
 *
 * Real RemoteHub server + the real release `remotehub-agent` in two roles:
 *   1. an outbound *registered* persistent agent on /ws/agent, and
 *   2. a loopback persistent agent reached through a Files session over SSH,
 * driven from headless Chromium. Shows the host rail/edit dialog status
 * (connected/disconnected, persistent, version, OS/arch), the merged
 * capabilities with provenance, and that a disconnect removes only the
 * agent-dependent capability.
 *
 *   node test/scripts/saa300-status-proof.mjs <agent-binary> <screenshot-dir>
 *
 * No secret (SSH password, agent credential, local token, owner password) is logged.
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
assert.ok(agentBin && shotDir, 'usage: saa300-status-proof.mjs <agent-binary> <screenshot-dir>');
fs.mkdirSync(shotDir, { recursive: true });

const ROOT = '/tmp/rh300-root';
const HOME = `${ROOT}/home/demo`;
const AGENT_PORT = 18399;
const TOKEN_FILE = `${HOME}/.remotehub/agent-local-token`;
const CRED_FILE = '/tmp/rh300-cred/agent-credential';
const SSH_PASSWORD = 'status demo pw';
const OWNER_PASSWORD = 'saa300-owner-password';
const secrets = [SSH_PASSWORD, OWNER_PASSWORD];
const log = [];
const note = (step, detail = {}) => { const entry = { at: new Date().toISOString(), step, ...detail }; log.push(entry); console.log(JSON.stringify(entry)); };

fs.rmSync(ROOT, { recursive: true, force: true });
fs.rmSync(path.dirname(CRED_FILE), { recursive: true, force: true });
fs.mkdirSync(`${HOME}/projects`, { recursive: true });
fs.mkdirSync(path.dirname(CRED_FILE), { recursive: true, mode: 0o700 });
fs.writeFileSync(`${HOME}/readme.md`, '# demo\n');

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

const serverLog = [];
const env = await startTestApp({ agentPort: 8377 }, { log: (line) => serverLog.push(String(line)) });
const client = httpClient(env.base, env.origin);
await client.request('/api/auth/setup', { method: 'POST', body: { setupCode: env.app.setupCode, password: OWNER_PASSWORD } });
const created = await client.request('/api/hosts', { method: 'POST', body: { name: 'Status demo', address: '127.0.0.1', port: sshPort, username: 'demo' } });
const hostId = created.body.host.id;
await env.app.store.setKnownHost('127.0.0.1', sshPort, { keyType: 'ssh-ed25519', fingerprint: fingerprintOf(utils.parseKey(keys.public).getPublicSSH()) });
const issued = await client.request(`/api/hosts/${hostId}/agent`, { method: 'POST' });
secrets.push(issued.body.token);
fs.writeFileSync(CRED_FILE, `${issued.body.token}\n`, { mode: 0o600 });
note('servers-up', { remotehub: env.base, sshPort, hostId, credentialIssued: true });

const view = async () => (await client.request('/api/hosts')).body.hosts.find((host) => host.id === hostId);
const apiSnapshot = (host) => ({ agent: host.agent, liveAgent: host.liveAgent, stored: pick(host.capabilities), effective: pick(host.effectiveCapabilities), provenance: host.capabilityProvenance });
const pick = (c) => ({ 'terminal.ssh': c.terminal.ssh, 'files.sftp': c.files.sftp, 'files.watch': c.files.watch, 'desktop.nativeStream': c.desktop.nativeStream, 'desktop.rdp': c.desktop.rdp, 'desktop.vnc': c.desktop.vnc });
const waitView = async (predicate, label, timeout = 10000) => {
  const deadline = Date.now() + timeout;
  for (;;) {
    const host = await view();
    if (predicate(host)) return host;
    if (Date.now() > deadline) throw new Error(`timed out: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
};

const procs = [];
const startAgent = (args, extraEnv = {}) => {
  const child = spawn(agentBin, args, { stdio: ['ignore', 'ignore', 'pipe'], env: { PATH: process.env.PATH, ...extraEnv } });
  child.stderrText = '';
  child.stderr.on('data', (chunk) => { child.stderrText += chunk; });
  procs.push(child);
  return child;
};
const stopAgent = async (child) => {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill('SIGTERM'); // own PID only
  await exited;
};

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || `${process.env.HOME}/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome` });
const page = await browser.newPage({ viewport: { width: 1200, height: 760 } });
const railText = () => page.$eval('.host-agent', (node) => node.textContent).catch(() => null);
const waitRail = async (predicate, label, timeout = 12000) => {
  const deadline = Date.now() + timeout;
  for (;;) {
    const text = await railText();
    if (predicate(text)) return text;
    if (Date.now() > deadline) throw new Error(`timed out: ${label}; rail: ${text}`);
    await page.waitForTimeout(100);
  }
};
const shoot = async (name, step, extra = {}) => {
  const file = path.join(shotDir, name);
  await page.screenshot({ path: file });
  note(step, { screenshot: file, rail: await railText(), ...extra });
};
const actions = () => page.$$eval('.host-capability', (nodes) => nodes.map((node) => `${node.textContent}:${node.disabled ? 'off' : 'on'}`));

let localAgent = null;
try {
  await page.goto(env.base);
  await page.fill('#auth-password', OWNER_PASSWORD);
  await page.press('#auth-password', 'Enter');
  await page.waitForSelector('.host-agent');
  let host = await view();
  assert.equal(host.liveAgent.connected, false);
  assert.equal(host.effectiveCapabilities.files.watch, false);
  await waitRail((text) => text === 'Agent · Disconnected', 'registered, not connected');
  await shoot('01-registered-disconnected.png', 'credential issued, no agent running', { api: apiSnapshot(host), actions: await actions() });

  // 1. Real outbound registered agent. Credential is read from a 0600 file, never argv.
  const outbound = startAgent(['--mode', 'persistent', '--root', ROOT], {
    REMOTEHUB_AGENT_SERVER: env.base.replace(/^http/, 'ws'),
    REMOTEHUB_AGENT_HOST_ID: hostId,
    REMOTEHUB_AGENT_TOKEN_FILE: CRED_FILE,
  });
  note('outbound-agent-started', { pid: outbound.pid });
  host = await waitView((h) => h.liveAgent.connected, 'outbound agent connected');
  assert.equal(host.liveAgent.source, 'registered');
  assert.equal(host.liveAgent.mode, 'persistent');
  assert.match(host.liveAgent.version, /^\d+\.\d+\.\d+/);
  assert.equal(host.liveAgent.os, process.platform === 'linux' ? 'linux' : host.liveAgent.os);
  assert.equal(host.liveAgent.arch, process.arch === 'x64' ? 'x86_64' : host.liveAgent.arch);
  // The outbound transport does not offer watching yet, so negotiation keeps it off.
  assert.equal(host.effectiveCapabilities.files.watch, false);
  assert.equal(host.effectiveCapabilities.terminal.ssh, true);
  const persistentRail = await waitRail((text) => text?.startsWith('Agent · Connected · persistent · v'), 'rail shows connected agent');
  await shoot('02-registered-connected.png', 'real outbound agent connected (4 s poll)', { api: apiSnapshot(host), actions: await actions() });

  // Edit dialog details.
  await page.locator('button[aria-label^="Edit Status demo"]').click();
  await page.waitForSelector('#host-agent-details:not([hidden])');
  const dialogDetails = await page.$eval('#host-agent-details', (node) => node.textContent);
  await shoot('03-edit-dialog-agent-details.png', 'edit dialog shows agent details', { dialogDetails });
  await page.keyboard.press('Escape');

  // 2. Loopback agent through Files adds live watching (merged with SSH caps).
  localAgent = startAgent(['--mode', 'persistent', '--listen', `127.0.0.1:${AGENT_PORT}`, '--root', ROOT, '--local-token-file', TOKEN_FILE]);
  note('local-agent-started', { pid: localAgent.pid });
  await new Promise((resolve, reject) => {
    const deadline = Date.now() + 5000;
    const tryConnect = () => {
      const socket = net.connect(AGENT_PORT, '127.0.0.1', () => { socket.destroy(); resolve(); });
      socket.on('error', () => (Date.now() > deadline ? reject(new Error('agent did not listen')) : setTimeout(tryConnect, 100)));
    };
    tryConnect();
  });
  await page.getByRole('button', { name: 'Files' }).first().click();
  await page.fill('input[aria-label^="SSH password"]', SSH_PASSWORD);
  await page.press('input[aria-label^="SSH password"]', 'Enter');
  await page.waitForSelector('.files-pane.active .files-live:not([hidden])', { timeout: 10000 });
  host = await waitView((h) => h.effectiveCapabilities.files.watch === true, 'watch negotiated');
  assert.equal(host.capabilityProvenance['files.watch'], 'agent');
  assert.equal(host.liveAgent.count, 2);
  assert.equal(host.capabilities.files.watch, false, 'stored capabilities untouched');
  await page.waitForTimeout(4500);
  await shoot('04-files-live-watch-negotiated.png', 'Files session via loopback agent: files.watch now provided by agent', { api: apiSnapshot(host) });

  // 3. Loopback agent dies: only files.watch goes; SSH/SFTP stay; registered agent still shown.
  const tStop = Date.now();
  await stopAgent(localAgent);
  host = await waitView((h) => h.effectiveCapabilities.files.watch === false, 'watch withdrawn');
  const withdrawMs = Date.now() - tStop;
  assert.equal(host.effectiveCapabilities.terminal.ssh, true);
  assert.equal(host.effectiveCapabilities.files.sftp, true);
  assert.equal(host.liveAgent.connected, true);
  assert.equal(host.liveAgent.count, 1);
  await page.waitForSelector('.files-pane.active .files-live[hidden]', { state: 'attached', timeout: 5000 });
  await page.waitForTimeout(4500);
  await shoot('05-local-agent-stopped-watch-removed.png', 'loopback agent stopped: only files.watch removed', { api: apiSnapshot(host), withdrawMs, actions: await actions() });

  // 4. Outbound agent dies: Disconnected; SSH/SFTP still available.
  const tOut = Date.now();
  await stopAgent(outbound);
  host = await waitView((h) => !h.liveAgent.connected, 'outbound gone');
  note('outbound-agent-stopped', { apiMs: Date.now() - tOut });
  assert.equal(host.agent.connected, false);
  assert.equal(host.effectiveCapabilities.terminal.ssh, true);
  assert.equal(host.effectiveCapabilities.files.sftp, true);
  await waitRail((text) => text === 'Agent · Disconnected', 'rail disconnected');
  note('rail-updated', { uiMs: Date.now() - tOut });
  await shoot('06-all-agents-disconnected.png', 'outbound agent stopped: Disconnected; Terminal/Files still enabled', { api: apiSnapshot(host), actions: await actions() });
  assert.deepEqual((await actions()).slice(0, 2), ['Terminal:on', 'Files:on']);

  // Nothing live persisted; no secrets in logs.
  const persisted = JSON.stringify(env.app.store.data);
  assert.equal(persisted.includes('liveAgent') || persisted.includes('effectiveCapabilities'), false, 'live status never persisted');
  const everything = JSON.stringify({ log, serverLog }) + procs.map((p) => p.stderrText).join('');
  for (const secret of secrets) assert.equal(everything.includes(secret), false, 'no secret in any log');
  const localToken = fs.existsSync(TOKEN_FILE) ? fs.readFileSync(TOKEN_FILE, 'utf8').trim() : null;
  if (localToken) assert.equal(everything.includes(localToken), false);
  note('checks', { persistedLiveStatus: false, secretsInLogs: false, persistentRail });
} finally {
  fs.writeFileSync(path.join(shotDir, 'run-log.json'), JSON.stringify({ log, serverLog, agentStderr: procs.map((p) => ({ pid: p.pid, stderr: p.stderrText })) }, null, 2));
  await browser.close();
  for (const child of procs) await stopAgent(child);
  await env.stop();
  sshServer.close();
  fs.rmSync(path.dirname(CRED_FILE), { recursive: true, force: true });
}
