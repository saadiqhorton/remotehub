// guacd sidecar: configuration and health (SAA-301).
//
// guacd is Apache Guacamole's protocol daemon. RemoteHub talks to it over a plain TCP
// socket (never exposed to the browser; SAA-302 adds the bridge). Desktop support is
// opt-in: with GUACD_ENABLED unset, nothing here opens a socket and the terminal/Files
// deployment behaves exactly as before.
//
// The health check is a real handshake, not just a port probe:
//   1. TCP connect to GUACD_HOST:GUACD_PORT
//   2. send   `6.select,<n>.<protocol>;`
//   3. expect `4.args,...;`  (guacd loaded that protocol plugin and is ready)
// then hang up before any connection is created. Everything has one overall timeout,
// so a hung guacd (accepts but never answers) is reported, never waited on forever.

import net from 'node:net';

export const GUACD_DEFAULTS = Object.freeze({
  host: '127.0.0.1',
  port: 4822,
  protocol: 'rdp',
  timeoutMs: 3000,
  cacheMs: 5000,
});

const PROTOCOL_NAME = /^[a-z][a-z0-9-]{0,31}$/;
const MAX_REPLY_BYTES = 8192;

function intFrom(env, name, fallback, min, max) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}.`);
  }
  return value;
}

/** Read guacd settings from the environment. Throws on invalid values (fail at startup). */
export function guacdConfigFromEnv(env = process.env) {
  const enabled = /^(1|true|yes|on)$/i.test(env.GUACD_ENABLED ?? '');
  const host = (env.GUACD_HOST ?? '').trim() || GUACD_DEFAULTS.host;
  if (!/^[A-Za-z0-9.:\[\]_-]{1,255}$/.test(host)) throw new Error('GUACD_HOST must be a computer name or IP address.');
  const protocol = (env.GUACD_HEALTH_PROTOCOL ?? '').trim() || GUACD_DEFAULTS.protocol;
  if (!PROTOCOL_NAME.test(protocol)) throw new Error('GUACD_HEALTH_PROTOCOL must be a protocol name such as rdp or vnc.');
  return {
    enabled,
    host,
    port: intFrom(env, 'GUACD_PORT', GUACD_DEFAULTS.port, 1, 65535),
    protocol,
    timeoutMs: intFrom(env, 'GUACD_HEALTH_TIMEOUT_MS', GUACD_DEFAULTS.timeoutMs, 100, 60_000),
    cacheMs: intFrom(env, 'GUACD_HEALTH_CACHE_MS', GUACD_DEFAULTS.cacheMs, 0, 600_000),
  };
}

/** Encode one Guacamole instruction: `<len>.<value>,...;` (lengths in code points). */
export function encodeInstruction(...elements) {
  return `${elements.map((e) => `${[...String(e)].length}.${e}`).join(',')};`;
}

/**
 * Parse the first complete instruction in `text`.
 * @returns {{elements: string[], rest: string}|null} null if incomplete; throws if malformed.
 */
export function parseInstruction(text) {
  const chars = [...text];
  const elements = [];
  let i = 0;
  for (;;) {
    let dot = i;
    while (dot < chars.length && chars[dot] !== '.') dot += 1;
    const lengthText = chars.slice(i, dot).join('');
    if (!/^\d{0,6}$/.test(lengthText)) throw new Error('malformed instruction');
    if (dot === chars.length) return null;
    if (!lengthText) throw new Error('malformed instruction');
    const length = Number(lengthText);
    if (chars.length < dot + 1 + length + 1) return null;
    elements.push(chars.slice(dot + 1, dot + 1 + length).join(''));
    const terminator = chars[dot + 1 + length];
    i = dot + 1 + length + 1;
    if (terminator === ';') return { elements, rest: chars.slice(i).join('') };
    if (terminator !== ',') throw new Error('malformed instruction');
  }
}

/**
 * One health probe. Never rejects.
 * @returns {Promise<{status: 'up'|'down'|'timeout'|'protocol-unavailable'|'bad-response',
 *   message: string, latencyMs: number, protocolVersion?: string}>}
 */
// monotonic: latency is a duration, and wall-clock steps (NTP/WSL) must not inflate it
export function probeGuacd({ host, port, protocol, timeoutMs }, { now = () => Math.round(performance.now()) } = {}) {
  const started = now();
  return new Promise((resolve) => {
    let settled = false;
    let reply = '';
    const socket = net.connect({ host, port });
    const finish = (status, message, extra = {}) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve({ status, message, latencyMs: now() - started, ...extra });
    };
    const timer = setTimeout(() => {
      finish('timeout', socket.connecting
        ? `guacd at ${host}:${port} did not accept a connection within ${timeoutMs} ms.`
        : `guacd at ${host}:${port} accepted the connection but did not answer the handshake within ${timeoutMs} ms: guacd is hung, or it lacks the ${protocol} plugin (guacd then logs "Support for protocol \"${protocol}\" is not installed" and sends nothing).`);
    }, timeoutMs);
    socket.setNoDelay(true);
    socket.on('connect', () => socket.write(encodeInstruction('select', protocol)));
    socket.on('data', (chunk) => {
      reply += chunk.toString('utf8');
      if (reply.length > MAX_REPLY_BYTES) return finish('bad-response', `guacd at ${host}:${port} sent an oversized reply; is this really guacd?`);
      let parsed;
      try {
        parsed = parseInstruction(reply);
      } catch {
        return finish('bad-response', `${host}:${port} answered, but not with the Guacamole protocol; is this really guacd?`);
      }
      if (!parsed) return;
      const [opcode, ...args] = parsed.elements;
      if (opcode === 'args') {
        const version = args.find((a) => /^VERSION_\d+_\d+_\d+$/.test(a));
        return finish('up', `guacd is ready for ${protocol}.`, version ? { protocolVersion: version } : {});
      }
      if (opcode === 'error') {
        return finish('protocol-unavailable', `guacd refused ${protocol}: ${String(args[0] ?? 'unknown error').slice(0, 200)}`);
      }
      return finish('bad-response', `guacd replied "${opcode.slice(0, 32)}" instead of the handshake arguments.`);
    });
    socket.on('error', (err) => {
      // ECONNRESET on an unused port is common on some hosts (e.g. WSL); treat it like refuse.
      const reason = err.code === 'ECONNREFUSED' || err.code === 'ECONNRESET'
        ? 'refused the connection (is guacd running?)'
        : err.code === 'ENOTFOUND' || err.code === 'EAI_AGAIN' ? 'could not be resolved'
        : err.code === 'EHOSTUNREACH' || err.code === 'ENETUNREACH' ? 'is unreachable'
        : `failed (${err.code || 'socket error'})`;
      finish('down', `guacd at ${host}:${port} ${reason}.`);
    });
    socket.on('close', () => {
      // guacd closes without a reply when the protocol plugin is not installed.
      finish('protocol-unavailable', `guacd at ${host}:${port} closed the handshake for ${protocol}; the ${protocol} plugin is probably not installed.`);
    });
  });
}

/**
 * Health monitor with a short cache and single-flight probes, so many status requests
 * never pile up sockets on guacd.
 */
export function createGuacdHealth(config, { probe = probeGuacd, now = Date.now } = {}) {
  let last = null;
  let inflight = null;
  const disabled = { enabled: false, status: 'disabled', message: 'Desktop is disabled (GUACD_ENABLED is not set).' };
  return {
    config,
    /** @param {{fresh?: boolean}} [options] */
    async check({ fresh = false } = {}) {
      if (!config.enabled) return disabled;
      if (!fresh && last && now() - last.at < config.cacheMs) return last.result;
      if (!inflight) {
        inflight = probe(config).then((outcome) => {
          const result = {
            enabled: true,
            status: outcome.status,
            healthy: outcome.status === 'up',
            message: outcome.message,
            latencyMs: outcome.latencyMs,
            ...(outcome.protocolVersion ? { protocolVersion: outcome.protocolVersion } : {}),
            checkedAt: new Date(now()).toISOString(),
            host: config.host,
            port: config.port,
            protocol: config.protocol,
          };
          last = { at: now(), result };
          return result;
        }).finally(() => { inflight = null; });
      }
      return inflight;
    },
  };
}

/** What unauthenticated callers may see: state only, no address or message. */
export function publicDesktopHealth(result) {
  return result.enabled ? { enabled: true, status: result.status, healthy: result.healthy } : { enabled: false, status: 'disabled' };
}
