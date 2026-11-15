import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createOAuthAuthLimiter } from './mcp-auth-limiter.js';

const SCOPES = ['hosts:read', 'files:read', 'files:write', 'commands:exec', 'offline_access'];
export const BASIC_SCOPES = Object.freeze(['hosts:read', 'files:read']);
const CODE_TTL_MS = 5 * 60_000;
// How long an answered consent form replays its redirect instead of saying "expired".
// Matches the code lifetime, so a resubmit always yields a usable code.
const CONSENT_REPLAY_MS = 5 * 60_000;
const TOKEN_TTL_MS = 15 * 60_000;
const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60_000;
const MAX_CLIENTS = 500;
const CLIENT_TTL_MS = 90 * 24 * 60 * 60_000;
const MAX_AUTH_CODES = 1000;
const MAX_TOKENS = 1000;
const tokenPairSize = (grant, client) => 1 + (grant?.scopes?.includes('offline_access') && client?.grant_types?.includes('refresh_token') ? 1 : 0);
const MAX_SPENT_REFRESH_TOKENS = 10_000;

const randomToken = (bytes = 32) => randomBytes(bytes).toString('base64url');
const digest = (value) => createHash('sha256').update(value).digest('hex');
const safeEqualHex = (left, right) => {
  if (!/^[a-f0-9]{64}$/i.test(left || '') || !/^[a-f0-9]{64}$/i.test(right || '')) return false;
  return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
};
const sameScopeSet = (left, right) => Array.isArray(left) && Array.isArray(right)
  && new Set(left).size === left.length
  && new Set(right).size === right.length
  && left.length === right.length
  && left.every((scope) => right.includes(scope));
const scopeSubset = (scopes, grantedScopes) => Array.isArray(scopes) && Array.isArray(grantedScopes)
  && scopes.length > 0
  && scopes.every((scope) => typeof scope === 'string' && SCOPES.includes(scope) && grantedScopes.includes(scope));
const parseRefreshScope = (value, grantedScopes) => {
  if (typeof value !== 'string' || value.length === 0) return null;
  const scopes = value.split(' ');
  if (scopes.some((scope) => !scope || !SCOPES.includes(scope) || !grantedScopes.includes(scope))) return null;
  return [...new Set(scopes)];
};
const esc = (value) => String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const json = (res, body, status = 200) => res.status(status).type('application/json').send(body);
const publicOrigin = (value) => {
  const url = new URL(value);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('MCP_PUBLIC_URL must be an absolute HTTP(S) origin without credentials, path, query, or fragment.');
  }
  if (url.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    throw new Error('MCP_PUBLIC_URL must use HTTPS outside loopback.');
  }
  return url.toString().replace(/\/$/, '');
};
const clientExpiry = (client) => {
  if (Number.isFinite(client?.expiresAt)) return client.expiresAt;
  const createdAt = Date.parse(client?.created_at || '');
  return Number.isFinite(createdAt) ? createdAt + CLIENT_TTL_MS : 0;
};
const activeClient = (client, now = Date.now()) => Boolean(client && clientExpiry(client) > now);

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const validRedirect = (value) => {
  try {
    const url = new URL(value);
    return !value.includes('#') && ((url.protocol === 'https:' && !url.username && !url.password)
      || (url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname) && !url.username && !url.password));
  } catch { return false; }
};
const LOOPBACK_REDIRECT_URI = /^(https?):\/\/(localhost|127\.0\.0\.1|\[::1\])(?::[0-9]+)?(.*)$/i;
const redirectUriMatches = (registered, requested) => {
  if (!validRedirect(registered) || !validRedirect(requested)) return false;
  if (registered === requested) return true;
  try {
    const registeredUrl = new URL(registered);
    const requestedUrl = new URL(requested);
    if (!LOOPBACK_HOSTS.has(registeredUrl.hostname) || registeredUrl.hostname !== requestedUrl.hostname) return false;
    if (registeredUrl.protocol !== 'http:' || requestedUrl.protocol !== 'http:') return false;
    const registeredParts = LOOPBACK_REDIRECT_URI.exec(registered);
    const requestedParts = LOOPBACK_REDIRECT_URI.exec(requested);
    return Boolean(registeredParts && requestedParts
      && registeredParts[1] === requestedParts[1]
      && registeredParts[2] === requestedParts[2]
      && registeredParts[3] === requestedParts[3]);
  } catch { return false; }
};
const callbackPresentation = (value) => {
  const url = new URL(value);
  const isLoopback = LOOPBACK_HOSTS.has(url.hostname);
  const host = isLoopback
    ? url.hostname + ':' + (url.port || (url.protocol === 'https:' ? '443' : '80'))
    : url.hostname;
  return { host, isLoopback };
};

class OAuthState {
  constructor(file) {
    this.file = file;
    this.data = { clients: {}, codes: {}, tokens: {}, grants: {}, spentRefreshTokens: {} };
    // The supported deployment uses one server process; this queue is not a cross-process file lock.
    this.serial = Promise.resolve();
    this.tokenIssuanceSerial = Promise.resolve();
    this.grantRevocationListeners = new Set();
  }

  async load() {
    try {
      const parsed = JSON.parse(await fs.readFile(this.file, 'utf8'));
      this.data = {
        clients: parsed.clients && typeof parsed.clients === 'object' ? parsed.clients : {},
        codes: parsed.codes && typeof parsed.codes === 'object' ? parsed.codes : {},
        tokens: parsed.tokens && typeof parsed.tokens === 'object' ? parsed.tokens : {},
        grants: parsed.grants && typeof parsed.grants === 'object' ? parsed.grants : {},
        spentRefreshTokens: parsed.spentRefreshTokens && typeof parsed.spentRefreshTokens === 'object' && !Array.isArray(parsed.spentRefreshTokens)
          ? parsed.spentRefreshTokens
          : {},
      };
    } catch (error) {
      if (error.code !== 'ENOENT') throw new Error(`Could not load MCP OAuth state: ${error.message}`);
    }
    await this.prune();
    return this;
  }

  async save() {
    const snapshot = JSON.stringify(this.data, null, 2);
    this.serial = this.serial.catch(() => {}).then(async () => {
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      const temp = `${this.file}.${randomToken(8)}.tmp`;
      await fs.writeFile(temp, snapshot, { mode: 0o600 });
      await fs.rename(temp, this.file);
    });
    return this.serial;
  }

