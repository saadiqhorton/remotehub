import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  AGENT_TOKEN_PREFIX,
  generateAgentToken,
  hashAgentToken,
  publicAgentStatus,
  redactSecrets,
  verifyAgentToken,
} from '../server/agent-auth.js';
import { Store } from '../server/store.js';
import { agentStatus } from '../public/js/host-actions.js';
import { httpClient, openAgent, startTestApp } from './helpers/app-harness.js';

/**
 * Persistent-agent registration, reconnect, and revocation (SAA-296).
 *
 * The control protocol itself is SAA-295; this suite covers the authenticated
 * outbound channel: host-scoped credentials, live connected/disconnected status,
 * reconnect after a drop, rejection after revoke, and secret-free logs.
 */

const OWNER_PASSWORD = 'owner-password-123';

test('agent tokens hash, verify, and never survive redaction', () => {
  const token = generateAgentToken();
  assert.match(token, new RegExp(`^${AGENT_TOKEN_PREFIX}[A-Za-z0-9_-]{40,}$`));
  const digest = hashAgentToken(token);
  assert.equal(digest.length, 64);
  assert.equal(verifyAgentToken(token, digest), true);
  assert.equal(verifyAgentToken('rhag_1_not-the-token', digest), false);
  assert.equal(verifyAgentToken(token, hashAgentToken('rhag_1_other')), false);

  const leaked = `issued ${token} for host abc and again ${token}`;
  const redacted = redactSecrets(leaked);
  assert.equal(redacted.includes(token), false);
  assert.match(redacted, /rhag_1_\[redacted\].*rhag_1_\[redacted\]/);
});

