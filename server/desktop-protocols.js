// Capability-driven desktop protocol selection (SAA-305).
//
// A desktop session may use protocol P only when BOTH hold:
//   1. the host's (effective) capabilities say desktop.P is true, and
//   2. guacd has the P plugin loaded (a real `select P` -> `args` handshake).
// Saving desktop settings records desktop.P = true on the host (the owner has told us
// the host runs that server); removing them clears it. OS names are never consulted.

import { probeGuacd } from './guacd.js';

export const GUACD_PROTOCOLS = Object.freeze(['rdp', 'vnc']);

/** Which protocols guacd can serve right now; cached, single-flight per protocol. */
export function createProtocolSupport(guacdConfig, { probe = probeGuacd, now = Date.now, cacheMs = 30_000 } = {}) {
  const last = new Map();
  const inflight = new Map();
  const checkOne = (protocol, fresh) => {
    const hit = last.get(protocol);
    if (!fresh && hit && now() - hit.at < cacheMs) return Promise.resolve(hit.value);
    if (!inflight.has(protocol)) {
      inflight.set(protocol, probe({ ...guacdConfig, protocol }).then((outcome) => {
        const value = outcome.status === 'up';
        // SAA-347: only an answer from guacd itself says whether the plugin exists. When guacd
        // is down or slow, forget (not cache) the answer, so a restarted guacd is usable at
        // once instead of being reported as "plugin not installed" for the cache window.
        if (value || outcome.status === 'protocol-unavailable') last.set(protocol, { at: now(), value });
        else last.delete(protocol);
        return value;
      }).finally(() => inflight.delete(protocol)));
    }
    return inflight.get(protocol);
  };
  return {
    async check({ fresh = false } = {}) {
      if (!guacdConfig?.enabled) return Object.fromEntries(GUACD_PROTOCOLS.map((p) => [p, false]));
      const values = await Promise.all(GUACD_PROTOCOLS.map((p) => checkOne(p, fresh)));
      return Object.fromEntries(GUACD_PROTOCOLS.map((p, i) => [p, values[i]]));
    },
    /** Last known answer without probing (undefined when never checked). */
    known(protocol) { return last.get(protocol)?.value; },
  };
}

function desktopCaps(host) { return host?.effectiveCapabilities?.desktop ?? host?.capabilities?.desktop ?? {}; }

/**
 * Pick the protocol for a host. `preferred` (e.g. the protocol in a PUT body or the saved
 * one) wins when it is allowed. Otherwise the first allowed protocol in capability order.
 * Returns { protocol } or { protocol: null, reason }.
 */
export function selectDesktopProtocol(host, supported = {}, preferred = null) {
  const caps = desktopCaps(host);
  const allowed = GUACD_PROTOCOLS.filter((p) => caps[p] === true && supported[p] !== false);
  if (preferred && allowed.includes(preferred)) return { protocol: preferred };
  if (preferred) {
    if (caps[preferred] !== true) return { protocol: null, missing: 'capability', reason: `This computer doesn’t offer a ${preferred.toUpperCase()} desktop.` };
    return { protocol: null, missing: 'plugin', reason: `RemoteHub can’t open ${preferred.toUpperCase()} desktops right now.` };
  }
  if (allowed.length) return { protocol: allowed[0] };
  return { protocol: null, reason: 'RemoteHub can’t open a desktop on this computer.' };
}

/** Capabilities after saving (protocol) or removing (null) a host's desktop settings. */
export function capabilitiesWithDesktop(capabilities, protocol, previousProtocol = null) {
  const desktop = { ...(capabilities?.desktop ?? {}) };
  if (previousProtocol && previousProtocol !== protocol) desktop[previousProtocol] = false;
  if (protocol) desktop[protocol] = true;
  return { ...(capabilities ?? {}), desktop };
}

// ── SAA-306: backend list + Auto/preference selection ─────────────────────────────
// Fixed order RDP > VNC (native stream listed, not selectable until SAA-311). See
// public/js/desktop-auto.js and deploy/guacd.md "Desktop backend discovery and Auto".
import { DESKTOP_PREFERENCES, NATIVE_NOT_YET, NO_TLS_RDP, desktopBackends, restrictToDiscovery, selectDesktopBackend } from '../public/js/desktop-auto.js';

export { DESKTOP_PREFERENCES, NATIVE_NOT_YET, NO_TLS_RDP, restrictToDiscovery, selectDesktopBackend };

/** Backends for a host view: discovery + (effective) capabilities + guacd plugin support. */
export function hostDesktopBackends(host, supported = {}, { guacdEnabled = true } = {}) {
  return desktopBackends({
    discovery: host?.desktopDiscovery ?? {},
    capabilities: host?.effectiveCapabilities ?? host?.capabilities ?? {},
    guacdProtocols: supported,
    guacdEnabled,
    saved: host?.desktop?.protocol ? { protocol: host.desktop.protocol, port: host.desktop.port } : null,
  });
}