  withTokenIssuance(operation) {
    const run = this.tokenIssuanceSerial.then(operation, operation);
    this.tokenIssuanceSerial = run.then(() => {}, () => {});
    return run;
  }

  onGrantRevoked(listener) {
    this.grantRevocationListeners.add(listener);
    return () => this.grantRevocationListeners.delete(listener);
  }

  isGrantActive(grantId) {
    return Boolean(grantId && this.data.grants[grantId]);
  }

  async prepareTokenCapacity(additionalTokens, replacingTokenHash = null) {
    const now = Date.now();
    let changed = false;
    for (const [key, item] of Object.entries(this.data.tokens)) {
      if (!Number.isFinite(item?.expiresAt) || item.expiresAt <= now || !activeClient(this.data.clients[item.clientId], now)) {
        delete this.data.tokens[key];
        changed = true;
      }
    }
    const replacementCount = replacingTokenHash && this.data.tokens[replacingTokenHash] ? 1 : 0;
    const remaining = Object.keys(this.data.tokens).length - replacementCount;
    if (changed) await this.save();
    return remaining + additionalTokens <= MAX_TOKENS;
  }

  async prune() {
    const now = Date.now();
    const clientIds = Object.keys(this.data.clients);
    for (const clientId of clientIds) {
      if (!activeClient(this.data.clients[clientId], now)) delete this.data.clients[clientId];
    }
    const liveClientIds = new Set(Object.keys(this.data.clients));
    for (const [grantId, grant] of Object.entries(this.data.grants)) {
      if (!liveClientIds.has(grant.clientId)) this.removeGrant(grantId);
    }
    for (const [key, item] of Object.entries(this.data.codes)) {
      if (item.expiresAt <= now || !liveClientIds.has(item.clientId)) delete this.data.codes[key];
    }
    for (const [key, item] of Object.entries(this.data.tokens)) {
      if (!Number.isFinite(item?.expiresAt) || item.expiresAt <= now || !liveClientIds.has(item.clientId)) delete this.data.tokens[key];
    }
    this.pruneSpentRefreshTokens(now);
    for (const key of Object.keys(this.data.codes).slice(0, Math.max(0, Object.keys(this.data.codes).length - MAX_AUTH_CODES))) delete this.data.codes[key];
    const liveGrantIds = new Set();
    for (const item of Object.values(this.data.codes)) if (item.grantId) liveGrantIds.add(item.grantId);
    for (const item of Object.values(this.data.tokens)) if (item.grantId) liveGrantIds.add(item.grantId);
    for (const item of Object.values(this.data.spentRefreshTokens)) if (item.grantId) liveGrantIds.add(item.grantId);
    for (const grantId of Object.keys(this.data.grants)) if (!liveGrantIds.has(grantId)) this.removeGrant(grantId);
    if (Object.keys(this.data.tokens).length > MAX_TOKENS) throw new Error('MCP OAuth token state exceeds the supported capacity.');
    await this.save();
  }

  refreshFamilyExpiresAt(grantId) {
    const grant = this.data.grants[grantId];
    if (Number.isFinite(grant?.refreshExpiresAt)) return grant.refreshExpiresAt;
    let expiresAt = 0;
    for (const token of Object.values(this.data.tokens)) {
      if (token.grantId === grantId && token.kind === 'refresh' && Number.isFinite(token.expiresAt)) {
        expiresAt = Math.max(expiresAt, token.expiresAt);
      }
    }
    return expiresAt;
  }

  pruneSpentRefreshTokens(now = Date.now()) {
    let changed = false;
    const familyExpiries = new Map();
    for (const [grantId, grant] of Object.entries(this.data.grants)) {
      if (Number.isFinite(grant.refreshExpiresAt)) familyExpiries.set(grantId, grant.refreshExpiresAt);
    }
    for (const token of Object.values(this.data.tokens)) {
      if (token.kind !== 'refresh' || !Number.isFinite(token.expiresAt) || familyExpiries.has(token.grantId)) continue;
      familyExpiries.set(token.grantId, Math.max(familyExpiries.get(token.grantId) || 0, token.expiresAt));
    }
    for (const [key, item] of Object.entries(this.data.spentRefreshTokens)) {
      const grant = this.data.grants[item.grantId];
      const familyExpiresAt = familyExpiries.get(item.grantId) || 0;
      if (!grant || grant.clientId !== item.clientId || grant.ownerId !== 'owner'
        || !activeClient(this.data.clients[item.clientId], now)
        || !familyExpiresAt || familyExpiresAt <= now
        || (Number.isFinite(item.expiresAt) && item.expiresAt <= now)) {
        delete this.data.spentRefreshTokens[key];
        changed = true;
      } else {
        if (!Number.isFinite(grant.refreshExpiresAt)) {
          grant.refreshExpiresAt = familyExpiresAt;
          changed = true;
        }
        if (!Number.isFinite(item.expiresAt) || item.expiresAt > familyExpiresAt) {
          item.expiresAt = familyExpiresAt;
          changed = true;
        }
      }
    }
    return changed;
  }

  async addClient(client) {
    this.data.clients[client.client_id] = client;
    await this.save();
  }
  async deleteClient(clientId) {
    if (!this.data.clients[clientId]) return false;
    delete this.data.clients[clientId];
    const grantIds = Object.entries(this.data.grants).filter(([, grant]) => grant.clientId === clientId).map(([id]) => id);
    for (const grantId of grantIds) this.removeGrant(grantId);
    for (const [key, item] of Object.entries(this.data.codes)) if (item.clientId === clientId) delete this.data.codes[key];
    for (const [key, item] of Object.entries(this.data.tokens)) if (item.clientId === clientId) delete this.data.tokens[key];
    await this.save();
    return true;
  }

  async revokeGrant(grantId, ownerId = null) {
    const grant = this.data.grants[grantId];
    if (!grant || (ownerId && grant.ownerId !== ownerId)) return false;
    this.removeGrant(grantId);
    await this.save();
    return true;
  }

