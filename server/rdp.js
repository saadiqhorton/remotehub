// SAA-304: the RDP layer on top of SAA-302's guacd tunnel.
//
// - Fixed, server-held guacd parameters (remote sound on, microphone off, clipboard on,
//   no drives/printing/file transfer/recording/gateway). The browser can never set any of these.
// - Per-host trust-on-first-use certificate pinning. RemoteHub reads the target's TLS
//   certificate itself before every connect (X.224 negotiation, then TLS) and compares
//   its SHA-256 fingerprint with the pin stored on the host. First connect stores the
//   pin; a different certificate later fails closed (close 4409) until the owner resets
//   the pin. The pin is also handed to guacd (`cert-fingerprints`) so FreeRDP refuses
//   any other certificate on its own connection to the target.
// - The RDP password is never stored and never put in `connect`: guacd asks for it with
//   `required password` and the browser answers once with an `argv` stream.
import net from 'node:net';
import tls from 'node:tls';

export const RDP_CLOSE = Object.freeze({ CERT_CHANGED: 4409, CERT_UNAVAILABLE: 4410 });

// guacd RDP parameters RemoteHub always sends. Names are guacd 1.5/1.6 (main@ecca029) names.
export const RDP_FIXED_PARAMS = Object.freeze({
  'disable-audio': 'false',       // remote sound plays in the browser (output only)
  'enable-audio-input': 'false',  // never the browser's microphone
  'enable-drive': 'false',
  'enable-printing': 'false',
  'disable-download': 'true',
  'disable-upload': 'true',
  'disable-copy': 'false',   // clipboard on
  'disable-paste': 'false',
  'enable-font-smoothing': 'true',
  'resize-method': 'display-update',
  'client-name': 'RemoteHub',
  timeout: '10',
});

const FINGERPRINT = /^sha256:(?:[0-9a-f]{2}:){31}[0-9a-f]{2}$/;
export const isFingerprint = (value) => typeof value === 'string' && FINGERPRINT.test(value);

/** Normalise Node's `AA:BB:...` fingerprint256 to FreeRDP's `sha256:aa:bb:...` form. */
export function normalizeFingerprint(fp256) {
  const out = `sha256:${String(fp256 ?? '').toLowerCase()}`;
  if (!isFingerprint(out)) throw new Error('Not a SHA-256 certificate fingerprint.');
  return out;
}

/** guacd parameters for an RDP host (server-side values only; no password). */
export function rdpParameters(settings, { certFingerprint } = {}) {
  const params = { ...RDP_FIXED_PARAMS, security: settings.security ?? 'any' };
  if (settings.domain) params.domain = settings.domain;
  if (settings.ignoreCert) params['ignore-cert'] = 'true';
  else if (certFingerprint) params['cert-fingerprints'] = certFingerprint;
  return params;
}

/**
 * Decide what to do with the observed certificate.
 * @returns {{action:'pin'|'match'|'changed', pin:string}}
 */
export function checkCertPin(stored, observed) {
  if (!isFingerprint(observed)) throw new Error('Not a SHA-256 certificate fingerprint.');
  if (!stored) return { action: 'pin', pin: observed };
  return stored === observed ? { action: 'match', pin: stored } : { action: 'changed', pin: stored };
}

// guacd status codes (Guacamole protocol). Auth problems are reported to the browser the
// same way as other target failures: the `error` instruction, then close 1011.
const STATUS_KIND = {
  0x0200: 'server', 0x0201: 'server', 0x0202: 'target', 0x0203: 'protocol', 0x0207: 'target', 0x0208: 'target',
  0x0209: 'conflict', 0x020a: 'target', 0x0301: 'auth', 0x0303: 'auth', 0x0308: 'timeout', 0x031d: 'too-many',
};
export function classifyGuacStatus(status) {
  const code = Number(status);
  return STATUS_KIND[code] ?? (code >= 0x0300 && code < 0x0400 ? 'client' : 'unknown');
}

// X.224 Connection Request with an RDP Negotiation Request for TLS (1) | CredSSP (2).
const X224_CR = Buffer.from([
  0x03, 0x00, 0x00, 0x13, // TPKT, length 19
  0x0e, 0xe0, 0x00, 0x00, 0x00, 0x00, 0x00, // X.224 CR
  0x01, 0x00, 0x08, 0x00, 0x03, 0x00, 0x00, 0x00, // RDP_NEG_REQ, PROTOCOL_SSL|PROTOCOL_HYBRID
]);

export class CertProbeError extends Error {
  constructor(message, code) { super(message); this.code = code; }
}

/**
 * Read an RDP server's TLS certificate fingerprint. Never sends credentials.
 * @returns {Promise<string>} `sha256:aa:bb:...`
 */
