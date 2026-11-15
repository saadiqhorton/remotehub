import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { httpClient, openTerminal, sleep, startTestApp } from './helpers/app-harness.js';

/**
 * Session expiry regression tests (SAA-284), run against a server with a tiny session TTL.
 *
 * Captures: an expired session loses API and WebSocket access immediately (sliding expiry
 * keeps active users logged in), and expired sessions are swept even without traffic.
 */

const OWNER_PASSWORD = 'owner-password-123';
const TTL_MS = 250;

let env;
let client;

before(async () => {
  env = await startTestApp({ sessionTtlMs: TTL_MS });
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

test('an expired session loses API and terminal access', async () => {
  assert.equal((await client.request('/api/hosts')).status, 200);

  await sleep(TTL_MS * 2);

  assert.equal((await client.request('/api/hosts')).status, 401);
  const state = await client.request('/api/auth/state');
  assert.deepEqual(state.body, { setupRequired: false, authenticated: false });

  const t = openTerminal(env.base, { headers: { Cookie: client.cookie, Origin: env.origin } });
  await assert.rejects(t.opened, (err) => err.status === 401);
});

test('sliding expiry keeps active sessions alive', async () => {
  const login = await client.request('/api/auth/login', { method: 'POST', body: { password: OWNER_PASSWORD } });
  assert.equal(login.status, 200);

  // Stay active for well beyond the TTL: each request must extend the session.
  for (let i = 0; i < 6; i += 1) {
    await sleep(TTL_MS / 3);
    assert.equal((await client.request('/api/auth/state')).body.authenticated, true, `request ${i}`);
  }

  await sleep(TTL_MS * 2);
  assert.equal((await client.request('/api/hosts')).status, 401, 'idle sessions must still expire');
});

test('the periodic sweep revokes expired sessions', async () => {
  const login = await client.request('/api/auth/login', { method: 'POST', body: { password: OWNER_PASSWORD } });
  assert.equal(login.status, 200);
  const token = client.sessionToken();
  assert.ok(env.app.sessions.sessions.has(token));

  await sleep(TTL_MS * 2);
  env.app.sessions.sweep();
  assert.ok(!env.app.sessions.sessions.has(token), 'sweep must remove expired sessions');
});