  removeGrant(grantId) {
    const existed = Boolean(this.data.grants[grantId]);
    delete this.data.grants[grantId];
    for (const [key, item] of Object.entries(this.data.codes)) if (item.grantId === grantId) delete this.data.codes[key];
    for (const [key, item] of Object.entries(this.data.tokens)) if (item.grantId === grantId) delete this.data.tokens[key];
    for (const [key, item] of Object.entries(this.data.spentRefreshTokens)) if (item.grantId === grantId) delete this.data.spentRefreshTokens[key];
    if (existed) for (const listener of this.grantRevocationListeners) listener(grantId);
  }

  async revokeToken(token, clientId) {
    const key = digest(token);
    const item = this.data.tokens[key];
    if (!item || item.clientId !== clientId) return false;
    if (item.grantId && this.data.grants[item.grantId]) this.removeGrant(item.grantId);
    else delete this.data.tokens[key];
    await this.save();
    return true;
  }

  async issueCode(code, grant) {
    this.data.codes[digest(code)] = grant;
    await this.save();
  }

  async consumeCode(code, clientId, redirectUri, verifier, resource, tokensToIssue = 0) {
    const key = digest(code);
    const grant = this.data.codes[key];
    if (!grant || grant.expiresAt <= Date.now() || grant.clientId !== clientId || grant.redirectUri !== redirectUri || grant.resource !== resource) {
      delete this.data.codes[key];
      await this.save();
      return null;
    }
    const expected = Buffer.from(grant.challenge);
    const actual = Buffer.from(createHash('sha256').update(verifier).digest('base64url'));
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
      delete this.data.codes[key];
      await this.save();
      return null;
    }
    if (tokensToIssue && !await this.prepareTokenCapacity(tokensToIssue)) return { status: 'capacity' };
    delete this.data.codes[key];
    await this.save();
    return grant;
  }

  async issueToken(token, grant) {
    this.data.tokens[digest(token)] = grant;
    await this.save();
  }

  async consumeRefreshToken(token, clientId, audience, tokensToIssue = 0) {
    const key = digest(token);
    const now = Date.now();
    const pruned = this.pruneSpentRefreshTokens(now);
    const prior = this.data.tokens[key];
    if (prior) {
      const grant = this.data.grants[prior.grantId];
      if (prior.kind !== 'refresh' || !Number.isFinite(prior.expiresAt) || prior.expiresAt <= now
        || prior.clientId !== clientId || prior.audience !== audience
        || prior.ownerId !== 'owner' || !grant || grant.clientId !== clientId || grant.ownerId !== 'owner') {
        if (pruned) await this.save();
        return { status: 'invalid' };
      }
      if (Object.keys(this.data.spentRefreshTokens).length >= MAX_SPENT_REFRESH_TOKENS) {
        if (pruned) await this.save();
        return { status: 'capacity' };
      }
      if (tokensToIssue && !await this.prepareTokenCapacity(tokensToIssue, key)) {
        if (pruned) await this.save();
        return { status: 'capacity' };
      }
      const familyExpiresAt = Math.max(this.refreshFamilyExpiresAt(prior.grantId), prior.expiresAt);
      grant.refreshExpiresAt = familyExpiresAt;
      delete this.data.tokens[key];
      this.data.spentRefreshTokens[key] = { grantId: prior.grantId, clientId, expiresAt: familyExpiresAt };
      await this.save();
      return { status: 'consumed', grant: prior };
    }

    const spent = this.data.spentRefreshTokens[key];
    const grant = spent && spent.clientId === clientId ? this.data.grants[spent.grantId] : null;
    if (!grant || grant.clientId !== clientId || grant.ownerId !== 'owner') {
      if (pruned) await this.save();
      return { status: 'invalid' };
    }
    this.removeGrant(spent.grantId);
    await this.save();
    return { status: 'replay' };
  }

  async getToken(token, audience) {
    const key = digest(token);
    const grant = this.data.tokens[key];
    if (!grant || grant.kind === 'refresh' || grant.expiresAt <= Date.now() || grant.audience !== audience
      || !activeClient(this.data.clients[grant.clientId]) || !this.isGrantActive(grant.grantId)) return null;
    return { ...grant };
  }
}

