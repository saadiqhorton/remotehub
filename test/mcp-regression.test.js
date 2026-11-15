import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import express from 'express';
import { createHash, randomBytes } from 'node:crypto';
import { createMcpOAuthRouter } from '../server/mcp-oauth.js';
import { httpClient, openAgent, startTestApp } from './helpers/app-harness.js';

const OWNER_PASSWORD = 'owner-password-123';
const MCP_PROTOCOL = '2025-11-25';
const MCP_SESSIONS_PER_CLIENT = 32;

async function startMcpEnvironment(config = {}, { handleAgentRequest } = {}) {
  const logs = [];
  const env = await startTestApp(config, { log: (line) => logs.push(String(line)) });
  try {
    const owner = httpClient(env.base, env.origin);
    const setup = await owner.request('/api/auth/setup', {
      method: 'POST',
      body: { setupCode: env.app.setupCode, password: OWNER_PASSWORD },
    });
    assert.equal(setup.status, 200);

    const created = await owner.request('/api/hosts', {
      method: 'POST',
      body: { name: 'MCP test host', address: '127.0.0.1', port: 22, username: 'tester' },
    });
    assert.equal(created.status, 201);
    const host = created.body.host;
    const credential = await owner.request('/api/hosts/' + host.id + '/agent', { method: 'POST' });
    assert.equal(credential.status, 201);

    const agent = openAgent(env.base);
    await agent.opened;
    agent.send({
      event: 'hello',
      protocol: 1,
      name: 'remotehub-agent',
      version: '0.1.0',
      mode: 'persistent',
      hostId: host.id,
      token: credential.body.token,
      operations: ['fs.read', 'fs.write', 'fs.list.page', 'exec.run'],
    });
    await agent.untilControl((message) => message.event === 'authenticated', 'agent authenticated');

    const agentRequests = [];
    agent.ws.on('message', (raw, isBinary) => {
      if (isBinary) return;
      const message = JSON.parse(raw.toString('utf8'));
      if (!message.id) return;
      agentRequests.push(message);
      if (handleAgentRequest?.(message, agent) === true) return;
      const result = message.op === 'fs.write'
        ? { written: true }
        : message.op === 'exec.run'
          ? { success: true, exitCode: 0, timedOut: false, elapsedMs: 1, stdout: 'ok', stderr: '', stdoutTruncated: false, stderrTruncated: false }
          : { entries: [] };
      agent.ws.send(JSON.stringify({ id: message.id, ok: true, result }));
    });

    return { env, owner, host, agent, agentRequests, logs };
  } catch (error) {
    await env.stop();
    throw error;
  }
}

async function createOAuthStateFixture(t) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'remotehub-oauth-state-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const oauth = await createMcpOAuthRouter({
    express,
    config: { dataDir, host: '127.0.0.1', port: 8090, mcpCommandsEnabled: false },
    store: { owner: null, listHosts: () => [] },
    sessions: { touch: () => false },
    tokenOf: () => null,
    originAllowed: () => true,
    verifyPassword: async () => false,
  });
  return oauth.state;
}

async function createOAuthServerFixture(t) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'remotehub-oauth-server-'));
  const oauth = await createMcpOAuthRouter({
    express,
    config: { dataDir, host: '127.0.0.1', port: 8090, mcpCommandsEnabled: false },
    store: { owner: null, listHosts: () => [] },
    sessions: { touch: () => false },
    tokenOf: () => null,
    originAllowed: () => true,
    verifyPassword: async () => false,
  });
  const app = express();
  app.use(oauth.router);
  const server = createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  return { ...oauth, base: 'http://127.0.0.1:' + server.address().port, dataDir };
}

async function registerClient(ctx, { clientName = 'RemoteHub regression test', redirectUri = 'http://127.0.0.1/callback' } = {}) {
  const metadataResponse = await fetch(ctx.env.base + '/.well-known/oauth-authorization-server');
  assert.equal(metadataResponse.status, 200);
  const metadata = await metadataResponse.json();
  const resource = metadata.issuer + '/mcp';
  const registeredResponse = await fetch(ctx.env.base + '/oauth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: clientName,
      redirect_uris: [redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    }),
  });
  assert.equal(registeredResponse.status, 201);
  const client = await registeredResponse.json();
  return { clientId: client.client_id, redirectUri, resource };
}

async function authorizeCode(ctx, client, scopes, redirectUri = client.redirectUri) {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const query = new URLSearchParams({
    response_type: 'code',
    client_id: client.clientId,
    redirect_uri: redirectUri,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: randomBytes(12).toString('base64url'),
    resource: client.resource,
    scope: scopes.join(' '),
  });
  const authorizeResponse = await fetch(ctx.env.base + '/oauth/authorize?' + query, {
    headers: { Origin: ctx.env.origin, Cookie: ctx.owner.cookie },
    redirect: 'manual',
  });
  assert.equal(authorizeResponse.status, 200);
  const html = await authorizeResponse.text();
  const requestId = /name="requestId" value="([A-Za-z0-9_-]+)"/.exec(html)?.[1];
  assert.ok(requestId, 'authorization form has a request id');

  const form = new URLSearchParams({ requestId, consent: 'allow', hostIds: ctx.host.id });
  for (const scope of scopes) form.append('scopes', scope);
  const consent = await fetch(ctx.env.base + '/oauth/authorize', {
    method: 'POST',
    headers: {
      Origin: ctx.env.origin,
      Cookie: ctx.owner.cookie,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: form,
    redirect: 'manual',
  });
  assert.equal(consent.status, 302);
  const callback = new URL(consent.headers.get('location'));
  const code = callback.searchParams.get('code');
  assert.ok(code, 'owner consent redirects with an authorization code');
  return { code, verifier };
}

async function exchangeCode(ctx, client, code, verifier, redirectUri = client.redirectUri) {
  const tokenResponse = await fetch(ctx.env.base + '/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: client.clientId,
      code,
      redirect_uri: redirectUri,
      code_verifier: verifier,
      resource: client.resource,
    }),
  });
  return { response: tokenResponse, tokens: await tokenResponse.json() };
}

async function authorize(ctx, client, scopes, redirectUri = client.redirectUri) {
  const { code, verifier } = await authorizeCode(ctx, client, scopes, redirectUri);
  return exchangeCode(ctx, client, code, verifier, redirectUri);
}

async function refreshToken(ctx, client, token, scope = undefined) {
  const response = await fetch(ctx.env.base + '/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: client.clientId,
      refresh_token: token,
      resource: client.resource,
      ...(scope === undefined ? {} : { scope }),
    }),
  });
  return { response, body: await response.json() };
}

function authorizationQuery(client, overrides = {}) {
  const query = new URLSearchParams({
    response_type: 'code',
    client_id: client.clientId,
    redirect_uri: client.redirectUri,
    code_challenge: 'A'.repeat(43),
    code_challenge_method: 'S256',
    resource: client.resource,
  });
  for (const [key, value] of Object.entries(overrides)) {
    if (value === null) query.delete(key);
    else query.set(key, String(value));
  }
  return query;
}

async function submitConsent(ctx, requestId, { consent = 'deny', cookie = ctx.owner.cookie, password, hostIds = [], scopes = [] } = {}) {
  const form = new URLSearchParams({ requestId, consent, ...(password === undefined ? {} : { password }) });
  for (const hostId of Array.isArray(hostIds) ? hostIds : [hostIds]) form.append('hostIds', hostId);
  for (const scope of scopes) form.append('scopes', scope);
  return fetch(ctx.env.base + '/oauth/authorize', {
    method: 'POST',
    headers: {
      Origin: ctx.env.origin,
      ...(cookie ? { Cookie: cookie } : {}),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: form,
    redirect: 'manual',
  });
}

async function mcpPost(ctx, token, message, sessionId = null) {
  const headers = {
    Authorization: 'Bearer ' + token,
    Accept: 'application/json, text/event-stream',
    'Content-Type': 'application/json',
  };
  if (sessionId) {
    headers['MCP-Session-Id'] = sessionId;
    headers['MCP-Protocol-Version'] = MCP_PROTOCOL;
  }
  const response = await fetch(ctx.env.base + '/mcp', {
    method: 'POST',
    headers,
    body: JSON.stringify(message),
  });
  return { response, body: await response.json().catch(() => null) };
}

async function initializeMcp(ctx, token) {
  const init = await mcpPost(ctx, token, {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: MCP_PROTOCOL, capabilities: {}, clientInfo: { name: 'regression', version: '1' } },
  });
  assert.equal(init.response.status, 200);
  const sessionId = init.response.headers.get('MCP-Session-Id');
  assert.ok(sessionId);
  const notified = await mcpPost(ctx, token, { jsonrpc: '2.0', method: 'notifications/initialized' }, sessionId);
  assert.equal(notified.response.status, 202);
  return sessionId;
}

async function fillMcpClientSessions(ctx, token) {
  const sessionIds = [];
  for (let index = 0; index < MCP_SESSIONS_PER_CLIENT; index += 1) {
    sessionIds.push(await initializeMcp(ctx, token));
  }
  return sessionIds;
}

async function callTool(ctx, token, sessionId, id, name, args) {
  return mcpPost(ctx, token, {
    jsonrpc: '2.0',
    id,
    method: 'tools/call',
    params: { name, arguments: args },
  }, sessionId);
}

test('protected resource metadata omits offline_access while authorization metadata supports it', async (t) => {
  const ctx = await startMcpEnvironment();
  t.after(() => ctx.env.stop());

  for (const endpoint of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp']) {
    const response = await fetch(ctx.env.base + endpoint);
    assert.equal(response.status, 200);
    const metadata = await response.json();
    assert.deepEqual(metadata.scopes_supported, ['hosts:read', 'files:read'], endpoint);
  }

  const authorization = await fetch(ctx.env.base + '/.well-known/oauth-authorization-server');
  assert.equal(authorization.status, 200);
  assert.equal((await authorization.json()).scopes_supported.includes('offline_access'), true);
});

test('initial MCP challenge and resource metadata request only basic read scopes', async (t) => {
  const ctx = await startMcpEnvironment();
  t.after(() => ctx.env.stop());

  for (const endpoint of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp']) {
    const response = await fetch(ctx.env.base + endpoint);
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).scopes_supported, ['hosts:read', 'files:read']);
  }

  const response = await fetch(ctx.env.base + '/mcp', {
    method: 'POST',
    headers: {
      Accept: 'application/json, text/event-stream',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: MCP_PROTOCOL } }),
  });
  assert.equal(response.status, 401);
  assert.match(response.headers.get('www-authenticate') || '', /scope="hosts:read files:read"/);
});

test('initial consent defaults to one connected host and basic read scopes, then persists only selected permissions', async (t) => {
  const ctx = await startMcpEnvironment();
  t.after(() => ctx.env.stop());

  const offlineResponse = await ctx.owner.request('/api/hosts', {
    method: 'POST',
    body: { name: 'MCP offline host', address: '127.0.0.2', port: 22, username: 'tester' },
  });
  assert.equal(offlineResponse.status, 201);
  const offlineHost = offlineResponse.body.host;
  assert.equal((await ctx.owner.request('/api/hosts/' + offlineHost.id + '/agent', { method: 'POST' })).status, 201);

  const client = await registerClient(ctx);
  const formUrl = ctx.env.base + '/oauth/authorize?' + authorizationQuery(client, { scope: 'hosts:read files:read files:write' });
  const response = await fetch(formUrl, {
    headers: { Origin: ctx.env.origin, Cookie: ctx.owner.cookie },
    redirect: 'manual',
  });
  assert.equal(response.status, 200);
  const html = await response.text();
  const checked = (name, value) => {
    const match = new RegExp('<input type="checkbox" name="' + name + '" value="' + value + '"([^>]*)>').exec(html);
    assert.ok(match, 'checkbox exists for ' + name + '=' + value);
    return /(?:^|\s)checked(?:\s|$)/.test(match[1]);
  };
  const requestId = /name="requestId" value="([A-Za-z0-9_-]+)"/.exec(html)?.[1];
  assert.ok(requestId);
  assert.equal(checked('hostIds', ctx.host.id), true);
  assert.equal(checked('hostIds', offlineHost.id), false);
  assert.equal(checked('scopes', 'hosts:read'), true);
  assert.equal(checked('scopes', 'files:read'), true);
  assert.equal(checked('scopes', 'files:write'), false);

  const consent = await submitConsent(ctx, requestId, {
    consent: 'allow',
    hostIds: [ctx.host.id],
    scopes: ['hosts:read'],
  });
  assert.equal(consent.status, 302);
  const saved = JSON.parse(await fs.readFile(path.join(ctx.env.dataDir, 'mcp-oauth.json'), 'utf8'));
  const grant = Object.values(saved.grants)[0];
  assert.deepEqual(grant.hostIds, [ctx.host.id]);
  assert.deepEqual(grant.scopes, ['hosts:read']);
});

