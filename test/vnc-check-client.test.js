import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VNC_CHECK_MAX_WAIT_MS, fetchVncExplanation } from '../public/js/vnc-check.js';

/** SAA-346: a quick retry must not lose the VNC explanation to the pre-check's 429. */
const reply = (status, body = {}, headers = {}) => ({ status, ok: status >= 200 && status < 300, headers: new Headers(headers), json: async () => body });
const explanation = { reason: 'vnc-auth', message: 'The VNC server rejected the password.' };

test('SAA-346 vnc-check client: a 429 waits for Retry-After and asks once more', async () => {
  const calls = []; const waits = [];
  const replies = [reply(429, { error: 'slow down' }, { 'Retry-After': '3' }), reply(200, { explanation })];
  const got = await fetchVncExplanation({ id: 'h1' }, { passwordGiven: true, fetchImpl: async (url) => { calls.push(url); return replies.shift(); }, wait: async (ms) => { waits.push(ms); } });
  assert.deepEqual(got, explanation);
  assert.deepEqual(calls, ['/api/hosts/h1/desktop/vnc-check?password=1', '/api/hosts/h1/desktop/vnc-check?password=1']);
  assert.deepEqual(waits, [3000]);
});

test('SAA-346 vnc-check client: the wait is capped, and a second 429 or an error gives null (no third call)', async () => {
  let n = 0; const waits = [];
  const got = await fetchVncExplanation({ id: 'h1' }, { fetchImpl: async () => { n += 1; return reply(429, {}, { 'Retry-After': '600' }); }, wait: async (ms) => { waits.push(ms); } });
  assert.equal(got, null); assert.equal(n, 2); assert.deepEqual(waits, [VNC_CHECK_MAX_WAIT_MS]);
  const missing = []; await fetchVncExplanation({ id: 'h1' }, { fetchImpl: async () => reply(429), wait: async (ms) => { missing.push(ms); } });
  assert.deepEqual(missing, [5000], 'no Retry-After header: 5 s');
  assert.equal(await fetchVncExplanation({ id: 'h1' }, { fetchImpl: async () => reply(500), wait: async () => assert.fail('no wait on 500') }), null);
});