export async function createMcpOAuthRouter({ express, config, store, sessions, tokenOf, originAllowed, verifyPassword, authLimiterOptions, requestHost, log = () => {} }) {
  const authLimiter = createOAuthAuthLimiter(authLimiterOptions);
  // OAuth can be instantiated with a partial server config (for example, embedded/test use).
  // Without MCP_PUBLIC_URL, publish a loopback issuer; deployments reachable remotely must set
  // MCP_PUBLIC_URL explicitly. Never interpolate missing config fields into an invalid URL.
  const configuredHost = config.host;
  const loopbackHost = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(configuredHost)
    ? (configuredHost === '::1' ? '[::1]' : configuredHost)
    : '127.0.0.1';
  const configuredPort = Number(config.port);
  const port = Number.isInteger(configuredPort) && configuredPort >= 1 && configuredPort <= 65535
    ? configuredPort
    : 8090;
  const issuer = publicOrigin(config.mcpPublicUrl || `http://${loopbackHost}:${port}`);
  const resource = `${issuer}/mcp`;
  // The authorization endpoint lives at the issuer, so its Origin is always same-origin for
  // these pages: without this, a reverse proxy that rewrites Host would refuse the MCP
  // client's top-level navigation (deploy/README.md says ALLOWED_ORIGINS is not needed).
  const issuerOrigin = new URL(issuer).origin.toLowerCase();
  // Like the routes in server/app.js: a trusted X-Forwarded-Host beats the raw Host.
  const issuerHost = (req) => requestHost?.(req) || req.headers.host;
  const state = await new OAuthState(path.join(config.dataDir, 'mcp-oauth.json')).load();
  const pending = new Map();
  const registrationAttempts = new Map();
  const router = express.Router();
  let registry = null;
  const allowedScope = (scope) => typeof scope === 'string' ? [...new Set(scope.trim().split(/\s+/).filter(Boolean))] : [];
  const enabledScopes = SCOPES.filter((scope) => config.mcpCommandsEnabled || scope !== 'commands:exec');
  const resourceScopes = [...BASIC_SCOPES];
  const authenticate = (req) => Boolean(store.owner && sessions.touch(tokenOf(req)));
  const ownOrigin = (req) => originAllowed(
    req.headers.origin,
    { ...req.headers, effectiveHost: issuerHost(req) },
    [...config.allowedOrigins || [], issuerOrigin],
  );
  // A form POST from the consent page can carry `Origin: null` (sandboxed webviews and
  // embedded browsers such as desktop clients do), so on this POST a foreign origin is always
  // rejected, while a missing or `null` origin is accepted only because the random pending
  // `requestId` (never shown cross-site, valid five minutes) already provides the CSRF check:
  // without it the handler rejects the request with "Authorization request expired."
  const consentOriginAllowed = (req) => {
    const origin = req.headers.origin;
    if (origin === undefined || origin === 'null') return true;
    return ownOrigin(req);
  };
  const finishOAuthError = (res, client, redirectUri, params) => {
    if (!trustedOAuthRedirect(client, redirectUri)) {
      return localOAuthNotice(res, client, redirectUri, 'RemoteHub kept this OAuth response on this page because the callback is not registered for this client.');
    }
    return redirectOAuth(res, redirectUri, params);
  };

  router.get('/.well-known/oauth-protected-resource', (_req, res) => json(res, {
    resource,
    authorization_servers: [issuer],
    bearer_methods_supported: ['header'],
    scopes_supported: resourceScopes,
  }));
  router.get('/.well-known/oauth-protected-resource/mcp', (_req, res) => json(res, {
    resource,
    authorization_servers: [issuer],
    bearer_methods_supported: ['header'],
    scopes_supported: resourceScopes,
  }));
  router.get('/.well-known/oauth-authorization-server', (_req, res) => json(res, {
    issuer,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: `${issuer}/oauth/token`,
    registration_endpoint: `${issuer}/oauth/register`,
    revocation_endpoint: `${issuer}/oauth/revoke`,
    revocation_endpoint_auth_methods_supported: ['none'],
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    scopes_supported: enabledScopes,
    authorization_response_iss_parameter_supported: true,
  }));

  router.post('/oauth/register', express.json({ limit: '16kb' }), async (req, res) => {
    const now = Date.now();
    const ip = String(req.ip || req.socket.remoteAddress || 'unknown');
    const prior = registrationAttempts.get(ip);
    if (registrationAttempts.size > 10_000) {
      for (const [key, entry] of registrationAttempts) if (now - entry.startedAt >= 60_000) registrationAttempts.delete(key);
      while (registrationAttempts.size > 10_000) registrationAttempts.delete(registrationAttempts.keys().next().value);
    }
    const attempts = prior && now - prior.startedAt < 60_000 ? prior : { startedAt: now, count: 0 };
    if (attempts.count >= 10) return json(res, { error: 'rate_limited' }, 429);
    attempts.count += 1;
    registrationAttempts.set(ip, attempts);
    const body = req.body || {};
    const redirects = body.redirect_uris;
    if (!Array.isArray(redirects) || redirects.length < 1 || redirects.length > 10
      || redirects.some((uri) => typeof uri !== 'string' || uri.length > 2048 || !validRedirect(uri))
      || new Set(redirects).size !== redirects.length) {
      return json(res, { error: 'invalid_redirect_uri', error_description: 'Provide 1–10 unique HTTPS or loopback redirect URIs.' }, 400);
    }
    const grantTypes = body.grant_types ?? ['authorization_code'];
    if (!Array.isArray(grantTypes) || !grantTypes.includes('authorization_code')
      || grantTypes.some((type) => !['authorization_code', 'refresh_token'].includes(type))) {
      return json(res, { error: 'invalid_client_metadata' }, 400);
    }
    const responseTypes = body.response_types ?? ['code'];
    if (!Array.isArray(responseTypes) || responseTypes.length !== 1 || responseTypes[0] !== 'code') {
      return json(res, { error: 'invalid_client_metadata' }, 400);
    }
    if (body.token_endpoint_auth_method && body.token_endpoint_auth_method !== 'none') {
      return json(res, { error: 'invalid_client_metadata', error_description: 'Only public clients are supported.' }, 400);
    }
    if (Object.keys(state.data.clients).length >= MAX_CLIENTS) await state.prune();
    if (Object.keys(state.data.clients).length >= MAX_CLIENTS) return json(res, { error: 'registration_not_supported' }, 503);
    const issuedAt = Date.now();
    const client = {
      client_id: randomToken(24),
      client_name: typeof body.client_name === 'string' ? body.client_name.slice(0, 120) : 'MCP client',
      redirect_uris: redirects,
      grant_types: [...new Set(grantTypes)],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      created_at: new Date(issuedAt).toISOString(),
      expiresAt: issuedAt + CLIENT_TTL_MS,
    };
    await state.addClient(client);
    const { expiresAt, ...clientResponse } = client;
    return json(res, { ...clientResponse, client_id_issued_at: Math.floor(issuedAt / 1000), client_id_expires_at: Math.floor(expiresAt / 1000) }, 201);
  });

  router.post('/oauth/revoke', express.urlencoded({ extended: false, limit: '16kb' }), async (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.set('Pragma', 'no-cache');
    const body = req.body || {};
    if (typeof body.client_id !== 'string' || !body.client_id || typeof body.token !== 'string' || !body.token || body.token.length > 2048) {
      return json(res, { error: 'invalid_request' }, 400);
    }
    const client = state.data.clients[body.client_id];
    if (!activeClient(client)) return json(res, { error: 'invalid_client' }, 401);
    // Public clients identify themselves with client_id; only tokens issued to that
    // registered client are accepted. RFC 7009 requires unknown tokens to be a no-op.
    await state.revokeToken(body.token, body.client_id);
    return res.status(200).end();
  });

  router.get('/oauth/authorize', (req, res) => {
    // Browser-driven OAuth navigations can omit Origin, but any supplied Origin
    // must be checked before this page touches the owner's sliding session.
    if (req.headers.origin !== undefined && !ownOrigin(req)) return res.status(403).send('Origin rejected.');
    const client = state.data.clients[String(req.query.client_id || '')];
    const redirectUri = String(req.query.redirect_uri || '');
    const challenge = String(req.query.code_challenge || '');
    const stateParameter = req.query.state;
    const hasOAuthState = typeof stateParameter === 'string';
    const oauthState = hasOAuthState ? stateParameter : '';
    const validOAuthState = hasOAuthState && oauthState.length <= 512;
    const requestedResource = String(req.query.resource || '');
    const rawScope = req.query.scope;
    const repeatedAuthorizationParameter = [
      'client_id', 'response_type', 'redirect_uri', 'scope', 'state',
      'code_challenge', 'code_challenge_method', 'resource',
    ].some((name) => Array.isArray(req.query[name]));
    const requestedScopes = allowedScope(rawScope);
    const scopes = rawScope === undefined ? [...BASIC_SCOPES] : requestedScopes;
    if (!activeClient(client) || !client.redirect_uris.some((registered) => redirectUriMatches(registered, redirectUri))) return res.status(400).send('Unknown or expired client or redirect URI.');
    if (repeatedAuthorizationParameter) {
      return finishOAuthError(
        res,
        client,
        redirectUri,
        { error: 'invalid_request', ...(validOAuthState ? { state: oauthState } : {}), iss: issuer },
      );
    }
    if (stateParameter !== undefined && !validOAuthState) {
      return finishOAuthError(res, client, redirectUri, { error: 'invalid_request', iss: issuer });
    }
    if (requestedResource !== resource) {
      return finishOAuthError(
        res,
        client,
        redirectUri,
        { error: 'invalid_target', ...(hasOAuthState ? { state: oauthState } : {}), iss: issuer },
      );
    }
    const unsupportedResponseType = typeof req.query.response_type === 'string'
      && req.query.response_type.length > 0 && req.query.response_type !== 'code';
    const invalidScope = rawScope !== undefined && (typeof rawScope !== 'string' || !scopes.length
      || scopes.some((scope) => !enabledScopes.includes(scope)));
    if (typeof req.query.response_type !== 'string' || req.query.response_type !== 'code' || req.query.code_challenge_method !== 'S256'
      || !/^[A-Za-z0-9_-]{43,128}$/.test(challenge) || invalidScope) {
      const error = unsupportedResponseType ? 'unsupported_response_type' : invalidScope ? 'invalid_scope' : 'invalid_request';
      return finishOAuthError(
        res,
        client,
        redirectUri,
        { error, ...(hasOAuthState ? { state: oauthState } : {}), iss: issuer },
      );
    }
    // A completed consent keeps its redirect for a short while so a resubmitted form replays it.
    for (const [id, item] of pending) {
      const deadline = item.completed ? (item.completedAt ?? 0) + CONSENT_REPLAY_MS : item.expiresAt;
      if (deadline <= Date.now()) pending.delete(id);
    }
    if (pending.size >= 1000) return res.status(429).send('Too many pending authorization requests.');
    const requestId = randomToken(18);
    pending.set(requestId, { clientId: client.client_id, redirectUri, challenge, oauthState, hasOAuthState, resource, scopes, expiresAt: Date.now() + CODE_TTL_MS });
    const hosts = store.listHosts().filter((host) => host.agentCredential && !host.agentCredential.revokedAt);
    const connectedHosts = hosts.filter((host) => registryConnected(host.id));
    const defaultHostId = connectedHosts[0]?.id;
    const checkboxes = hosts.map((host) => `<label><input type="checkbox" name="hostIds" value="${esc(host.id)}" ${host.id === defaultHostId ? 'checked' : ''}>${esc(host.name)} (${esc(host.address)}) — ${registryConnected(host.id) ? 'connected' : 'offline'}</label>`).join('<br>');
    // A host only counts when its agent is connected right now, so say that plainly here
    // instead of letting the form fail later with "choose at least one connected host".
    const noHostsHere = connectedHosts.length === 0
      ? `<p><strong>${hosts.length === 0 ? 'No computer has the agent set up yet.' : 'No computer is connected right now.'}</strong> `
        + (hosts.length === 0
          ? 'Open the computer in RemoteHub and use “Install agent on this computer”, then come back to this page.'
          : 'Start the RemoteHub agent on the computer you want to authorize (or reinstall it from that computer’s dialog in RemoteHub), then reload this page.')
        + '</p>'
      : '';
    const availableScopes = enabledScopes.filter((scope) => scope !== 'commands:exec' && scope !== 'files:write');
    const scopeOptions = availableScopes.map((scope) => `<label><input type="checkbox" name="scopes" value="${scope}" ${BASIC_SCOPES.includes(scope) && scopes.includes(scope) ? 'checked' : ''}>${scope}</label>`).join('<br>');
    const writeConsent = scopes.includes('files:write')
      ? '<fieldset><legend>File write permission</legend><p>Writing can create or overwrite files under every selected host root. Select this only when you intend to allow changes.</p><label><input type="checkbox" name="scopes" value="files:write"> Allow file writes (files:write)</label></fieldset>'
      : '';
    const commandConsent = config.mcpCommandsEnabled
      ? `<fieldset><legend>Host command authority</legend><p>Granting this permission lets this client run programs on selected hosts as the agent service account. The host filesystem root is not a sandbox; shell executables can run arbitrary commands.</p>${scopes.includes('commands:exec')
        ? '<label><input type="checkbox" name="scopes" value="commands:exec"> Allow host command execution (commands:exec)</label>'
        : '<p>This client did not request commands:exec. Reconnect it with that scope to grant host command access.</p>'}</fieldset>`
      : '';
    const login = authenticate(req) ? '' : '<label>Owner password <input type="password" name="password" autocomplete="current-password" required></label><br>';
    const callback = callbackPresentation(redirectUri);
    const callbackWarning = callback.isLoopback
      ? '<p><strong>Localhost warning:</strong> A local application listening on ' + esc(callback.host) + ' can receive this authorization response. Continue only if you trust that application.</p>'
      : '';
    // The form posts here and the answer is a redirect to the client's callback. Chrome applies
    // form-action to every hop of that redirect chain, and a callback commonly bounces on to
    // another origin of the client's own (www.cursor.com answers 308 to cursor.com), so no
    // allowlist built from the registered URI is enough: the navigation is silently cancelled
    // and the Authorize button appears to do nothing. This page therefore sends no form-action.
    // Its only form is the server-written one above, and every client-supplied value is escaped.
    const policy = res.get('Content-Security-Policy');
    if (policy) {
      res.set('Content-Security-Policy', policy.split('; ').filter((directive) => !directive.startsWith('form-action ')).join('; '));
    }
    res.type('html').send('<!doctype html><meta charset="utf-8"><title>Authorize RemoteHub MCP</title><main><h1>Authorize '
      + esc(client.client_name) + '</h1><p><a href="/oauth/manage">Manage OAuth clients and grants</a></p>'
      + '<p>This client will receive the authorization response at <strong>' + esc(callback.host) + '</strong>.</p>'
      + '<p>Callback URI: <code>' + esc(redirectUri) + '</code></p>' + callbackWarning
      + '<p>Only one connected host and basic read permissions are selected initially. Review each permission before authorizing. Access expires after 15 minutes.</p>'
      + '<form method="post" action="/oauth/authorize"><input type="hidden" name="requestId" value="' + requestId + '">' + login
      + '<h2>Hosts</h2>' + noHostsHere + (checkboxes || '') + '<h2>Basic access</h2>' + scopeOptions + writeConsent + commandConsent
      + '<button name="consent" value="allow">Authorize</button><button name="consent" value="deny">Deny</button></form></main>');
  });

  router.post('/oauth/authorize', express.urlencoded({ extended: false, limit: '16kb' }), async (req, res) => {
    if (!consentOriginAllowed(req)) return res.status(403).send('Origin rejected.');
    const requestId = String(req.body.requestId || '');
    const tx = pending.get(requestId);
    if (!tx) return res.status(400).send('Authorization request expired.');
    // This form was already answered: replay its redirect rather than calling it expired.
    // Browsers and clients resubmit the consent form (back button, double click, reopening the
    // page), and the authorization code it produced is still valid for several minutes.
    if (tx.completed) return res.redirect(302, tx.completed);
    if (tx.expiresAt <= Date.now()) return res.status(400).send('Authorization request expired.');
    const client = state.data.clients[tx.clientId];
    if (!client || !client.redirect_uris.some((registered) => redirectUriMatches(registered, tx.redirectUri))) return res.status(400).send('Client registration changed.');
    let authenticated = authenticate(req);
    if (!authenticated) {
      const attempt = authLimiter.begin(req.ip || req.socket.remoteAddress || 'unknown');
      if (!attempt.ok) {
        const seconds = Math.max(1, Math.ceil(attempt.retryAfterMs / 1000));
        res.set('Retry-After', String(seconds));
        return res.status(429).send(`Too many authorization attempts. Retry after ${seconds} seconds.`);
      }
      let passwordAccepted = false;
      try {
        const password = req.body.password;
        passwordAccepted = typeof password === 'string'
          && await verifyPassword(password, store.owner?.password);
      } catch (error) {
        attempt.finish(false);
        throw error;
      }
      attempt.finish(passwordAccepted);
      if (!passwordAccepted) {
        return res.status(401).send('Owner authentication failed. Return to RemoteHub and sign in, then retry.');
      }
    }
    if (pending.get(requestId) !== tx) return res.status(400).send('Authorization request expired.');
    if (req.body.consent !== 'allow') {
      const denied = new URL(tx.redirectUri);
      denied.searchParams.set('error', 'access_denied');
      if (tx.hasOAuthState) denied.searchParams.set('state', tx.oauthState);
      denied.searchParams.set('iss', issuer);
      const replayable = trustedOAuthRedirect(client, tx.redirectUri);
      if (replayable) tx.completed = denied.toString();
      return finishOAuthError(
        res,
        client,
        tx.redirectUri,
        { error: 'access_denied', ...(tx.hasOAuthState ? { state: tx.oauthState } : {}), iss: issuer },
      );
    }
    const connected = new Set(store.listHosts().filter((host) => registryConnected(host.id)).map((host) => host.id));
    const hostIds = [...new Set((Array.isArray(req.body.hostIds) ? req.body.hostIds : req.body.hostIds ? [req.body.hostIds] : []).map(String))]
      .filter((id) => connected.has(id));
    const submittedScopes = Array.isArray(req.body.scopes) ? req.body.scopes : req.body.scopes ? [req.body.scopes] : [];
    if (submittedScopes.some((scope) => typeof scope !== 'string'
      || !enabledScopes.includes(scope) || !tx.scopes.includes(scope))) {
      return res.status(400).send('The approved permissions must be valid, enabled, and requested by this client.');
    }
    const scopes = [...new Set(submittedScopes)];
    if (!hostIds.length || !scopes.length) return res.status(400).send('Choose at least one currently connected host and one requested permission.');
    const grantId = randomToken(24);
    state.data.grants[grantId] = {
      clientId: tx.clientId, ownerId: 'owner', hostIds, scopes,
      createdAt: new Date().toISOString(),
    };
    const code = randomToken(32);
    await state.issueCode(code, {
      grantId, clientId: tx.clientId, redirectUri: tx.redirectUri, challenge: tx.challenge,
      resource: tx.resource, ownerId: 'owner', hostIds, scopes, expiresAt: Date.now() + CODE_TTL_MS,
    });
    await state.prune();
    const callback = new URL(tx.redirectUri);
    callback.searchParams.set('code', code);
    if (tx.hasOAuthState) callback.searchParams.set('state', tx.oauthState);
    callback.searchParams.set('iss', issuer);
    // Keep the answered form reachable so a resubmit replays this same redirect.
    tx.completed = callback.toString();
    tx.completedAt = Date.now();
    return res.redirect(302, callback.toString());
  });

  router.get('/oauth/manage', (req, res) => {
    if (req.headers.origin !== undefined && !ownOrigin(req)) return res.status(403).type('html').send('Origin rejected.');
    if (!authenticate(req)) return res.status(401).type('html').send('Sign in to RemoteHub, then open OAuth access management again.');
    const clients = Object.values(state.data.clients).filter((client) => activeClient(client));
    const grants = Object.entries(state.data.grants).filter(([, grant]) => grant.ownerId === 'owner' && state.data.clients[grant.clientId]);
    const clientRows = clients.map((client) => `<li><strong>${esc(client.client_name)}</strong> — expires ${new Date(clientExpiry(client)).toISOString()}<form method="post" action="/oauth/manage/delete-client"><input type="hidden" name="clientId" value="${esc(client.client_id)}"><button>Remove client and revoke its grants</button></form></li>`).join('') || '<li>No registered clients.</li>';
    const grantRows = grants.map(([grantId, grant]) => {
      const client = state.data.clients[grant.clientId];
      return `<li><strong>${esc(client.client_name)}</strong> — hosts: ${esc(grant.hostIds.join(', '))}; scopes: ${esc(grant.scopes.join(', '))}; created ${esc(grant.createdAt)}<form method="post" action="/oauth/manage/revoke-grant"><input type="hidden" name="grantId" value="${esc(grantId)}"><button>Revoke access grant</button></form></li>`;
    }).join('') || '<li>No active access grants.</li>';
    return res.type('html').send(`<!doctype html><meta charset="utf-8"><title>RemoteHub OAuth access</title><main><h1>OAuth clients and access grants</h1><p>Revoking a grant invalidates its access and refresh tokens. Removing a client revokes all of its grants.</p><h2>Clients</h2><ul>${clientRows}</ul><h2>Access grants</h2><ul>${grantRows}</ul></main>`);
  });

  router.post('/oauth/manage/revoke-grant', express.urlencoded({ extended: false, limit: '16kb' }), async (req, res) => {
    if (typeof req.headers.origin !== 'string' || !ownOrigin(req) || !authenticate(req)) return res.status(403).send('Owner session and same-origin request required.');
    const grantId = String(req.body?.grantId || '');
    await state.revokeGrant(grantId, 'owner');
    return res.redirect(303, '/oauth/manage');
  });

  router.post('/oauth/manage/delete-client', express.urlencoded({ extended: false, limit: '16kb' }), async (req, res) => {
    if (typeof req.headers.origin !== 'string' || !ownOrigin(req) || !authenticate(req)) return res.status(403).send('Owner session and same-origin request required.');
    const clientId = String(req.body?.clientId || '');
    await state.deleteClient(clientId);
    return res.redirect(303, '/oauth/manage');
  });

  router.post('/oauth/token', express.urlencoded({ extended: false, limit: '16kb' }), async (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.set('Pragma', 'no-cache');
    const body = req.body || {};
    // One line per token attempt, so a client whose exchange fails can be diagnosed from the
    // server log. Never a secret: the code, the verifier and the token stay out.
    const attempt = {
      client: typeof body.client_id === 'string' ? body.client_id.slice(0, 8) : 'none',
      grant: typeof body.grant_type === 'string' ? body.grant_type : 'none',
      resource: body.resource === undefined ? 'omitted' : String(body.resource),
      redirect: typeof body.redirect_uri === 'string' ? body.redirect_uri : 'none',
    };
    const fail = (error, status = 400) => {
      log(`oauth token client=${attempt.client} grant=${attempt.grant} resource=${attempt.resource} outcome=${error}`);
      return json(res, { error }, status);
    };
    const repeatedTokenParameter = [
      'grant_type', 'client_id', 'client_secret', 'code', 'redirect_uri',
      'code_verifier', 'refresh_token', 'resource', 'scope',
    ].some((name) => Array.isArray(body[name]));
    if (repeatedTokenParameter) return fail('invalid_request');
    if (typeof body.grant_type !== 'string' || !body.grant_type) return fail('invalid_request');
    if (!['authorization_code', 'refresh_token'].includes(body.grant_type)) return fail('unsupported_grant_type');
    if (body.grant_type === 'authorization_code' && (typeof body.code !== 'string'
      || typeof body.redirect_uri !== 'string' || typeof body.code_verifier !== 'string'
      || !/^[A-Za-z0-9._~-]{43,128}$/.test(body.code_verifier))) {
      return fail('invalid_request');
    }
    // RFC 8707 lets a client state the resource it wants a token for. Some MCP clients send it
    // during authorization but not during the exchange, and some send the origin without the
    // path. A code is only ever issued for this server's own resource, so an omitted or
    // equivalent resource is accepted; a resource for something else is refused.
    // The token is always issued for this server's canonical resource, never for the
    // client's wording of it.
    const requestedResource = body.resource === undefined ? null : String(body.resource);
    if (requestedResource !== null && !sameResource(requestedResource, resource)) return fail('invalid_target');
    // A public client may omit client_id on the exchange; the code identifies the client.
    let clientId = typeof body.client_id === 'string' ? body.client_id : '';
    if (!clientId && body.grant_type === 'authorization_code' && typeof body.code === 'string') {
      clientId = state.data.codes[digest(body.code)]?.clientId || '';
    }
    if (!clientId) return fail('invalid_client', 401);
    attempt.client = clientId.slice(0, 8);
    const client = state.data.clients[clientId];
    if (!activeClient(client)) return fail('invalid_client', 401);
    const tokenResource = resource;
    if (body.grant_type === 'refresh_token') {
      if (typeof body.refresh_token !== 'string') return fail('invalid_request');
      return state.withTokenIssuance(async () => {
        const candidate = state.data.tokens[digest(body.refresh_token)];
        const candidateGrant = candidate && state.data.grants[candidate.grantId];
        const candidateIsValid = Boolean(candidate && candidate.kind === 'refresh'
          && Number.isFinite(candidate.expiresAt) && candidate.expiresAt > Date.now()
          && candidate.clientId === clientId && candidate.audience === resource
          && candidate.ownerId === 'owner' && candidateGrant
          && candidateGrant.clientId === clientId && candidateGrant.ownerId === 'owner');
        let accessScopes;
        if (candidateIsValid) {
          if (!sameScopeSet(candidate.scopes, candidateGrant.scopes)) {
            return json(res, { error: 'invalid_grant' }, 400);
          }
          if (body.scope === undefined) {
            accessScopes = Array.isArray(candidate.accessScopes) ? candidate.accessScopes : candidate.scopes;
            if (!scopeSubset(accessScopes, candidateGrant.scopes)) {
              return json(res, { error: 'invalid_grant' }, 400);
            }
          } else {
            accessScopes = parseRefreshScope(body.scope, candidateGrant.scopes);
            if (!accessScopes) return json(res, { error: 'invalid_scope' }, 400);
          }
        }
        const consumed = await state.consumeRefreshToken(
          body.refresh_token,
          clientId,
          resource,
          tokenPairSize(candidate, client),
        );
        if (consumed.status === 'capacity') return json(res, { error: 'temporarily_unavailable' }, 503);
        if (consumed.status !== 'consumed') return json(res, { error: 'invalid_grant' }, 400);
        return issueTokenPair(res, state, consumed.grant, resource, accessScopes);
      });
    }
    if (!client.redirect_uris.some((registered) => redirectUriMatches(registered, body.redirect_uri))) return fail('invalid_grant');
    return state.withTokenIssuance(async () => {
      const candidate = state.data.codes[digest(body.code)];
      const grant = await state.consumeCode(
        body.code,
        clientId,
        body.redirect_uri,
        body.code_verifier,
        tokenResource,
        tokenPairSize(candidate, client),
      );
      if (grant?.status === 'capacity') {
        log(`oauth token client=${attempt.client} grant=${attempt.grant} resource=${attempt.resource} outcome=temporarily_unavailable`);
        return json(res, { error: 'temporarily_unavailable' }, 503);
      }
      if (!grant || grant.ownerId !== 'owner') {
        log(`oauth token client=${attempt.client} grant=${attempt.grant} resource=${attempt.resource} outcome=invalid_grant`);
        return json(res, { error: 'invalid_grant' }, 400);
      }
      log(`oauth token client=${attempt.client} grant=${attempt.grant} resource=${attempt.resource} outcome=issued`);
      return issueTokenPair(res, state, grant, tokenResource);
    });
  });

  return { router, issuer, resource, state, setRegistry(value) { registry = value; } };

  function registryConnected(hostId) { return Boolean(registry?.isConnected(hostId)); }
}