test('step-up consent leaves write and command scopes unchecked until the owner explicitly grants them', async (t) => {
  const ctx = await startMcpEnvironment({ mcpCommandsEnabled: true });
  t.after(() => ctx.env.stop());

  const client = await registerClient(ctx);
  const granted = await authorize(ctx, client, ['hosts:read', 'files:read']);
  assert.equal(granted.response.status, 200);
  const sessionId = await initializeMcp(ctx, granted.tokens.access_token);

  const write = await callTool(ctx, granted.tokens.access_token, sessionId, 2, 'remotehub.files.write', {
    hostId: ctx.host.id, path: 'step-up.txt', content: 'write',
  });
  assert.equal(write.response.status, 403);
  assert.match(write.response.headers.get('www-authenticate') || '', /error="insufficient_scope"/);
  const writeChallenge = write.body.result._meta['mcp/www_authenticate'][0];
  assert.match(writeChallenge, /error="insufficient_scope"/);
  assert.match(writeChallenge, /scope="hosts:read files:read files:write"/);

  const command = await callTool(ctx, granted.tokens.access_token, sessionId, 3, 'remotehub.commands.run', {
    hostId: ctx.host.id, executable: 'cmd.exe', args: ['/c', 'echo', 'step-up'],
  });
  assert.equal(command.response.status, 403);
  assert.match(command.response.headers.get('www-authenticate') || '', /error="insufficient_scope"/);
  const commandChallenge = command.body.result._meta['mcp/www_authenticate'][0];
  assert.match(commandChallenge, /error="insufficient_scope"/);
  assert.match(commandChallenge, /scope="hosts:read files:read commands:exec"/);

  const requested = ['hosts:read', 'files:read', 'files:write', 'commands:exec'];
  const query = authorizationQuery(client, { scope: requested.join(' ') });
  const formResponse = await fetch(ctx.env.base + '/oauth/authorize?' + query, {
    headers: { Origin: ctx.env.origin, Cookie: ctx.owner.cookie },
    redirect: 'manual',
  });
  assert.equal(formResponse.status, 200);
  const html = await formResponse.text();
  const checked = (name, value) => {
    const match = new RegExp('<input type="checkbox" name="' + name + '" value="' + value + '"([^>]*)>').exec(html);
    assert.ok(match, 'checkbox exists for ' + name + '=' + value);
    return /(?:^|\s)checked(?:\s|$)/.test(match[1]);
  };
  assert.equal(checked('scopes', 'hosts:read'), true);
  assert.equal(checked('scopes', 'files:read'), true);
  assert.equal(checked('scopes', 'files:write'), false);
  assert.equal(checked('scopes', 'commands:exec'), false);

  const requestId = /name="requestId" value="([A-Za-z0-9_-]+)"/.exec(html)?.[1];
  assert.ok(requestId);
  const consent = await submitConsent(ctx, requestId, {
    consent: 'allow',
    hostIds: [ctx.host.id],
    scopes: requested,
  });
  assert.equal(consent.status, 302);
  const saved = JSON.parse(await fs.readFile(path.join(ctx.env.dataDir, 'mcp-oauth.json'), 'utf8'));
  const stepUpGrant = Object.values(saved.grants).find((grant) => grant.scopes.includes('commands:exec'));
  assert.ok(stepUpGrant);
  assert.deepEqual(stepUpGrant.hostIds, [ctx.host.id]);
  assert.deepEqual(stepUpGrant.scopes, requested);
});

test('MCP initialize negotiates only the documented 2025 versions and falls back to the latest 2025 version', async (t) => {
  const ctx = await startMcpEnvironment();
  t.after(() => ctx.env.stop());

  const client = await registerClient(ctx);
  const granted = await authorize(ctx, client, ['hosts:read', 'files:read']);
  const initialize = async (version) => fetch(ctx.env.base + '/mcp', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + granted.tokens.access_token,
      Accept: 'application/json, text/event-stream',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: version, capabilities: {}, clientInfo: { name: 'version-regression', version: '1' } },
    }),
  });

  const notifyInitialized = (token, sessionId, version) => fetch(ctx.env.base + '/mcp', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + token,
      Accept: 'application/json, text/event-stream',
      'Content-Type': 'application/json',
      'MCP-Session-Id': sessionId,
      'MCP-Protocol-Version': version,
    },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
  });

  for (const version of ['2025-11-25', '2025-06-18', '2025-03-26']) {
    const response = await initialize(version);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).result.protocolVersion, version);

    const mismatch = version === '2025-11-25' ? '2025-06-18' : '2025-11-25';
    const rejected = await notifyInitialized(granted.tokens.access_token, response.headers.get('mcp-session-id'), mismatch);
    assert.equal(rejected.status, 400);

    const initialized = await notifyInitialized(granted.tokens.access_token, response.headers.get('mcp-session-id'), version);
    assert.equal(initialized.status, 202);
  }

  const unsupported = await initialize('2026-07-28');
  assert.equal(unsupported.status, 200);
  assert.equal((await unsupported.json()).result.protocolVersion, '2025-11-25');
  const fallbackInitialized = await notifyInitialized(
    granted.tokens.access_token,
    unsupported.headers.get('mcp-session-id'),
    '2025-11-25',
  );
  assert.equal(fallbackInitialized.status, 202);
});

test('OAuth code exchange, refresh rotation, revocation, and MCP session lifecycle work end to end', async (t) => {
  const ctx = await startMcpEnvironment({ mcpCommandsEnabled: true });
  t.after(() => ctx.env.stop());

  const client = await registerClient(ctx);
  const granted = await authorize(ctx, client, ['hosts:read', 'files:write', 'offline_access']);
  assert.equal(granted.response.status, 200);
  assert.ok(granted.tokens.access_token);
  assert.ok(granted.tokens.refresh_token);

  const sessionId = await initializeMcp(ctx, granted.tokens.access_token);
  const listing = await mcpPost(ctx, granted.tokens.access_token, {
    jsonrpc: '2.0', id: 2, method: 'tools/list', params: {},
  }, sessionId);
  assert.equal(listing.response.status, 200);
  assert.ok(listing.body.result.tools.some((tool) => tool.name === 'remotehub.files.write'));

  const refreshResponse = await fetch(ctx.env.base + '/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: client.clientId,
      refresh_token: granted.tokens.refresh_token,
      resource: client.resource,
    }),
  });
  assert.equal(refreshResponse.status, 200);
  const rotated = await refreshResponse.json();
  assert.ok(rotated.access_token);
  assert.ok(rotated.refresh_token);
  assert.notEqual(rotated.refresh_token, granted.tokens.refresh_token);

  const revoke = await fetch(ctx.env.base + '/oauth/revoke', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: client.clientId, token: rotated.access_token }),
  });
  assert.equal(revoke.status, 200);

  const rejected = await mcpPost(ctx, rotated.access_token, {
    jsonrpc: '2.0', id: 3, method: 'initialize',
    params: { protocolVersion: MCP_PROTOCOL, capabilities: {}, clientInfo: { name: 'regression', version: '1' } },
  });
  assert.equal(rejected.response.status, 401);
  const staleRefresh = await fetch(ctx.env.base + '/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: client.clientId,
      refresh_token: rotated.refresh_token,
      resource: client.resource,
    }),
  });
  assert.equal(staleRefresh.status, 400);
  assert.equal((await staleRefresh.json()).error, 'invalid_grant');
});

test('one OAuth client cannot occupy every MCP session slot', async (t) => {
  const ctx = await startMcpEnvironment();
  t.after(() => ctx.env.stop());
  const firstClient = await registerClient(ctx, { clientName: 'Session limit client' });
  const secondClient = await registerClient(ctx, { clientName: 'Unaffected session client' });
  const firstGrant = await authorize(ctx, firstClient, ['hosts:read']);
  const secondGrant = await authorize(ctx, secondClient, ['hosts:read']);

  await fillMcpClientSessions(ctx, firstGrant.tokens.access_token);
  const rejected = await mcpPost(ctx, firstGrant.tokens.access_token, {
    jsonrpc: '2.0', id: 100, method: 'initialize',
    params: { protocolVersion: MCP_PROTOCOL, capabilities: {}, clientInfo: { name: 'regression', version: '1' } },
  });
  assert.equal(rejected.response.status, 429);

  const unaffectedSession = await initializeMcp(ctx, secondGrant.tokens.access_token);
  assert.ok(unaffectedSession, 'a different OAuth client can still establish a session');
});

test('owner revocation promptly releases the grant client’s MCP sessions', async (t) => {
  const ctx = await startMcpEnvironment();
  t.after(() => ctx.env.stop());
  const client = await registerClient(ctx, { clientName: 'Owner revocation session client' });
  const firstGrant = await authorize(ctx, client, ['hosts:read']);
  await fillMcpClientSessions(ctx, firstGrant.tokens.access_token);

  const persisted = JSON.parse(await fs.readFile(ctx.env.dataDir + '/mcp-oauth.json', 'utf8'));
  const grantId = Object.keys(persisted.grants)[0];
  const revoked = await fetch(ctx.env.base + '/oauth/manage/revoke-grant', {
    method: 'POST',
    headers: {
      Origin: ctx.env.origin,
      Cookie: ctx.owner.cookie,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ grantId }),
    redirect: 'manual',
  });
  assert.equal(revoked.status, 303);

  const reauthorized = await authorize(ctx, client, ['hosts:read']);
  assert.equal(reauthorized.response.status, 200);
  await fillMcpClientSessions(ctx, reauthorized.tokens.access_token);
});

test('refresh-token replay revocation promptly releases the grant client’s MCP sessions', async (t) => {
  const ctx = await startMcpEnvironment();
  t.after(() => ctx.env.stop());
  const client = await registerClient(ctx, { clientName: 'Replay revocation session client' });
  const firstGrant = await authorize(ctx, client, ['hosts:read', 'offline_access']);
  await fillMcpClientSessions(ctx, firstGrant.tokens.access_token);

  const rotated = await refreshToken(ctx, client, firstGrant.tokens.refresh_token);
  assert.equal(rotated.response.status, 200);
  const replay = await refreshToken(ctx, client, firstGrant.tokens.refresh_token);
  assert.equal(replay.response.status, 400);
  assert.equal(replay.body.error, 'invalid_grant');

  const reauthorized = await authorize(ctx, client, ['hosts:read', 'offline_access']);
  assert.equal(reauthorized.response.status, 200);
  await fillMcpClientSessions(ctx, reauthorized.tokens.access_token);
});

