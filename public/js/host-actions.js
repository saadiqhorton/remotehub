import { BACKEND_LABELS, DESKTOP_NOT_SET_UP_HERE, restrictToDiscovery, selectDesktopBackend } from './desktop-auto.js';

// Live agent status for the host rail and edit dialog (SAA-296, SAA-300).
//
// `host.agent` is the outbound registration ({registered, connected}). `host.liveAgent`
// is the server's merged view of every RemoteHub agent connected right now
// ({connected, source, mode, version, os, arch}). Neither the status nor the actions
// below ever look at the OS name to decide what a host can do: OS/arch is display only.
const SOURCE_LABEL = { registered: 'agent', local: 'local agent', helper: 'temporary connection' };

export function agentStatus(host) {
  const registered = host?.agent?.registered === true;
  const live = host?.liveAgent?.connected === true ? host.liveAgent : null;
  const connected = Boolean(live) || (registered && host?.agent?.connected === true);
  if (!registered && !live) {
    return { registered: false, connected: false, state: 'none', label: 'Not set up on this computer', details: [], summary: '' };
  }
  const details = [];
  if (live) {
    if (live.mode) details.push(live.mode);
    if (live.source && live.source !== 'registered') details.push(SOURCE_LABEL[live.source] || live.source);
    if (live.version) details.push(`v${live.version}`);
    if (live.os || live.arch) details.push([live.os, live.arch].filter(Boolean).join('/'));
  }
  const label = connected ? 'Connected' : 'Not connected right now';
  return {
    registered,
    connected,
    state: connected ? 'connected' : 'disconnected',
    label,
    mode: live?.mode ?? null,
    version: live?.version ?? null,
    os: live?.os ?? null,
    arch: live?.arch ?? null,
    source: live?.source ?? null,
    details,
    summary: [label, ...details].join(' · '),
  };
}

/** Capabilities the UI should act on: the server's negotiated view when present. */
export function effectiveCapabilities(host) {
  return host?.effectiveCapabilities ?? host?.capabilities;
}

const PROVENANCE_LABEL = { ssh: 'SSH', agent: 'agent', helper: 'helper' };

/** Human list of the features that depend on a connected agent, with their source. */
export function agentFeatures(host) {
  const capabilities = effectiveCapabilities(host);
  const provenance = host?.capabilityProvenance || {};
  const features = [];
  if (capabilities?.files?.watch === true) features.push(`Live file updates (${PROVENANCE_LABEL[provenance['files.watch']] || 'agent'})`);
  if (capabilities?.desktop?.nativeStream === true) features.push(`Native desktop (${PROVENANCE_LABEL[provenance['desktop.nativeStream']] || 'agent'})`);
  return features;
}

// Only known capability flags can expose actions. Older hosts without a model
// retain their SSH terminal; other surfaces need an explicit capability.
export function hostActions(host) {
  const capabilities = effectiveCapabilities(host);
  const terminal = capabilities ? capabilities.terminal?.ssh === true : true;
  const files = capabilities?.files?.sftp === true;
  const desktop = ['nativeStream', 'rdp', 'vnc'].some((key) => capabilities?.desktop?.[key] === true);
  return [
    { type: 'terminal', label: 'Terminal', enabled: terminal, reason: terminal ? '' : 'Terminal isn’t available on this computer.' },
    { type: 'files', label: 'Files', enabled: files, reason: files ? '' : 'Files aren’t available on this computer.' },
    desktopAction(host, desktop),
  ];
}

