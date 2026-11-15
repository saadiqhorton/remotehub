import { randomBytes, randomInt, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb);

export const SESSION_COOKIE = 'rh_session';

const SCRYPT = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const KEY_LENGTH = 64;

export async function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, KEY_LENGTH, SCRYPT);
  return {
    algorithm: 'scrypt',
    params: { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p },
    salt: salt.toString('base64'),
    hash: hash.toString('base64'),
  };
}

export async function verifyPassword(password, record) {
  if (!record || record.algorithm !== 'scrypt' || typeof password !== 'string') return false;
  const expected = Buffer.from(record.hash, 'base64');
  const actual = await scrypt(password, Buffer.from(record.salt, 'base64'), expected.length, {
    ...record.params,
    maxmem: SCRYPT.maxmem,
  });
  return timingSafeEqual(actual, expected);
}

export function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && timingSafeEqual(left, right);
}

export function generateSetupCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const pick = () => Array.from({ length: 4 }, () => alphabet[randomInt(alphabet.length)]).join('');
  return `${pick()}-${pick()}`;
}

export function parseCookies(header) {
  const cookies = {};
  for (const part of (header || '').split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    const name = part.slice(0, index).trim();
    if (!name || name in cookies) continue;
    try {
      cookies[name] = decodeURIComponent(part.slice(index + 1).trim());
    } catch {
      // Ignore malformed cookie values.
    }
  }
  return cookies;
}

export class Sessions {
  constructor(ttlMs) {
    this.ttlMs = ttlMs;
    this.sessions = new Map();
    this.onRevoke = () => {};
    setInterval(() => this.sweep(), 60_000).unref();
  }

  create() {
    const token = randomBytes(32).toString('base64url');
    this.sessions.set(token, { expiresAt: Date.now() + this.ttlMs });
    return token;
  }

  // Sliding expiry: every authenticated request extends the session.
  touch(token) {
    if (typeof token !== 'string') return false;
    const session = this.sessions.get(token);
    if (!session) return false;
    if (session.expiresAt <= Date.now()) {
      this.revoke(token);
      return false;
    }
    session.expiresAt = Date.now() + this.ttlMs;
    return true;
  }

  revoke(token) {
    if (this.sessions.delete(token)) this.onRevoke(token);
  }

  revokeAll() {
    for (const token of [...this.sessions.keys()]) this.revoke(token);
  }

  sweep() {
    const now = Date.now();
    for (const [token, session] of this.sessions) {
      if (session.expiresAt <= now) this.revoke(token);
    }
  }
}

// Per-client lockout: 5 failures within 15 minutes locks that client out for 5 minutes.
export class LoginLimiter {
  constructor({ maxFailures = 5, windowMs = 15 * 60_000, lockMs = 5 * 60_000 } = {}) {
    Object.assign(this, { maxFailures, windowMs, lockMs });
    this.clients = new Map();
    setInterval(() => this.sweep(), 60_000).unref();
  }

  retryAfterMs(key) {
    const entry = this.clients.get(key);
    if (!entry || !entry.lockedUntil) return 0;
    return Math.max(0, entry.lockedUntil - Date.now());
  }

  fail(key) {
    const now = Date.now();
    let entry = this.clients.get(key);
    if (!entry || now - entry.firstAt > this.windowMs) entry = { firstAt: now, failures: 0, lockedUntil: 0 };
    entry.failures += 1;
    if (entry.failures >= this.maxFailures) {
      entry.lockedUntil = now + this.lockMs;
      entry.failures = 0;
      entry.firstAt = now;
    }
    this.clients.set(key, entry);
  }

  succeed(key) {
    this.clients.delete(key);
  }

  sweep() {
    const now = Date.now();
    for (const [key, entry] of this.clients) {
      if (entry.lockedUntil < now && now - entry.firstAt > this.windowMs) this.clients.delete(key);
    }
  }
}
