// Server-side Desktop bridge (SAA-302): browser <-> RemoteHub <-> guacd.
//
// The browser opens /ws/desktop?hostId=&width=&height=&dpi= with its normal session
// cookie (see public/js/desktop-tunnel.js in SAA-303). guacd is never reachable from
// the browser: RemoteHub resolves the host's desktop settings (protocol, address,
// port, credentials) from its own store, performs the Guacamole select/connect
// handshake itself, and only then relays instructions in both directions.
//
// Close codes and refusals (the browser contract; same table in deploy/guacd.md and
// public/js/desktop-tunnel.js):
//   HTTP 403  upgrade refused: Origin not allowed (same check as /ws/terminal)
//   HTTP 503  upgrade refused: desktop session limit (MAX_DESKTOPS, default 8) reached
//   1000 normal end: browser sent `disconnect`/closed, or guacd sent `disconnect`
//   1003 browser sent a binary frame (desktop is text-only)
//   1007 browser sent a malformed Guacamole instruction
//   1008 first browser message was not a valid `credentials` instruction
//   1011 guacd reported an error (e.g. wrong VNC password); its `error` instruction is forwarded first
//   4401 RemoteHub login missing/expired/logged out
//   4403 the page's Origin is not allowed (same check as /ws/terminal); closed right after the upgrade
//   4404 no desktop configured for that host (or unknown host)
//   4502 guacd crashed or dropped the connection unexpectedly mid-session
//   4409 RDP: the target's certificate differs from the pinned one (SAA-304; fails closed)
//   4410 RDP: the target's certificate could not be checked (no TLS, unreachable)
//        (RDP_CLOSE in server/rdp.js; mirrored in public/js/desktop-tunnel.js DESKTOP_CLOSE)
//   4503 Desktop disabled (GUACD_ENABLED off), guacd unreachable, or handshake timed out
//
// Desktop passwords are NEVER stored. The browser's first WebSocket message must be a
// `credentials` instruction, e.g. `11.credentials,8.password,6.secret;` (or just
// `11.credentials;` for no password). The value is put in guacd's `connect` instruction
// once, then the reference is dropped. It is never logged, stored or sent back.

import net from 'node:net';
import { RDP_CLOSE, isFingerprint, rdpParameters } from './rdp.js';
import { ValidationError, validatePort } from './validate.js';

export const DESKTOP_CLOSE = Object.freeze({ NORMAL: 1000, REMOTE_ERROR: 1011, AUTH: 4401, ORIGIN: 4403, UNAVAILABLE: 4404, ...RDP_CLOSE, BACKEND_LOST: 4502, BACKEND_DOWN: 4503 });
// guacd/target reported an error (e.g. bad VNC password). The browser treats it as
// "failed" before ready and "disconnected" after, per the SAA-303 contract.
export const REMOTE_ERROR_CLOSE = DESKTOP_CLOSE.REMOTE_ERROR;
// Per-connection secrets the browser may supply in its `credentials` instruction.
export const BROWSER_CREDENTIALS = Object.freeze(['password']);
export const DESKTOP_PROTOCOLS = Object.freeze(['vnc', 'rdp']);
export const DESKTOP_DEFAULT_PORTS = Object.freeze({ vnc: 5900, rdp: 3389 });
export const DESKTOP_TIMEOUTS = Object.freeze({ connectMs: 5000, handshakeMs: 15000, idleMs: 60000 });

// Audio the browser's Guacamole client plays (Guacamole.RawAudioPlayer: raw PCM through Web
// Audio). guacd matches these exact names to its encoders. Output only: the browser's own
// `audio` opcode (microphone) stays off the allow-list below.
export const BROWSER_AUDIO_TYPES = Object.freeze(['audio/L8', 'audio/L16']);

const MAX_INSTRUCTION_CHARS = 4 * 1024 * 1024;
// After the handshake, ONLY these browser->guacd opcodes are forwarded; everything else
// (select/connect/args, audio/video/image, unknown ops) is dropped. This is what the
// SAA-303 view sends: input (mouse, key), resize (size, clamped below), sync replies,
// stream acks for images, clipboard streams (clipboard/blob/end), `argv` streams for
// guacd's `required` prompt (only names guacd listed in `required`, each once; the
// blob/end of a refused argv stream are dropped too), and nop keep-alives. `disconnect` is handled by the bridge.
export const BROWSER_ALLOWED = Object.freeze(new Set(['mouse', 'key', 'size', 'sync', 'ack', 'clipboard', 'blob', 'end', 'argv', 'nop']));

