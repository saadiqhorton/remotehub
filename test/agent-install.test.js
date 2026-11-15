import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { hashAgentToken } from '../server/agent-auth.js';
import { agentServerUrl, installAgent, reachableFrom } from '../server/agent-install.js';
import { fingerprintOf } from '../server/ssh-bridge.js';
import { startFakeSshServer } from './helpers/fake-ssh-server.js';
import { httpClient, startTestApp } from './helpers/app-harness.js';

// SAA-317: one-click agent install. The real server logs in to a fake SSH server, uploads the
// agent build over the fake SFTP tree, runs the install command there, and the test checks what
// the computer received. Nothing here touches the real network or a real agent binary.

const SSH_PASSWORD = 'correct horse';
const OWNER_PASSWORD = 'install-owner-password';
const BINARY_BYTES = Buffer.from('FAKE-REMOTEHUB-AGENT-BINARY');
const INSTALL_COMMAND = /^exec '(\/tmp\/remotehub-install-[0-9a-f]{16})\/remotehub-agent' install --server '([^']+)' --host-id '([^']+)' --token-file '(\/tmp\/remotehub-install-[0-9a-f]{16}\/agent\.token)'$/;

async function waitFor(predicate, label, timeout = 8000) {
  const deadline = performance.now() + timeout;
  while (!predicate()) {
    assert.ok(performance.now() < deadline, `timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/**
 * One RemoteHub, one fake computer, one owner signed in, and one host record for the computer.
 * `installer(ctx)` plays the agent's own `install` command; it may return a promise.
 */
async function fixture({ uname = 'Linux x86_64', installer = async () => ({ exit: 0 }), binary = true, trusted = true } = {}) {
  const helperDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rh-install-builds-'));
  if (binary) await fs.writeFile(path.join(helperDir, 'remotehub-agent-linux-x86_64'), BINARY_BYTES);
  const logs = [];
  let tree = null;
  const seen = { installs: [] };
  const ssh = await startFakeSshServer({
    password: SSH_PASSWORD,
    persistTree: true,
    sftpEntries: [['/tmp', { type: 'dir', mode: 0o1777 }]],
    onSftpTree(next) { tree = next; },
    onExec(command, accept) {
      const channel = accept();
      const finish = (exit, { stdout = '', stderr = '' } = {}) => {
        if (stdout) channel.write(stdout);
        if (stderr) channel.stderr.write(stderr);
        channel.exit(exit);
        channel.end();
      };
      if (command === 'uname -sm') return finish(0, { stdout: `${uname}\n` });
      const match = INSTALL_COMMAND.exec(command);
      if (!match) return finish(127, { stderr: 'unexpected command\n' });
      const [, dir, serverUrl, hostId, tokenPath] = match;
      const modeOf = (p) => (tree.get(p) ? tree.get(p).mode & 0o777 : null);
      const tokenFile = tree.get(tokenPath);
      // What the computer holds at the moment the installer starts.
      const ctx = {
        dir, serverUrl, hostId, tokenPath, command,
        snapshot: {
          dirMode: modeOf(dir),
          exeMode: modeOf(`${dir}/remotehub-agent`),
          exeBytes: tree.get(`${dir}/remotehub-agent`) ? Buffer.from(tree.get(`${dir}/remotehub-agent`).content) : null,
          tokenMode: modeOf(tokenPath),
          token: tokenFile ? tokenFile.content.toString('utf8') : null,
        },
      };
      seen.installs.push(ctx);
      Promise.resolve()
        .then(() => installer(ctx))
        .then((result) => finish(result.exit ?? 0, result), () => finish(1, { stderr: 'remotehub-agent install: fake installer crashed\n' }));
    },
  });
  const env = await startTestApp({ helperDir }, { log: (line) => logs.push(String(line)) });
  const owner = httpClient(env.base, env.origin);
  await owner.request('/api/auth/setup', { method: 'POST', body: { setupCode: env.app.setupCode, password: OWNER_PASSWORD } });
  const created = await owner.request('/api/hosts', { method: 'POST', body: { name: 'Install target', address: '127.0.0.1', port: ssh.port, username: 'tester' } });
  const hostId = created.body.host.id;
  // Most cases start from a computer whose key the owner already trusted; the host-key cases opt out.
  if (trusted) await env.app.store.setKnownHost('127.0.0.1', ssh.port, { keyType: 'ssh-ed25519', fingerprint: fingerprintOf(ssh.publicBlob) });
  const serverUrl = env.base.replace('http://', 'ws://');
  const install = (body = {}, client = owner) => client.request(`/api/hosts/${hostId}/agent/install`, {
    method: 'POST',
    body: { password: SSH_PASSWORD, serverUrl, ...body },
  });
  const stored = () => env.app.store.getHost(hostId);
  return {
    env, ssh, owner, hostId, logs, seen, serverUrl, install, stored, helperDir,
    tree: () => tree,
    async close() {
      await ssh.close();
      await env.stop();
      await fs.rm(helperDir, { recursive: true, force: true });
    },
  };
}

async function withFixture(options, body) {
  const f = await fixture(options);
  try {
    await body(f);
  } finally {
    await f.close();
  }
}

const noTempFolders = (f) => ![...f.tree().keys()].some((key) => key.startsWith('/tmp/remotehub-install-'));
const NO_INSTALL_ON_COMPUTER = (f) => {
  assert.ok(f.ssh.events.execs.every((command) => command === 'uname -sm'), 'only the system check ran');
  assert.equal(f.ssh.events.sftp.mkdirs.length, 0, 'nothing was created on the computer');
  assert.equal(f.ssh.events.sftp.opens.filter((p) => p.includes('remotehub-install-')).length, 0);
};

test('a successful install uploads the agent into a private folder, runs it, and leaves nothing behind', async () => {
  await withFixture({}, async (f) => {
    const res = await f.install();
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.ok, true);
    assert.equal(res.body.host.agent.registered, true);
    assert.equal(res.body.host.agent.connected, false);
    assert.match(res.body.message, /installed on Install target/);

    const [run] = f.seen.installs;
    assert.ok(run, 'the installer ran once');
    assert.equal(run.snapshot.dirMode, 0o700, 'the folder is private');
    assert.equal(run.snapshot.exeMode, 0o700, 'the agent is executable by its owner only');
    assert.deepEqual(run.snapshot.exeBytes, BINARY_BYTES);
    assert.equal(run.snapshot.tokenMode, 0o600, 'the token file is readable by its owner only');

    // The token on disk is exactly the one the server issued, and only its hash is stored.
    const token = run.snapshot.token.trim();
    assert.match(token, /^rhag_1_[A-Za-z0-9_-]+$/);
    assert.equal(run.snapshot.token, `${token}\n`);
    assert.equal(f.stored().agentCredential.tokenHash, hashAgentToken(token));
    assert.equal(f.stored().agentCredential.revokedAt, null);

    // The exact command shape: the agent's own install subcommand, every value shell-quoted.
    assert.deepEqual(f.ssh.events.execs, ['uname -sm', run.command]);
    assert.equal(run.serverUrl, f.serverUrl);
    assert.equal(run.hostId, f.hostId);
    assert.equal(run.tokenPath, `${run.dir}/agent.token`);

    // The temporary folder is gone, with its token file.
    assert.ok(noTempFolders(f), 'the temporary folder is removed');
    assert.equal(f.tree().has(run.dir), false);
    assert.equal(f.tree().has(run.tokenPath), false);

    const installLines = f.logs.filter((line) => line.includes('agent install'));
    assert.deepEqual(installLines, [`agent install host=${f.hostId} platform=linux-x86_64 outcome=installed`]);

    // The stored host shows the credential as registered, and the response never carries the token.
    assert.doesNotMatch(JSON.stringify(res.body), /rhag_1_/);
  });
});

test('neither the SSH password nor the agent token reach any log line or response', async () => {
  await withFixture({ installer: async () => ({ exit: 1, stderr: 'remotehub-agent install: systemctl --user unavailable\n' }) }, async (f) => {
    const responses = [];
    const bad = await f.install({ password: 'not the password' });
    responses.push(bad);
    const failed = await f.install();
    responses.push(failed);
    const token = f.seen.installs[0].snapshot.token.trim();
    const texts = [...f.logs, ...responses.map((r) => JSON.stringify(r.body))];
    for (const text of texts) {
      assert.ok(!text.includes(SSH_PASSWORD), 'the SSH password is not logged or returned');
      assert.ok(!text.includes('not the password'), 'a wrong password is not logged or returned');
      assert.ok(!text.includes(token), 'the agent token is not logged or returned');
      assert.ok(!text.includes('rhag_1_'), 'no token-shaped value is logged or returned');
    }
    // The failed install's command line carries the token file path, never the token itself.
    assert.ok(f.ssh.events.execs.every((command) => !command.includes(token)));
  });
});

test('an unknown host key is shown to the owner and nothing is sent until they accept that exact fingerprint', async () => {
  await withFixture({ trusted: false }, async (f) => {
    const fp = fingerprintOf(f.ssh.publicBlob);

    const first = await f.install();
    assert.equal(first.status, 409);
    assert.equal(first.body.code, 'hostkey-new');
    assert.equal(first.body.fingerprint, fp);
    assert.equal(first.body.keyType, 'ssh-ed25519');
    assert.equal(f.ssh.events.passwordsTried, 0, 'the password is not sent before the owner trusts the key');
    assert.equal(f.stored().agentCredential, undefined);
    assert.equal(f.env.app.store.getKnownHost('127.0.0.1', f.ssh.port), null);
    NO_INSTALL_ON_COMPUTER(f);

    const wrong = await f.install({ acceptFingerprint: 'SHA256:not-this-one' });
    assert.equal(wrong.status, 409);
    assert.equal(wrong.body.code, 'hostkey-new');
    assert.equal(wrong.body.fingerprint, fp, 'the refusal shows the real fingerprint again');
    assert.equal(f.ssh.events.passwordsTried, 0);
    assert.equal(f.env.app.store.getKnownHost('127.0.0.1', f.ssh.port), null, 'a wrong fingerprint is not saved');
    NO_INSTALL_ON_COMPUTER(f);

    const accepted = await f.install({ acceptFingerprint: fp });
    assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
    assert.equal(f.env.app.store.getKnownHost('127.0.0.1', f.ssh.port).fingerprint, fp, 'the accepted fingerprint is saved');
    assert.equal(f.seen.installs.length, 1);
  });
});

test('when the agent prints its reason on stdout instead of stderr, that reason is reported', async () => {
  const installer = async () => ({ exit: 1, stdout: 'remotehub-agent install: the token file is empty\n' });
  await withFixture({ installer }, async (f) => {
    const res = await f.install();
    assert.equal(res.status, 502);
    assert.match(res.body.error, /couldn’t be installed as a background service on this computer: the token file is empty$/);
  });
});

test('a computer whose host key differs from the saved one is refused before anything is uploaded', async () => {
  await withFixture({ trusted: false }, async (f) => {
    await f.env.app.store.setKnownHost('127.0.0.1', f.ssh.port, { keyType: 'ssh-ed25519', fingerprint: 'SHA256:someone-else' });
    const res = await f.install({ acceptFingerprint: fingerprintOf(f.ssh.publicBlob) });
    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'hostkey-mismatch');
    assert.equal(f.ssh.events.passwordsTried, 0);
    NO_INSTALL_ON_COMPUTER(f);
    assert.equal(f.stored().agentCredential, undefined);
    assert.equal(f.env.app.store.getKnownHost('127.0.0.1', f.ssh.port).fingerprint, 'SHA256:someone-else', 'the saved identity is untouched');
  });
});

test('a wrong SSH password gives a plain sign-in error and issues no credential', async () => {
  await withFixture({}, async (f) => {
    const res = await f.install({ password: 'wrong password' });
    assert.equal(res.status, 403, 'not 401: the browser would treat 401 as an expired RemoteHub session');
    assert.equal(res.body.code, 'auth');
    assert.equal(res.body.error, 'The server rejected that username and password.');
    assert.ok(f.ssh.events.passwordsTried > 0);
    assert.equal(f.stored().agentCredential, undefined);
    NO_INSTALL_ON_COMPUTER(f);
  });
});

test('when the agent refuses to install, its reason is reported, the credential is revoked and the folder removed', async () => {
  const installer = async () => ({ exit: 1, stderr: 'remotehub-agent install: systemctl --user unavailable: Failed to connect to bus\n' });
  await withFixture({ installer }, async (f) => {
    const res = await f.install();
    assert.equal(res.status, 502);
    assert.equal(res.body.code, 'install-failed');
    assert.match(res.body.error, /couldn’t be installed as a background service on this computer: systemctl --user unavailable: Failed to connect to bus/);
    const [run] = f.seen.installs;
    assert.equal(f.stored().agentCredential.tokenHash, hashAgentToken(run.snapshot.token.trim()), 'the revoked credential is the one issued for this install');
    assert.ok(f.stored().agentCredential.revokedAt, 'the credential is revoked');
    assert.ok(noTempFolders(f), 'the temporary folder is removed after a failure');
    assert.ok(f.logs.some((line) => line.includes('outcome=install-failed')));
  });
});

test('a server URL that points anywhere but this RemoteHub, or is not ws(s), is refused before login', async () => {
  await withFixture({}, async (f) => {
    const elsewhere = await f.install({ serverUrl: 'ws://10.0.0.9:8090' });
    assert.equal(elsewhere.status, 400);
    assert.equal(elsewhere.body.code, 'server-url');
    const plainHttp = await f.install({ serverUrl: f.env.base });
    assert.equal(plainHttp.status, 400);
    assert.equal(plainHttp.body.code, 'server-url');
    assert.equal(f.ssh.events.passwordsTried, 0, 'no login was attempted');
    assert.deepEqual(f.ssh.events.execs, []);
  });
});

test('a RemoteHub opened as localhost cannot install onto another computer (its agent could never dial back)', async () => {
  await withFixture({}, async (f) => {
    const lan = await f.owner.request('/api/hosts', { method: 'POST', body: { name: 'LAN box', address: '192.168.50.9', port: f.ssh.port, username: 'tester' } });
    const refused = await f.owner.request(`/api/hosts/${lan.body.host.id}/agent/install`, { method: 'POST', body: { password: 'pw', serverUrl: f.serverUrl } });
    assert.equal(refused.status, 400);
    assert.equal(refused.body.code, 'server-url-loopback');
    assert.match(refused.body.error, /network address/);
    assert.equal(f.ssh.events.passwordsTried, 0, 'refused before any login');
  });
});

test('reachability: a localhost RemoteHub is reachable only from the same machine', () => {
  assert.equal(reachableFrom('ws://localhost:8090', '192.168.1.20'), false);
  assert.equal(reachableFrom('ws://127.0.0.1:8090', 'pc.lan'), false);
  assert.equal(reachableFrom('ws://[::1]:8090', '10.0.0.2'), false);
  assert.equal(reachableFrom('ws://localhost:8090', '127.0.0.1'), true, 'the target is this machine');
  assert.equal(reachableFrom('ws://[::1]:8090', '::1'), true);
  assert.equal(reachableFrom('wss://hub.example', '192.168.1.20'), true);
  assert.equal(reachableFrom('ws://192.168.1.5:8090', '192.168.1.20'), true);
});

test('the install route refuses a foreign Origin, a signed-out caller, an unknown host and bad input', async () => {
  await withFixture({}, async (f) => {
    const foreign = httpClient(f.env.base, 'http://evil.example');
    foreign.cookie = f.owner.cookie;
    const blocked = await f.install({}, foreign);
    assert.equal(blocked.status, 403);

    const anonymous = httpClient(f.env.base, f.env.origin);
    const signedOut = await f.install({}, anonymous);
    assert.equal(signedOut.status, 401);

    const missing = await f.owner.request('/api/hosts/does-not-exist/agent/install', {
      method: 'POST', body: { password: SSH_PASSWORD, serverUrl: f.serverUrl },
    });
    assert.equal(missing.status, 404);

    const noPassword = await f.install({ password: '' });
    assert.equal(noPassword.status, 400);
    assert.equal(noPassword.body.code, 'password');
    const longPassword = await f.install({ password: 'x'.repeat(1025) });
    assert.equal(longPassword.status, 400);
    assert.equal(f.ssh.events.passwordsTried, 0);
    assert.deepEqual(f.ssh.events.execs, []);
  });
});

test('a second install for the same computer is refused while the first is still running', async () => {
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  await withFixture({ installer: () => held }, async (f) => {
    const first = f.install();
    try {
      await waitFor(() => f.ssh.events.execs.some((command) => command.includes(' install --server ')), 'the first install to start');
      const second = await f.install();
      assert.equal(second.status, 409);
      assert.equal(second.body.code, 'busy');
    } finally {
      release({ exit: 0 });
    }
    const firstRes = await first;
    assert.equal(firstRes.status, 200, JSON.stringify(firstRes.body));
  });
});

test('a computer whose system RemoteHub cannot install on is refused before anything is uploaded', async () => {
  await withFixture({ uname: 'Windows_NT x86_64' }, async (f) => {
    const res = await f.install();
    assert.equal(res.status, 400);
    assert.equal(res.body.code, 'unsupported');
    assert.match(res.body.error, /only on Linux and Mac/);
    NO_INSTALL_ON_COMPUTER(f);
  });
});

test('a server with no agent build for that system refuses with a plain 503 and uploads nothing', async () => {
  await withFixture({ binary: false }, async (f) => {
    const res = await f.install();
    assert.equal(res.status, 503);
    assert.equal(res.body.code, 'no-binary');
    assert.match(res.body.error, /no agent build for that system \(linux, x86_64\)/);
    NO_INSTALL_ON_COMPUTER(f);
    assert.equal(f.stored().agentCredential, undefined);
  });
});

test('the agent installer is given a time limit; when it runs past it the install fails and is cleaned up', async () => {
  await withFixture({ installer: () => new Promise(() => {}) }, async (f) => {
    // The route uses the 60 s limit; the limit is injected here so the test stays short.
    const host = f.stored();
    await assert.rejects(
      installAgent({
        store: f.env.app.store,
        registry: f.env.app.registry,
        host,
        password: SSH_PASSWORD,
        serverUrl: f.serverUrl,
        helperDir: f.helperDir,
        timeoutMs: 300,
      }),
      (error) => error.code === 'install-timeout' && /within 0\.3 seconds|didn’t finish/.test(error.message),
    );
    assert.ok(noTempFolders(f), 'the folder is removed after a timeout');
    assert.ok(f.env.app.store.getHost(f.hostId).agentCredential.revokedAt, 'the credential is revoked after a timeout');
  });
});

test('the server URL check accepts only this request host, ws or wss, and no credentials', () => {
  assert.equal(agentServerUrl('ws://127.0.0.1:8090', '127.0.0.1:8090'), 'ws://127.0.0.1:8090');
  assert.equal(agentServerUrl('wss://RemoteHub.local', 'remotehub.local'), 'wss://remotehub.local');
  assert.equal(agentServerUrl('ws://127.0.0.1:8090/anything', '127.0.0.1:8090'), 'ws://127.0.0.1:8090', 'the path is dropped');
  assert.equal(agentServerUrl('http://127.0.0.1:8090', '127.0.0.1:8090'), null);
  assert.equal(agentServerUrl('ws://127.0.0.1:9999', '127.0.0.1:8090'), null);
  assert.equal(agentServerUrl('ws://user:pw@127.0.0.1:8090', '127.0.0.1:8090'), null);
  assert.equal(agentServerUrl(42, '127.0.0.1:8090'), null);
});