export function probeRdpCertificate({ host, port, timeoutMs = 5000, connect = net.connect }) {
  return new Promise((resolve, reject) => {
    let done = false;
    let tlsSocket = null;
    const sock = connect({ host, port });
    const fail = (message, code) => { if (done) return; done = true; clearTimeout(timer); tlsSocket?.destroy(); sock.destroy(); reject(new CertProbeError(message, code)); };
    const timer = setTimeout(() => fail('This computer’s remote desktop didn’t answer in time. Click Reconnect to try again.', 'timeout'), timeoutMs);
    timer.unref?.();
    let buf = Buffer.alloc(0);
    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (buf.length < 4) return;
      if (buf[0] !== 0x03) return fail('This computer isn’t offering a Windows remote desktop on that port. Check the port in this computer’s desktop settings.', 'protocol');
      const len = buf.readUInt16BE(2);
      if (len < 11 || len > 512) return fail('This computer isn’t offering a Windows remote desktop on that port. Check the port in this computer’s desktop settings.', 'protocol');
      if (buf.length < len) return;
      sock.off('data', onData);
      // X.224 Connection Confirm (0xd0) carrying RDP_NEG_RSP (2) or RDP_NEG_FAILURE (3).
      if ((buf[5] & 0xf0) !== 0xd0) return fail('This computer isn’t offering a Windows remote desktop on that port. Check the port in this computer’s desktop settings.', 'protocol');
      if (len < 19) return fail('RemoteHub can’t open a remote desktop on this computer. Try VNC instead.', 'no-tls');
      const type = buf[11];
      if (type === 0x03) return fail('RemoteHub can’t open a remote desktop on this computer. Try VNC instead.', 'no-tls');
      const selected = buf.readUInt32LE(15);
      if (type !== 0x02 || !(selected & 0x3)) return fail('RemoteHub can’t open a remote desktop on this computer. Try VNC instead.', 'no-tls');
      tlsSocket = tls.connect({ socket: sock, rejectUnauthorized: false, servername: net.isIP(host) ? undefined : host });
      tlsSocket.once('secureConnect', () => {
        const cert = tlsSocket.getPeerCertificate();
        let fp;
        try { fp = normalizeFingerprint(cert?.fingerprint256); } catch { return fail('RemoteHub can’t open a remote desktop on this computer. Try VNC instead.', 'no-cert'); }
        if (done) return;
        done = true; clearTimeout(timer); tlsSocket.destroy(); sock.destroy();
        resolve(fp);
      });
      tlsSocket.once('error', (err) => fail('RemoteHub couldn’t open a safe connection to this computer’s remote desktop. Click Reconnect to try again.', 'tls'));
    };
    sock.on('data', onData);
    sock.once('connect', () => sock.write(X224_CR));
    sock.once('error', (err) => fail('RemoteHub couldn’t reach this computer’s remote desktop. Click Reconnect to try again.', 'unreachable'));
    sock.once('close', () => fail('This computer’s remote desktop closed the connection. Click Reconnect to try again.', 'closed'));
  });
}

/**
 * Pre-connect step for an RDP host: probe, pin on first use, fail closed on change.
 * `savePin(pin)` persists a first-use pin. Returns extra guacd params.
 * Throws `{ code, reason }` for the bridge to close with.
 */
export async function rdpPreflight({ host, settings, savePin, probe = probeRdpCertificate, log = () => {} }) {
  if (settings.ignoreCert) {
    log(`desktop host=${host.id} rdp certificate check skipped (ignore-cert set by owner)`);
    return rdpParameters(settings);
  }
  let observed;
  try { observed = await probe({ host: host.address, port: settings.port }); }
  catch (err) {
    // Legacy RDP security has no certificate; the owner chose it explicitly.
    if (err?.code === 'no-tls' && settings.security === 'rdp') return rdpParameters(settings);
    throw { code: RDP_CLOSE.CERT_UNAVAILABLE, reason: err?.message ?? 'RemoteHub couldn’t reach this computer’s remote desktop. Click Reconnect to try again.' };
  }
  const { action, pin } = checkCertPin(settings.certPin, observed);
  if (action === 'changed') {
    log(`desktop host=${host.id} rdp certificate CHANGED (pinned ${pin.slice(0, 23)}..., now ${observed.slice(0, 23)}...); refusing`);
    throw { code: RDP_CLOSE.CERT_CHANGED, reason: 'This computer looks different from last time. If you expected that, click “Trust this computer again”.' };
  }
  if (action === 'pin') {
    await savePin(observed);
    log(`desktop host=${host.id} rdp certificate pinned on first use ${observed}`);
  }
  return rdpParameters(settings, { certFingerprint: observed });
}
