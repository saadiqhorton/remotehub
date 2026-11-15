import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createServer } from 'node:http';
import express from 'express';
import { createMcpOAuthRouter } from '../server/mcp-oauth.js';

async function createConsentHarness(t, { now = () => Date.now(), maxAuthBuckets, verifyPassword = async () => false } = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'remotehub-oauth-throttle-'));
  const oauth = await createMcpOAuthRouter({
    express,
    config: { dataDir, host: '127.0.0.1', port: 8090, mcpCommandsEnabled: false },
    store: { owner: null, listHosts: () => [] },
    sessions: { touch: () => false },
    tokenOf: () => null,
    originAllowed: () => true,
    verifyPassword,
    authLimiterOptions: { now, maxBuckets: maxAuthBuckets },
  });
  const app = express();
  app.set('trust proxy', 'loopback');
  app.use(oauth.router);
  const server = createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  t.after(async () => {
    const force = setTimeout(() => server.closeAllConnections(), 2000);
    force.unref();
    await new Promise((resolve) => server.close(resolve));
    clearTimeout(force);
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  return { base };
}

async function createConsentRequest(base) {
  const metadataResponse = await fetch(base + '/.well-known/oauth-authorization-server');
  assert.equal(metadataResponse.status, 200);
  const metadata = await metadataResponse.json();
  const redirectUri = 'http://127.0.0.1/callback';
  const registeredResponse = await fetch(base + '/oauth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: 'OAuth throttle regression',
      redirect_uris: [redirectUri],
      grant_types: ['authorization_code'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    }),
  });
  assert.equal(registeredResponse.status, 201);
  const client = await registeredResponse.json();
  const query = new URLSearchParams({
    response_type: 'code',
    client_id: client.client_id,
    redirect_uri: redirectUri,
    code_challenge: 'A'.repeat(43),
    code_challenge_method: 'S256',
    state: 'throttle-test',
    resource: metadata.issuer + '/mcp',
    scope: 'hosts:read',
  });
  const response = await fetch(base + '/oauth/authorize?' + query);
  assert.equal(response.status, 200);
  const html = await response.text();
  const requestId = /name="requestId" value="([A-Za-z0-9_-]+)"/.exec(html)?.[1];
  assert.ok(requestId);
  return requestId;
}

function submitPassword(base, requestId, ip, password = 'wrong-password') {
  return fetch(base + '/oauth/authorize', {
    method: 'POST',
    headers: {
      Origin: base,
      'X-Forwarded-For': ip,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ requestId, consent: 'allow', password }),
    redirect: 'manual',
  });
}

async function exhaustAggregateLimit(base, requestId, firstIpOctet) {
  for (let i = 1; i <= 5; i += 1) {
    const response = await submitPassword(base, requestId, `198.51.${firstIpOctet}.${i}`);
    assert.equal(response.status, 401, `failed attempt ${i} from a distinct IP`);
  }
}

test('OAuth password fallback caps failed attempts across rotating IPs and returns a 60-second Retry-After', async (t) => {
  const harness = await createConsentHarness(t);
  const requestId = await createConsentRequest(harness.base);
  await exhaustAggregateLimit(harness.base, requestId, 101);

  const limited = await submitPassword(harness.base, requestId, '198.51.102.10');
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get('retry-after'), '60');
});

test('OAuth password fallback cooldown expires after 60 seconds', async (t) => {
  let now = Date.now();
  const harness = await createConsentHarness(t, { now: () => now });
  const requestId = await createConsentRequest(harness.base);
  await exhaustAggregateLimit(harness.base, requestId, 111);

  const limitedIp = '198.51.112.10';
  const blocked = await submitPassword(harness.base, requestId, limitedIp);
  assert.equal(blocked.status, 429);
  assert.equal(blocked.headers.get('retry-after'), '60');

  now += 59_000;
  const almostExpired = await submitPassword(harness.base, requestId, limitedIp);
  assert.equal(almostExpired.status, 429);
  assert.equal(almostExpired.headers.get('retry-after'), '1');

  now += 1_000;
  const afterCooldown = await submitPassword(harness.base, requestId, limitedIp);
  assert.equal(afterCooldown.status, 401, 'a new attempt is allowed when the deterministic cooldown expires');
});

test('OAuth password limiter evicts its oldest IP bucket at capacity', async (t) => {
  let now = Date.now();
  const harness = await createConsentHarness(t, { now: () => now, maxAuthBuckets: 2 });
  const requestId = await createConsentRequest(harness.base);
  const oldestIp = '198.51.121.1';

  for (let i = 0; i < 5; i += 1) {
    const response = await submitPassword(harness.base, requestId, oldestIp);
    assert.equal(response.status, 401);
  }
  now += 60_000;

  const secondIp = await submitPassword(harness.base, requestId, '198.51.121.2');
  assert.equal(secondIp.status, 401);
  const thirdIp = await submitPassword(harness.base, requestId, '198.51.121.3');
  assert.equal(thirdIp.status, 401);

  const retriedOldestIp = await submitPassword(harness.base, requestId, oldestIp);
  assert.equal(retriedOldestIp.status, 401, 'the locked oldest bucket was evicted to admit the new IP');
});

test('parallel OAuth password checks cannot exceed the aggregate attempt cap', async (t) => {
  const verificationResolvers = [];
  let verificationCount = 0;
  const harness = await createConsentHarness(t, {
    verifyPassword: async () => {
      verificationCount += 1;
      recordDecision();
      return new Promise((resolve) => verificationResolvers.push(resolve));
    },
  });
  const requestId = await createConsentRequest(harness.base);
  let resolveDecisions;
  const allDecisions = new Promise((resolve) => { resolveDecisions = resolve; });
  let decisionCount = 0;
  const recordDecision = () => {
    decisionCount += 1;
    if (decisionCount === 6) resolveDecisions();
  };
  const requests = Array.from({ length: 6 }, async (_, index) => {
    const response = await submitPassword(harness.base, requestId, `203.0.113.${index + 1}`);
    if (response.status === 429) recordDecision();
    return response;
  });
  const allResponses = Promise.all(requests);

  const timeout = setTimeout(resolveDecisions, 2000);
  timeout.unref();
  await allDecisions;
  clearTimeout(timeout);
  const attemptsBeforeRelease = verificationCount;
  for (const resolve of verificationResolvers) resolve(false);
  const responses = await allResponses;

  assert.equal(decisionCount, 6, 'every request reached the limiter or the password verifier');
  assert.equal(attemptsBeforeRelease, 5, 'only five password verifications may be in flight across all IPs');
  assert.deepEqual(responses.map((response) => response.status).sort(), [401, 401, 401, 401, 401, 429]);
});