test('token errors distinguish unsupported grants from authorization-code redirect mismatches', async (t) => {
  const ctx = await startMcpEnvironment();
  t.after(() => ctx.env.stop());
  const client = await registerClient(ctx, { redirectUri: 'https://remotehub.example/callback' });

  const unsupportedGrant = await fetch(ctx.env.base + '/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:example:unsupported-grant',
      client_id: client.clientId,
      resource: client.resource,
    }),
  });
  assert.equal(unsupportedGrant.status, 400);
  assert.equal((await unsupportedGrant.json()).error, 'unsupported_grant_type');

  const { code, verifier } = await authorizeCode(ctx, client, ['hosts:read']);
  const mismatchedRedirect = await exchangeCode(ctx, client, code, verifier, 'https://remotehub.example/other');
  assert.equal(mismatchedRedirect.response.status, 400);
  assert.equal(mismatchedRedirect.tokens.error, 'invalid_grant');

  const correctRedirect = await exchangeCode(ctx, client, code, verifier);
  assert.equal(correctRedirect.response.status, 200, 'a rejected redirect mismatch leaves the code available for its bound URI');
});

test('concurrent refresh token replay atomically revokes every token in the grant family', async (t) => {
  const ctx = await startMcpEnvironment();
  t.after(() => ctx.env.stop());
  const client = await registerClient(ctx);
  const granted = await authorize(ctx, client, ['hosts:read', 'offline_access']);
  assert.equal(granted.response.status, 200);

  const attempts = await Promise.all([
    refreshToken(ctx, client, granted.tokens.refresh_token),
    refreshToken(ctx, client, granted.tokens.refresh_token),
  ]);
  assert.equal(attempts.some(({ response, body }) => response.status === 400 && body.error === 'invalid_grant'), true);

  const persisted = JSON.parse(await fs.readFile(ctx.env.dataDir + '/mcp-oauth.json', 'utf8'));
  assert.equal(Object.keys(persisted.grants).length, 0);
  assert.equal(Object.keys(persisted.tokens).length, 0);
  assert.equal(Object.keys(persisted.spentRefreshTokens).length, 0);
});

test('expired refresh families prune replay evidence and live legacy evidence inherits family expiry', async (t) => {
  const state = await createOAuthStateFixture(t);
  const now = Date.now();
  const clientId = 'fixture-client';
  const expiredGrantId = 'expired-family';
  const activeGrantId = 'active-family';
  state.data.clients[clientId] = { client_id: clientId, expiresAt: now + 60_000 };
  state.data.grants[expiredGrantId] = { grantId: expiredGrantId, clientId, ownerId: 'owner' };
  state.data.grants[activeGrantId] = { grantId: activeGrantId, clientId, ownerId: 'owner' };
  const activeRefreshExpiresAt = now + 24 * 60 * 60_000;
  const activeRefreshHash = createHash('sha256').update('active-refresh-token').digest('hex');
  state.data.tokens[activeRefreshHash] = {
    grantId: activeGrantId,
    kind: 'refresh',
    ownerId: 'owner',
    clientId,
    audience: 'http://127.0.0.1:8090/mcp',
    expiresAt: activeRefreshExpiresAt,
  };
  const expiredSpentHash = '1'.repeat(64);
  const activeSpentHash = '2'.repeat(64);
  state.data.spentRefreshTokens = {
    [expiredSpentHash]: { grantId: expiredGrantId, clientId },
    [activeSpentHash]: { grantId: activeGrantId, clientId },
  };

  await state.prune();

  assert.equal(state.data.spentRefreshTokens[expiredSpentHash], undefined);
  assert.equal(state.data.spentRefreshTokens[activeSpentHash].expiresAt, activeRefreshExpiresAt);
});

test('pruning repeated OAuth consents bounds grants while preserving live code, token, and replay evidence', async (t) => {
  const state = await createOAuthStateFixture(t);
  const now = Date.now();
  const clientId = 'repeated-consent-client';
  state.data.clients[clientId] = { client_id: clientId, expiresAt: now + 60_000 };

  for (let index = 0; index < 1100; index += 1) {
    const grantId = `consent-${index}`;
    const codeHash = createHash('sha256').update(`authorization-code-${index}`).digest('hex');
    state.data.grants[grantId] = { grantId, clientId, ownerId: 'owner', hostIds: ['host-one'], scopes: ['hosts:read'] };
    state.data.codes[codeHash] = { grantId, clientId, expiresAt: now + 60_000 };
  }
  for (let index = 0; index < 1500; index += 1) {
    const grantId = `expired-consent-${index}`;
    state.data.grants[grantId] = { grantId, clientId, ownerId: 'owner', hostIds: ['host-one'], scopes: ['hosts:read'] };
  }

  const tokenGrantId = 'live-access-token-grant';
  const tokenHash = createHash('sha256').update('live-access-token').digest('hex');
  state.data.grants[tokenGrantId] = { grantId: tokenGrantId, clientId, ownerId: 'owner' };
  state.data.tokens[tokenHash] = { grantId: tokenGrantId, clientId, kind: 'access', expiresAt: now + 60_000 };

  const replayGrantId = 'live-refresh-replay-grant';
  const replayExpiry = now + 24 * 60 * 60_000;
  const spentHash = createHash('sha256').update('spent-refresh-token').digest('hex');
  state.data.grants[replayGrantId] = { grantId: replayGrantId, clientId, ownerId: 'owner', refreshExpiresAt: replayExpiry };
  state.data.spentRefreshTokens[spentHash] = { grantId: replayGrantId, clientId, expiresAt: replayExpiry };

  await state.prune();
  await state.prune();

  assert.equal(Object.keys(state.data.codes).length, 1000);
  assert.equal(Object.keys(state.data.grants).length, 1002);
  assert.equal(state.data.grants['expired-consent-0'], undefined);
  assert.equal(state.data.grants[tokenGrantId] !== undefined, true);
  assert.equal(state.data.grants[replayGrantId] !== undefined, true);
  assert.equal(state.data.tokens[tokenHash]?.grantId, tokenGrantId);
  assert.equal(state.data.spentRefreshTokens[spentHash]?.grantId, replayGrantId);
  for (const code of Object.values(state.data.codes)) {
    assert.equal(state.data.grants[code.grantId] !== undefined, true, 'every retained authorization code keeps its grant');
  }
});

test('refresh rotation fails closed at replay-evidence capacity without evicting live evidence', async (t) => {
  const state = await createOAuthStateFixture(t);
  const now = Date.now();
  const clientId = 'capacity-client';
  const grantId = 'capacity-family';
  const audience = 'http://127.0.0.1:8090/mcp';
  const refreshToken = 'current-refresh-token';
  const refreshExpiresAt = now + 24 * 60 * 60_000;
  state.data.clients[clientId] = { client_id: clientId, expiresAt: now + 60_000 };
  state.data.grants[grantId] = { grantId, clientId, ownerId: 'owner', refreshExpiresAt };
  const refreshHash = createHash('sha256').update(refreshToken).digest('hex');
  state.data.tokens[refreshHash] = {
    grantId,
    kind: 'refresh',
    ownerId: 'owner',
    clientId,
    audience,
    expiresAt: refreshExpiresAt,
  };
  for (let index = 0; index < 10_000; index += 1) {
    state.data.spentRefreshTokens[index.toString(16).padStart(64, '0')] = {
      grantId,
      clientId,
      expiresAt: refreshExpiresAt,
    };
  }
  const evidenceBefore = Object.keys(state.data.spentRefreshTokens).sort();

  const result = await state.consumeRefreshToken(refreshToken, clientId, audience);

  assert.equal(result.status, 'capacity');
  assert.deepEqual(Object.keys(state.data.spentRefreshTokens).sort(), evidenceBefore);
  assert.equal(state.data.tokens[refreshHash].kind, 'refresh', 'capacity rejection leaves the current refresh token usable');
});

test('replaying a rotated refresh token revokes its grant and stored replay evidence is hash-only', async (t) => {
  const ctx = await startMcpEnvironment();
  t.after(() => ctx.env.stop());
  const client = await registerClient(ctx);
  const granted = await authorize(ctx, client, ['hosts:read', 'offline_access']);
  assert.equal(granted.response.status, 200);

  const rotated = await refreshToken(ctx, client, granted.tokens.refresh_token);
  assert.equal(rotated.response.status, 200);
  assert.ok(rotated.body.refresh_token);

  const spentHash = createHash('sha256').update(granted.tokens.refresh_token).digest('hex');
  const afterRotation = JSON.parse(await fs.readFile(ctx.env.dataDir + '/mcp-oauth.json', 'utf8'));
  const grantId = Object.keys(afterRotation.grants)[0];
  assert.equal(afterRotation.spentRefreshTokens[spentHash]?.grantId, grantId);
  assert.equal(afterRotation.spentRefreshTokens[spentHash]?.clientId, client.clientId);
  assert.equal(JSON.stringify(afterRotation).includes(granted.tokens.refresh_token), false, 'persisted OAuth state never contains the spent token value');

  const replay = await refreshToken(ctx, client, granted.tokens.refresh_token);
  assert.equal(replay.response.status, 400);
  assert.equal(replay.body.error, 'invalid_grant');

  const afterReplay = JSON.parse(await fs.readFile(ctx.env.dataDir + '/mcp-oauth.json', 'utf8'));
  assert.equal(afterReplay.grants[grantId], undefined);
  assert.equal(Object.keys(afterReplay.tokens).length, 0);
  assert.equal(Object.values(afterReplay.spentRefreshTokens).some((item) => item.grantId === grantId), false);
});

test('refreshing without a scope preserves the original grant scope', async (t) => {
  const ctx = await startMcpEnvironment();
  t.after(() => ctx.env.stop());
  const client = await registerClient(ctx);
  const scopes = ['files:read', 'hosts:read', 'offline_access'];
  const granted = await authorize(ctx, client, scopes);

  const refreshed = await refreshToken(ctx, client, granted.tokens.refresh_token);

  assert.equal(refreshed.response.status, 200);
  assert.equal(refreshed.body.scope, scopes.join(' '));
  assert.ok(refreshed.body.refresh_token);
});

test('narrow refresh scopes persist as the default across refresh-token rotation', async (t) => {
  const ctx = await startMcpEnvironment();
  t.after(() => ctx.env.stop());
  const client = await registerClient(ctx);
  const grantedScopes = ['files:read', 'hosts:read', 'offline_access'];
  const granted = await authorize(ctx, client, grantedScopes);

  const narrowed = await refreshToken(ctx, client, granted.tokens.refresh_token, 'files:read');
  assert.equal(narrowed.response.status, 200);
  assert.equal(narrowed.body.scope, 'files:read');

  const continued = await refreshToken(ctx, client, narrowed.body.refresh_token);
  assert.equal(continued.response.status, 200);
  assert.equal(continued.body.scope, 'files:read', 'omitting scope after narrowing must not silently restore the broader grant');

  const persisted = JSON.parse(await fs.readFile(ctx.env.dataDir + '/mcp-oauth.json', 'utf8'));
  const grant = Object.values(persisted.grants)[0];
  const accessHash = createHash('sha256').update(continued.body.access_token).digest('hex');
  const refreshHash = createHash('sha256').update(continued.body.refresh_token).digest('hex');
  assert.deepEqual(grant.scopes, grantedScopes);
  assert.deepEqual(persisted.tokens[accessHash].scopes, ['files:read']);
  assert.deepEqual(persisted.tokens[refreshHash].scopes, grantedScopes,
    'rotated refresh-token scope remains identical to the scope bound to the previous refresh token');
  assert.deepEqual(persisted.tokens[refreshHash].accessScopes, ['files:read'],
    'the narrowed access scope is retained separately for later omitted-scope refreshes');
});

