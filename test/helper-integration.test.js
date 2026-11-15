import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import WebSocket from 'ws';
import { fingerprintOf } from '../server/ssh-bridge.js';
import { CWD_COMMAND, helperTokens } from '../server/helper-deploy.js';
import { startFakeSshServer } from './helpers/fake-ssh-server.js';
import { httpClient, startTestApp } from './helpers/app-harness.js';
import { makeDocument } from './helpers/fake-dom.js';

// SAA-299 end to end: production FileSession (node:vm) -> real HTTP/WS server ->
// real ssh2 client -> fake SSH server. The fake server's exec handler plays the
// host: it answers `uname -sm` and runs a scripted helper that behaves like
// `remotehub-agent --mode temporary --helper-token-file ... --helper-cleanup`
// against the in-memory SFTP tree the upload went to.

const HOME = '/home/tester';
const SSH_PASSWORD = 'correct horse';

async function waitFor(predicate, label, timeout = 8000) {
  const deadline = performance.now() + timeout;
  while (!predicate()) {
    assert.ok(performance.now() < deadline, `timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const row = (session, name) => session.listEl.children.find((node) => node.getAttribute('data-files-key') === name);
const HELPER_COMMAND = /^exec '([^']+)\/remotehub-agent' --mode temporary --root '([^']+)' --helper-token-file '([^']+)' --helper-cleanup --helper-ttl (\d+)$/;

function runFakeHelper(channel, fixture, { dir, tokenPath, selfClean, expectToken }) {
  const tree = fixture.remoteTree;
  const snapshot = {
    dirMode: tree.get(dir)?.mode,
    binaryMode: tree.get(`${dir}/remotehub-agent`)?.mode,
    tokenMode: tree.get(tokenPath)?.mode,
  };
  // Like the real helper: read the token, delete the file at once.
  const token = tree.get(tokenPath)?.content?.toString().trim();
  tree.delete(tokenPath);
  const helper = { dir, token, snapshot, channel, requests: [], eof: false, exitCode: null };
  fixture.helpers.push(helper);
  const write = (frame) => channel.write(`${JSON.stringify(frame)}\n`);
  helper.emit = write;
  const finish = (code) => {
    if (helper.exitCode !== null) return;
    helper.exitCode = code;
    if (selfClean) {
      tree.delete(`${dir}/remotehub-agent`);
      tree.delete(dir);
    }
    channel.exit(code);
    channel.end();
  };
  write({ event: 'hello', protocol: 1, name: 'remotehub-agent', version: '0.1.0', mode: 'temporary', capabilities: { files: { watch: true } } });
  let authed = false;
  let buffer = '';
  let nextWatch = 1;
  channel.on('data', (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const request = JSON.parse(buffer.slice(0, index));
      buffer = buffer.slice(index + 1);
      helper.requests.push(request.op);
      if (!authed) {
        if (request.op !== 'hello' || request.params?.token !== (expectToken ?? token)) {
          write({ id: request.id, ok: false, error: { code: 'unauthorized', message: 'a hello with the local access token is required' } });
          return finish(3);
        }
        authed = true;
      }
      if (request.op === 'hello') write({ id: request.id, ok: true, result: { event: 'authenticated', protocol: 1, mode: 'temporary' } });
      if (request.op === 'watchDirectory') write({ id: request.id, ok: true, result: { watchId: nextWatch++, path: request.params.path } });
      if (request.op === 'unwatchDirectory') write({ id: request.id, ok: true, result: { watchId: request.params.watchId, stopped: true } });
    }
  });
  channel.on('end', () => { helper.eof = true; finish(0); });
}

async function startHelperFixture({ uname = 'Linux x86_64', selfClean = true, expectToken, extraEntries = [], hostNow = 1700010000, ps = 'sshd: tester\n', cwd = 'C /home/tester\nRH_CWD_OK\n', hardlinks = [] } = {}) {
  const fixture = { outbound: [], timers: new Set(), remoteTree: null, helpers: [], logs: [] };
  fixture.helperDir = await mkdtemp(path.join(os.tmpdir(), 'rh-helper-builds-'));
  await writeFile(path.join(fixture.helperDir, 'remotehub-agent-linux-x86_64'), Buffer.alloc(70_000, 9));
  fixture.env = await startTestApp({ agentPort: 8377, helperDir: fixture.helperDir }, { log: (line) => fixture.logs.push(String(line)) });
  fixture.ssh = await startFakeSshServer({
    sftpEntries: [['/tmp', { type: 'dir', mode: 0o1777, uid: 0 }], ...extraEntries],
    onSftpTree(tree) { fixture.remoteTree = tree; },
    onExec(command, accept, reject) {
      if (command === 'id -u; date +%s' || command === 'ps -ww -A -o args=' || command === CWD_COMMAND || command.startsWith('find -P ')) {
        const channel = accept();
        let out = command.startsWith('id') ? `1000\n${hostNow}\n` : command === CWD_COMMAND ? cwd : ps;
        const find = /^find -P '([^']+)' /.exec(command);
        if (find) {
          const hits = [...fixture.remoteTree.keys()].filter((k) => k.startsWith(`${find[1]}/`) && (fixture.remoteTree.get(k).type === 'symlink' || hardlinks.includes(k)));
          out = `${hits.map((k) => `${k}\n`).join('')}RH_FIND_OK\n`;
        }
        channel.write(out);
        channel.exit(0);
        channel.end();
        return;
      }
      if (command === 'uname -sm') {
        const channel = accept();
        channel.write(`${uname}\n`);
        channel.exit(0);
        channel.end();
        return;
      }
      const match = HELPER_COMMAND.exec(command);
      if (!match) return reject();
      runFakeHelper(accept(), fixture, { dir: match[1], tokenPath: match[3], selfClean, expectToken });
    },
  });
  const { env, ssh, outbound, timers } = fixture;
  const client = httpClient(env.base, env.origin);
  await client.request('/api/auth/setup', { method: 'POST', body: { setupCode: env.app.setupCode, password: 'helper-owner-password' } });
  const created = await client.request('/api/hosts', { method: 'POST', body: { name: 'Helper host', address: '127.0.0.1', port: ssh.port, username: 'tester' } });
  await env.app.store.setKnownHost('127.0.0.1', ssh.port, { keyType: 'ssh-ed25519', fingerprint: fingerprintOf(ssh.publicBlob) });
  const context = vm.createContext({
    document: makeDocument(), console, Date, queueMicrotask,
    location: new URL(env.base),
    setTimeout: (fn, ms) => { const id = setTimeout(() => { timers.delete(id); fn(); }, ms); timers.add(id); return id; },
    clearTimeout: (id) => { timers.delete(id); clearTimeout(id); },
    WebSocket: class extends WebSocket {
      constructor(url) { super(url, { headers: { Cookie: client.cookie, Origin: env.origin } }); }
      send(data, ...args) {
        outbound.push(JSON.parse(data).t);
        return super.send(data, ...args);
      }
    },
  });
  const domSource = await readFile(new URL('../public/js/dom.js', import.meta.url), 'utf8');
  const fileSource = await readFile(new URL('../public/js/file-session.js', import.meta.url), 'utf8');
  vm.runInContext(domSource.replace(/^export /gm, '') + '\n' + fileSource.replace("import { el } from './dom.js';", '').replace(/^export /gm, '') + '\nglobalThis.FileSession = FileSession;', context);
  fixture.session = new context.FileSession({ host: created.body.host });
  fixture.session.show();
  fixture.session.connect(SSH_PASSWORD);
  fixture.leftovers = (dir) => [...fixture.remoteTree.keys()].filter((key) => key === dir || key.startsWith(`${dir}/`));
  fixture.stop = async () => {
    fixture.session?.dispose();
    for (const id of timers) clearTimeout(id);
    await ssh.close();
    await env.stop();
    await rm(fixture.helperDir, { recursive: true, force: true });
  };
  return fixture;
}

function assertNoSecrets(fixture) {
  const text = fixture.logs.join('\n');
  for (const helper of fixture.helpers) if (helper.token) assert.ok(!text.includes(helper.token), 'helper token never logged');
  assert.ok(!text.includes(SSH_PASSWORD), 'SSH password never logged');
}

test('temporary helper: deploy, live updates marked as helper, then stop removes it and reuse fails', { timeout: 60_000 }, async () => {
  // This helper does not delete itself, so RemoteHub's own SFTP cleanup is what is proven.
  const fixture = await startHelperFixture({ selfClean: false });
  const { session, ssh } = fixture;
  try {
    await waitFor(() => session.helper.available && session.state === 'ready' && !session.pending, 'helper offered');
    assert.equal(session.helperButton.hidden, false);
    assert.equal(session.helperButton.textContent, 'Start a temporary connection for this visit');
    await waitFor(() => session.watchRequested === HOME, 'watch requested');

    session.toggleHelper();
    await waitFor(() => session.livePath === HOME && session.liveSource === 'helper', 'live through the helper');
    const [helper] = fixture.helpers;
    // Upload shape: private dir, private binary, private single-use token file.
    assert.match(helper.dir, /^\/tmp\/remotehub-helper-[0-9a-f]{16}$/);
    assert.deepEqual(helper.snapshot, { dirMode: 0o700, binaryMode: 0o700, tokenMode: 0o600 });
    assert.equal(fixture.remoteTree.get(`${helper.dir}/remotehub-agent`).size, 70_000);
    assert.equal(fixture.remoteTree.has(`${helper.dir}/session-token`), false, 'token file gone once read');
    assert.deepEqual(helper.requests.slice(0, 2), ['hello', 'watchDirectory']);
    assert.ok(!ssh.events.execs.some((command) => command.includes(helper.token)), 'token never on a command line');

    // Visibly distinguished from a persistent agent.
    assert.equal(session.liveBadge.hidden, false);
    assert.equal(session.liveBadge.textContent, 'Live \u00b7 temporary connection for this visit');
    assert.equal(session.liveBadge.className, 'files-live files-live-helper');
    assert.equal(session.helperChip.hidden, false);
    assert.equal(session.helperChip.textContent, 'Temporary connection for this visit \u00b7 linux-x86_64');
    assert.equal(session.helperButton.textContent, 'Stop the temporary connection');
    assert.equal(session.pollTimer, null, 'no polling while the helper is live');

    // SAA-300: the host's live status shows the helper and the capability it adds.
    const liveReports = () => [...fixture.env.app.hostStatus.hosts.values()].flatMap((reports) => [...reports.values()]);
    assert.deepEqual(liveReports().map((report) => [report.source, report.mode, report.capabilities.files.watch]), [['helper', 'temporary', true]]);

    // Enhanced capability: a change on the host shows up from one event.
    await sleep(300);
    await waitFor(() => !session.pending, 'catch-up re-list');
    fixture.remoteTree.set(`${HOME}/from-helper.txt`, { type: 'file', mode: 0o644, size: 2, mtime: 1700000900, content: Buffer.from('hi') });
    helper.emit({ event: 'filesystemEvent', watchId: 1, change: 'create', path: `${HOME}/from-helper.txt` });
    await waitFor(() => row(session, 'from-helper.txt') && !session.pending, 'helper event refreshes the listing');

    // The token was single-use: redeeming it again fails.
    assert.equal(helperTokens.consume(helper.token), false);

    // Normal close of the helper from the UI.
    session.toggleHelper();
    await waitFor(() => session.helper.state === 'stopped', 'helper stopped');
    assert.deepEqual(liveReports(), [], 'stopping the helper withdraws its capability');
    assert.equal(helper.eof, true, 'helper got EOF (session ended)');
    assert.deepEqual(fixture.leftovers(helper.dir), [], 'binary and directory removed by RemoteHub');
    assert.ok(ssh.events.sftp.rmdirs.includes(helper.dir));
    assert.match(session.notice, /stopped and removed from the computer/);
    assert.equal(session.livePath, null);
    assert.equal(session.helperChip.hidden, true);
    assert.equal(session.helperButton.textContent, 'Start a temporary connection for this visit');
    await waitFor(() => session.pollTimer !== null, 'polling resumes');
    assertNoSecrets(fixture);
  } finally {
    await fixture.stop();
  }
});

test('closing Files stops a running helper; nothing persists on the host', { timeout: 60_000 }, async () => {
  const fixture = await startHelperFixture({ selfClean: true });
  const { session } = fixture;
  try {
    await waitFor(() => session.helper.available && session.state === 'ready' && !session.pending, 'helper offered');
    session.toggleHelper();
    await waitFor(() => session.liveSource === 'helper', 'live through the helper');
    const [helper] = fixture.helpers;
    session.dispose();
    fixture.session = null;
    await waitFor(() => helper.eof && helper.exitCode === 0, 'helper told to exit on close');
    await waitFor(() => fixture.leftovers(helper.dir).length === 0, 'helper files removed');
    assert.equal(fixture.env.app.hostStatus.hosts.size, 0, 'closing Files withdraws the helper from host status');
    assert.equal(helperTokens.consume(helper.token), false, 'token invalid after the session');
    assertNoSecrets(fixture);
  } finally {
    await fixture.stop();
  }
});

test('failures: unsupported OS uploads nothing; a refused helper is still cleaned up', { timeout: 60_000 }, async () => {
  const unsupported = await startHelperFixture({ uname: 'Windows_NT x86_64' });
  try {
    const { session, ssh } = unsupported;
    await waitFor(() => session.helper.available && session.state === 'ready' && !session.pending, 'helper offered');
    session.toggleHelper();
    await waitFor(() => session.helper.state === 'failed', 'deploy failed');
    assert.match(session.notice, /Temporary connection couldn’t start: A temporary connection isn’t available for this computer/);
    assert.deepEqual(ssh.events.execs, ['uname -sm']);
    assert.ok(!ssh.events.sftp.mkdirs.some((dir) => dir.startsWith('/tmp/')), 'nothing uploaded');
    assert.equal(session.helperButton.textContent, 'Start a temporary connection for this visit', 'can retry');
  } finally {
    await unsupported.stop();
  }

  // The helper refuses the session (as if handed a stale token) and exits without
  // deleting itself: RemoteHub still removes everything it uploaded.
  const refused = await startHelperFixture({ selfClean: false, expectToken: 'f'.repeat(64) });
  try {
    const { session } = refused;
    await waitFor(() => session.helper.available && session.state === 'ready' && !session.pending, 'helper offered');
    session.toggleHelper();
    await waitFor(() => session.helper.state === 'stopped', 'refused helper stopped');
    const [helper] = refused.helpers;
    assert.equal(helper.exitCode, 3);
    assert.deepEqual(refused.leftovers(helper.dir), [], 'cleanup attempted and confirmed after failure');
    assert.equal(session.livePath, null, 'never went live');
    assertNoSecrets(refused);
  } finally {
    await refused.stop();
  }
});

test('before deploying, stale own helper folders are swept; fresh, in-use, cwd-in-use, linked, foreign and symlinked ones are kept', { timeout: 60_000 }, async () => {
  const NOW = 1700010000;
  const dir = (c) => `/tmp/remotehub-helper-${c.repeat(16)}`;
  const folder = (mtime, uid = 1000) => ({ type: 'dir', mode: 0o700, uid, mtime, atime: mtime });
  const file = (uid = 1000) => ({ type: 'file', mode: 0o700, uid, size: 4, mtime: NOW - 9000, content: Buffer.from('bin!') });
  const fixture = await startHelperFixture({
    hostNow: NOW,
    ps: `sshd: tester\n${dir('3')}/remotehub-agent --mode temporary --root /home/tester\n`,
    cwd: `C /home/tester\nC ${dir('6')}\nRH_CWD_OK\n`,
    hardlinks: [`${dir('8')}/remotehub-agent`],
    extraEntries: [
      [dir('1'), folder(NOW - 2 * 3600)], [`${dir('1')}/remotehub-agent`, file()], // stale, own, idle
      [dir('2'), folder(NOW - 600)], [`${dir('2')}/remotehub-agent`, file()], // fresh
      [dir('3'), folder(NOW - 3 * 3600)], [`${dir('3')}/remotehub-agent`, file()], // in use
      [dir('4'), folder(NOW - 3 * 3600, 0)], [`${dir('4')}/remotehub-agent`, file(0)], // other owner
      [dir('5'), { type: 'symlink', target: `${HOME}/documents`, mode: 0o777, mtime: NOW - 3 * 3600 }], // symlink
      [dir('6'), folder(NOW - 3 * 3600)], [`${dir('6')}/remotehub-agent`, file()], // a shell's working directory
      [dir('7'), folder(NOW - 3 * 3600)], [`${dir('7')}/remotehub-agent`, file()], // contains a symlink
      [`${dir('7')}/escape`, { type: 'symlink', target: `${HOME}/documents`, mode: 0o777, mtime: NOW - 9000 }],
      [dir('8'), folder(NOW - 3 * 3600)], [`${dir('8')}/remotehub-agent`, file()], // contains a hard link
    ],
  });
  const { session, ssh } = fixture;
  try {
    await waitFor(() => session.helper.available && session.state === 'ready' && !session.pending, 'helper offered');
    session.toggleHelper();
    await waitFor(() => session.liveSource === 'helper', 'live through the helper');
    const tree = fixture.remoteTree;
    assert.equal(tree.has(dir('1')), false, 'stale folder swept');
    assert.ok(tree.has(`${HOME}/documents`), 'symlink target untouched');
    assert.equal(tree.get(`${dir('7')}/escape`)?.type, 'symlink', 'link inside a kept folder untouched');
    for (const c of ['2', '3', '4', '6', '7', '8']) assert.ok(tree.has(`${dir(c)}/remotehub-agent`), `${dir(c)} kept`);
    assert.equal(tree.get(dir('5'))?.type, 'symlink', 'symlinked folder kept');
    assert.ok(!ssh.events.sftp.opendirPaths.includes(dir('5')), 'symlinked folder never listed');
    assert.ok(!ssh.events.sftp.removes.some((p) => ['2', '3', '4', '6', '7', '8'].some((c) => p.startsWith(dir(c)))));
    assert.deepEqual(ssh.events.sftp.rmdirs, [dir('1')], 'only the stale folder removed before deploy');
    // The sweep ran before the new helper was uploaded.
    const order = ssh.events.execs;
    assert.ok(order.indexOf('ps -ww -A -o args=') < order.findIndex((c) => c.startsWith('exec ')));
    assert.ok(fixture.logs.some((line) => line.includes('swept 1 stale temporary helper folder(s)')));
  } finally {
    await fixture.stop();
  }
});
