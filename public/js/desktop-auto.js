// SAA-306: desktop backend Auto selection. Pure: no DOM, no Node APIs, so the server
// and the browser share it.
//
// Documented preference (owner-approved, never based on the host's OS):
//   1. RDP  - TLS with a pinned certificate (SAA-304)
//   2. VNC  - through guacd (SAA-305)
//   3. RemoteHub stream (coming soon) - listed when an agent reports it, but not selectable until
//      SAA-311 integrates it into DesktopSession.
//
// RDP without TLS is unsupported: it is listed with NO_TLS_RDP as its reason, is never
// available or selectable, Auto skips it, and an explicit pick of RDP is refused with that message.
//
// A backend found ONLY on a port the owner has not saved for it (a default port or
// DESKTOP_DISCOVERY_PORTS) is "unconfirmed": shown available, never chosen by Auto, and usable
// only after the owner confirms that exact address:port (the server enforces the match).
//
// A backend entry: { backend, available, selectable, insecure (RDP found without TLS: unsupported), unconfirmed, port, note, reason }.
//   available  - the host offers it (probe, agent report or configured) AND RemoteHub can
//                serve it (guacd plugin present, where relevant)
//   selectable - available and implemented (false for nativeStream for now)
//   reason     - why it is not available or selectable ('' when it is)

export const DESKTOP_BACKEND_ORDER = Object.freeze(['rdp', 'vnc', 'nativeStream']);
export const DESKTOP_PREFERENCES = Object.freeze(['auto', ...DESKTOP_BACKEND_ORDER]);
export const BACKEND_LABELS = Object.freeze({ auto: 'Auto (recommended)', nativeStream: 'RemoteHub stream', rdp: 'RDP', vnc: 'VNC' });
export const NATIVE_NOT_YET = "RemoteHub's own desktop streaming isn't available yet.";
export const NO_TLS_RDP = "RemoteHub can't open a remote desktop on this computer. Try VNC instead.";
export const NOT_CHECKED = 'not checked (use Check desktop options)';
const NOT_DISCOVERED = 'Not found the last time RemoteHub checked. Click Check desktop options first.';

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * Combine everything RemoteHub knows into one entry per backend, in preference order.
 * @param {object} input
 * @param {object} [input.discovery]   { rdp|vnc: { available, reason } } from desktop-discovery
 * @param {object} [input.capabilities] effective host capabilities ({ desktop: { rdp, vnc, nativeStream } })
 * @param {object} [input.guacdProtocols] { rdp, vnc } plugin support (false = known missing; unknown counts as present)
 * @param {boolean} [input.guacdEnabled] Desktop turned on on this RemoteHub server
 * @param {object} [input.saved] the host's saved desktop settings ({ protocol, port }), if any
 */
export const DESKTOP_NOT_SET_UP_HERE = 'Remote desktop isn’t set up in this copy of RemoteHub yet. You can still connect with the terminal.';

export function desktopBackends({ discovery = {}, capabilities = {}, guacdProtocols = {}, guacdEnabled = true, saved = null } = {}) {
  const caps = isObject(capabilities?.desktop) ? capabilities.desktop : {};
  return DESKTOP_BACKEND_ORDER.map((backend) => {
    if (backend === 'nativeStream') {
      const offered = caps.nativeStream === true;
      return { backend, available: offered, selectable: false, source: offered ? 'agent' : null,
        reason: offered ? NATIVE_NOT_YET : 'Needs the RemoteHub agent installed on this computer.' };
    }
    const found = isObject(discovery?.[backend]) ? discovery[backend] : null;
    // The latest real probe wins over saved settings: if discovery just found nothing on the
    // port, a configured backend is reported unavailable with the probe's reason.
    const probedDown = found?.available === false;
    const offered = found?.available === true || (caps[backend] === true && !probedDown);
    const source = found?.available === true ? 'probe' : offered ? 'configured' : null;
    let reason = '';
    // Found by discovery but without TLS: unsupported, never offered.
    if (backend === 'rdp' && found?.available === true && found.tls === false) {
      return { backend, available: false, selectable: false, insecure: true, unconfirmed: false, port: found.port ?? null, note: '', source: null, reason: NO_TLS_RDP };
    }
    // No discovery data for this protocol means it was never checked, not that nothing is there.
    if (!offered) reason = found ? (found.reason || `No ${backend.toUpperCase()} remote desktop was found on this computer.`) : NOT_CHECKED;
    // RemoteHub's own side (Desktop off on the server, or guacd without this plugin): not the remote computer's fault.
    else if (!guacdEnabled || guacdProtocols?.[backend] === false) reason = DESKTOP_NOT_SET_UP_HERE;
    const available = offered && !reason;
    const port = found?.available === true && Number.isInteger(found.port) ? found.port : (saved?.protocol === backend ? saved.port ?? null : null);
    const unconfirmed = available && found?.available === true && !(saved?.protocol === backend && saved.port === found.port);
    const note = unconfirmed ? 'found; you’ll be asked to confirm before first use' : '';
    return { backend, available, selectable: available, insecure: false, unconfirmed, port, note, source, reason };
  });
}

