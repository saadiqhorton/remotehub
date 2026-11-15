import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fingerprintOf, keyTypeOf } from '../server/ssh-bridge.js';
import { ValidationError, validateAddress, validateHost, validatePort } from '../server/validate.js';
import { LoginLimiter, Sessions, hashPassword, parseCookies, verifyPassword } from '../server/auth.js';
import { Store, endpointKey } from '../server/store.js';
import { originAllowed, trustedHostname } from '../server/app.js';

test('fingerprint matches OpenSSH SHA256 format', () => {
  const blob = Buffer.concat([Buffer.from([0, 0, 0, 11]), Buffer.from('ssh-ed25519'), Buffer.alloc(36, 1)]);
  assert.match(fingerprintOf(blob), /^SHA256:[A-Za-z0-9+/]{43}$/);
  assert.equal(keyTypeOf(blob), 'ssh-ed25519');
  assert.equal(keyTypeOf(Buffer.from([0, 0])), 'unknown');
});

test('addresses', () => {
  for (const ok of ['192.168.1.20', 'nas.local', 'pi', 'fe80::1', '[fd00::2]', 'server-01.lan']) {
    assert.doesNotThrow(() => validateAddress(ok), ok);
  }
  for (const bad of ['', 'has space', '-lead', 'a;rm -rf', 'http://x', 'host_name']) {
    assert.throws(() => validateAddress(bad), ValidationError, bad);
  }
  assert.equal(validateAddress('[fd00::2]'), 'fd00::2');
});

test('ports and hosts', () => {
  assert.equal(validatePort(''), 22);
  assert.equal(validatePort('2222'), 2222);
  assert.throws(() => validatePort('70000'), ValidationError);
  assert.throws(() => validateHost({ name: 'x', address: '10.0.0.1', username: 'bad user' }), ValidationError);
  assert.deepEqual(validateHost({ name: ' NAS ', address: '10.0.0.5', username: 'admin' }), {
    name: 'NAS',
    address: '10.0.0.5',
    port: 22,
    username: 'admin',
  });
});

test('password hashing round-trips', async () => {
  const record = await hashPassword('a long enough password');
  assert.equal(await verifyPassword('a long enough password', record), true);
  assert.equal(await verifyPassword('wrong', record), false);
});

test('cookie parsing', () => {
  assert.deepEqual(parseCookies('a=1; rh_session=abc%3D; b'), { a: '1', rh_session: 'abc=' });
});

test('origin checks', () => {
  assert.equal(originAllowed('http://hub.lan', { host: 'hub.lan' }, []), true);
  const forwarded = { host: '127.0.0.1:8080', 'x-forwarded-host': 'hub.example' };
  assert.equal(originAllowed('https://hub.example', forwarded, []), false, 'raw X-Forwarded-Host is not trusted');
  assert.equal(originAllowed('https://hub.example', forwarded, [], 'hub.example'), true, 'the trusted effective hostname may match');
  assert.equal(originAllowed('https://evil.example', { host: 'hub.lan' }, []), false);
  assert.equal(originAllowed(undefined, { host: 'hub.lan' }, []), false);
  assert.equal(originAllowed('https://other.lan', { host: 'hub.lan' }, ['https://other.lan']), true);
});

test('only a trusted immediate proxy supplies the effective hostname', () => {
  const req = {
    headers: { host: 'remotehub.example.test', 'x-forwarded-host': 'attacker.example' },
    socket: { remoteAddress: '172.31.240.1' },
  };
  assert.equal(trustedHostname(req, () => false), 'remotehub.example.test');
  assert.equal(trustedHostname(req, (address, hop) => address === '172.31.240.1' && hop === 0), 'attacker.example');
});

test('login limiter locks after repeated failures', () => {
  const limiter = new LoginLimiter({ maxFailures: 3, windowMs: 60_000, lockMs: 60_000 });
  limiter.fail('ip');
  limiter.fail('ip');
  assert.equal(limiter.retryAfterMs('ip'), 0);
  limiter.fail('ip');
  assert.ok(limiter.retryAfterMs('ip') > 0);
  limiter.succeed('ip');
  assert.equal(limiter.retryAfterMs('ip'), 0);
});

test('sessions create, slide, revoke, and expire', (t) => {
  let now = 1000;
  t.mock.method(Date, 'now', () => now);
  const sessions = new Sessions(25);
  const revoked = [];
  sessions.onRevoke = (token) => revoked.push(token);

  assert.equal(sessions.touch('nonsense'), false);
  assert.equal(sessions.touch(undefined), false);

  const token = sessions.create();
  assert.equal(sessions.touch(token), true);
  const first = sessions.sessions.get(token).expiresAt;
  now += 5;
  assert.equal(sessions.touch(token), true);
  assert.ok(sessions.sessions.get(token).expiresAt > first, 'touch must slide the expiry forward');

  sessions.revoke(token);
  assert.deepEqual(revoked, [token], 'revoke must notify listeners exactly once');
  assert.equal(sessions.touch(token), false);
  sessions.revoke(token);
  assert.deepEqual(revoked, [token], 'revoking an unknown token must not notify');

  const expired = sessions.create();
  now += 30;
  assert.equal(sessions.touch(expired), false, 'expired tokens must be rejected');
  assert.deepEqual(revoked, [token, expired], 'touching an expired token must revoke it');

  const a = sessions.create();
  const b = sessions.create();
  sessions.revokeAll();
  assert.deepEqual(revoked.slice(2).sort(), [a, b].sort(), 'revokeAll must revoke every session');
});

test('sessions sweep only removes expired sessions', async () => {
  const sessions = new Sessions(20);
  const fresh = sessions.create();
  const stale = sessions.create();
  sessions.sessions.get(stale).expiresAt = Date.now() - 1;
  sessions.sweep();
  assert.equal(sessions.touch(fresh), true);
  assert.ok(!sessions.sessions.has(stale));
});

test('store persists hosts and known fingerprints across restarts', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'remotehub-store-'));
  try {
    const first = await new Store(dataDir).load();
    const host = await first.addHost({ name: 'NAS', address: 'NAS.local', port: 2222, username: 'admin' });
    await first.setKnownHost('NAS.local ', 2222, { keyType: 'ssh-ed25519', fingerprint: 'SHA256:abc' });

    // Endpoint keys are case-insensitive and trimmed.
    assert.equal(endpointKey(' NAS.Local', 2222), 'nas.local:2222');
    assert.equal(first.getKnownHost('nas.local', 2222).fingerprint, 'SHA256:abc');

    const second = await new Store(dataDir).load();
    assert.ok(second.getHost(host.id), 'hosts must survive a reload');
    assert.equal(second.getKnownHost('nas.local', 2222).fingerprint, 'SHA256:abc');
    assert.equal(second.listHosts()[0].knownHost.fingerprint, 'SHA256:abc');

    assert.equal(await second.removeHost('no-such-id'), false);
    assert.equal(await second.removeHost(host.id), true);
    assert.equal(await second.forgetKnownHost('nas.local', 2222), true);
    assert.equal(await second.forgetKnownHost('nas.local', 2222), false, 'forgetting twice reports false');
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});