/** Streaming Guacamole parser. Lengths are in Unicode code points. Throws on malformed input. */
export class InstructionStream {
  constructor() { this.buffer = ''; }

  /** Feed text; returns [{ elements, raw }] for every complete instruction. */
  push(text) {
    this.buffer += text;
    const out = [];
    let start = 0;
    const buf = this.buffer;
    for (;;) {
      const elements = [];
      let i = start;
      let complete = false;
      for (;;) {
        let dot = i;
        while (dot < buf.length && dot - i <= 7 && buf.charCodeAt(dot) !== 46) dot += 1;
        if (dot >= buf.length) break;
        const lengthText = buf.slice(i, dot);
        if (!/^\d{1,7}$/.test(lengthText)) throw new Error('malformed instruction');
        let remaining = Number(lengthText);
        let j = dot + 1;
        while (remaining > 0 && j < buf.length) {
          const code = buf.charCodeAt(j);
          j += code >= 0xd800 && code <= 0xdbff ? 2 : 1;
          remaining -= 1;
        }
        if (remaining > 0 || j >= buf.length) break;
        elements.push(buf.slice(dot + 1, j));
        const terminator = buf[j];
        i = j + 1;
        if (terminator === ';') { complete = true; break; }
        if (terminator !== ',') throw new Error('malformed instruction');
      }
      if (!complete) break;
      out.push({ elements, raw: buf.slice(start, i) });
      start = i;
    }
    this.buffer = buf.slice(start);
    if (this.buffer.length > MAX_INSTRUCTION_CHARS) throw new Error('instruction too large');
    return out;
  }
}

export function encode(...elements) {
  return `${elements.map((e) => `${[...String(e)].length}.${e}`).join(',')};`;
}

/** Validate a host's desktop settings (PUT /api/hosts/:id/desktop). Keeps a stored password if none is sent. */
export function validateDesktopSettings(body, previous = null) {
  if (!body || typeof body !== 'object') throw new ValidationError('Desktop settings are required.');
  const protocol = String(body.protocol ?? '').toLowerCase();
  if (!DESKTOP_PROTOCOLS.includes(protocol)) throw new ValidationError('Desktop protocol must be vnc or rdp.');
  const port = body.port === undefined || body.port === '' ? DESKTOP_DEFAULT_PORTS[protocol] : validatePort(body.port);
  const str = (value, label, max) => {
    if (value === undefined || value === null) return undefined;
    if (typeof value !== 'string' || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) {
      throw new ValidationError(`${label} must be text of ${max} characters or fewer.`);
    }
    return value;
  };
  if ('password' in body) throw new ValidationError('Desktop passwords are not stored. Enter the password when you connect.');
  const username = str(body.username, 'Desktop username', 128);
  const settings = { protocol, port };
  if (username) settings.username = username;
  if (protocol === 'rdp') {
    // SAA-304: username and domain are saved on the host; the password never is.
    const domain = str(body.domain, 'Desktop domain', 128);
    if (domain) settings.domain = domain;
    // The TOFU certificate pin is set only by the server. The browser cannot set it;
    // it survives edits unless the protocol or port changes (then it is re-learned).
    if ('certPin' in body) throw new ValidationError('The certificate pin is learned on first connect; reset it instead of setting it.');
    if (previous?.protocol === 'rdp' && previous.port === port && isFingerprint(previous.certPin)) {
      settings.certPin = previous.certPin;
      if (previous.certPinnedAt) settings.certPinnedAt = previous.certPinnedAt;
    }
    const security = body.security ?? previous?.security ?? 'any';
    if (!['any', 'nla', 'tls', 'rdp', 'vmconnect'].includes(security)) throw new ValidationError('RDP security must be any, nla, tls, rdp or vmconnect.');
    settings.security = security;
    settings.ignoreCert = body.ignoreCert === undefined ? previous?.ignoreCert === true : body.ignoreCert === true;
  }
  return settings;
}

/** What the browser may see about a host's desktop settings. */
export function publicDesktopSettings(settings) {
  if (!settings) return null;
  const out = { protocol: settings.protocol, port: settings.port, username: settings.username ?? null };
  if (settings.protocol === 'rdp') {
    Object.assign(out, { domain: settings.domain ?? null, security: settings.security ?? 'any', ignoreCert: settings.ignoreCert === true,
      certPin: settings.certPin ?? null, certPinnedAt: settings.certPinnedAt ?? null });
  }
  return out;
}