test('unknown and out-of-grant refresh scopes return invalid_scope without consuming the refresh token', async (t) => {
  const ctx = await startMcpEnvironment();
  t.after(() => ctx.env.stop());
  const client = await registerClient(ctx);
  const granted = await authorize(ctx, client, ['files:read', 'hosts:read', 'offline_access']);
  const refreshHash = createHash('sha256').update(granted.tokens.refresh_token).digest('hex');

  for (const scope of ['unknown:scope', 'files:read commands:exec']) {
    const rejected = await refreshToken(ctx, client, granted.tokens.refresh_token, scope);
    assert.equal(rejected.response.status, 400);
    assert.equal(rejected.body.error, 'invalid_scope');
    const persisted = JSON.parse(await fs.readFile(ctx.env.dataDir + '/mcp-oauth.json', 'utf8'));
    assert.equal(persisted.tokens[refreshHash]?.kind, 'refresh', 'invalid scope must leave the refresh token unconsumed');
  }

  const usable = await refreshToken(ctx, client, granted.tokens.refresh_token);
  assert.equal(usable.response.status, 200, 'the original refresh token remains usable after invalid scope requests');
});

test('a wrong client cannot consume another client refresh token', async (t) => {
  const ctx = await startMcpEnvironment();
  t.after(() => ctx.env.stop());
  const wrongClient = await registerClient(ctx);
  const rightfulClient = await registerClient(ctx);
  const granted = await authorize(ctx, rightfulClient, ['hosts:read', 'offline_access']);
  assert.equal(granted.response.status, 200);

  const rejected = await refreshToken(ctx, wrongClient, granted.tokens.refresh_token);
  assert.equal(rejected.response.status, 400);
  assert.equal(rejected.body.error, 'invalid_grant');

  const rightful = await refreshToken(ctx, rightfulClient, granted.tokens.refresh_token);
  assert.equal(rightful.response.status, 200, 'the wrong-client attempt leaves the rightful refresh credential usable');

  const wrongClientReplay = await refreshToken(ctx, wrongClient, granted.tokens.refresh_token);
  assert.equal(wrongClientReplay.response.status, 400);
  assert.equal(wrongClientReplay.body.error, 'invalid_grant');

  const continued = await refreshToken(ctx, rightfulClient, rightful.body.refresh_token);
  assert.equal(continued.response.status, 200, 'a wrong-client replay cannot revoke the rightful grant');
});

test('invalid clients and callbacks stay local while validated callbacks receive OAuth errors', async (t) => {
  const ctx = await startMcpEnvironment({ mcpPublicUrl: 'https://remotehub.example' });
  t.after(() => ctx.env.stop());
  const client = await registerClient(ctx, { redirectUri: 'https://remotehub.example/callback' });

  const invalidRequests = [
    authorizationQuery(client, { client_id: 'unknown-client', state: 'unknown-client' }),
    authorizationQuery(client, { redirect_uri: null, state: 'missing-redirect' }),
    authorizationQuery(client, { redirect_uri: 'javascript:alert(1)', state: 'invalid-redirect' }),
    authorizationQuery(client, { redirect_uri: 'https://attacker.example/callback', state: 'mismatched-redirect' }),
    authorizationQuery(client, { redirect_uri: 'https://remotehub.example/callback#fragment', state: 'fragment-redirect' }),
  ];
  for (const query of invalidRequests) {
    const response = await fetch(ctx.env.base + '/oauth/authorize?' + query, { redirect: 'manual' });
    assert.equal(response.status, 400);
    assert.equal(response.headers.get('location'), null, 'invalid client and redirect errors never redirect');
  }

  const oauthErrorQuery = authorizationQuery(client, { response_type: 'token', state: '' });
  const unauthenticated = await fetch(ctx.env.base + '/oauth/authorize?' + oauthErrorQuery, { redirect: 'manual' });
  assert.equal(unauthenticated.status, 302);
  const unauthenticatedCallback = new URL(unauthenticated.headers.get('location'));
  assert.equal(unauthenticatedCallback.searchParams.get('error'), 'unsupported_response_type');
  assert.equal(unauthenticatedCallback.searchParams.get('state'), '', 'the explicitly empty state is preserved');

  const authenticated = await fetch(ctx.env.base + '/oauth/authorize?' + oauthErrorQuery, {
    headers: { Cookie: ctx.owner.cookie },
    redirect: 'manual',
  });
  assert.equal(authenticated.status, 302);
  const callback = new URL(authenticated.headers.get('location'));
  assert.equal(callback.searchParams.get('error'), 'unsupported_response_type');
  assert.equal(callback.searchParams.has('state'), true);
  assert.equal(callback.searchParams.get('state'), '', 'an explicitly empty state value is preserved');

  const oversizedState = authorizationQuery(client, { response_type: 'token', state: 's'.repeat(513) });
  const invalidState = await fetch(ctx.env.base + '/oauth/authorize?' + oversizedState, {
    headers: { Cookie: ctx.owner.cookie },
    redirect: 'manual',
  });
  assert.equal(invalidState.status, 302);
  const invalidStateCallback = new URL(invalidState.headers.get('location'));
  assert.equal(invalidStateCallback.searchParams.get('error'), 'invalid_request');
  assert.equal(invalidStateCallback.searchParams.has('state'), false, 'invalid state is not echoed');
});

test('oversized OAuth state returns invalid_request without echoing the state', async (t) => {
  const ctx = await startMcpEnvironment({ mcpPublicUrl: 'https://remotehub.example' });
  t.after(() => ctx.env.stop());
  const client = await registerClient(ctx, { redirectUri: 'https://remotehub.example/callback' });
  const query = authorizationQuery(client, { state: 's'.repeat(513) });
  const response = await fetch(ctx.env.base + '/oauth/authorize?' + query, {
    headers: { Cookie: ctx.owner.cookie },
    redirect: 'manual',
  });
  assert.equal(response.status, 302);
  const callback = new URL(response.headers.get('location'));
  assert.equal(callback.searchParams.get('error'), 'invalid_request');
  assert.equal(callback.searchParams.has('state'), false);
});

test('the issuer origin is accepted for authorize pages behind a Host-rewriting proxy', async (t) => {
  const ctx = await startMcpEnvironment({ mcpPublicUrl: 'https://remotehub.example' });
  t.after(() => ctx.env.stop());
  const client = await registerClient(ctx, { redirectUri: 'http://127.0.0.1/callback' });
  const query = authorizationQuery(client, { state: 'proxied' });
  const url = ctx.env.base + '/oauth/authorize?' + query;
  const issuer = 'https://remotehub.example';

  // Same-machine proxy preserving the public Host: the raw Host never matches, the issuer origin must.
  const preservedHost = await fetch(url, { headers: { Origin: issuer }, redirect: 'manual' });
  assert.equal(preservedHost.status, 200);
  // Proxy that rewrites Host but forwards it, with RemoteHub trusting the immediate peer.
  const forwardedHost = await fetch(url, {
    headers: { Origin: issuer, Host: 'internal:8090', 'X-Forwarded-Host': 'remotehub.example' },
    redirect: 'manual',
  });
  assert.equal(forwardedHost.status, 200);

  // Foreign origins stay rejected, with or without a forwarded header.
  const foreignOrigin = await fetch(url, { headers: { Origin: 'https://attacker.example' }, redirect: 'manual' });
  assert.equal(foreignOrigin.status, 403);
  const httpDowngrade = await fetch(url, { headers: { Origin: 'http://remotehub.example' }, redirect: 'manual' });
  assert.equal(httpDowngrade.status, 403);
  const foreignWithForward = await fetch(url, {
    headers: { Origin: 'https://attacker.example', Host: 'internal:8090', 'X-Forwarded-Host': 'other.example' },
    redirect: 'manual',
  });
  assert.equal(foreignWithForward.status, 403);
});

test('the consent form posts with a null Origin and still authorizes the pending request', async (t) => {
  const ctx = await startMcpEnvironment();
  t.after(() => ctx.env.stop());
  const client = await registerClient(ctx);
  const query = authorizationQuery(client, { state: 'null-origin' });
  const authorizeResponse = await fetch(ctx.env.base + '/oauth/authorize?' + query, {
    headers: { Origin: ctx.env.origin, Cookie: ctx.owner.cookie },
    redirect: 'manual',
  });
  assert.equal(authorizeResponse.status, 200);
  const requestId = /name="requestId" value="([A-Za-z0-9_-]+)"/.exec(await authorizeResponse.text())?.[1];
  assert.ok(requestId, 'authorization form has a request id');

  // A sandboxed or embedded browser (desktop clients) sends `Origin: null` on the form POST.
  const form = new URLSearchParams({ requestId, consent: 'allow', hostIds: ctx.host.id });
  for (const scope of ['hosts:read', 'files:read']) form.append('scopes', scope);
  const consent = await fetch(ctx.env.base + '/oauth/authorize', {
    method: 'POST',
    headers: {
      Origin: 'null',
      Cookie: ctx.owner.cookie,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: form,
    redirect: 'manual',
  });
  assert.equal(consent.status, 302);
  const callback = new URL(consent.headers.get('location'));
  assert.equal(callback.searchParams.get('error'), null);
  assert.ok(callback.searchParams.get('code'), 'the null-origin consent still issues an authorization code');

  // A foreign origin stays rejected, and a null origin without a pending request is refused.
  const foreign = await fetch(ctx.env.base + '/oauth/authorize', {
    method: 'POST',
    headers: {
      Origin: 'https://attacker.example',
      Cookie: ctx.owner.cookie,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: form,
    redirect: 'manual',
  });
  assert.equal(foreign.status, 403);
  const unknownRequest = await fetch(ctx.env.base + '/oauth/authorize', {
    method: 'POST',
    headers: {
      Origin: 'null',
      Cookie: ctx.owner.cookie,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ requestId: 'not-a-pending-request', consent: 'allow' }),
    redirect: 'manual',
  });
  assert.equal(unknownRequest.status, 400);
  assert.match(await unknownRequest.text(), /expired/i);
});

test('the token endpoint accepts a client that omits resource or client_id', async (t) => {
  const ctx = await startMcpEnvironment();
  t.after(() => ctx.env.stop());
  const client = await registerClient(ctx);

  // A client that states the resource only as the origin still gets a token.
  const originResource = new URL(client.resource).origin;
  const first = await authorizeCode(ctx, client, ['hosts:read']);
  const originOnly = await fetch(ctx.env.base + '/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: client.clientId,
      code: first.code,
      redirect_uri: client.redirectUri,
      code_verifier: first.verifier,
      resource: originResource,
    }),
  });
  assert.equal(originOnly.status, 200);
  assert.ok((await originOnly.json()).access_token);

  // A client that omits client_id: the code identifies the client.
  const second = await authorizeCode(ctx, client, ['hosts:read']);
  const noClientId = await fetch(ctx.env.base + '/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: second.code,
      redirect_uri: client.redirectUri,
      code_verifier: second.verifier,
      resource: client.resource,
    }),
  });
  assert.equal(noClientId.status, 200);
  assert.ok((await noClientId.json()).access_token);

  // A client that omits the resource entirely still gets a token.
  const third = await authorizeCode(ctx, client, ['hosts:read']);
  const noResource = await fetch(ctx.env.base + '/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: client.clientId,
      code: third.code,
      redirect_uri: client.redirectUri,
      code_verifier: third.verifier,
    }),
  });
  assert.equal(noResource.status, 200);
  assert.ok((await noResource.json()).access_token);

  // A resource for something else is still refused.
  const fourth = await authorizeCode(ctx, client, ['hosts:read']);
  const otherResource = await fetch(ctx.env.base + '/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: client.clientId,
      code: fourth.code,
      redirect_uri: client.redirectUri,
      code_verifier: fourth.verifier,
      resource: 'https://someone-else.example/mcp',
    }),
  });
  assert.equal(otherResource.status, 400);
  assert.equal((await otherResource.json()).error, 'invalid_target');
});

