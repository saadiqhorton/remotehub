import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import express from 'express';
import { WebSocketServer } from 'ws';
import { ROOT } from './config.js';
import { Store } from './store.js';
import {
  LoginLimiter,
  SESSION_COOKIE,
  Sessions,
  generateSetupCode,
  hashPassword,
  parseCookies,
  safeEqual,
  verifyPassword,
} from './auth.js';
import { ValidationError, validateHost, validateOwnerPassword } from './validate.js';
import { attachTerminal } from './ssh-bridge.js';
import { attachFiles } from './sftp-bridge.js';
import { DESKTOP_PREFERENCES, NATIVE_NOT_YET, NO_TLS_RDP, capabilitiesWithDesktop, createProtocolSupport, hostDesktopBackends, restrictToDiscovery, selectDesktopBackend, selectDesktopProtocol } from './desktop-protocols.js';
import { DISCOVERY_DEFAULT_PORTS, createDiscoveryLimiter, discoverDesktopBackends } from './desktop-discovery.js';
import { explainVncFailure, probeVnc } from './vnc.js';
import { AGENT_CLOSE, publicAgentStatus, redactSecrets } from './agent-auth.js';
import { AgentRegistry } from './agent-registry.js';
import { INSTALL_STATUS, agentServerUrl, installAgent, reachableFrom } from './agent-install.js';
import { HelperError } from './helper-deploy.js';
import { SOUND_CLOSE, SoundHub } from './desktop-sound.js';
import { HostStatus } from './host-status.js';
import { createGuacdHealth, publicDesktopHealth } from './guacd.js';
import { attachAgent } from './agent-bridge.js';
import { RDP_CLOSE, rdpPreflight } from './rdp.js';
import { DESKTOP_CLOSE, attachDesktop, browserFixedSize, browserSize, publicDesktopSettings, validateDesktopSettings } from './desktop-bridge.js';
import { createMcpRouter } from './mcp.js';

const PUBLIC_DIR = path.join(ROOT, 'public');
const MODULES = path.join(ROOT, 'node_modules');

const SECURITY_HEADERS = {
  'Content-Security-Policy': [
    "default-src 'self'",
    "script-src 'self'",
    // xterm.js injects <style> elements for its renderer.
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self'",
    "img-src 'self' data:",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'self'",
  ].join('; '),
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Opener-Policy': 'same-origin',
};

function firstHeader(value) {
  return String(Array.isArray(value) ? value[0] : value || '').split(',')[0].trim().toLowerCase();
}

// Match Origin against Host or a hostname forwarded by a trusted immediate proxy.
export function originAllowed(origin, headers, allowedOrigins, effectiveHost = headers.effectiveHost) {
  if (!origin) return false;
  const normalized = origin.replace(/\/+$/, '');
  if (allowedOrigins.includes(normalized)) return true;
  let originHost;
  try {
    originHost = new URL(normalized).host.toLowerCase();
  } catch {
    return false;
  }
  return [firstHeader(headers.host), firstHeader(effectiveHost)].includes(originHost);
}

/** Return X-Forwarded-Host only when the immediate peer is trusted by Express. */
export function trustedHostname(req, trustProxy) {
  const host = firstHeader(req.headers.host);
  const forwardedHost = firstHeader(req.headers['x-forwarded-host']);
  const remoteAddress = req.socket?.remoteAddress;
  return forwardedHost && remoteAddress && trustProxy?.(remoteAddress, 0) ? forwardedHost : host;
}

function publicHost(host, { connected = false, live = null } = {}) {
  const { id, name, address, port, username, capabilities, knownHost, createdAt, updatedAt } = host;
  return {
    id,
    name,
    address,
    port,
    username,
    capabilities,
    knownHost,
    createdAt,
    updatedAt,
    agent: publicAgentStatus(host, connected),
    // SAA-302: server-held desktop settings; the password is never returned.
    desktop: publicDesktopSettings(host.desktop),
    // SAA-300: capabilities as negotiated right now (stored agentless baseline merged
    // with connected agents/helpers), where each flag came from, and who is connected.
    // Computed per request, never persisted.
    ...(live
      ? { effectiveCapabilities: live.capabilities, capabilityProvenance: live.provenance, liveAgent: live.agent }
      : {}),
  };
}