function trustedOAuthRedirect(client, redirectUri) {
  return client.redirect_uris.some((registered) => redirectUriMatches(registered, redirectUri));
}

/**
 * Whether a client-stated resource points at this server's own MCP resource. A client may
 * state the origin (no path) or the exact resource URI; anything else is a different
 * resource and is refused.
 */
function sameResource(requested, resource) {
  if (requested === resource) return true;
  try {
    const asked = new URL(requested);
    const own = new URL(resource);
    // A bare origin parses with the path "/", so both spellings mean "no path".
    const askedPath = asked.pathname === '/' ? '' : asked.pathname;
    const ownPath = own.pathname === '/' ? '' : own.pathname;
    return asked.origin === own.origin && (askedPath === '' || askedPath === ownPath);
  } catch {
    return false;
  }
}

function localOAuthNotice(res, client, redirectUri, message, status = 200) {
  const callback = callbackPresentation(redirectUri);
  const loopbackWarning = callback.isLoopback
    ? '<p><strong>Localhost warning:</strong> A local application listening on ' + esc(callback.host) + ' may receive responses sent to this callback.</p>'
    : '';
  return res.status(status).type('html').send(
    '<!doctype html><meta charset="utf-8"><title>RemoteHub authorization notice</title><main><h1>Authorization notice</h1>'
      + '<p>' + esc(message) + '</p><p>Client: <strong>' + esc(client.client_name) + '</strong></p>'
      + '<p>Callback host: <strong>' + esc(callback.host) + '</strong></p><p>Callback URI: <code>' + esc(redirectUri) + '</code></p>'
      + loopbackWarning + '</main>',
  );
}