test('the token endpoint logs one line per attempt without secrets', async (t) => {
  const ctx = await startMcpEnvironment();
  t.after(() => ctx.env.stop());
  const client = await registerClient(ctx);
  const { code, verifier } = await authorizeCode(ctx, client, ['hosts:read']);
  const response = await exchangeCode(ctx, client, code, verifier);
  assert.equal(response.response.status, 200);
  const lines = ctx.logs.filter((line) => line.startsWith('oauth token'));
  assert.equal(lines.length, 1);
  assert.match(lines[0], /outcome=issued/);
  assert.equal(lines[0].includes(code), false, 'the log must not contain the code');
  assert.equal(lines[0].includes(verifier), false, 'the log must not contain the verifier');
});

test('resubmitting an answered consent form replays its redirect instead of expiring', async (t) => {
  const ctx = await startMcpEnvironment();
  t.after(() => ctx.env.stop());
  const client = await registerClient(ctx);
  const query = authorizationQuery(client, { state: 'replay' });
  const page = await fetch(ctx.env.base + '/oauth/authorize?' + query, {
    headers: { Origin: ctx.env.origin, Cookie: ctx.owner.cookie },
    redirect: 'manual',
  });
  assert.equal(page.status, 200);
  const html = await page.text();
  const requestId = /name="requestId" value="([A-Za-z0-9_-]+)"/.exec(html)[1];

  const form = new URLSearchParams({ requestId, consent: 'allow', hostIds: ctx.host.id });
  for (const scope of ['hosts:read', 'files:read']) form.append('scopes', scope);
  const submit = () => fetch(ctx.env.base + '/oauth/authorize', {
    method: 'POST',
    headers: { Origin: ctx.env.origin, Cookie: ctx.owner.cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form,
    redirect: 'manual',
  });

  const first = await submit();
  assert.equal(first.status, 302);
  const firstLocation = first.headers.get('location');
  assert.ok(new URL(firstLocation).searchParams.get('code'));

  // The same form submitted again (back button, double click, reopened tab) must not say
  // "Authorization request expired" while the code it produced is still usable.
  const second = await submit();
  assert.equal(second.status, 302);
  assert.equal(second.headers.get('location'), firstLocation, 'the same redirect is replayed');

  // Only one grant was created for the two submissions.
  const persisted = JSON.parse(await fs.readFile(path.join(ctx.env.dataDir, 'mcp-oauth.json'), 'utf8'));
  assert.equal(Object.keys(persisted.grants).length, 1);
});

test('the consent page says when no computer is connected instead of failing later', async (t) => {
  const ctx = await startMcpEnvironment();
  t.after(() => ctx.env.stop());
  const client = await registerClient(ctx);
  // Stop the agent so the registered host is offline, the state that has no selectable host.
  ctx.agent.ws.close();
  await new Promise((resolve) => setTimeout(resolve, 50));
  const response = await fetch(ctx.env.base + '/oauth/authorize?' + authorizationQuery(client, { state: 'offline-hosts' }), {
    headers: { Origin: ctx.env.origin, Cookie: ctx.owner.cookie },
    redirect: 'manual',
  });
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /No computer is connected right now\./);
  assert.match(html, /Start the RemoteHub agent on the computer you want to authorize/);
  assert.match(html, /offline/, 'the registered host is still listed with its state');

  // Without that explanation the form would only fail later with the host-selection error.
  const form = new URLSearchParams({ requestId: /name="requestId" value="([A-Za-z0-9_-]+)"/.exec(html)[1], consent: 'allow' });
  for (const scope of ['hosts:read', 'files:read']) form.append('scopes', scope);
  const denied = await fetch(ctx.env.base + '/oauth/authorize', {
    method: 'POST',
    headers: { Origin: ctx.env.origin, Cookie: ctx.owner.cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form,
    redirect: 'manual',
  });
  assert.equal(denied.status, 400);
  assert.match(await denied.text(), /Choose at least one currently connected host/);
});

test('authorize errors distinguish unsupported response types, invalid scopes, and malformed parameters', async (t) => {
  const ctx = await startMcpEnvironment({ mcpPublicUrl: 'https://remotehub.example' });
  t.after(() => ctx.env.stop());
  const client = await registerClient(ctx, { redirectUri: 'https://remotehub.example/callback' });
  const cases = [
    [{ response_type: 'token', state: 'unsupported' }, 'unsupported_response_type'],
    [{ scope: 'hosts:read unknown:scope', state: 'unknown-scope' }, 'invalid_scope'],
    [{ scope: 'commands:exec', state: 'disabled-scope' }, 'invalid_scope'],
    [{ response_type: null, state: 'missing-response-type' }, 'invalid_request'],
  ];

  for (const [overrides, expectedError] of cases) {
    const response = await fetch(ctx.env.base + '/oauth/authorize?' + authorizationQuery(client, overrides), {
      headers: { Cookie: ctx.owner.cookie },
      redirect: 'manual',
    });
    assert.equal(response.status, 302, expectedError);
    assert.equal(new URL(response.headers.get('location')).searchParams.get('error'), expectedError);
  }
});

test('repeated authorization parameters are invalid_request and preserve only an unambiguous state', async (t) => {
  const ctx = await startMcpEnvironment({ mcpPublicUrl: 'https://remotehub.example' });
  t.after(() => ctx.env.stop());
  const client = await registerClient(ctx, { redirectUri: 'https://remotehub.example/callback' });
  for (const [parameter, firstValue, repeatedValue] of [
    ['scope', 'hosts:read', 'files:read'],
    ['response_type', 'code', 'code'],
  ]) {
    const query = authorizationQuery(client, {
      [parameter]: firstValue,
      state: 'duplicate-' + parameter,
    });
    query.append(parameter, repeatedValue);

    const response = await fetch(ctx.env.base + '/oauth/authorize?' + query, {
      headers: { Cookie: ctx.owner.cookie },
      redirect: 'manual',
    });
    assert.equal(response.status, 302, parameter);
    const callback = new URL(response.headers.get('location'));
    assert.equal(callback.searchParams.get('error'), 'invalid_request', parameter);
    assert.equal(callback.searchParams.get('state'), 'duplicate-' + parameter, 'a single state is preserved when another parameter repeats');
  }

  const duplicateState = authorizationQuery(client, { state: 'first-state' });
  duplicateState.append('state', 'second-state');
  const response = await fetch(ctx.env.base + '/oauth/authorize?' + duplicateState, {
    headers: { Cookie: ctx.owner.cookie },
    redirect: 'manual',
  });
  assert.equal(response.status, 302);
  const callback = new URL(response.headers.get('location'));
  assert.equal(callback.searchParams.get('error'), 'invalid_request');
  assert.equal(callback.searchParams.has('state'), false, 'ambiguous repeated state is not echoed');
});

test('denial authenticates the owner before redirecting and preserves empty state', async (t) => {
  const ctx = await startMcpEnvironment({ mcpPublicUrl: 'https://remotehub.example' });
  t.after(() => ctx.env.stop());
  const client = await registerClient(ctx, { redirectUri: 'https://remotehub.example/callback' });
  const query = authorizationQuery(client, { state: '' });
  const authorize = await fetch(ctx.env.base + '/oauth/authorize?' + query, { redirect: 'manual' });
  assert.equal(authorize.status, 200);
  const requestId = /name="requestId" value="([A-Za-z0-9_-]+)"/.exec(await authorize.text())?.[1];
  assert.ok(requestId);

  const unauthenticated = await submitConsent(ctx, requestId, { cookie: null });
  assert.equal(unauthenticated.status, 401);
  assert.equal(unauthenticated.headers.get('location'), null);

  const denied = await submitConsent(ctx, requestId, { cookie: null, password: OWNER_PASSWORD });
  assert.equal(denied.status, 302);
  const callback = new URL(denied.headers.get('location'));
  assert.equal(callback.searchParams.get('error'), 'access_denied');
  assert.equal(callback.searchParams.has('state'), true);
  assert.equal(callback.searchParams.get('state'), '');
});

test('the consent page sends no form-action so its redirect chain can reach the client', async (t) => {
  const ctx = await startMcpEnvironment({ mcpPublicUrl: 'https://remotehub.example' });
  t.after(() => ctx.env.stop());
  const client = await registerClient(ctx, { redirectUri: 'https://client.example/oauth/callback' });
  const page = await fetch(ctx.env.base + '/oauth/authorize?' + authorizationQuery(client, { state: 'csp' }), {
    headers: { Cookie: ctx.owner.cookie },
    redirect: 'manual',
  });
  assert.equal(page.status, 200);
  // Chrome enforces form-action on every hop of the redirect that answers the form POST, and
  // a callback may bounce to another origin (www.cursor.com -> cursor.com). Any form-action
  // here makes the Authorize button silently do nothing.
  const policy = page.headers.get('content-security-policy');
  assert.doesNotMatch(policy, /form-action/);
  assert.match(policy, /default-src 'self'/, 'the rest of the policy is kept');

  // Every other page keeps the strict policy.
  const manage = await fetch(ctx.env.base + '/oauth/manage', { headers: { Cookie: ctx.owner.cookie } });
  assert.match(manage.headers.get('content-security-policy'), /form-action 'self'(;|$)/);
});

test('registered external callbacks receive authenticated OAuth errors and denials', async (t) => {
  const ctx = await startMcpEnvironment({ mcpPublicUrl: 'https://remotehub.example' });
  t.after(() => ctx.env.stop());
  const client = await registerClient(ctx, { redirectUri: 'https://attacker.example/callback' });

  const errorQuery = authorizationQuery(client, { response_type: 'token', state: 'dynamic-error' });
  const errorResponse = await fetch(ctx.env.base + '/oauth/authorize?' + errorQuery, {
    headers: { Cookie: ctx.owner.cookie },
    redirect: 'manual',
  });
  assert.equal(errorResponse.status, 302);
  const errorCallback = new URL(errorResponse.headers.get('location'));
  assert.equal(errorCallback.origin, 'https://attacker.example');
  assert.equal(errorCallback.searchParams.get('error'), 'unsupported_response_type');
  assert.equal(errorCallback.searchParams.get('state'), 'dynamic-error');

  const consentQuery = authorizationQuery(client, { state: 'dynamic-denial' });
  const consent = await fetch(ctx.env.base + '/oauth/authorize?' + consentQuery, {
    headers: { Cookie: ctx.owner.cookie },
    redirect: 'manual',
  });
  assert.equal(consent.status, 200);
  const requestId = /name="requestId" value="([A-Za-z0-9_-]+)"/.exec(await consent.text())?.[1];
  assert.ok(requestId);

  const denied = await submitConsent(ctx, requestId, { consent: 'deny' });
  assert.equal(denied.status, 302);
  const denialCallback = new URL(denied.headers.get('location'));
  assert.equal(denialCallback.origin, 'https://attacker.example');
  assert.equal(denialCallback.searchParams.get('error'), 'access_denied');
  assert.equal(denialCallback.searchParams.get('state'), 'dynamic-denial');
});

test('OAuth registration rejects redirect URIs with fragment components', async (t) => {
  const ctx = await startMcpEnvironment();
  t.after(() => ctx.env.stop());
  for (const redirectUri of [
    'https://client.example/callback#section',
    'https://client.example/callback#',
    'http://127.0.0.1:41234/callback#fragment',
  ]) {
    const response = await fetch(ctx.env.base + '/oauth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_name: 'Fragment callback test',
        redirect_uris: [redirectUri],
        grant_types: ['authorization_code'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      }),
    });
    assert.equal(response.status, 400, redirectUri);
    assert.equal((await response.json()).error, 'invalid_redirect_uri', redirectUri);
  }
});

