import fs from 'node:fs';
import http from 'node:http';

const base = process.env.BASE || 'http://127.0.0.1:8090';
const origin = process.env.PROXY_TEST_ORIGIN || 'https://remotehub.example.test';
const setupCodeFile = process.env.DATA_DIR || 'data';
const setupCodePath = `${setupCodeFile}/SETUP-CODE.txt`;
const setupCode = fs.existsSync(setupCodePath) ? fs.readFileSync(setupCodePath, 'utf8').trim() : '';
const password = process.env.OWNER_PASSWORD;
if (!password) throw new Error('OWNER_PASSWORD is required for the disposable Compose proxy-cookie check.');

const forwardedHeaders = {
  'content-type': 'application/json',
  host: new URL(origin).host,
  origin,
  'x-forwarded-host': new URL(origin).host,
  'x-forwarded-proto': 'https',
};

// Use a raw HTTP request so `Host` stays the public proxy hostname while connecting to
// the loopback-published test port (fetch may normalize Host to the URL hostname).
function request(path, { method = 'GET', headers = {}, body } = {}) {
  const target = new URL(base);
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: target.hostname,
      port: target.port,
      path,
      method,
      headers,
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({
          status: res.statusCode,
          headers: {
            get: (name) => res.headers[name.toLowerCase()],
            getSetCookie: () => res.headers['set-cookie'] ?? [],
          },
          text: async () => text,
        });
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}

const state = await request('/api/auth/state');
if (state.status !== 200) throw new Error(`Compose auth-state check returned HTTP ${state.status}.`);
const { setupRequired } = JSON.parse(await state.text());

const goodPath = setupRequired ? '/api/auth/setup' : '/api/auth/login';
const goodBody = setupRequired ? { setupCode, password } : { password };
const forged = await request(goodPath, {
  method: 'POST',
  headers: { ...forwardedHeaders, origin: 'https://attacker.example.test', 'x-forwarded-host': 'attacker.example.test' },
  body: JSON.stringify(goodBody),
});
if (forged.status !== 403) throw new Error(`Forged X-Forwarded-Host origin was not rejected (HTTP ${forged.status}).`);

const response = await request(goodPath, {
  method: 'POST',
  headers: forwardedHeaders,
  body: JSON.stringify(goodBody),
});
if (response.status !== 200) {
  const detail = await response.text();
  throw new Error(`Compose proxy ${setupRequired ? 'setup' : 'login'} returned HTTP ${response.status}: ${detail}`);
}

const cookies = response.headers.getSetCookie?.() ?? [response.headers.get('set-cookie') ?? ''];
const sessionCookie = cookies.find((cookie) => cookie.startsWith('rh_session='));
if (!sessionCookie || !/;\s*secure(?:;|$)/i.test(sessionCookie)) {
  throw new Error('Secure session cookie was missing for the Compose proxy-style request.');
}
for (let i = 0; i < 5; i++) {
  const failedLogin = await request('/api/auth/login', {
    method: 'POST',
    headers: { ...forwardedHeaders, 'x-forwarded-for': `198.51.100.${i + 1}` },
    body: JSON.stringify({ password: 'not-the-owner-password' }),
  });
  if (failedLogin.status !== 401) throw new Error(`Expected invalid password attempt ${i + 1} to return HTTP 401, got ${failedLogin.status}.`);
}
const lockedLogin = await request('/api/auth/login', {
  method: 'POST',
  headers: { ...forwardedHeaders, 'x-forwarded-for': '203.0.113.77' },
  body: JSON.stringify({ password: 'not-the-owner-password' }),
});
if (lockedLogin.status !== 429) throw new Error(`Rotating X-Forwarded-For bypassed login lockout (HTTP ${lockedLogin.status}).`);

console.log('PASS published-port proxy-header checks: forged X-Forwarded-Host rejected, session cookie Secure, and rotating X-Forwarded-For cannot evade login lockout.');
