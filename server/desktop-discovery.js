// SAA-306: discover which desktop backends a host offers, by probing - never by OS name.
//
// - RDP: SAA-304's certificate probe (X.224 negotiation, then TLS). It sends no
//   credentials and pins nothing; pinning stays in the RDP preflight at connect time.
// - VNC: SAA-305's read-only RFB check (probeVnc). It reads the server's version and offered
//   sign-in methods, answers only the version, and never picks a security type or sends a password.
// - Native stream: not probed; it comes from live agent reports (capabilities).
//
// Owner-triggered only (POST /api/hosts/:id/desktop/discover). Probes run in parallel, each with
// a timeout, and at most once per host per interval (createDiscoveryLimiter).
// Results hold no secrets: availability, port, a short reason, and a check time.
import { probeRdpCertificate } from './rdp.js';
import { probeVnc } from './vnc.js';

export const DISCOVERY_DEFAULT_PORTS = Object.freeze({ rdp: 3389, vnc: 5900 });
export const DISCOVERY_TIMEOUT_MS = 3000;

// One reason table for both protocols (shared codes), plus protocol-specific ones.
const NAME = { rdp: 'RDP', vnc: 'VNC' };
const REASONS = {
  unreachable: () => 'Nothing answered when RemoteHub looked for a remote desktop.',
  timeout: (P) => `No answer in time from the ${NAME[P]} remote desktop.`,
  closed: (P) => `Something answered, but it hung up during the ${NAME[P]} check.`,
  protocol: (P) => `Something answered, but it isn't an ${NAME[P]} remote desktop.`,
  'not-vnc': () => 'Something answered, but it isn’t a VNC remote desktop.',
  failed: (P) => `RemoteHub couldn't check the ${NAME[P]} remote desktop.`,
  // RDP
  tls: () => 'The RDP remote desktop couldn’t set up a secure connection.',
  'no-cert': () => 'The RDP remote desktop didn’t identify itself securely.',
  // VNC
  refused: () => 'The VNC remote desktop turned RemoteHub away.',
  unsupported: () => 'The VNC remote desktop uses a sign-in method RemoteHub doesn’t support.',
};
export const discoveryReason = (protocol, code, port) => (REASONS[code] ?? REASONS.failed)(protocol, port);

/** Default RDP probe: SAA-304's certificate check, mapped to a discovery result. */
export async function probeRdpBackend({ host, port, timeoutMs = DISCOVERY_TIMEOUT_MS, probe = probeRdpCertificate }) {
  try {
    await probe({ host, port, timeoutMs });
    return { available: true, port, tls: true, reason: '' };
  } catch (err) {
    // RDP without TLS is unsupported: reported as found (tls: false) so the UI can say why,
    // but desktopBackends marks it unavailable and every pick of it is refused.
    if (err?.code === 'no-tls') return { available: true, port, tls: false, reason: '', note: 'Unsupported.' };
    return { available: false, port, reason: discoveryReason('rdp', err?.code, port) };
  }
}

/** Default VNC probe: SAA-305's read-only RFB check, mapped to a discovery result. */
export async function probeVncBackend({ host, port, timeoutMs = DISCOVERY_TIMEOUT_MS, probe = probeVnc }) {
  const check = await probe({ host, port, timeoutMs });
  if (check?.status === 'ok' && check.supported !== false) {
    return { available: true, port, reason: '', ...(check.needsPassword ? { note: 'Asks for a password.' } : {}) };
  }
  // A server that refused the check connection is NOT available: we could not confirm it.
  const code = check?.status === 'ok' ? 'unsupported' : check?.status;
  return { available: false, port, reason: discoveryReason('vnc', code, port) };
}

function clean(result, port, now) {
  const out = { available: result?.available === true, port: Number.isInteger(result?.port) ? result.port : port, reason: String(result?.reason ?? '').slice(0, 200), checkedAt: new Date(now()).toISOString() };
  if (typeof result?.tls === 'boolean') out.tls = result.tls;
  if (result?.note) out.note = String(result.note).slice(0, 200);
  return out;
}