test('unacceptable OAuth resources use invalid_target at authorization and token endpoints', async (t) => {
  const ctx = await startMcpEnvironment({ mcpPublicUrl: 'https://remotehub.example' });
  t.after(() => ctx.env.stop());
  const client = await registerClient(ctx, { redirectUri: 'https://client.example/callback' });

  const authorization = await fetch(ctx.env.base + '/oauth/authorize?' + authorizationQuery(client, {
    resource: 'https://other.example/mcp',
    state: 'wrong-resource',
  }), {
    headers: { Cookie: ctx.owner.cookie },
    redirect: 'manual',
  });
  assert.equal(authorization.status, 302);
  const authorizationCallback = new URL(authorization.headers.get('location'));
  assert.equal(authorizationCallback.searchParams.get('error'), 'invalid_target');
  assert.equal(authorizationCallback.searchParams.get('state'), 'wrong-resource');

  const { code, verifier } = await authorizeCode(ctx, client, ['hosts:read']);
  const tokenResponse = await fetch(ctx.env.base + '/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: client.clientId,
      code,
      redirect_uri: client.redirectUri,
      code_verifier: verifier,
      resource: 'https://other.example/mcp',
    }),
  });
  assert.equal(tokenResponse.status, 400);
  assert.equal((await tokenResponse.json()).error, 'invalid_target');
  const correctResource = await exchangeCode(ctx, client, code, verifier);
  assert.equal(correctResource.response.status, 200, 'an unacceptable target does not consume the authorization code');
});

test('refresh rotation remains within token capacity and preserves a grant when full', async (t) => {
  const fixture = await createOAuthServerFixture(t);
  const { state, base, resource } = fixture;
  const clientId = 'bounded-token-client';
  const grantId = 'bounded-token-grant';
  const now = Date.now();
  const refreshExpiresAt = now + 24 * 60 * 60_000;
  const refreshTokenHash = (token) => createHash('sha256').update(token).digest('hex');
  const currentToken = 'initial-bounded-refresh-token';
  state.data.clients[clientId] = {
    client_id: clientId,
    expiresAt: now + 60_000,
    redirect_uris: ['http://127.0.0.1/callback'],
    grant_types: ['authorization_code', 'refresh_token'],
  };
  state.data.grants[grantId] = {
    grantId,
    clientId,
    ownerId: 'owner',
    hostIds: ['host-one'],
    scopes: ['hosts:read', 'offline_access'],
    refreshExpiresAt,
  };
  state.data.tokens[refreshTokenHash(currentToken)] = {
    grantId, kind: 'refresh', ownerId: 'owner', clientId, audience: resource, hostIds: ['host-one'],
    scopes: ['hosts:read', 'offline_access'], expiresAt: refreshExpiresAt,
  };
  const fillerHashes = [];
  for (let index = 0; index < 997; index += 1) {
    const hash = refreshTokenHash('live-filler-token-' + index);
    fillerHashes.push(hash);
    state.data.tokens[hash] = {
      kind: 'access', ownerId: 'owner', clientId, audience: resource, expiresAt: refreshExpiresAt,
    };
  }

  const rotate = async (refreshToken) => {
    const response = await fetch(base + '/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: clientId,
        refresh_token: refreshToken,
        resource,
      }),
    });
    return { response, body: await response.json() };
  };

  const first = await rotate(currentToken);
  assert.equal(first.response.status, 200);
  assert.equal(Object.keys(state.data.tokens).length, 999);
  const second = await rotate(first.body.refresh_token);
  assert.equal(second.response.status, 200);
  assert.equal(Object.keys(state.data.tokens).length, 1000);

  const full = await rotate(second.body.refresh_token);
  assert.equal(full.response.status, 503);
  assert.equal(full.body.error, 'temporarily_unavailable');
  assert.equal(state.data.tokens[refreshTokenHash(second.body.refresh_token)]?.kind, 'refresh',
    'capacity rejection leaves the still-valid refresh token unconsumed');
  assert.equal(Object.keys(state.data.tokens).length, 1000);

  state.data.tokens[fillerHashes[0]].expiresAt = Date.now() - 1;
  const afterExpiry = await rotate(second.body.refresh_token);
  assert.equal(afterExpiry.response.status, 200, 'expired token records are pruned before capacity is assessed');
  assert.equal(Object.keys(state.data.tokens).length, 1000);

  const verifier = 'a'.repeat(43);
  const code = 'full-store-authorization-code';
  const codeHash = refreshTokenHash(code);
  state.data.codes[codeHash] = {
    grantId,
    clientId,
    redirectUri: 'http://127.0.0.1/callback',
    challenge: createHash('sha256').update(verifier).digest('base64url'),
    resource,
    ownerId: 'owner',
    hostIds: ['host-one'],
    scopes: ['hosts:read'],
    expiresAt: Date.now() + 60_000,
  };
  const codeExchange = await fetch(base + '/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: clientId,
      code,
      redirect_uri: 'http://127.0.0.1/callback',
      code_verifier: verifier,
      resource,
    }),
  });
  assert.equal(codeExchange.status, 503);
  assert.equal((await codeExchange.json()).error, 'temporarily_unavailable');
  assert.ok(state.data.codes[codeHash], 'capacity rejection leaves the valid authorization code available');
  assert.equal(Object.keys(state.data.tokens).length, 1000);
});

test('OAuth endpoints ignore repeated unrecognized extension parameters', async (t) => {
  const ctx = await startMcpEnvironment({ mcpPublicUrl: 'https://remotehub.example' });
  t.after(() => ctx.env.stop());
  const client = await registerClient(ctx, { redirectUri: 'https://remotehub.example/callback' });

  const authorizationQueryWithExtension = authorizationQuery(client, { state: 'extension-state' });
  authorizationQueryWithExtension.append('client_hint', 'first');
  authorizationQueryWithExtension.append('client_hint', 'second');
  const authorization = await fetch(ctx.env.base + '/oauth/authorize?' + authorizationQueryWithExtension, {
    headers: { Cookie: ctx.owner.cookie },
    redirect: 'manual',
  });
  assert.equal(authorization.status, 200, 'unknown repeated authorization parameters are ignored');

  const granted = await authorize(ctx, client, ['hosts:read', 'offline_access']);
  const tokenRequest = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: client.clientId,
    refresh_token: granted.tokens.refresh_token,
    resource: client.resource,
  });
  tokenRequest.append('client_hint', 'first');
  tokenRequest.append('client_hint', 'second');
  const token = await fetch(ctx.env.base + '/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: tokenRequest,
  });
  assert.equal(token.status, 200, 'unknown repeated token parameters are ignored');
});

test('repeated refresh scope parameters are invalid_request and leave the token usable', async (t) => {
  const ctx = await startMcpEnvironment();
  t.after(() => ctx.env.stop());
  const client = await registerClient(ctx);
  const granted = await authorize(ctx, client, ['hosts:read', 'offline_access']);
  const repeated = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: client.clientId,
    refresh_token: granted.tokens.refresh_token,
    resource: client.resource,
    scope: 'hosts:read',
  });
  repeated.append('scope', 'hosts:read');
  const rejected = await fetch(ctx.env.base + '/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: repeated,
  });
  assert.equal(rejected.status, 400);
  assert.equal((await rejected.json()).error, 'invalid_request');
  const usable = await refreshToken(ctx, client, granted.tokens.refresh_token);
  assert.equal(usable.response.status, 200, 'duplicate-parameter rejection does not consume the refresh token');
});

test('native loopback redirects accept a dynamic port and reject other URI changes', async (t) => {
  const ctx = await startMcpEnvironment();
  t.after(() => ctx.env.stop());

  for (const host of ['localhost', '127.0.0.1', '[::1]']) {
    const queryValue = 'client=remotehub';
    const registeredUri = 'http://' + host + ':41234/callback?' + queryValue;
    const dynamicUri = 'http://' + host + ':53121/callback?' + queryValue;
    const client = await registerClient(ctx, { redirectUri: registeredUri });
    const requested = authorizationQuery(client, { redirect_uri: dynamicUri, state: 'dynamic-port' });

    if (host === 'localhost') {
      const errorQuery = authorizationQuery(client, {
        redirect_uri: dynamicUri,
        response_type: 'token',
        state: 'dynamic-port-error',
      });
      const errorResponse = await fetch(ctx.env.base + '/oauth/authorize?' + errorQuery, {
        headers: { Cookie: ctx.owner.cookie },
        redirect: 'manual',
      });
      assert.equal(errorResponse.status, 302);
      const errorCallback = new URL(errorResponse.headers.get('location'));
      assert.equal(errorCallback.origin, 'http://localhost:53121');
      assert.equal(errorCallback.searchParams.get('error'), 'unsupported_response_type');
      assert.equal(errorCallback.searchParams.get('state'), 'dynamic-port-error');
      const exchanged = await authorize(ctx, client, ['hosts:read'], dynamicUri);
      assert.equal(exchanged.response.status, 200);
    } else {
      const response = await fetch(ctx.env.base + '/oauth/authorize?' + requested, {
        headers: { Cookie: ctx.owner.cookie },
        redirect: 'manual',
      });
      assert.equal(response.status, 200, host + ' accepts an allocated port');
    }

    const mismatches = [
      'http://otherhost:53121/callback?' + queryValue,
      'http://' + host + ':53121/other?' + queryValue,
      'https://' + host + ':53121/callback?' + queryValue,
      'http://' + host + ':53121/callback?client=other',
      'http://' + host + ':53121/callback?' + queryValue + '#different-fragment',
    ];
    for (const redirectUri of mismatches) {
      const response = await fetch(ctx.env.base + '/oauth/authorize?' + authorizationQuery(client, { redirect_uri: redirectUri }), { redirect: 'manual' });
      assert.equal(response.status, 400, redirectUri);
      assert.equal(response.headers.get('location'), null, redirectUri);
    }
  }

  const httpsRegisteredUri = 'https://localhost:41234/callback?client=remotehub';
  const httpsDynamicUri = 'https://localhost:53121/callback?client=remotehub';
  const httpsClient = await registerClient(ctx, { redirectUri: httpsRegisteredUri });
  const exactPort = await fetch(ctx.env.base + '/oauth/authorize?' + authorizationQuery(httpsClient), {
    headers: { Cookie: ctx.owner.cookie },
    redirect: 'manual',
  });
  assert.equal(exactPort.status, 200, 'HTTPS loopback redirects continue to match the registered port exactly');

  const dynamicPort = await fetch(ctx.env.base + '/oauth/authorize?' + authorizationQuery(httpsClient, {
    redirect_uri: httpsDynamicUri,
  }), { redirect: 'manual' });
  assert.equal(dynamicPort.status, 400, 'HTTPS loopback redirects do not receive the HTTP dynamic-port exception');
  assert.equal(dynamicPort.headers.get('location'), null);
});

test('loopback consent identifies the hostname and port, warns locally, and escapes client data', async (t) => {
  const ctx = await startMcpEnvironment();
  t.after(() => ctx.env.stop());
  const redirectUri = 'http://localhost:41234/callback?first=1&next=%3Cscript%3E';
  const client = await registerClient(ctx, {
    clientName: '<img src=x onerror=alert(1)>',
    redirectUri,
  });
  const query = authorizationQuery(client, { state: 'loopback-state' });
  const authorize = await fetch(ctx.env.base + '/oauth/authorize?' + query, {
    headers: { Cookie: ctx.owner.cookie },
    redirect: 'manual',
  });
  assert.equal(authorize.status, 200);
  const html = await authorize.text();
  const requestId = /name="requestId" value="([A-Za-z0-9_-]+)"/.exec(html)?.[1];
  assert.ok(requestId);
  assert.match(html, /localhost:41234/);
  assert.match(html, /localhost warning/i);
  assert.equal(html.includes('&lt;img src=x onerror=alert(1)&gt;'), true);
  assert.equal(html.includes('<img src=x onerror=alert(1)>'), false);
  assert.match(html, /\?first=1&amp;next=%3Cscript%3E/);

  const denied = await submitConsent(ctx, requestId, { consent: 'deny' });
  assert.equal(denied.status, 302);
  const callback = new URL(denied.headers.get('location'));
  assert.equal(callback.origin, 'http://localhost:41234');
  assert.equal(callback.searchParams.get('error'), 'access_denied');
  assert.equal(callback.searchParams.get('state'), 'loopback-state');
});