// SAA-303: Desktop opens only when this host has server-held desktop settings
// (host.desktop, from PUT /api/hosts/:id/desktop) AND the server has Desktop turned on
// (host.desktopServerEnabled, set by the app from GET /api/desktop/status).
// SAA-306: a host with no saved settings can still open Desktop once discovery found RDP
// or VNC (the server feeds that into effectiveCapabilities). Opening it then saves settings
// from the owner's preference (PUT {preference}); nothing here pins or sends credentials.
export { DESKTOP_NOT_SET_UP_HERE };
function desktopAction(host, capabilityDesktop) {
  const configured = Boolean(host?.desktop?.protocol);
  const choice = configured ? null : discoveredChoice(host);
  const discovered = choice?.backend ?? null;
  const serverOn = host?.desktopServerEnabled === true;
  let reason = '';
  // RemoteHub's own side can't do desktops: Desktop is off on the server (GUACD_ENABLED off,
  // host.desktopServerEnabled === false from GET /api/desktop/status) or guacd has neither
  // the RDP nor the VNC plugin (host.desktopProtocols, same call). Unknown (undefined) is not
  // treated as missing, so a host the app hasn't checked yet keeps the remote-computer wording.
  const helperMissing = host?.desktopServerEnabled === false
    || (host?.desktopProtocols != null && host.desktopProtocols.rdp === false && host.desktopProtocols.vnc === false);
  if (!configured && !discovered) reason = helperMissing ? DESKTOP_NOT_SET_UP_HERE
    : (capabilityDesktop ? 'Desktop is not set up for this computer yet.' : 'No remote desktop is available on this computer.') + discoveredText(host); // SAA-306
  else if (!serverOn) reason = DESKTOP_NOT_SET_UP_HERE;
  else reason = desktopProtocolReason(host, discovered ?? host.desktop.protocol); // SAA-305
  return { type: 'desktop', label: 'Desktop', enabled: (configured || Boolean(discovered)) && serverOn && !reason, reason, ...(discovered ? { needsSetup: true, backend: discovered, ...(choice.confirm ? { confirm: choice.confirm } : {}) } : {}) };
}

/**
 * SAA-306: what discovery lets the owner's preference open: { backend } when it can open
 * directly, { backend, confirm: { protocol, address, port } } when the port was found but not
 * saved (the owner must confirm that exact address:port first), or null.
 */
export function discoveredChoice(host) {
  if (!host?.desktopDiscovery || !Array.isArray(host.desktopBackends)) return null;
  const caps = effectiveCapabilities(host)?.desktop ?? {};
  const usable = restrictToDiscovery(host.desktopBackends, host.desktopDiscovery).map((b) =>
    (b.selectable && (caps[b.backend] !== true || host.desktopProtocols?.[b.backend] === false) ? { ...b, selectable: false } : b));
  const picked = selectDesktopBackend(usable, host.desktopPreference || 'auto');
  if (picked.backend) return { backend: picked.backend };
  if (picked.needsConfirm) return { backend: picked.needsConfirm.protocol, confirm: { ...picked.needsConfirm, address: host.address } };
  return null;
}

/** The backend discovery would open (confirmed or awaiting confirmation), or null. */
export function discoveredBackend(host) {
  return discoveredChoice(host)?.backend ?? null;
}

/** SAA-306: the confirmation question for a port the owner has not saved. */
export function confirmPrompt(confirm) {
  return `Use ${BACKEND_LABELS[confirm.protocol]} at ${confirm.address}:${confirm.port}? RemoteHub found it in a place you haven't used for this computer before.`;
}

// SAA-306: owner-only "Check desktop options" action. It is offered for every host (even
// when Desktop is disabled); the app renders it only for a signed-in owner session.
export function discoverAction(host, { busy = false } = {}) {
  return { type: 'discover', label: busy ? 'Checking desktop options…' : 'Check desktop options', enabled: !busy, reason: busy ? 'Checking…' : `Look for remote desktop on ${host?.address ?? 'this computer'} (doesn't sign in or change anything).` };
}