function redirectOAuth(res, redirectUri, params) {
  const callback = new URL(redirectUri);
  for (const [key, value] of Object.entries(params)) callback.searchParams.set(key, value);
  return res.redirect(302, callback.toString());
}

async function issueTokenPair(res, state, grant, resource, requestedAccessScopes = undefined) {
  const grantId = grant.grantId;
  const activeGrant = grantId ? state.data.grants[grantId] : null;
  if (!activeGrant || activeGrant.clientId !== grant.clientId || activeGrant.ownerId !== 'owner') {
    return json(res, { error: 'invalid_grant' }, 400);
  }
  const accessScopes = requestedAccessScopes
    || (Array.isArray(grant.accessScopes) ? grant.accessScopes : activeGrant.scopes);
  if (!scopeSubset(accessScopes, activeGrant.scopes)) return json(res, { error: 'invalid_grant' }, 400);
  const accessToken = randomToken(32);
  const client = state.data.clients[activeGrant.clientId];
  const refreshToken = activeGrant.scopes.includes('offline_access') && client?.grant_types?.includes('refresh_token') ? randomToken(48) : null;
  const refreshExpiresAt = refreshToken ? Date.now() + REFRESH_TOKEN_TTL_MS : null;
  const common = {
    grantId,
    ownerId: 'owner',
    clientId: activeGrant.clientId,
    audience: resource,
    hostIds: activeGrant.hostIds,
  };
  state.data.tokens[digest(accessToken)] = {
    ...common,
    kind: 'access',
    scopes: [...accessScopes],
    expiresAt: Date.now() + TOKEN_TTL_MS,
  };
  if (refreshToken) {
    activeGrant.refreshExpiresAt = refreshExpiresAt;
    for (const spent of Object.values(state.data.spentRefreshTokens)) {
      if (spent.grantId === grantId) spent.expiresAt = refreshExpiresAt;
    }
    state.data.tokens[digest(refreshToken)] = {
      ...common,
      kind: 'refresh',
      scopes: [...activeGrant.scopes],
      accessScopes: [...accessScopes],
      expiresAt: refreshExpiresAt,
    };
  }
  // Save the pair together. A revocation that runs while persistence is pending
  // removes the grant and both tokens; it must never be repaired from a stale code
  // or refresh-token snapshot.
  await state.save();
  if (state.data.grants[grantId] !== activeGrant
    || !state.data.tokens[digest(accessToken)]
    || (refreshToken && !state.data.tokens[digest(refreshToken)])) {
    return json(res, { error: 'invalid_grant' }, 400);
  }
  const response = {
    access_token: accessToken,
    token_type: 'Bearer',
    expires_in: TOKEN_TTL_MS / 1000,
    scope: accessScopes.join(' '),
    resource,
  };
  if (refreshToken) response.refresh_token = refreshToken;
  return json(res, response, 200);
}

export const MCP_SCOPES = SCOPES;
export const MCP_TOKEN_TTL_MS = TOKEN_TTL_MS;
