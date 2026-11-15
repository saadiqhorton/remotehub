import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { startTestApp, httpClient } from './helpers/app-harness.js';

// SAA-346: every state-changing API route refuses a foreign Origin with 403, signed in or not.
const ROUTES = [
  ['POST', '/api/auth/setup'], ['POST', '/api/auth/login'], ['POST', '/api/auth/logout'],
  ['POST', '/api/hosts/:id/desktop/discover'], ['POST', '/api/hosts'], ['PUT', '/api/hosts/:id'],
  ['DELETE', '/api/hosts/:id'], ['POST', '/api/hosts/:id/agent'], ['DELETE', '/api/hosts/:id/agent'], ['POST', '/api/hosts/:id/agent/install'],
  ['PUT', '/api/hosts/:id/desktop'], ['DELETE', '/api/hosts/:id/desktop'], ['DELETE', '/api/hosts/:id/desktop/cert-pin'],
  ['DELETE', '/api/hosts/:id/fingerprint'],
];

test('table: a foreign Origin gets 403 on every POST/PUT/DELETE route, and the owner session survives', async () => {
  const t = await startTestApp();
  try {
    const owner = httpClient(t.base, t.origin);
    const code = (await fs.readFile(`${t.dataDir}/SETUP-CODE.txt`, 'utf8')).trim();
    await owner.request('/api/auth/setup', { method: 'POST', body: { setupCode: code, password: 'owner-password-1' } });
    const host = (await owner.request('/api/hosts', { method: 'POST', body: { name: 'box', address: '192.0.2.10', port: 22, username: 'me' } })).body.host;
    const results = [];
    for (const [method, route] of ROUTES) {
      const r = await owner.request(route.replace(':id', host.id), { method, body: {}, headers: { Origin: 'http://evil.example' } });
      results.push(`${method} ${route} ${r.status}`);
    }
    assert.deepEqual(results, ROUTES.map(([m, r]) => `${m} ${r} 403`));
    const still = await owner.request('/api/hosts');
    assert.equal(still.status, 200, 'foreign logout did not end the owner session');
    assert.equal(still.body.hosts.length, 1, 'foreign DELETE did not remove the host');
  } finally { await t.stop(); }
});

test('the route table covers every state-changing route in server/app.js', async () => {
  const src = await fs.readFile(new URL('../server/app.js', import.meta.url), 'utf8');
  const found = [...src.matchAll(/\bapi\.(post|put|delete|patch)\('([^']+)'/g)].map(([, m, p]) => `${m.toUpperCase()} /api${p}`).sort();
  assert.deepEqual(found, ROUTES.map(([m, r]) => `${m} ${r}`).sort());
  assert.ok(!/\bapp\.(post|put|delete|patch)\(/.test(src), 'no state-changing route outside the Origin-checked api router');
});