test('a grant revoked while code consumption is saving cannot be recreated by token issuance', async (t) => {
  const ctx = await startMcpEnvironment();
  t.after(() => ctx.env.stop());
  const client = await registerClient(ctx);
  const { code, verifier } = await authorizeCode(ctx, client, ['hosts:read']);
  const manageUrl = ctx.env.base + '/oauth/manage';
  const management = await fetch(manageUrl, { headers: { Origin: ctx.env.origin, Cookie: ctx.owner.cookie } });
  const managementHtml = await management.text();
  const grantId = /name="grantId" value="([A-Za-z0-9_-]+)"/.exec(managementHtml)?.[1];
  assert.ok(grantId, 'owner management page exposes the grant revocation form');

  let signalBlocked;
  let releaseBlocked;
  const blocked = new Promise((resolve) => { signalBlocked = resolve; });
  const release = new Promise((resolve) => { releaseBlocked = resolve; });
  const originalRename = fs.rename;
  let oauthRenames = 0;
  fs.rename = async (from, to) => {
    if (String(to).endsWith('mcp-oauth.json') && ++oauthRenames === 2) {
      signalBlocked();
      await release;
    }
    return originalRename(from, to);
  };

  try {
    const exchanging = exchangeCode(ctx, client, code, verifier);
    await blocked;
    const revoking = fetch(ctx.env.base + '/oauth/manage/revoke-grant', {
      method: 'POST',
      headers: {
        Origin: ctx.env.origin,
        Cookie: ctx.owner.cookie,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ grantId }),
      redirect: 'manual',
    });

    let revokedInMemory = false;
    for (let attempt = 0; attempt < 100 && !revokedInMemory; attempt += 1) {
      const check = await fetch(manageUrl, { headers: { Origin: ctx.env.origin, Cookie: ctx.owner.cookie } });
      revokedInMemory = (await check.text()).includes('No active access grants.');
      if (!revokedInMemory) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(revokedInMemory, 'the owner revocation takes effect while code persistence is paused');

    releaseBlocked();
    const [exchanged, revoked] = await Promise.all([exchanging, revoking]);
    assert.equal(revoked.status, 303);
    assert.equal(exchanged.response.status, 400);
    assert.equal(exchanged.tokens.error, 'invalid_grant');
    const after = await fetch(manageUrl, { headers: { Origin: ctx.env.origin, Cookie: ctx.owner.cookie } });
    assert.match(await after.text(), /No active access grants\./);
    const persisted = JSON.parse(await fs.readFile(ctx.env.dataDir + '/mcp-oauth.json', 'utf8'));
    assert.equal(persisted.grants[grantId], undefined);
    assert.equal(Object.keys(persisted.tokens).length, 0);
  } finally {
    releaseBlocked();
    fs.rename = originalRename;
  }
});

test('a grant revoked while refresh token issuance is saving cannot be recreated', async (t) => {
  const ctx = await startMcpEnvironment();
  t.after(() => ctx.env.stop());
  const client = await registerClient(ctx);
  const granted = await authorize(ctx, client, ['hosts:read', 'offline_access']);
  assert.equal(granted.response.status, 200);
  const manageUrl = ctx.env.base + '/oauth/manage';
  const management = await fetch(manageUrl, { headers: { Origin: ctx.env.origin, Cookie: ctx.owner.cookie } });
  const grantId = /name="grantId" value="([A-Za-z0-9_-]+)"/.exec(await management.text())?.[1];
  assert.ok(grantId, 'owner management page exposes the grant revocation form');

  let signalBlocked;
  let releaseBlocked;
  const blocked = new Promise((resolve) => { signalBlocked = resolve; });
  const release = new Promise((resolve) => { releaseBlocked = resolve; });
  const originalRename = fs.rename;
  let oauthRenames = 0;
  fs.rename = async (from, to) => {
    if (String(to).endsWith('mcp-oauth.json') && ++oauthRenames === 2) {
      signalBlocked();
      await release;
    }
    return originalRename(from, to);
  };

  try {
    const refreshing = fetch(ctx.env.base + '/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: client.clientId,
        refresh_token: granted.tokens.refresh_token,
        resource: client.resource,
      }),
    });
    await blocked;
    const revoking = fetch(ctx.env.base + '/oauth/manage/revoke-grant', {
      method: 'POST',
      headers: {
        Origin: ctx.env.origin,
        Cookie: ctx.owner.cookie,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ grantId }),
      redirect: 'manual',
    });

    let revokedInMemory = false;
    for (let attempt = 0; attempt < 100 && !revokedInMemory; attempt += 1) {
      const check = await fetch(manageUrl, { headers: { Origin: ctx.env.origin, Cookie: ctx.owner.cookie } });
      revokedInMemory = (await check.text()).includes('No active access grants.');
      if (!revokedInMemory) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(revokedInMemory, 'the owner revocation takes effect while refresh issuance persistence is paused');

    releaseBlocked();
    const [refreshed, revoked] = await Promise.all([refreshing, revoking]);
    assert.equal(revoked.status, 303);
    assert.equal(refreshed.status, 400);
    assert.equal((await refreshed.json()).error, 'invalid_grant');
    const persisted = JSON.parse(await fs.readFile(ctx.env.dataDir + '/mcp-oauth.json', 'utf8'));
    assert.equal(persisted.grants[grantId], undefined);
    assert.equal(Object.keys(persisted.tokens).length, 0);
  } finally {
    releaseBlocked();
    fs.rename = originalRename;
  }
});

test('owner OAuth pages reject foreign Origins before touching the owner session', async (t) => {
  const ctx = await startMcpEnvironment();
  t.after(() => ctx.env.stop());
  const client = await registerClient(ctx);
  let touchCount = 0;
  const originalTouch = ctx.env.app.sessions.touch;
  ctx.env.app.sessions.touch = function (...args) {
    touchCount += 1;
    return originalTouch.apply(this, args);
  };

  try {
    const manage = await fetch(ctx.env.base + '/oauth/manage', {
      headers: { Origin: 'https://attacker.example', Cookie: ctx.owner.cookie },
    });
    assert.equal(manage.status, 403);

    const query = new URLSearchParams({
      response_type: 'code',
      client_id: client.clientId,
      redirect_uri: client.redirectUri,
      code_challenge: 'A'.repeat(43),
      code_challenge_method: 'S256',
      state: 'origin-check',
      resource: client.resource,
      scope: 'hosts:read',
    });
    const authorizeResponse = await fetch(ctx.env.base + '/oauth/authorize?' + query, {
      headers: { Origin: 'https://attacker.example', Cookie: ctx.owner.cookie },
    });
    assert.equal(authorizeResponse.status, 403);
    assert.equal(touchCount, 0, 'Origin checks run before either route slides the owner session');
  } finally {
    ctx.env.app.sessions.touch = originalTouch;
  }
});

test('directory listing tool forwards bounded page cursors so clients can continue through entries', async (t) => {
  const pageRequests = [];
  const ctx = await startMcpEnvironment({}, {
    handleAgentRequest(message, agent) {
      if (message.op !== 'fs.list') return false;
      pageRequests.push(message);
      const result = message.params.cursor
        ? { entries: [{ name: 'gamma', path: '/root/gamma', kind: 'file', size: 1 }], hasMore: false, nextCursor: null }
        : {
          entries: [
            { name: 'alpha', path: '/root/alpha', kind: 'file', size: 1 },
            { name: 'beta', path: '/root/beta', kind: 'file', size: 1 },
          ],
          hasMore: true,
          nextCursor: 'beta',
        };
      agent.ws.send(JSON.stringify({ id: message.id, ok: true, result }));
      return true;
    },
  });
  t.after(() => ctx.env.stop());

  const client = await registerClient(ctx);
  const granted = await authorize(ctx, client, ['hosts:read', 'files:read']);
  const sessionId = await initializeMcp(ctx, granted.tokens.access_token);
  const first = await callTool(ctx, granted.tokens.access_token, sessionId, 10, 'remotehub.files.list', {
    hostId: ctx.host.id, path: '.', limit: 2,
  });
  assert.equal(first.response.status, 200);
  assert.equal(first.body.result.structuredContent.hasMore, true);
  assert.deepEqual(first.body.result.structuredContent.entries.map((entry) => entry.name), ['alpha', 'beta']);

  const second = await callTool(ctx, granted.tokens.access_token, sessionId, 11, 'remotehub.files.list', {
    hostId: ctx.host.id, path: '.', limit: 2, cursor: first.body.result.structuredContent.nextCursor,
  });
  assert.equal(second.response.status, 200);
  assert.equal(second.body.result.structuredContent.hasMore, false);
  assert.deepEqual(second.body.result.structuredContent.entries.map((entry) => entry.name), ['gamma']);
  assert.deepEqual(pageRequests.map((request) => request.params), [
    { path: '.', cursor: null, limit: 2 },
    { path: '.', cursor: 'beta', limit: 2 },
  ]);
});

test('file tool dispatch preserves a 1 MiB write across escaped HTTP and agent JSON frames', async (t) => {
  const ctx = await startMcpEnvironment();
  t.after(() => ctx.env.stop());
  const client = await registerClient(ctx);
  const issued = await authorize(ctx, client, ['hosts:read', 'files:write']);
  assert.equal(issued.response.status, 200);
  const sessionId = await initializeMcp(ctx, issued.tokens.access_token);

  const content = '\0'.repeat(1024 * 1024);
  const httpRequest = {
    jsonrpc: '2.0', id: 10, method: 'tools/call',
    params: { name: 'remotehub.files.write', arguments: { hostId: ctx.host.id, path: 'escaped.txt', content } },
  };
  const httpBodyBytes = Buffer.byteLength(JSON.stringify(httpRequest), 'utf8');
  assert.ok(httpBodyBytes > 2 * 1024 * 1024, 'the HTTP JSON body exceeds the former 2 MiB parser limit');
  assert.ok(httpBodyBytes <= 8 * 1024 * 1024, 'the escaped HTTP JSON body remains bounded');

  const accepted = await callTool(ctx, issued.tokens.access_token, sessionId, 10, 'remotehub.files.write', httpRequest.params.arguments);
  assert.equal(accepted.response.status, 200);
  assert.equal(accepted.body.result.isError, false);
  assert.equal(ctx.agentRequests.length, 1);
  assert.equal(ctx.agentRequests[0].op, 'fs.write');
  assert.equal(ctx.agentRequests[0].params.content, content);
  assert.equal(Buffer.byteLength(ctx.agentRequests[0].params.content, 'utf8'), 1024 * 1024);
  const agentFrameBytes = Buffer.byteLength(JSON.stringify(ctx.agentRequests[0]), 'utf8');
  assert.ok(agentFrameBytes > 1024 * 1024, 'the request envelope and JSON escaping exceed the former frame limit');
  assert.ok(agentFrameBytes <= 7 * 1024 * 1024, 'the serialized agent frame remains bounded');

  const overLimit = await callTool(ctx, issued.tokens.access_token, sessionId, 11, 'remotehub.files.write', {
    hostId: ctx.host.id, path: 'over-limit.txt', content: '\0'.repeat(1024 * 1024 + 1),
  });
  assert.equal(overLimit.response.status, 200);
  assert.equal(overLimit.body.result.isError, true);
  assert.match(overLimit.body.result.content[0].text, /1 MiB in UTF-8 bytes/);
  assert.equal(ctx.agentRequests.length, 1, 'content above the documented byte limit never reaches the agent');
  assert.equal(ctx.agent.ws.readyState, ctx.agent.ws.OPEN, 'rejecting oversized content does not disconnect the agent');
});