export async function createServer(config, { log = console.log } = {}) {
  const store = await new Store(config.dataDir).load();
  const sessions = new Sessions(config.sessionTtlMs);
  const limiter = new LoginLimiter();
  const agentLimiter = new LoginLimiter();
  const terminals = new Set();
  const filesSessions = new Set();
  const agents = new Set();
  const desktops = new Set();
  const registry = new AgentRegistry();
  const soundSockets = new Set();
  const sound = new SoundHub({ registry, log });
  const hostStatus = new HostStatus();
  const guacd = createGuacdHealth(config.guacd ?? { enabled: false });
  // SAA-305: which desktop protocols guacd can actually serve (vnc/rdp plugin present).
  const protocolSupport = config.protocolSupport ?? createProtocolSupport(config.guacd ?? { enabled: false });
  const setupCodeFile = path.join(config.dataDir, 'SETUP-CODE.txt');
  let setupCode = null;

  const viewHost = (host) => {
    const view = publicHost(
      { ...host, knownHost: host.knownHost ?? store.getKnownHost(host.address, host.port) },
      { connected: registry.isConnected(host.id), live: hostStatus.view(host) },
    );
    // SAA-306: which desktop backends this host offers (no probing here: last discovery,
    // capabilities and guacd's last known plugin support), plus the owner's choice.
    const known = Object.fromEntries(['rdp', 'vnc'].map((p) => [p, protocolSupport.known(p)]));
    view.desktopDiscovery = host.desktopDiscovery ?? null;
    view.desktopPreference = host.desktopPreference ?? 'auto';
    view.desktopBackends = hostDesktopBackends({ ...view, desktopDiscovery: host.desktopDiscovery }, known, { guacdEnabled: config.guacd?.enabled === true });
    // SAA-306: a backend the last discovery found feeds the negotiated capabilities
    // (desktop.rdp / desktop.vnc, provenance "discovery"), so the normal capability path
    // can offer Desktop. Per request only: never persisted, never touches host.desktop/pin.
    const found = ['rdp', 'vnc'].filter((p) => host.desktopDiscovery?.[p]?.available === true && !(p === 'rdp' && host.desktopDiscovery.rdp.tls === false));
    if (found.length) {
      const base = view.effectiveCapabilities ?? view.capabilities ?? {};
      const desktop = { ...(base.desktop ?? {}) };
      const provenance = { ...(view.capabilityProvenance ?? {}) };
      for (const p of found) {
        if (desktop[p] !== true) provenance[`desktop.${p}`] = 'discovery';
        desktop[p] = true;
      }
      view.effectiveCapabilities = { ...base, desktop };
      view.capabilityProvenance = provenance;
    }
    return view;
  };
  // SAA-306: discovery has its own per-host limiter (one run per host per 10 s by default),
  // separate from SAA-305's VNC check (one per host per 5 s): discovery probes RDP and VNC
  // together, and an explanation fetch after a failed session must not be blocked by it.
  const discoveryLimiter = config.discoveryLimiter ?? createDiscoveryLimiter({ intervalMs: config.discoveryIntervalMs ?? 10_000 });

  async function refreshSetupCode() {
    if (store.owner) {
      setupCode = null;
      await fs.rm(setupCodeFile, { force: true });
      return;
    }
    setupCode = generateSetupCode();
    await fs.writeFile(setupCodeFile, `${setupCode}\n`, { mode: 0o600 });
  }
  await refreshSetupCode();

  sessions.onRevoke = (token) => {
    for (const ws of [...terminals, ...filesSessions]) if (ws.sessionToken === token) ws.close(4001, 'Logged out');
    for (const ws of desktops) if (ws.sessionToken === token) ws.bridge?.close(DESKTOP_CLOSE.AUTH, 'Logged out');
    for (const ws of soundSockets) if (ws.sessionToken === token) ws.close(SOUND_CLOSE.AUTH, 'Logged out');
  };

  const cookieOptions = (req) => ({
    httpOnly: true,
    sameSite: 'strict',
    secure: config.sessionCookieSecure || req.secure,
    path: '/',
    maxAge: config.sessionTtlMs,
  });

  const tokenOf = (req) => parseCookies(req.headers.cookie)[SESSION_COOKIE];

  const tooMany = (res, waitMs) => {
    const seconds = Math.ceil(waitMs / 1000);
    res.set('Retry-After', String(seconds));
    res.status(429).json({ error: `Too many attempts. Try again in ${Math.ceil(seconds / 60)} minute(s).` });
  };

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);
  const trustProxy = app.get('trust proxy fn');
  const requestHost = (req) => trustedHostname(req, trustProxy);

  const mcpRouter = await createMcpRouter({ config, store, sessions, registry, tokenOf, originAllowed, verifyPassword, requestHost, log });

  app.use((_req, res, next) => {
    res.set(SECURITY_HEADERS);
    next();
  });
  app.use(mcpRouter);

  const api = express.Router();
  api.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      // A missing Origin is refused too: browsers always send it on non-GET fetches, and
      // there are no non-browser callers of these routes (same rule as the WebSocket upgrades).
      if (!originAllowed(req.headers.origin, { ...req.headers, effectiveHost: requestHost(req) }, config.allowedOrigins)) {
        return res.status(403).json({ error: 'Cross-site request blocked.' });
      }
    }
    next();
  });
  api.use(express.json({ limit: '16kb' }));

  api.get('/auth/state', (req, res) => {
    const token = tokenOf(req);
    const authenticated = Boolean(store.owner) && sessions.touch(token);
    if (authenticated) res.cookie(SESSION_COOKIE, token, cookieOptions(req));
    res.json({ setupRequired: !store.owner, authenticated });
  });

  // Liveness for proxies/monitors (SAA-301). Public, so it reveals state only: no
  // guacd address or error text. RemoteHub itself is up even when guacd is not, so
  // this stays 200; `desktop.healthy` says whether Desktop can work right now.
  api.get('/health', async (_req, res) => {
    res.json({ ok: true, desktop: publicDesktopHealth(await guacd.check()) });
  });

  api.post('/auth/setup', async (req, res) => {
    if (store.owner) return res.status(409).json({ error: 'RemoteHub is already set up. Log in instead.' });
    const wait = limiter.retryAfterMs(req.ip);
    if (wait) return tooMany(res, wait);
    const code = String(req.body?.setupCode ?? '').trim().toUpperCase();
    if (!setupCode || !safeEqual(code, setupCode)) {
      limiter.fail(req.ip);
      return res.status(403).json({
        error: 'That setup code is not right. It is printed in the server console and saved in data/SETUP-CODE.txt.',
      });
    }
    const password = validateOwnerPassword(req.body?.password);
    await store.setOwner({ password: await hashPassword(password), createdAt: new Date().toISOString() });
    limiter.succeed(req.ip);
    await refreshSetupCode();
    log('owner account created');
    res.cookie(SESSION_COOKIE, sessions.create(), cookieOptions(req));
    res.json({ ok: true });
  });

  api.post('/auth/login', async (req, res) => {
    if (!store.owner) return res.status(409).json({ error: 'RemoteHub has not been set up yet.' });
    const wait = limiter.retryAfterMs(req.ip);
    if (wait) return tooMany(res, wait);
    const ok = await verifyPassword(req.body?.password, store.owner.password);
    if (!ok) {
      limiter.fail(req.ip);
      log(`failed login from ${req.ip}`);
      return res.status(401).json({ error: 'Wrong password.' });
    }
    limiter.succeed(req.ip);
    res.cookie(SESSION_COOKIE, sessions.create(), cookieOptions(req));
    res.json({ ok: true });
  });

  api.post('/auth/logout', (req, res) => {
    const token = tokenOf(req);
    if (token) sessions.revoke(token);
    res.clearCookie(SESSION_COOKIE, { ...cookieOptions(req), maxAge: undefined });
    res.json({ ok: true });
  });

  api.use((req, res, next) => {
    const token = tokenOf(req);
    if (!store.owner || !sessions.touch(token)) {
      return res.status(401).json({ error: 'Your session expired. Log in again.' });
    }
    res.cookie(SESSION_COOKIE, token, cookieOptions(req));
    next();
  });

  // Full guacd status for the signed-in owner: address, protocol, reason, latency.
  // `?fresh=1` skips the short cache (used by a "check again" action).
  api.get('/desktop/status', async (req, res) => {
    const fresh = req.query.fresh === '1';
    const [status, protocols] = await Promise.all([guacd.check({ fresh }), protocolSupport.check({ fresh })]);
    res.json({ guacd: status, protocols });
  });

  // SAA-305: read-only VNC pre-check for a host (RFB version + offered sign-in methods).
  // Used by the Desktop view to explain a failed VNC session. Never authenticates.
  // Owner-only (behind the session middleware above); it dials only the host's saved
  // desktop address/port, gives up after 3 s, and runs at most once per host per window.
  const vncCheckAt = new Map();
  const vncCheckIntervalMs = config.vncCheckIntervalMs ?? 5000;
  api.get('/hosts/:id/desktop/vnc-check', async (req, res) => {
    // SAA-346: this GET dials out, so refuse a foreign Origin like the other owner routes do.
    if (req.headers.origin && !originAllowed(req.headers.origin, { ...req.headers, effectiveHost: requestHost(req) }, config.allowedOrigins)) return res.status(403).json({ error: 'Cross-site request blocked.' });
    const host = store.getHost(req.params.id);
    if (host?.desktop?.protocol !== 'vnc') return res.status(404).json({ error: 'No VNC desktop for this computer.' });
    // Monotonic clock: a wall-clock step (NTP/WSL) must not shorten or stretch the limit.
    const last = vncCheckAt.get(host.id) ?? -Infinity;
    const now = performance.now();
    if (now - last < vncCheckIntervalMs) {
      res.set('Retry-After', String(Math.ceil((vncCheckIntervalMs - (now - last)) / 1000)));
      return res.status(429).json({ error: 'VNC check ran moments ago; try again shortly.' });
    }
    vncCheckAt.set(host.id, now);
    const check = await (config.vncProbe ?? probeVnc)({ host: host.address, port: host.desktop.port, timeoutMs: 3000 });
    const explanation = explainVncFailure(check, { address: host.address, port: host.desktop.port, passwordGiven: req.query.password === '1' });
    res.json({ check, explanation });
  });

  // SAA-306: owner-only (behind the session middleware above) desktop backend discovery.
  // Probes RDP (X.224 + TLS) and VNC (RFB version + offered methods) on the host's address.
  // It never sends credentials and never records or updates a certificate pin: results go
  // to host.desktopDiscovery, never to host.desktop.
  api.post('/hosts/:id/desktop/discover', async (req, res) => {
    const host = store.getHost(req.params.id);
    if (!host) return res.status(404).json({ error: 'Computer not found.' });
    const slot = discoveryLimiter.take(host.id);
    if (!slot.ok) {
      const retryAfterSeconds = Math.max(1, Math.ceil(slot.retryAfterMs / 1000));
      res.set('Retry-After', String(retryAfterSeconds));
      return res.status(429).json({ error: 'Checked moments ago. Try again shortly.', retryAfterSeconds });
    }
    // Snapshot what the probes are based on (address + saved desktop
    // protocol/port). If any of it changes, or the host is removed, while the probes run,
    // the result describes something else and is not written.
    const basis = (h) => JSON.stringify([h.address, h.desktop?.protocol ?? null, h.desktop?.port ?? null]);
    const before = basis(host);
    const [discovery] = await Promise.all([
      discoverDesktopBackends({ host: { ...host, desktop: host.desktop ? { ...host.desktop } : host.desktop }, extraPorts: config.discoveryPorts ?? {}, defaultPorts: config.discoveryDefaultPorts ?? DISCOVERY_DEFAULT_PORTS, probes: config.discoveryProbes ?? {} }),
      protocolSupport.check().catch(() => null),
    ]);
    const current = store.getHost(host.id);
    if (!current) return res.status(404).json({ error: 'Computer not found.' });
    if (basis(current) !== before) {
      log(`desktop discovery dropped host=${host.id} (host changed while checking)`);
      return res.status(409).json({ error: 'This computer was changed while RemoteHub was checking. Check again.' });
    }
    // No await between the check above and the in-memory update in setDesktopDiscovery.
    const updated = await store.setDesktopDiscovery(host.id, discovery);
    if (!updated) return res.status(404).json({ error: 'Computer not found.' });
    log(`desktop discovery host=${host.id} rdp=${discovery.rdp.available} vnc=${discovery.vnc.available}`);
    res.json({ host: viewHost(updated), discovery });
  });

  api.get('/hosts', (_req, res) => {
    res.json({ hosts: store.listHosts().map(viewHost) });
  });

  api.post('/hosts', async (req, res) => {
    const host = await store.addHost(validateHost(req.body));
    res.status(201).json({ host: viewHost(host) });
  });

  api.put('/hosts/:id', async (req, res) => {
    const before = store.getHost(req.params.id)?.address;
    const host = await store.updateHost(req.params.id, validateHost(req.body));
    if (!host) return res.status(404).json({ error: 'Computer not found.' });
    // SAA-304: a new address is a different machine; its RDP certificate is learned again.
    if (before !== host.address && host.desktop?.certPin) {
      await store.setDesktopCertPin(host.id, null);
      log(`desktop rdp certificate pin cleared host=${host.id} (address changed)`);
    }
    // SAA-306: discovery results belong to the old machine; a confirmation must never pair the
    // new address with a port found there. Run discovery again for the new address.
    if (before !== host.address && host.desktopDiscovery) {
      await store.setDesktopDiscovery(host.id, null);
      log(`desktop discovery cleared host=${host.id} (address changed)`);
    }
    res.json({ host: viewHost(host) });
  });

  api.delete('/hosts/:id', async (req, res) => {
    if (!(await store.removeHost(req.params.id))) return res.status(404).json({ error: 'Computer not found.' });
    discoveryLimiter.forget(req.params.id); // SAA-306
    vncCheckAt.delete(req.params.id);
    registry.disconnect(req.params.id, AGENT_CLOSE.UNKNOWN_HOST, 'host deleted');
    res.json({ ok: true });
  });

  api.post('/hosts/:id/agent', async (req, res) => {
    const issued = await store.issueAgentCredential(req.params.id);
    if (!issued) return res.status(404).json({ error: 'Computer not found.' });
    registry.disconnect(req.params.id, AGENT_CLOSE.REPLACED, 'credential replaced');
    log(`agent credential issued host=${req.params.id}`);
    res.status(201).json({ host: viewHost(issued.host), token: issued.token });
  });

  api.delete('/hosts/:id/agent', async (req, res) => {
    const host = await store.revokeAgentCredential(req.params.id);
    if (!host) return res.status(404).json({ error: 'Computer not found.' });
    registry.disconnect(req.params.id, AGENT_CLOSE.REVOKED, 'revoked');
    log(`agent credential revoked host=${req.params.id}`);
    res.json({ ok: true, host: viewHost(host) });
  });

  // SAA-317: one-click install of the persistent agent. The SSH password is used for this login
  // only (server/agent-install.js). The agent is pointed back at this RemoteHub and nowhere else.
  api.post('/hosts/:id/agent/install', async (req, res) => {
    const host = store.getHost(req.params.id);
    if (!host) return res.status(404).json({ error: 'Computer not found.' });
    const body = req.body ?? {};
    const password = body.password;
    body.password = undefined;
    if (typeof password !== 'string' || !password || password.length > 1024) {
      return res.status(400).json({ error: 'Enter the SSH password for this computer.', code: 'password' });
    }
    const serverUrl = agentServerUrl(body.serverUrl, requestHost(req));
    if (!serverUrl) return res.status(400).json({ error: 'The agent must connect back to this RemoteHub server.', code: 'server-url' });
    if (!reachableFrom(serverUrl, host.address)) {
      return res.status(400).json({ error: 'This page is open as localhost, which another computer can’t reach. Open RemoteHub by its network address (the one this computer would use), then install the agent.', code: 'server-url-loopback' });
    }
    const acceptFingerprint = body.acceptFingerprint ?? null;
    if (acceptFingerprint !== null && (typeof acceptFingerprint !== 'string' || acceptFingerprint.length > 200)) {
      return res.status(400).json({ error: 'That fingerprint is not valid.', code: 'fingerprint' });
    }
    try {
      const installed = await installAgent({ store, registry, host, password, acceptFingerprint, serverUrl, helperDir: config.helperDir, log });
      res.json({
        ok: true,
        host: viewHost(installed.host),
        message: installed.connected === false
          ? `The agent is installed on ${host.name}, but it has not connected yet. It usually takes a few seconds; this page shows Connected when it does.`
          : `The agent is installed on ${host.name} as a background service and connected.`,
      });
    } catch (error) {
      const known = error instanceof HelperError;
      const code = known ? error.code : 'deploy';
      const payload = { error: known ? error.message : 'The agent couldn’t be installed on this computer.', code };
      if (code === 'hostkey-new') Object.assign(payload, { fingerprint: error.fingerprint, keyType: error.keyType });
      res.status(INSTALL_STATUS[code] ?? 500).json(payload);
    }
  });

  // SAA-302: desktop settings live only on the server. The browser later picks a host by
  // id; it can never choose the address, port, protocol or guacd parameters itself.
  api.put('/hosts/:id/desktop', async (req, res) => {
    const host = store.getHost(req.params.id);
    if (!host) return res.status(404).json({ error: 'Computer not found.' });
    // SAA-305: capability-driven protocol choice. No protocol in the body -> pick from the
    // host's capabilities and guacd's plugins; an explicit one is refused only when guacd is already known to lack its plugin.
    const body = { ...(req.body ?? {}) };
    // Guard (all paths): credentials and the pin are never accepted from the browser.
    if ('password' in body) return res.status(400).json({ error: 'Desktop passwords are not stored. Enter the password when you connect.' });
    if ('certPin' in body) return res.status(400).json({ error: "RemoteHub remembers this computer's identity on first connect; it can't be set by hand." });
    // SAA-306: `preference` ('auto', 'rdp' or 'vnc') picks the protocol from the LAST discovery
    // (fixed order RDP > VNC; Auto skips RDP without TLS); it is remembered on the host.
    const preference = body.preference;
    const confirm = body.confirm;
    delete body.preference;
    delete body.confirm;
    if (confirm !== undefined && (preference === undefined || body.protocol !== undefined)) {
      return res.status(400).json({ error: 'A confirmation only works when choosing a desktop connection.' });
    }
    if (preference !== undefined) {
      if (!DESKTOP_PREFERENCES.includes(preference)) return res.status(400).json({ error: 'Desktop connection must be Auto, RDP or VNC.' });
      if (preference === 'nativeStream') return res.status(400).json({ error: NATIVE_NOT_YET });
      if (body.protocol !== undefined && String(body.protocol).toLowerCase() !== preference) {
        return res.status(400).json({ error: 'The chosen desktop connection and the requested type don\'t match.' });
      }
      if (!body.protocol) {
        // Preference-only save (the Desktop first click / chooser). Same route, same owner
        // session + Origin check, same validateDesktopSettings + capability code below.
        // Only a backend the LAST discovery actually found; the port comes from that
        // discovery result (the address is always the host record's), never from the client.
        for (const key of ['port', 'address', 'host', 'hostname']) {
          if (key in body) return res.status(400).json({ error: "The desktop port comes from RemoteHub's last check; it can't be set here." });
        }
        await protocolSupport.check().catch(() => null); // refresh guacd plugin support
        // A backend found only on a port the owner has not saved (default or
        // DESKTOP_DISCOVERY_PORTS) needs an explicit confirmation naming exactly this host's
        // address and the discovered port. Anything else is refused.
        if (confirm !== undefined) {
          const ok = confirm && typeof confirm === 'object' && ['rdp', 'vnc'].includes(confirm.protocol)
            && confirm.address === host.address && Number.isInteger(confirm.port)
            && host.desktopDiscovery?.[confirm.protocol]?.available === true && host.desktopDiscovery[confirm.protocol].port === confirm.port;
          if (!ok) return res.status(400).json({ error: "The confirmation doesn't match this computer's address and the port RemoteHub found." });
        }
        const view = viewHost(host);
        const picked = selectDesktopBackend(restrictToDiscovery(view.desktopBackends, host.desktopDiscovery), preference, { confirm: confirm ?? null });
        if (!picked.backend) {
          const needsConfirm = picked.needsConfirm ? { ...picked.needsConfirm, address: host.address } : undefined;
          return res.status(400).json({ error: picked.reason, reasons: picked.reasons, helper: picked.helper, ...(needsConfirm ? { needsConfirm } : {}) });
        }
        body.protocol = picked.backend;
        const found = host.desktopDiscovery[picked.backend];
        if (Number.isInteger(found.port)) body.port = found.port;
        // Keep the saved (non-secret) username/domain when the protocol stays the same.
        if (host.desktop?.protocol === picked.backend) {
          for (const key of ['username', 'domain']) if (body[key] === undefined && host.desktop[key]) body[key] = host.desktop[key];
        }
      }
    }
    if (!body.protocol) {
      const supported = await protocolSupport.check();
      const picked = selectDesktopProtocol(viewHost(host), supported, host.desktop?.protocol ?? null);
      if (!picked.protocol) return res.status(400).json({ error: picked.reason });
      body.protocol = picked.protocol;
    } else if (protocolSupport.known(String(body.protocol).toLowerCase()) === false && config.guacd?.enabled) {
      return res.status(400).json({ error: `RemoteHub can’t open ${String(body.protocol).toUpperCase()} desktops right now. Pick another desktop type.` });
    }
    // RDP without TLS is unsupported. Refuse saving RDP on a port the last discovery
    // found without TLS (the preference path is refused by selectDesktopBackend with the same text).
    const noTls = host.desktopDiscovery?.rdp;
    if (String(body.protocol).toLowerCase() === 'rdp' && noTls?.available === true && noTls.tls === false
        && Number(body.port ?? host.desktop?.port ?? 3389) === noTls.port) {
      return res.status(400).json({ error: NO_TLS_RDP });
    }
    const previousProtocol = host.desktop?.protocol ?? null;
    const desktop = validateDesktopSettings(body, host.desktop);
    // One atomic store write: settings + capabilities (+ preference).
    // When the saved desktop port changes (any protocol, incl. the first save), the
    // last discovery no longer describes what is saved; drop it in the same atomic write.
    const portChanged = previousProtocol !== desktop.protocol || host.desktop?.port !== desktop.port;
    // Keep discovery when the save is exactly what discovery found at this address
    // (protocol + port); discovery is already cleared whenever the address changes.
    const found = host.desktopDiscovery?.[desktop.protocol];
    const matchesDiscovery = found?.available === true && found.port === desktop.port;
    const updated = await store.saveDesktopChoice(host.id, { desktop, capabilities: capabilitiesWithDesktop(host.capabilities, desktop.protocol, previousProtocol), preference, clearDiscovery: portChanged && !matchesDiscovery && Boolean(host.desktopDiscovery) });
    log(`desktop settings saved host=${host.id} protocol=${updated.desktop.protocol}${preference !== undefined ? ` preference=${preference}` : ''}`);
    res.json({ host: viewHost(updated) });
  });

  api.delete('/hosts/:id/desktop', async (req, res) => {
    const previousProtocol = store.getHost(req.params.id)?.desktop?.protocol ?? null;
    const host = await store.setDesktop(req.params.id, null);
    if (!host) return res.status(404).json({ error: 'Computer not found.' });
    if (previousProtocol) await store.updateHost(host.id, { capabilities: capabilitiesWithDesktop(host.capabilities, null, previousProtocol) }); // SAA-305
    if (host.desktopDiscovery) await store.setDesktopDiscovery(host.id, null); // SAA-306: saved port removed
    for (const ws of desktops) if (ws.hostId === host.id) ws.bridge?.close(DESKTOP_CLOSE.UNAVAILABLE, 'Desktop removed');
    res.json({ host: viewHost(host) });
  });

  // SAA-304: owner-only (every API route is behind the owner session) reset of the RDP
  // certificate pin after a legitimate certificate change. The next connect pins again.
  api.delete('/hosts/:id/desktop/cert-pin', async (req, res) => {
    const host = store.getHost(req.params.id);
    if (!host) return res.status(404).json({ error: 'Computer not found.' });
    if (host.desktop?.protocol !== 'rdp') return res.status(404).json({ error: 'No RDP desktop for this computer.' });
    await store.setDesktopCertPin(host.id, null);
    log(`desktop rdp certificate pin reset host=${host.id}`);
    res.json({ host: viewHost(store.getHost(host.id)) });
  });

  api.delete('/hosts/:id/fingerprint', async (req, res) => {
    const host = store.getHost(req.params.id);
    if (!host) return res.status(404).json({ error: 'Computer not found.' });
    await store.forgetKnownHost(host.address, host.port);
    log(`fingerprint forgotten for ${host.address}:${host.port}`);
    res.json({ ok: true });
  });

  api.use((_req, res) => res.status(404).json({ error: 'Not found.' }));

  // eslint-disable-next-line no-unused-vars
  api.use((err, _req, res, _next) => {
    if (err instanceof ValidationError) return res.status(400).json({ error: err.message });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Request body must be valid JSON.' });
    if (err.status && err.status < 500) return res.status(err.status).json({ error: err.message });
    log(`api error: ${redactSecrets(err.stack || err.message)}`);
    res.status(500).json({ error: 'Something went wrong on the RemoteHub server.' });
  });

  app.use('/api', api);

  app.get('/tokens.css', (_req, res) => {
    res.sendFile(path.join(ROOT, 'design-system', 'editorial-mono', 'tokens.css'));
  });
  app.use('/vendor/xterm/lib', express.static(path.join(MODULES, '@xterm', 'xterm', 'lib')));
  app.use('/vendor/xterm/css', express.static(path.join(MODULES, '@xterm', 'xterm', 'css')));
  app.use('/vendor/xterm-fit/lib', express.static(path.join(MODULES, '@xterm', 'addon-fit', 'lib')));
  app.use('/vendor/fonts/space-mono', express.static(path.join(MODULES, '@fontsource', 'space-mono')));
  app.use('/vendor/fonts/space-grotesk', express.static(path.join(MODULES, '@fontsource', 'space-grotesk')));
  app.use(express.static(PUBLIC_DIR));

  const server = http.createServer(app);
  // This caps peer-to-server frames; large fs.write requests are separately bounded on the server-to-agent path.
  const wss = new WebSocketServer({ noServer: true, clientTracking: false, maxPayload: 1024 * 1024 });

  const routes = {
    '/ws/terminal': { attach: attachTerminal, sockets: terminals, max: () => config.maxTerminals },
    '/ws/files': { attach: attachFiles, sockets: filesSessions, max: () => config.maxFiles },
  };

  server.on('upgrade', (req, socket, head) => {
    const onSocketError = () => socket.destroy();
    socket.on('error', onSocketError);
    const reject = (status, text) => {
      socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      socket.destroy();
    };

    const { pathname } = new URL(req.url, 'http://localhost');
    if (pathname === '/ws/agent') {
      if (agents.size >= (config.maxAgents ?? 32)) return reject(503, 'Service Unavailable');
      socket.removeListener('error', onSocketError);
      wss.handleUpgrade(req, socket, head, (ws) => {
        ws.isAlive = true;
        ws.on('pong', () => { ws.isAlive = true; });
        agents.add(ws);
        ws.on('close', () => agents.delete(ws));
        attachAgent(ws, { store, registry, log, limiter: agentLimiter, clientIp: req.socket.remoteAddress, hostStatus, sound });
      });
      return;
    }

    // Desktop sound from the computer's RemoteHub agent (server/desktop-sound.js).
    if (pathname === '/ws/desktop-sound') {
      const originOk = originAllowed(req.headers.origin, { ...req.headers, effectiveHost: requestHost(req) }, config.allowedOrigins);
      if (soundSockets.size >= (config.maxDesktops ?? 8)) return reject(503, 'Service Unavailable');
      socket.removeListener('error', onSocketError);
      wss.handleUpgrade(req, socket, head, (ws) => {
        // Refusals happen after the upgrade so the tab sees the close code.
        if (!originOk) return ws.close(SOUND_CLOSE.ORIGIN, 'This page’s address isn’t allowed.');
        const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
        if (!store.owner || !sessions.touch(token)) return ws.close(SOUND_CLOSE.AUTH, 'Log in again.');
        const host = store.getHost(String(new URL(req.url, 'http://localhost').searchParams.get('hostId') ?? ''));
        if (!host) return ws.close(SOUND_CLOSE.UNKNOWN_HOST, 'That computer no longer exists.');
        ws.sessionToken = token;
        ws.isAlive = true;
        ws.on('pong', () => { ws.isAlive = true; });
        soundSockets.add(ws);
        ws.on('close', () => soundSockets.delete(ws));
        sound.attach(ws, host.id);
      });
      return;
    }

    if (pathname === '/ws/desktop') {
      const originOk = originAllowed(req.headers.origin, { ...req.headers, effectiveHost: requestHost(req) }, config.allowedOrigins);
      if (desktops.size >= (config.maxDesktops ?? 8)) return reject(503, 'Service Unavailable');
      socket.removeListener('error', onSocketError);
      wss.handleUpgrade(req, socket, head, (ws) => {
        // Refusals happen after the upgrade so the browser sees the contract close code.
        const refuse = (code, reason) => ws.close(code, reason);
        // Foreign Origin: closed at once with 4403, before any session, guacd or desktop-count work.
        if (!originOk) return refuse(DESKTOP_CLOSE.ORIGIN, 'This page’s address isn’t allowed.');
        const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
        if (!store.owner || !sessions.touch(token)) return refuse(DESKTOP_CLOSE.AUTH, 'Log in again.');
        if (!config.guacd?.enabled) return refuse(DESKTOP_CLOSE.BACKEND_DOWN, 'Desktop is disabled.');
        const query = new URL(req.url, 'http://localhost').searchParams;
        const host = store.getHost(String(query.get('hostId') ?? ''));
        if (!host?.desktop) return refuse(DESKTOP_CLOSE.UNAVAILABLE, 'No desktop for this computer.');
        // SAA-305: the saved protocol must be a host capability and servable by guacd.
        const allowed = selectDesktopProtocol(viewHost(host), { [host.desktop.protocol]: protocolSupport.known(host.desktop.protocol) }, host.desktop.protocol);
        if (!allowed.protocol) return refuse(allowed.missing === 'plugin' ? DESKTOP_CLOSE.BACKEND_DOWN : DESKTOP_CLOSE.UNAVAILABLE, allowed.reason);
        const size = browserSize(query);
        ws.sessionToken = token;
        ws.hostId = host.id;
        ws.isAlive = true;
        ws.on('pong', () => { ws.isAlive = true; });
        desktops.add(ws);
        ws.on('close', () => desktops.delete(ws));
        const preflight = host.desktop.protocol === 'rdp' ? () => rdpPreflight({
          host, settings: host.desktop, log, probe: config.rdpProbe,
          savePin: async (pin) => {
            const { result } = await store.setDesktopCertPin(host.id, pin, { onlyIfUnset: true });
            if (result === 'changed') throw { code: RDP_CLOSE.CERT_CHANGED, reason: 'This computer looks different from last time. If you expected that, click “Trust this computer again”.' };
          },
        }) : null;
        ws.bridge = attachDesktop(ws, { host, settings: host.desktop, guacd: config.guacd, size, fixedSize: browserFixedSize(query), log, timeouts: config.desktopTimeouts, preflight });
      });
      return;
    }

    const route = routes[pathname];
    if (!route) return reject(404, 'Not Found');
    if (!originAllowed(req.headers.origin, { ...req.headers, effectiveHost: requestHost(req) }, config.allowedOrigins)) return reject(403, 'Forbidden');
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (!store.owner || !sessions.touch(token)) return reject(401, 'Unauthorized');
    if (route.sockets.size >= route.max()) return reject(503, 'Service Unavailable');

    socket.removeListener('error', onSocketError);
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.sessionToken = token;
      ws.isAlive = true;
      ws.on('pong', () => { ws.isAlive = true; });
      route.sockets.add(ws);
      ws.on('close', () => route.sockets.delete(ws));
      route.attach(ws, { store, log, agentPort: config.agentPort, helperDir: config.helperDir, helperOptions: config.helperOptions, hostStatus });
    });
  });

  // Reverse proxies drop idle WebSockets (nginx defaults to 60s), so ping well inside that window.
  const heartbeat = setInterval(() => {
    for (const ws of [...terminals, ...filesSessions, ...agents, ...desktops, ...soundSockets]) {
      if (!ws.isAlive) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
  }, 25_000);
  heartbeat.unref();

  server.on('close', () => clearInterval(heartbeat));

  return {
    server,
    store,
    sessions,
    registry,
    hostStatus,
    guacd,
    get setupCode() {
      return setupCode;
    },
    closeTerminals() {
      for (const ws of terminals) ws.close(1001, 'Server shutting down');
    },
    closeFiles() {
      for (const ws of filesSessions) ws.close(1001, 'Server shutting down');
    },
    closeDesktops() {
      for (const ws of desktops) ws.bridge ? ws.bridge.close(1001, 'Server shutting down') : ws.close(1001, 'Server shutting down');
      for (const ws of soundSockets) ws.close(1001, 'Server shutting down');
    },
    closeAgents() {
      registry.closeAll(1001, 'Server shutting down');
    },
  };
}