// The ONLY values the browser may influence, and only through the handshake `size`
// instruction. Everything else (address, port, credentials, protocol options) comes
// from the server-held host settings below. Unknown query keys are ignored.
// SAA-352: plus the `fixed=1` off-switch for RDP resizing (browserFixedSize below).
export const BROWSER_SETTABLE = Object.freeze({
  width: { min: 320, max: 8192, fallback: 1024 },
  height: { min: 240, max: 8192, fallback: 768 },
  dpi: { min: 48, max: 384, fallback: 96 },
});

export function browserSize(searchParams) {
  const out = {};
  for (const [name, { min, max, fallback }] of Object.entries(BROWSER_SETTABLE)) {
    const value = Number(searchParams.get(name));
    out[name] = Number.isInteger(value) && value > 0 ? Math.min(max, Math.max(min, value)) : fallback;
  }
  return out;
}

// SAA-352: the browser may also turn RDP resizing OFF for one connection (after the
// computer refused a size change). Only `fixed=1` counts; it can never pick a method.
export function browserFixedSize(searchParams) { return searchParams.get('fixed') === '1'; }

// Per-protocol server-held parameters. SAA-304 extends the rdp entry; the bridge itself
// is protocol-agnostic and just answers guacd's `args` list from this map.
export const PROTOCOL_PARAMS = {
  vnc: () => ({}),
  rdp: (settings) => rdpParameters(settings), // SAA-304: see server/rdp.js
};

/** Parameter values for guacd's `args` list. Only server-side values; never from the browser. */
export function connectionParameters(host, settings, credentials = {}) {
  const params = { hostname: host.address, port: String(settings.port) };
  if (settings.username) params.username = settings.username;
  // RDP passwords only travel through guacd's `required`/`argv` prompt (SAA-304), so
  // a credentials-message password is never put in `connect` for RDP.
  if (settings.protocol !== 'rdp') for (const name of BROWSER_CREDENTIALS) if (typeof credentials[name] === 'string' && credentials[name]) params[name] = credentials[name];
  return { ...params, ...(PROTOCOL_PARAMS[settings.protocol]?.(settings) ?? {}) };
}

/**
 * Attach an accepted desktop WebSocket. `ws` is already authenticated.
 * @param {import('ws').WebSocket} ws
 */