/** Ports to probe for one protocol, in priority order: owner-saved, server-configured, default. */
export function discoveryPortsFor(protocol, host, { extraPorts = {}, defaultPorts = DISCOVERY_DEFAULT_PORTS } = {}) {
  const saved = host?.desktop?.protocol === protocol && Number.isInteger(host.desktop.port) ? host.desktop.port : null;
  return [...new Set([saved, extraPorts[protocol], defaultPorts[protocol]].filter((p) => Number.isInteger(p)))];
}

/**
 * Probe a host for RDP and VNC. Each protocol is checked on its default port, on any port
 * the owner saved for that protocol on the host, and on DESKTOP_DISCOVERY_PORTS (server
 * config). Never on a port from the request. The result per protocol is the first available
 * candidate (saved > configured > default; for RDP a TLS one before a no-TLS one), else the
 * highest-priority failure; `tried` lists every port checked.
 * @param {object} opts
 * @param {{ address: string, desktop?: { protocol?: string, port?: number } }} opts.host
 * @param {{ rdp?: number, vnc?: number }} [opts.extraPorts] DESKTOP_DISCOVERY_PORTS
 * @param {{ rdp?: number, vnc?: number }} [opts.defaultPorts] defaults (DESKTOP_DISCOVERY_DEFAULT_PORTS)
 * @param {{ rdp?: Function, vnc?: Function }} [opts.probes]
 */
export async function discoverDesktopBackends({ host, extraPorts = {}, defaultPorts = DISCOVERY_DEFAULT_PORTS, probes = {}, timeoutMs = DISCOVERY_TIMEOUT_MS, now = Date.now }) {
  if (!host?.address) throw new Error('discoverDesktopBackends needs a computer address.');
  const probeOne = async (backend, probe, port) => {
    let timer;
    const guard = new Promise((resolve) => { timer = setTimeout(() => resolve({ available: false, port, reason: discoveryReason(backend, 'timeout', port) }), timeoutMs + 500); });
    try {
      const result = await Promise.race([Promise.resolve().then(() => probe({ host: host.address, port, timeoutMs })), guard]);
      return clean(result, port, now);
    } catch {
      return clean({ available: false, reason: discoveryReason(backend, 'failed', port) }, port, now);
    } finally { clearTimeout(timer); }
  };
  const run = async (backend, probe) => {
    const ports = discoveryPortsFor(backend, host, { extraPorts, defaultPorts });
    const results = await Promise.all(ports.map((port) => probeOne(backend, probe, port)));
    const best = results.find((r) => r.available && r.tls !== false) ?? results.find((r) => r.available) ?? results[0];
    return { ...best, tried: results.map(({ port, available, reason }) => ({ port, available, reason })) };
  };
  const [rdp, vnc] = await Promise.all([run('rdp', probes.rdp ?? probeRdpBackend), run('vnc', probes.vnc ?? probeVncBackend)]);
  return { rdp, vnc };
}

/** At most one discovery per host per interval; reports when the next one is allowed. */
export function createDiscoveryLimiter({ intervalMs = 10_000, now = Date.now } = {}) {
  const last = new Map();
  return {
    take(hostId) {
      const at = last.get(hostId) ?? -Infinity;
      const wait = intervalMs - (now() - at);
      if (wait > 0) return { ok: false, retryAfterMs: wait };
      last.set(hostId, now());
      return { ok: true };
    },
    forget(hostId) { last.delete(hostId); },
  };
}

/**
 * SAA-306: parse DESKTOP_DISCOVERY_PORTS / DESKTOP_DISCOVERY_DEFAULT_PORTS
 * ("vnc=15901,rdp=13389"). Server config only: the browser can never choose which port is
 * probed or saved. Throws on bad input (fail at startup).
 */
export function parseDiscoveryPorts(raw, name = 'DESKTOP_DISCOVERY_PORTS') {
  const out = {};
  for (const item of String(raw ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
    const m = /^(rdp|vnc)\s*[=:]\s*(\d{1,5})$/i.exec(item);
    const port = m ? Number(m[2]) : NaN;
    if (!m || port < 1 || port > 65535) throw new Error(`${name} must look like "vnc=5901,rdp=3389".`);
    out[m[1].toLowerCase()] = port;
  }
  return out;
}
