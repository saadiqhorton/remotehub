// Versioned host capability model (SAA-285).
//
// A host exposes what it can do (Terminal / Files / Desktop / Agent) instead of the
// product inferring behavior from OS names. The shape follows the RemoteHub product &
// architecture spec:
//
//   {
//     version: 1,
//     terminal: { ssh: true },
//     files: { sftp: true, watch: false },
//     commands: { exec: false },
//     desktop: { nativeStream: false, rdp: false, vnc: false },
//     agent: { available: false, mode: null, version: null },
//   }
//
// Unknown surfaces and keys are preserved verbatim so a host file written by a newer
// RemoteHub is never damaged by an older one — but they stay inert: only the known
// flags below can ever enable behavior (see isEnabled).

export const CAPABILITIES_VERSION = 1;

// Known on/off flags per surface, with the baseline value for an agentless SSH host.
// A saved host always has an SSH transport, so ssh/sftp default to true; everything
// that needs an agent, helper, or desktop backend defaults to false until a later
// discovery/negotiation step records it (SAA-300, SAA-306).
const BOOLEAN_FLAGS = {
  terminal: { ssh: true },
  files: { sftp: true, watch: false },
  commands: { exec: false },
  desktop: { nativeStream: false, rdp: false, vnc: false },
};

const AGENT_MODES = new Set(['persistent', 'temporary']);

// Stable order for enumerating desktop backends.
export const DESKTOP_BACKENDS = ['nativeStream', 'rdp', 'vnc'];

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

// Baseline for an agentless SSH host: terminal over SSH and files over SFTP on the
// same connection; live watch, desktop backends, and the agent need later discovery.
export function defaultCapabilities() {
  return {
    version: CAPABILITIES_VERSION,
    terminal: { ...BOOLEAN_FLAGS.terminal },
    files: { ...BOOLEAN_FLAGS.files },
    commands: { ...BOOLEAN_FLAGS.commands },
    desktop: { ...BOOLEAN_FLAGS.desktop },
    agent: { available: false, mode: null, version: null },
  };
}

function normalizeBooleans(rawGroup, defaults) {
  const group = isPlainObject(rawGroup) ? rawGroup : {};
  const normalized = {};
  for (const [key, fallback] of Object.entries(defaults)) {
    const value = group[key];
    normalized[key] = typeof value === 'boolean' ? value : fallback;
  }
  // Preserve unknown (future) keys verbatim without interpreting them.
  for (const [key, value] of Object.entries(group)) {
    if (!(key in normalized)) normalized[key] = value;
  }
  return normalized;
}

function normalizeAgent(rawAgent) {
  const agent = isPlainObject(rawAgent) ? rawAgent : {};
  const normalized = {
    available: agent.available === true,
    mode: AGENT_MODES.has(agent.mode) ? agent.mode : null,
    version: typeof agent.version === 'string' ? agent.version : null,
  };
  for (const [key, value] of Object.entries(agent)) {
    if (!(key in normalized)) normalized[key] = value;
  }
  return normalized;
}

// Accepts anything (persisted JSON, client input, future model versions) and always
// returns a valid capability object. Never throws, never loses unknown data.
export function normalizeCapabilities(raw) {
  const source = isPlainObject(raw) ? raw : {};
  const normalized = {
    version:
      Number.isInteger(source.version) && source.version > 0 ? source.version : CAPABILITIES_VERSION,
    terminal: normalizeBooleans(source.terminal, BOOLEAN_FLAGS.terminal),
    files: normalizeBooleans(source.files, BOOLEAN_FLAGS.files),
    commands: normalizeBooleans(source.commands, BOOLEAN_FLAGS.commands),
    desktop: normalizeBooleans(source.desktop, BOOLEAN_FLAGS.desktop),
    agent: normalizeAgent(source.agent),
  };
  for (const [key, value] of Object.entries(source)) {
    if (!(key in normalized)) normalized[key] = value;
  }
  return normalized;
}