export function attachDesktop(ws, { host, settings, guacd, size, fixedSize = false, log = () => {}, timeouts = DESKTOP_TIMEOUTS, connect = net.connect, preflight = null }) {
  const label = `desktop host=${host.id} ${settings.protocol}`;
  const started = Date.now();
  const fromGuacd = new InstructionStream();
  const fromBrowser = new InstructionStream();
  let phase = 'connecting'; // connecting -> select -> connect -> open -> closed
  let closed = false;
  let lastGuacdData = Date.now();
  const pendingBrowser = [];
  const requiredNames = new Set(); // params guacd asked for via `required` this session
  const argvSent = new Set();       // params already answered (once each)
  const droppedStreams = new Set(); // argv stream indexes whose blob/end must not pass
  let dropped = 0; // browser instructions refused by the allow-list (counted, not logged)
  let credentials = null; // set from the browser's first message; dropped after connect
  let argNames = null;    // guacd's args list, held until credentials arrive
  // SAA-304: optional async pre-connect step (RDP certificate pin check). Resolves to
  // extra server-side params; rejects with { code, reason } to fail closed. `connect`
  // is not sent to guacd until it has resolved.
  let extraParams = preflight ? null : {};
  if (preflight) {
    Promise.resolve().then(preflight).then((params) => { extraParams = params ?? {}; sendConnect(); },
      (err) => finish(err?.code ?? DESKTOP_CLOSE.BACKEND_DOWN, err?.reason ?? 'Desktop pre-connect check failed.'));
  }

  const socket = connect({ host: guacd.host, port: guacd.port });
  socket.setNoDelay?.(true);

  let phaseTimer = setTimeout(() => finish(DESKTOP_CLOSE.BACKEND_DOWN, phase === 'connecting'
    ? 'Desktop service did not accept the connection in time.' : 'Desktop service did not finish connecting in time.'),
    phase === 'connecting' ? timeouts.connectMs : timeouts.handshakeMs);
  // guacd-silence watchdog. It only counts time this process was actually running: after
  // an event-loop or host stall the timer can fire before the socket data that arrived
  // during the stall has been read (timers run before I/O in Node's loop), which used to
  // close healthy sessions with 4503. So: a late tick restarts the silence window, and a
  // timeout is confirmed with setImmediate, which runs after pending I/O has been read.
  const tickMs = Math.min(5000, timeouts.idleMs);
  let lastTick = Date.now();
  let lastGuacdOp = '-';
  let lastBrowserOp = '-';
  let lastBrowserData = Date.now();
  const idleTimer = setInterval(() => {
    const now = Date.now();
    const gap = now - lastTick;
    lastTick = now;
    if (phase !== 'open' || closed) return;
    if (gap > tickMs + timeouts.idleMs / 2) {
      log(`${label} watchdog tick ${gap}ms late (process or host stall); silence window restarted`);
      lastGuacdData = now;
      return;
    }
    if (now - lastGuacdData <= timeouts.idleMs) return;
    setImmediate(() => {
      if (closed || phase !== 'open') return;
      const t = Date.now();
      if (t - lastGuacdData <= timeouts.idleMs) return;
      log(`${label} watchdog: guacd silent ${t - lastGuacdData}ms (last ${lastGuacdOp}); browser last ${lastBrowserOp} ${t - lastBrowserData}ms ago`);
      finish(DESKTOP_CLOSE.BACKEND_DOWN, 'Desktop service stopped responding.');
    });
  }, tickMs);
  idleTimer.unref?.();

  function finish(code, reason) {
    if (closed) return;
    closed = true;
    const wasOpen = phase === 'open';
    phase = 'closed';
    clearTimeout(phaseTimer);
    clearInterval(idleTimer);
    try { if (!socket.destroyed) { if (wasOpen) socket.write(encode('disconnect')); socket.end(); setTimeout(() => socket.destroy(), 1000).unref?.(); } } catch { /* gone */ }
    if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) ws.close(code, String(reason).slice(0, 120));
    log(`${label} closed code=${code} after ${Date.now() - started}ms${dropped ? ` dropped=${dropped}` : ''}: ${reason}`);
  }

  function sendConnect() {
    if (phase !== 'await-credentials' || !credentials || !extraParams || closed) return;
    const params = { ...connectionParameters(host, settings, credentials), ...extraParams };
    if (fixedSize && settings.protocol === 'rdp') { params['resize-method'] = ''; log(`${label} resizing off for this connection (computer refused a size change)`); } // SAA-352
    const values = argNames.map((name) => (/^VERSION_\d+_\d+_\d+$/.test(name) ? name : params[name] ?? ''));
    socket.write(
      encode('size', size.width, size.height, size.dpi)
      + encode('audio', ...BROWSER_AUDIO_TYPES) + encode('video')
      + encode('image', 'image/png', 'image/jpeg', 'image/webp')
      + encode('connect', ...values),
    );
    credentials = {}; // drop the secret: used exactly once
    phase = 'connect';
  }

  socket.on('connect', () => {
    if (closed) return;
    phase = 'select';
    clearTimeout(phaseTimer);
    phaseTimer = setTimeout(() => finish(DESKTOP_CLOSE.BACKEND_DOWN, 'Desktop service did not finish connecting in time.'), timeouts.handshakeMs);
    socket.write(encode('select', settings.protocol));
  });

  socket.on('data', (chunk) => {
    if (closed) return;
    lastGuacdData = Date.now();
    let instructions;
    try { instructions = fromGuacd.push(chunk.toString('utf8')); }
    catch { return finish(DESKTOP_CLOSE.BACKEND_DOWN, 'Desktop service sent an invalid reply.'); }
    let forward = '';
    for (const { elements, raw } of instructions) {
      if (closed) return;
      const [opcode, ...args] = elements;
      lastGuacdOp = opcode;
      if (phase === 'select') {
        if (opcode === 'error') return finish(DESKTOP_CLOSE.BACKEND_DOWN, `Desktop service refused ${settings.protocol}.`);
        if (opcode !== 'args') return finish(DESKTOP_CLOSE.BACKEND_DOWN, 'Desktop service sent an unexpected reply.');
        argNames = args;
        phase = 'await-credentials';
        sendConnect();
        continue;
      }
      if (phase === 'connect' && opcode === 'ready') {
        phase = 'open';
        clearTimeout(phaseTimer);
        log(`${label} ready after ${Date.now() - started}ms`);
        for (const text of pendingBrowser.splice(0)) socket.write(text);
      }
      if (opcode === 'error') {
        // guacd reports target failures (wrong VNC password, unreachable host) with an
        // `error` instruction, often right after `ready`. Forward it so the view can
        // show why, then end with 1011 so it is never mistaken for a normal close.
        forward += raw;
        if (ws.readyState === ws.OPEN) ws.send(forward);
        return finish(REMOTE_ERROR_CLOSE, `Desktop connection failed (status ${String(args[1] ?? '?').slice(0, 8)}).`);
      }
      if (opcode === 'disconnect') guacdSaidDisconnect = true;
      if (opcode === 'required') for (const name of args) requiredNames.add(name);
      forward += raw;
    }
    if (forward && ws.readyState === ws.OPEN) ws.send(forward);
  });

  socket.on('error', (err) => {
    if (phase === 'open') return finish(DESKTOP_CLOSE.BACKEND_LOST, 'Desktop service stopped unexpectedly.');
    finish(DESKTOP_CLOSE.BACKEND_DOWN, err.code === 'ECONNREFUSED' ? 'Desktop service is not running.' : `Desktop service connection failed (${err.code || 'error'}).`);
  });
  // guacd ends a session it chose to end with a `disconnect` instruction; a bare TCP
  // close/reset mid-session means guacd crashed or dropped us.
  let guacdSaidDisconnect = false;
  socket.on('close', () => {
    if (phase === 'open') return finish(guacdSaidDisconnect ? DESKTOP_CLOSE.NORMAL : DESKTOP_CLOSE.BACKEND_LOST,
      guacdSaidDisconnect ? 'Desktop session ended.' : 'Desktop service stopped unexpectedly.');
    finish(DESKTOP_CLOSE.BACKEND_DOWN, 'Desktop service closed the connection.');
  });

  ws.on('message', (data, isBinary) => {
    if (closed) return;
    if (isBinary) return finish(1003, 'Desktop expects text frames.');
    let instructions;
    try { instructions = fromBrowser.push(data.toString('utf8')); }
    catch { return finish(1007, 'Invalid desktop instruction.'); }
    let out = '';
    for (const { elements, raw } of instructions) {
      const opcode = elements[0];
      lastBrowserOp = opcode || 'ping';
      lastBrowserData = Date.now();
      if (credentials === null) {
        // First instruction must be `credentials` (allow-listed name/value pairs).
        if (opcode !== 'credentials' || elements.length % 2 !== 1) return finish(1008, 'First desktop message must be credentials.');
        const supplied = {};
        for (let k = 1; k < elements.length; k += 2) {
          if (!BROWSER_CREDENTIALS.includes(elements[k]) || elements[k + 1].length > 256) return finish(1008, 'Unsupported desktop credential.');
          supplied[elements[k]] = elements[k + 1];
        }
        credentials = supplied;
        sendConnect();
        continue;
      }
      if (opcode === 'credentials') continue;
      if (opcode === '') continue; // tunnel-internal (e.g. ping) - not for guacd
      if (opcode === 'disconnect') { if (out) socket.write(out); return finish(DESKTOP_CLOSE.NORMAL, 'Closed by browser.'); }
      if (!BROWSER_ALLOWED.has(opcode)) { dropped += 1; continue; }
      if (opcode === 'argv') {
        // argv,<stream>,<mimetype>,<name>: only for a name guacd listed in `required`, once.
        const [, stream, , name] = elements;
        if (!requiredNames.has(name) || argvSent.has(name)) { dropped += 1; droppedStreams.add(stream); continue; }
        argvSent.add(name);
        droppedStreams.delete(stream);
      }
      if ((opcode === 'blob' || opcode === 'end') && droppedStreams.has(elements[1])) {
        dropped += 1;
        if (opcode === 'end') droppedStreams.delete(elements[1]);
        continue;
      }
      if (opcode === 'size') {
        // Same limits as the handshake size. Browser sends size,<width>,<height>[,<dpi>].
        const [, w, h, d] = elements;
        const clamp = (raw, { min, max, fallback }) => {
          const v = Number(raw);
          return Number.isInteger(v) && v > 0 ? Math.min(max, Math.max(min, v)) : fallback;
        };
        const sized = [clamp(w, BROWSER_SETTABLE.width), clamp(h, BROWSER_SETTABLE.height)];
        if (d !== undefined) sized.push(clamp(d, BROWSER_SETTABLE.dpi));
        out += encode('size', ...sized);
        continue;
      }
      out += raw;
    }
    if (!out) return;
    if (phase === 'open') socket.write(out);
    else if (pendingBrowser.length < 256) pendingBrowser.push(out);
  });
  ws.on('close', () => finish(DESKTOP_CLOSE.NORMAL, 'Browser closed the connection.'));
  ws.on('error', () => finish(DESKTOP_CLOSE.NORMAL, 'Browser connection error.'));

  return { close: (code = 1001, reason = 'Server shutting down') => finish(code, reason) };
}