/**
 * Pick the backend for a preference ('auto' or a backend name).
 * @returns {{ backend: string, auto: boolean } | { backend: null, auto: boolean, reason: string, reasons: object, helper: boolean }}
 */
export function selectDesktopBackend(backends, preference = 'auto', { confirm = null } = {}) {
  const pref = DESKTOP_PREFERENCES.includes(preference) ? preference : 'auto';
  // A confirmation clears `unconfirmed` only for the exact backend and port it names.
  const list = (Array.isArray(backends) ? backends : []).map((b) =>
    (b.unconfirmed && confirm && confirm.protocol === b.backend && confirm.port === b.port ? { ...b, unconfirmed: false } : b));
  const byName = new Map(list.map((b) => [b.backend, b]));
  const reasons = Object.fromEntries(DESKTOP_BACKEND_ORDER.map((b) => [b, byName.get(b)?.reason || (byName.get(b)?.selectable ? '' : 'Not checked yet.')]));
  if (pref !== 'auto') {
    const entry = byName.get(pref);
    if (entry?.selectable && entry.unconfirmed) return needsConfirmation(entry, false, reasons, list);
    if (entry?.selectable) return { backend: pref, auto: false };
    if (entry?.insecure) return { backend: null, auto: false, reason: NO_TLS_RDP, reasons, helper: needsHelper(list) };
    return { backend: null, auto: false, reason: `${BACKEND_LABELS[pref]} is not available: ${reasons[pref]}`, reasons, helper: needsHelper(list) };
  }
  let pending = null;
  for (const backend of DESKTOP_BACKEND_ORDER) {
    const entry = byName.get(backend);
    if (!entry?.selectable) continue;
    if (entry.unconfirmed) { pending ??= entry; continue; }
    return { backend, auto: true };
  }
  if (pending) return needsConfirmation(pending, true, reasons, list);
  return { backend: null, auto: true, reason: 'No remote desktop is available on this computer.', reasons, helper: needsHelper(list) };
}

// Found on a port the owner has not saved: the owner must confirm that exact port first.
function needsConfirmation(entry, auto, reasons, list) {
  const reason = `${BACKEND_LABELS[entry.backend]} was found in a place you haven’t used for this computer before. Confirm it to use it.`;
  return { backend: null, auto, reason, reasons: { ...reasons, [entry.backend]: reason }, helper: needsHelper(list), needsConfirm: { protocol: entry.backend, port: entry.port } };
}

/**
 * Only what the LAST discovery actually found stays selectable (first-click save, Desktop
 * enabled by discovery). Entries keep their own reason; configured-but-not-found ones say so.
 */
export function restrictToDiscovery(backends, discovery) {
  return (Array.isArray(backends) ? backends : []).map((b) => {
    if (b.backend === 'nativeStream' || discovery?.[b.backend]?.available === true) return b;
    return { ...b, selectable: false, available: false, reason: b.reason || NOT_DISCOVERED };
  });
}

// Offer the agent/helper path when nothing guacd-based works and no agent is connected yet.
function needsHelper(list) {
  return !list.some((b) => b.backend === 'nativeStream' && b.available);
}