// The only way behavior should branch on capabilities. Returns true when a known
// flag is explicitly true, or when it is absent and the baseline default applies
// (every saved host is an SSH host). A present-but-invalid value is never treated
// as enabled, and unknown/future keys always read as disabled — so current code can
// never act on a capability it does not understand.
export function isEnabled(capabilities, surface, key) {
  if (!BOOLEAN_FLAGS[surface] || !(key in BOOLEAN_FLAGS[surface])) return false;
  const group = isPlainObject(capabilities) ? capabilities[surface] : undefined;
  if (isPlainObject(group) && Object.hasOwn(group, key)) return group[key] === true;
  return BOOLEAN_FLAGS[surface][key];
}

// Known desktop backends currently enabled on the host, in preference-listing order.
// (Precedence/Auto selection is SAA-306; this only enumerates what the model holds.)
export function availableDesktopBackends(capabilities) {
  const desktop = normalizeCapabilities(capabilities).desktop;
  return DESKTOP_BACKENDS.filter((backend) => desktop[backend] === true);
}

// ---- Capability negotiation (SAA-300) ----------------------------------------------
//
// Effective capabilities = the agentless (SSH-transport) baseline stored on the host,
// merged with what *currently connected* agents/helpers report. Two kinds of flag:
//
// - Agentless: terminal.ssh, files.sftp, desktop.rdp, desktop.vnc. They come from
//   the host record (the SSH transport or a configured protocol) and an agent can
//   never turn them on or off.
// - Agent-dependent: files.watch, commands.exec, desktop.nativeStream. They are true
//   only while at least one connected RemoteHub agent reports them. A stored value is
//   ignored (it would be a stale guess), and an agent disconnecting removes these.
//
// Only known flags are read from a report: an agent cannot invent capabilities.
// Nothing here looks at the OS name.

export const AGENT_DEPENDENT = { files: ['watch'], commands: ['exec'], desktop: ['nativeStream'] };
const AGENTLESS = { terminal: ['ssh'], files: ['sftp'], desktop: ['rdp', 'vnc'] };
const SOURCE_RANK = { registered: 0, local: 1, helper: 2 };

/** Keep only the agent-dependent boolean flags of an agent's reported capabilities. */
export function sanitizeReportedCapabilities(raw) {
  const source = isPlainObject(raw) ? raw : {};
  const out = {};
  for (const [surface, keys] of Object.entries(AGENT_DEPENDENT)) {
    out[surface] = {};
    for (const key of keys) out[surface][key] = isPlainObject(source[surface]) && source[surface][key] === true;
  }
  return out;
}

/**
 * @param {object} base stored host capabilities (agentless baseline)
 * @param {Array<{source:'registered'|'local'|'helper', mode, version, os, arch, capabilities}>} reports
 *   currently connected agents/helpers for the host
 * @returns {{ capabilities: object, provenance: Record<string,string>, agent: object }}
 */
export function mergeCapabilities(base, reports = []) {
  const capabilities = normalizeCapabilities(base);
  const provenance = {};
  for (const [surface, keys] of Object.entries(AGENTLESS)) {
    for (const key of keys) if (capabilities[surface][key] === true) provenance[`${surface}.${key}`] = 'ssh';
  }
  const live = [...reports].sort((a, b) => (SOURCE_RANK[a.source] ?? 9) - (SOURCE_RANK[b.source] ?? 9));
  for (const [surface, keys] of Object.entries(AGENT_DEPENDENT)) {
    for (const key of keys) {
      const provider = live.find((report) => report.capabilities?.[surface]?.[key] === true);
      capabilities[surface][key] = Boolean(provider);
      if (provider) provenance[`${surface}.${key}`] = provider.source === 'helper' ? 'helper' : 'agent';
    }
  }
  const primary = live[0] || null;
  const agent = primary
    ? { available: true, connected: true, source: primary.source, mode: primary.mode, version: primary.version, os: primary.os, arch: primary.arch, count: live.length }
    : { available: false, connected: false, source: null, mode: null, version: null, os: null, arch: null, count: 0 };
  capabilities.agent = { ...capabilities.agent, available: agent.available, mode: agent.mode, version: agent.version };
  return { capabilities, provenance, agent };
}
