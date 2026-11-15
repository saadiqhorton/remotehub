import path from 'node:path';
import { guacdConfigFromEnv } from './guacd.js';
import { DISCOVERY_DEFAULT_PORTS, parseDiscoveryPorts } from './desktop-discovery.js';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function integer(name, fallback, min, max) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max} (got "${raw}").`);
  }
  return value;
}

// Accepts the same forms as Express's "trust proxy" setting.
function trustProxy(raw) {
  if (raw === undefined || raw === '') return 'loopback';
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (/^\d+$/.test(raw)) return Number(raw);
  return raw;
}

function boolean(name, fallback = false) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  throw new Error(`${name} must be true or false (got "${raw}").`);
}

function list(raw) {
  return (raw || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

export const config = {
  host: process.env.HOST || '127.0.0.1',
  port: integer('PORT', 8090, 1, 65535),
  dataDir: path.resolve(ROOT, process.env.DATA_DIR || 'data'),
  trustProxy: trustProxy(process.env.TRUST_PROXY),
  sessionCookieSecure: boolean('SESSION_COOKIE_SECURE'),
  mcpPublicUrl: process.env.MCP_PUBLIC_URL || null,
  mcpAllowedOrigins: list(process.env.MCP_ALLOWED_ORIGINS).map((origin) => origin.replace(/\/+$/, '')),
  mcpCommandsEnabled: boolean('MCP_COMMANDS_ENABLED', false),
  allowedOrigins: list(process.env.ALLOWED_ORIGINS).map((origin) => origin.replace(/\/+$/, '')),
  sessionTtlMs: integer('SESSION_TTL_HOURS', 12, 1, 24 * 30) * 60 * 60 * 1000,
  maxTerminals: integer('MAX_TERMINALS', 16, 1, 256),
  maxFiles: integer('MAX_FILES', 16, 1, 256),
  maxAgents: integer('MAX_AGENTS', 32, 1, 256),
  // Concurrent /ws/desktop sessions (SAA-302); over the limit the upgrade gets HTTP 503.
  maxDesktops: integer('MAX_DESKTOPS', 8, 1, 256),
  // Loopback port of the persistent RemoteHub agent on each host, reached over the
  // Files SSH connection for live directory updates (SAA-298). 0 disables it.
  agentPort: integer('AGENT_PORT', 8377, 0, 65535),
  // Directory holding temporary-helper builds named remotehub-agent-<os>-<arch>
  // (SAA-299). Unset disables the "Start temporary helper" option.
  helperDir: process.env.HELPER_DIR ? path.resolve(ROOT, process.env.HELPER_DIR) : null,
  // guacd sidecar for Desktop (SAA-301). Off unless GUACD_ENABLED=1; see deploy/guacd.md.
  guacd: guacdConfigFromEnv(process.env),
  // SAA-306: extra ports desktop discovery probes, besides each protocol's default and the
  // owner-saved port (e.g. DESKTOP_DISCOVERY_PORTS=vnc=5901), and the defaults themselves
  // (DESKTOP_DISCOVERY_DEFAULT_PORTS, normally rdp=3389,vnc=5900). See deploy/guacd.md.
  discoveryPorts: parseDiscoveryPorts(process.env.DESKTOP_DISCOVERY_PORTS),
  discoveryDefaultPorts: { ...DISCOVERY_DEFAULT_PORTS, ...parseDiscoveryPorts(process.env.DESKTOP_DISCOVERY_DEFAULT_PORTS, 'DESKTOP_DISCOVERY_DEFAULT_PORTS') },
};