test('command tool requires server opt-in and explicit commands:exec consent', async (t) => {
  const disabled = await startMcpEnvironment({ mcpCommandsEnabled: false });
  t.after(() => disabled.env.stop());
  const disabledClient = await registerClient(disabled);
  const disabledGrant = await authorize(disabled, disabledClient, ['hosts:read']);
  assert.equal(disabledGrant.response.status, 200);
  const disabledSession = await initializeMcp(disabled, disabledGrant.tokens.access_token);
  const disabledList = await mcpPost(disabled, disabledGrant.tokens.access_token, {
    jsonrpc: '2.0', id: 20, method: 'tools/list', params: {},
  }, disabledSession);
  assert.ok(!disabledList.body.result.tools.some((tool) => tool.name === 'remotehub.commands.run'));
  const disabledCall = await callTool(disabled, disabledGrant.tokens.access_token, disabledSession, 21, 'remotehub.commands.run', {
    hostId: disabled.host.id, executable: 'whoami',
  });
  assert.equal(disabledCall.body.result.isError, true);
  assert.match(disabledCall.body.result.content[0].text, /disabled/i);
  assert.equal(disabled.agentRequests.length, 0);

  const enabled = await startMcpEnvironment({ mcpCommandsEnabled: true });
  t.after(() => enabled.env.stop());
  const enabledClient = await registerClient(enabled);
  const readOnlyGrant = await authorize(enabled, enabledClient, ['hosts:read']);
  assert.equal(readOnlyGrant.response.status, 200);
  const readOnlySession = await initializeMcp(enabled, readOnlyGrant.tokens.access_token);
  const denied = await callTool(enabled, readOnlyGrant.tokens.access_token, readOnlySession, 22, 'remotehub.commands.run', {
    hostId: enabled.host.id, executable: 'whoami',
  });
  assert.equal(denied.body.result.isError, true);
  assert.match(denied.body.result.content[0].text, /commands:exec|permission/i);
  assert.equal(enabled.agentRequests.length, 0);

  const commandGrant = await authorize(enabled, enabledClient, ['hosts:read', 'commands:exec']);
  assert.equal(commandGrant.response.status, 200);
  const commandSession = await initializeMcp(enabled, commandGrant.tokens.access_token);
  const allowed = await callTool(enabled, commandGrant.tokens.access_token, commandSession, 23, 'remotehub.commands.run', {
    hostId: enabled.host.id, executable: 'whoami', args: ['--version'],
  });
  assert.equal(allowed.body.result.isError, false);
  assert.equal(enabled.agentRequests.length, 1);
  assert.equal(enabled.agentRequests[0].op, 'exec.run');
  assert.deepEqual(enabled.agentRequests[0].params, { executable: 'whoami', args: ['--version'], timeoutMs: 10_000 });
});

test('grant revocation cancels correlated host requests without affecting another grant', async (t) => {
  const ctx = await startMcpEnvironment({ mcpCommandsEnabled: true }, {
    handleAgentRequest(message) {
      return ['exec.run', 'fs.write', 'exec.cancel'].includes(message.op);
    },
  });
  t.after(() => ctx.env.stop());

  const revokedClient = await registerClient(ctx, { clientName: 'Revoked queued write client' });
  const revokedGrant = await authorize(ctx, revokedClient, ['hosts:read', 'files:write', 'commands:exec']);
  const revokedSession = await initializeMcp(ctx, revokedGrant.tokens.access_token);
  const unaffectedClient = await registerClient(ctx, { clientName: 'Unaffected queued write client' });
  const unaffectedGrant = await authorize(ctx, unaffectedClient, ['hosts:read', 'files:write']);
  const unaffectedSession = await initializeMcp(ctx, unaffectedGrant.tokens.access_token);

  const blockerCall = callTool(ctx, revokedGrant.tokens.access_token, revokedSession, 60, 'remotehub.commands.run', {
    hostId: ctx.host.id, executable: 'whoami',
  });
  blockerCall.catch(() => {});
  await ctx.agent.untilControl((message) => message.op === 'exec.run', 'the blocker command reaches the host agent');
  const blockerRequest = ctx.agentRequests.find((message) => message.op === 'exec.run');

  const revokedWriteCall = callTool(ctx, revokedGrant.tokens.access_token, revokedSession, 61, 'remotehub.files.write', {
    hostId: ctx.host.id, path: 'revoked.txt', content: 'must not be written after revocation',
  });
  revokedWriteCall.catch(() => {});
  await ctx.agent.until(() => ctx.agentRequests.some((message) => message.op === 'fs.write' && message.params.path === 'revoked.txt'),
    'the write request reaches the host agent');
  const revokedWriteRequest = ctx.agentRequests.find((message) => message.op === 'fs.write' && message.params.path === 'revoked.txt');

  const unaffectedWriteCall = callTool(ctx, unaffectedGrant.tokens.access_token, unaffectedSession, 62, 'remotehub.files.write', {
    hostId: ctx.host.id, path: 'unaffected.txt', content: 'normal completion',
  });
  await ctx.agent.until(() => ctx.agentRequests.some((message) => message.op === 'fs.write' && message.params.path === 'unaffected.txt'),
    'the unrelated grant request reaches the same host agent');
  const unaffectedWriteRequest = ctx.agentRequests.find((message) => message.op === 'fs.write' && message.params.path === 'unaffected.txt');

  const persisted = JSON.parse(await fs.readFile(ctx.env.dataDir + '/mcp-oauth.json', 'utf8'));
  const grantId = Object.entries(persisted.grants).find(([, grant]) => grant.clientId === revokedClient.clientId)?.[0];
  assert.ok(grantId, 'the owner revocation form identifies the grant under test');
  const revoked = await fetch(ctx.env.base + '/oauth/manage/revoke-grant', {
    method: 'POST',
    headers: {
      Origin: ctx.env.origin,
      Cookie: ctx.owner.cookie,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ grantId }),
    redirect: 'manual',
  });
  assert.equal(revoked.status, 303);

  await ctx.agent.until(() => ctx.agentRequests.filter((message) => message.op === 'exec.cancel').length === 2,
    'the host agent receives correlated cancellation frames for the revoked grant');
  const cancelledIds = ctx.agentRequests.filter((message) => message.op === 'exec.cancel').map((message) => message.params.requestId).sort();
  assert.deepEqual(cancelledIds, [blockerRequest.id, revokedWriteRequest.id].sort());
  assert.ok(!cancelledIds.includes(unaffectedWriteRequest.id), 'revocation does not cancel another grant’s host request');

  ctx.agent.ws.send(JSON.stringify({ id: unaffectedWriteRequest.id, ok: true, result: { written: true } }));
  const [blockerResult, revokedWriteResult, unaffectedWriteResult] = await Promise.all([blockerCall, revokedWriteCall, unaffectedWriteCall]);
  assert.equal(blockerResult.response.status, 202);
  assert.equal(revokedWriteResult.response.status, 202);
  assert.equal(unaffectedWriteResult.response.status, 200);
  assert.equal(unaffectedWriteResult.body.result.isError, false, 'the unrelated request retains normal completion');
});

test('MCP notifications/cancelled stop the matching host command and suppress its response', async (t) => {
  const ctx = await startMcpEnvironment({ mcpCommandsEnabled: true }, {
    handleAgentRequest(message) {
      return message.op === 'exec.run' || message.op === 'exec.cancel';
    },
  });
  t.after(() => ctx.env.stop());
  const client = await registerClient(ctx);
  const granted = await authorize(ctx, client, ['hosts:read', 'commands:exec']);
  assert.equal(granted.response.status, 200);
  const sessionId = await initializeMcp(ctx, granted.tokens.access_token);

  const running = callTool(ctx, granted.tokens.access_token, sessionId, 42, 'remotehub.commands.run', {
    hostId: ctx.host.id, executable: 'whoami',
  });
  running.catch(() => {});
  await ctx.agent.untilControl((message) => message.op === 'exec.run', 'command reaches the host agent');
  const commandRequest = ctx.agentRequests.find((message) => message.op === 'exec.run');

  const cancelled = await mcpPost(ctx, granted.tokens.access_token, {
    jsonrpc: '2.0',
    method: 'notifications/cancelled',
    params: { requestId: 42, reason: 'user stopped the command' },
  }, sessionId);
  assert.equal(cancelled.response.status, 202);

  await ctx.agent.until(() => ctx.agentRequests.some((message) => message.op === 'exec.cancel'),
    'the host agent receives the cancellation frame');
  const cancelRequest = ctx.agentRequests.find((message) => message.op === 'exec.cancel');
  assert.ok(cancelRequest, 'the server forwards cancellation to the connected agent');
  assert.equal(cancelRequest.params.requestId, commandRequest.id, 'cancellation is correlated to the agent request ID');

  const stopped = await running;
  assert.equal(stopped.response.status, 202, 'a cancelled MCP request sends no JSON-RPC result');
  assert.equal(stopped.body, null);
});

test('concurrent refresh issuance cannot pass the final token-capacity slot twice', async (t) => {
  const fixture = await createOAuthServerFixture(t);
  const { state, base, resource } = fixture;
  const clientId = 'concurrent-capacity-client';
  const now = Date.now();
  const refreshExpiresAt = now + 24 * 60 * 60_000;
  const refreshTokenHash = (token) => createHash('sha256').update(token).digest('hex');
  state.data.clients[clientId] = {
    client_id: clientId,
    expiresAt: now + 60_000,
    grant_types: ['authorization_code', 'refresh_token'],
  };
  const liveRefreshTokens = ['concurrent-refresh-a', 'concurrent-refresh-b'];
  for (let index = 0; index < liveRefreshTokens.length; index += 1) {
    const grantId = 'concurrent-capacity-grant-' + index;
    state.data.grants[grantId] = {
      grantId,
      clientId,
      ownerId: 'owner',
      hostIds: ['host-one'],
      scopes: ['hosts:read', 'offline_access'],
      refreshExpiresAt,
    };
    state.data.tokens[refreshTokenHash(liveRefreshTokens[index])] = {
      grantId, kind: 'refresh', ownerId: 'owner', clientId, audience: resource,
      hostIds: ['host-one'], scopes: ['hosts:read', 'offline_access'], expiresAt: refreshExpiresAt,
    };
  }
  for (let index = 0; index < 997; index += 1) {
    const hash = refreshTokenHash('concurrent-live-filler-' + index);
    state.data.tokens[hash] = {
      kind: 'access', ownerId: 'owner', clientId, audience: resource, expiresAt: refreshExpiresAt,
    };
  }
  assert.equal(Object.keys(state.data.tokens).length, 999);

  const attempts = await Promise.all(liveRefreshTokens.map(async (refreshToken) => {
    const response = await fetch(base + '/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: clientId,
        refresh_token: refreshToken,
        resource,
      }),
    });
    return { refreshToken, response, body: await response.json() };
  }));

  assert.equal(attempts.filter(({ response }) => response.status === 200).length, 1);
  assert.equal(attempts.filter(({ response }) => response.status === 503).length, 1);
  assert.equal(Object.keys(state.data.tokens).length, 1000);
  const rejected = attempts.find(({ response }) => response.status === 503);
  assert.equal(rejected.body.error, 'temporarily_unavailable');
  assert.equal(state.data.tokens[refreshTokenHash(rejected.refreshToken)]?.kind, 'refresh',
    'the rejected concurrent request keeps its live refresh grant');
});