/** SAA-306: per-backend lines for a discovery result, or for its error (incl. 429 Retry-After). */
export function discoveryResultLines(host, error = null) {
  if (error) {
    if (error.status === 429) {
      const wait = error.retryAfterSeconds ?? error.data?.retryAfterSeconds;
      return [`Checked moments ago. Try again${wait ? ` in ${wait} s` : ' shortly'}.`];
    }
    return [error.message || 'Could not check desktop options.'];
  }
  const backends = Array.isArray(host?.desktopBackends) ? host.desktopBackends : [];
  // RemoteHub's own side is missing: say it once per card, not once per desktop type.
  const notHere = backends.filter((b) => b.reason === DESKTOP_NOT_SET_UP_HERE);
  const lines = backends.filter((b) => b.reason !== DESKTOP_NOT_SET_UP_HERE && (b.backend !== 'nativeStream' || b.selectable)).map((b) => {
    const name = BACKEND_LABELS[b.backend] || b.backend;
    if (b.selectable) return `${name}: ${b.note || 'available'}`;
    if (b.available) return `${name}: found, but can't be used yet${b.reason ? ` (${b.reason})` : ''}`;
    return `${name}: ${b.reason || 'not available'}`;
  });
  const choice = discoveredChoice(host);
  const anySelectable = backends.some((b) => b.selectable);
  // Something was found (by this check or as a usable backend): never follow it with "No remote desktop found".
  const foundAny = backends.some((b) => b.available) || Object.values(host?.desktopDiscovery ?? {}).some((d) => d?.available === true) || notHere.length > 0;
  const NONE = 'No remote desktop found. Turn on remote desktop on that computer, or install the RemoteHub agent on it.';
  // Fresh computer (no saved desktop settings) and nothing found: one plain line, no per-type "RDP: / VNC:" lines repeating the same thing.
  if (!host?.desktop && !choice && !anySelectable && !foundAny) return [NONE];
  if (choice?.confirm) lines.push(`Desktop can open with ${BACKEND_LABELS[choice.backend]} at ${choice.confirm.address}:${choice.confirm.port} after you confirm it.`);
  else lines.push(choice ? `Desktop can now open with ${BACKEND_LABELS[choice.backend]}.` : (anySelectable || foundAny ? '' : 'No remote desktop found. Turn on remote desktop on that computer, or install the RemoteHub agent on it.'));
  if (notHere.length) lines.unshift('This computer has a remote desktop, but RemoteHub can’t open it yet.', DESKTOP_NOT_SET_UP_HERE);
  return lines.filter(Boolean);
}

// SAA-305: capability-driven protocol check. The saved protocol must be a host
// capability (desktop.vnc / desktop.rdp) and guacd must have that plugin
// (host.desktopProtocols, from GET /api/desktop/status; unknown counts as available).
function desktopProtocolReason(host, protocol = host.desktop.protocol) {
  const caps = effectiveCapabilities(host)?.desktop ?? {};
  if (caps[protocol] !== true) return `This computer doesn’t offer a ${protocol.toUpperCase()} desktop.`;
  if (host.desktopProtocols?.[protocol] === false) return `RemoteHub can’t open ${protocol.toUpperCase()} desktops right now.`;
  return '';
}

// SAA-306: what the last discovery found, appended to the "not set up" reason. Uses the
// server's desktopBackends (fixed order RDP > VNC; native listed, not selectable yet).
function discoveredText(host) {
  if (!host?.desktopDiscovery || !Array.isArray(host.desktopBackends)) return '';
  const label = BACKEND_LABELS;
  const usable = host.desktopBackends.filter((b) => b.selectable).map((b) => label[b.backend]);
  const auto = selectDesktopBackend(host.desktopBackends, 'auto').backend;
  if (usable.length) return ` Found: ${usable.join(', ')}${auto ? ` (Auto would use ${label[auto]})` : ''}.`;
  const why = host.desktopBackends.filter((b) => b.backend !== 'nativeStream' && b.reason).map((b) => `${label[b.backend]}: ${b.reason}`);
  return why.length ? ` ${why.join(' ')}` : '';
}