test('store persists a hashed credential and revoke keeps the hash for rejection', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'remotehub-agent-store-'));
  try {
    const first = await new Store(dataDir).load();
    const host = await first.addHost({ name: 'Lab', address: '10.0.0.8', port: 22, username: 'root' });
    const issued = await first.issueAgentCredential(host.id);
    assert.match(issued.token, /^rhag_1_/);
    assert.equal(issued.host.agentCredential.tokenHash, hashAgentToken(issued.token));
    assert.equal(issued.host.agentCredential.revokedAt, null);

    const second = await new Store(dataDir).load();
    const stored = second.getHost(host.id).agentCredential;
    assert.equal(stored.tokenHash, hashAgentToken(issued.token));
    assert.ok(!JSON.stringify(second.data).includes(issued.token), 'raw token must not be persisted');

    const revoked = await second.revokeAgentCredential(host.id);
    assert.ok(revoked.agentCredential.revokedAt);
    assert.equal(revoked.agentCredential.tokenHash, stored.tokenHash);
    assert.equal(await second.revokeAgentCredential('missing'), null);
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test('public agent status never exposes the credential and host UI can tell states apart', () => {
  assert.deepEqual(publicAgentStatus({}), { registered: false, connected: false });
  assert.deepEqual(publicAgentStatus({ agentCredential: { tokenHash: 'abc', revokedAt: null } }, true), {
    registered: true,
    connected: true,
  });
  assert.deepEqual(publicAgentStatus({ agentCredential: { tokenHash: 'abc', revokedAt: '2026-01-01' } }, true), {
    registered: false,
    connected: false,
  });

  assert.equal(agentStatus({}).state, 'none');
  assert.equal(agentStatus({ agent: { registered: true, connected: false } }).label, 'Not connected right now');
  assert.equal(agentStatus({ agent: { registered: true, connected: true } }).label, 'Connected');
});

describe('authenticated outbound agent registration', { concurrency: 1 }, () => {
const logs = [];
let env;
let client;

before(async () => {
  env = await startTestApp({}, { log: (message) => logs.push(String(message)) });
  client = httpClient(env.base, env.origin);
  const setup = await client.request('/api/auth/setup', {
    method: 'POST',
    body: { setupCode: env.app.setupCode, password: OWNER_PASSWORD },
  });
  assert.equal(setup.status, 200);
});

after(async () => {
  await env.stop();
});

async function addHost() {
  const created = await client.request('/api/hosts', {
    method: 'POST',
    body: { name: 'Agent box', address: '127.0.0.1', port: 22, username: 'tester' },
  });
  assert.equal(created.status, 201);
  assert.deepEqual(created.body.host.agent, { registered: false, connected: false });
  return created.body.host;
}

function hello(hostId, token, extra = {}) {
  return {
    event: 'hello',
    protocol: 1,
    name: 'remotehub-agent',
    version: '0.1.0',
    mode: 'persistent',
    hostId,
    token,
    capabilities: { agent: { available: true, mode: 'persistent', version: '0.1.0' } },
    ...extra,
  };
}

async function registerSocket(hostId, token) {
  const socket = openAgent(env.base);
  await socket.opened;
  socket.send(hello(hostId, token));
  await socket.untilControl((message) => message.event === 'authenticated', 'authenticated');
  return socket;
}

test('issuing a credential returns the token once and lists the host as disconnected', async () => {
  const host = await addHost();
  const issued = await client.request(`/api/hosts/${host.id}/agent`, { method: 'POST' });
  assert.equal(issued.status, 201);
  assert.match(issued.body.token, /^rhag_1_/);
  assert.deepEqual(issued.body.host.agent, { registered: true, connected: false });
  assert.equal(issued.body.host.agentCredential, undefined);
  assert.equal(issued.body.host.tokenHash, undefined);

  const listed = await client.request('/api/hosts');
  const view = listed.body.hosts.find((item) => item.id === host.id);
  assert.deepEqual(view.agent, { registered: true, connected: false });
  assert.equal(JSON.stringify(view).includes(issued.body.token), false);
  assert.equal(JSON.stringify(env.app.store.data).includes(issued.body.token), false);
});

test('a registered agent connects, reconnects after a drop, and the host UI flips status', async () => {
  const host = await addHost();
  const issued = await client.request(`/api/hosts/${host.id}/agent`, { method: 'POST' });
  const token = issued.body.token;

  const first = await registerSocket(host.id, token);
  assert.equal(first.control.find((message) => message.event === 'authenticated').hostId, host.id);
  assert.equal(env.app.registry.isConnected(host.id), true);
  let view = (await client.request('/api/hosts')).body.hosts.find((item) => item.id === host.id);
  assert.deepEqual(view.agent, { registered: true, connected: true });
  assert.equal(agentStatus(view).label, 'Connected');

  first.ws.close();
  await first.closed();
  await new Promise((resolve) => setTimeout(resolve, 30));
  view = (await client.request('/api/hosts')).body.hosts.find((item) => item.id === host.id);
  assert.deepEqual(view.agent, { registered: true, connected: false });
  assert.equal(agentStatus(view).label, 'Not connected right now');

  const second = await registerSocket(host.id, token);
  view = (await client.request('/api/hosts')).body.hosts.find((item) => item.id === host.id);
  assert.deepEqual(view.agent, { registered: true, connected: true });
  second.ws.close();
  await second.closed();
});

test('a revoked agent is rejected and cannot reconnect', async () => {
  const host = await addHost();
  const issued = await client.request(`/api/hosts/${host.id}/agent`, { method: 'POST' });
  const token = issued.body.token;
  const live = await registerSocket(host.id, token);

  const revoked = await client.request(`/api/hosts/${host.id}/agent`, { method: 'DELETE' });
  assert.equal(revoked.status, 200);
  assert.deepEqual(revoked.body.host.agent, { registered: false, connected: false });
  await live.closed();

  const rejected = openAgent(env.base);
  await rejected.opened;
  rejected.send(hello(host.id, token));
  await rejected.untilControl((message) => message.ok === false && message.error?.code === 'revoked', 'revoked');
  const code = await rejected.closedWithCode();
  assert.equal(code, 4003);

  const view = (await client.request('/api/hosts')).body.hosts.find((item) => item.id === host.id);
  assert.deepEqual(view.agent, { registered: false, connected: false });
  assert.equal(env.app.registry.isConnected(host.id), false);
});

test('unknown, missing, and mismatched credentials are rejected without a session cookie', async () => {
  const host = await addHost();
  const issued = await client.request(`/api/hosts/${host.id}/agent`, { method: 'POST' });

  const cases = [
    { hostId: host.id, token: 'rhag_1_not-a-real-token', code: 'unauthorized', close: 4001 },
    { hostId: 'missing-host', token: issued.body.token, code: 'unauthorized', close: 4001 },
    { hostId: host.id, token: '', code: 'bad_request', close: 4008 },
  ];
  for (const item of cases) {
    const socket = openAgent(env.base);
    await socket.opened;
    socket.send(hello(item.hostId, item.token));
    await socket.untilControl((message) => message.ok === false && message.error?.code === item.code, item.code);
    assert.equal(await socket.closedWithCode(), item.close);
  }
});

test('the agent socket does not require Origin or a browser session', async () => {
  const host = await addHost();
  const issued = await client.request(`/api/hosts/${host.id}/agent`, { method: 'POST' });
  const socket = openAgent(env.base, { headers: {} });
  await socket.opened;
  socket.send(hello(host.id, issued.body.token));
  await socket.untilControl((message) => message.event === 'authenticated', 'authenticated without origin');
  socket.ws.close();
  await socket.closed();
});

test('re-issuing a credential invalidates the previous token', async () => {
  const host = await addHost();
  const first = await client.request(`/api/hosts/${host.id}/agent`, { method: 'POST' });
  const second = await client.request(`/api/hosts/${host.id}/agent`, { method: 'POST' });
  assert.notEqual(first.body.token, second.body.token);

  const stale = openAgent(env.base);
  await stale.opened;
  stale.send(hello(host.id, first.body.token));
  await stale.untilControl((message) => message.error?.code === 'unauthorized', 'old token rejected');
  assert.equal(await stale.closedWithCode(), 4001);

  const fresh = await registerSocket(host.id, second.body.token);
  fresh.ws.close();
  await fresh.closed();
});

test('deleting a host disconnects its agent', async () => {
  const host = await addHost();
  const issued = await client.request(`/api/hosts/${host.id}/agent`, { method: 'POST' });
  const live = await registerSocket(host.id, issued.body.token);
  assert.equal((await client.request(`/api/hosts/${host.id}`, { method: 'DELETE' })).status, 200);
  await live.closed();
  assert.equal(env.app.registry.isConnected(host.id), false);
});

test('logs record agent events without the raw token', () => {
  const joined = logs.join('\n');
  assert.match(joined, /agent credential issued/);
  assert.match(joined, /agent connected/);
  assert.match(joined, /agent disconnected/);
  assert.match(joined, /agent credential revoked|agent rejected/);
  for (const line of logs) {
    assert.equal(redactSecrets(line), line, `log leaked a secret: ${line}`);
    assert.doesNotMatch(line, /rhag_1_[A-Za-z0-9_-]{20,}/);
    assert.doesNotMatch(line, /"token"\s*:/);
  }
});

test('a connected agent reports version, mode and OS/arch, and its capabilities leave with it (SAA-300)', async () => {
  const host = await addHost();
  const issued = await client.request(`/api/hosts/${host.id}/agent`, { method: 'POST' });
  const socket = openAgent(env.base);
  await socket.opened;
  socket.send(hello(host.id, issued.body.token, {
    system: { os: 'linux', family: 'unix', arch: 'aarch64' },
    capabilities: { terminal: { ssh: false }, files: { sftp: false, watch: true }, desktop: { nativeStream: false } },
  }));
  await socket.untilControl((message) => message.event === 'authenticated', 'authenticated');

  let view = (await client.request('/api/hosts')).body.hosts.find((item) => item.id === host.id);
  assert.deepEqual(view.liveAgent, { available: true, connected: true, source: 'registered', mode: 'persistent', version: '0.1.0', os: 'linux', arch: 'aarch64', count: 1 });
  assert.equal(view.effectiveCapabilities.files.watch, true);
  assert.equal(view.capabilityProvenance['files.watch'], 'agent');
  assert.equal(view.effectiveCapabilities.terminal.ssh, view.capabilities.terminal.ssh, 'agent cannot switch SSH off');
  assert.equal(view.effectiveCapabilities.files.sftp, view.capabilities.files.sftp);
  assert.equal(agentStatus(view).summary, 'Connected · persistent · v0.1.0 · linux/aarch64');
  assert.equal(JSON.stringify(view).includes(issued.body.token), false);
  assert.equal(JSON.stringify(env.app.store.data).includes('aarch64'), false, 'live status is never persisted');

  socket.ws.close();
  await socket.closed();
  await new Promise((resolve) => setTimeout(resolve, 30));
  view = (await client.request('/api/hosts')).body.hosts.find((item) => item.id === host.id);
  assert.equal(view.liveAgent.connected, false);
  assert.equal(view.effectiveCapabilities.files.watch, false);
  assert.equal(view.capabilityProvenance['files.watch'], undefined);
  assert.equal(view.effectiveCapabilities.terminal.ssh, view.capabilities.terminal.ssh);
  assert.equal(agentStatus(view).summary, 'Not connected right now');
});

});
