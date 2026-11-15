import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export const AGENT_TOKEN_PREFIX = 'rhag_1_';
export const AGENT_CLOSE = {
  UNAUTHORIZED: 4001,
  REPLACED: 4002,
  REVOKED: 4003,
  UNKNOWN_HOST: 4004,
  PROTOCOL: 4008,
};

const TOKEN_PATTERN = /rhag_1_[A-Za-z0-9_-]+/g;

export function generateAgentToken() {
  return `${AGENT_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
}

export function hashAgentToken(token) {
  return createHash('sha256').update(String(token), 'utf8').digest('hex');
}

export function verifyAgentToken(token, tokenHash) {
  if (typeof token !== 'string' || typeof tokenHash !== 'string' || !token || !tokenHash) return false;
  const actual = Buffer.from(hashAgentToken(token), 'hex');
  const expected = Buffer.from(tokenHash, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function redactSecrets(value) {
  return String(value ?? '').replace(TOKEN_PATTERN, `${AGENT_TOKEN_PREFIX}[redacted]`);
}

export function publicAgentStatus(host, connected = false) {
  const credential = host?.agentCredential;
  const registered = Boolean(credential?.tokenHash && !credential.revokedAt);
  return {
    registered,
    connected: registered && connected === true,
  };
}
