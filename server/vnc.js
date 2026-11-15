// VNC backend helpers (SAA-305).
//
// probeVnc() is a read-only RFB pre-check used to explain a failed VNC session in
// plain words. It connects to the host's VNC port, reads the server's RFB version and
// the security types it offers, and hangs up before any authentication. It never
// sends or receives a password, so nothing secret can be logged.
//
//   RFB handshake (RFC 6143 §7.1): server "RFB 003.00x\n" -> client echoes a version ->
//   3.7/3.8: server sends <count:u8> <types...>; count 0 => <len:u32> <reason>
//   3.3:     server sends <type:u32>; type 0 => <len:u32> <reason>

import net from 'node:net';

export const VNC_SECURITY_NAMES = Object.freeze({
  1: 'None', 2: 'VNC password', 5: 'RA2', 6: 'RA2ne', 16: 'Tight', 17: 'Ultra',
  18: 'TLS', 19: 'VeNCrypt', 20: 'GTK-VNC SASL', 21: 'MD5 hash', 22: 'Colin Dean xvp',
  30: 'Apple Remote Desktop', 113: 'MSLogonII', 129: 'Unix Login',
});
// Types libvncclient (what guacd's VNC plugin uses) can complete in its usual build.
export const VNC_SUPPORTED_SECURITY = Object.freeze([1, 2, 18, 19, 30]);

function finish(socket, resolve, result) {
  socket.removeAllListeners('data');
  socket.destroy();
  resolve(result);
}

/** Read-only RFB pre-check. Never authenticates. */
// monotonic: latency is a duration, and wall-clock steps (NTP/WSL) must not inflate it
export function probeVnc({ host, port, timeoutMs = 3000 }, { connect = net.connect, now = () => Math.round(performance.now()) } = {}) {
  return new Promise((resolve) => {
    const started = now();
    const socket = connect({ host, port });
    let buf = Buffer.alloc(0);
    let stage = 'version';
    let version = null;
    const done = (status, extra = {}) => finish(socket, resolve, { status, latencyMs: now() - started, ...(version ? { rfbVersion: version } : {}), ...extra });
    let connected = false;
    socket.once('connect', () => { connected = true; });
    // Connected but no RFB greeting in time (e.g. an HTTP server waiting for a request)
    // means something other than VNC is on that port.
    const timer = setTimeout(() => { stage = 'done'; done(connected && !version ? 'not-vnc' : 'timeout', connected && !version ? { silent: true } : {}); }, timeoutMs);
    socket.once('close', () => { clearTimeout(timer); if (stage !== 'done') { stage = 'done'; resolve({ status: version ? 'closed' : 'unreachable', latencyMs: now() - started, ...(version ? { rfbVersion: version } : {}) }); } });
    socket.on('error', (error) => { clearTimeout(timer); if (stage === 'done') return; stage = 'done'; resolve({ status: 'unreachable', code: error.code || 'error', latencyMs: now() - started }); });
    const end = (status, extra) => { clearTimeout(timer); stage = 'done'; done(status, extra); };
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (stage === 'version') {
        if (buf.length < 12) return;
        const text = buf.subarray(0, 12).toString('latin1');
        const m = /^RFB (\d{3})\.(\d{3})\n$/.exec(text);
        if (!m) return end('not-vnc');
        version = `${Number(m[1])}.${Number(m[2])}`;
        const minor = Number(m[2]);
        const reply = Number(m[1]) > 3 || minor >= 8 ? '003.008' : minor >= 7 ? '003.007' : '003.003';
        socket.write(`RFB ${reply}\n`);
        buf = buf.subarray(12);
        stage = reply === '003.003' ? 'type33' : 'types';
      }
      if (stage === 'types') {
        if (buf.length < 1) return;
        const count = buf[0];
        if (count === 0) {
          if (buf.length < 5) return;
          const len = buf.readUInt32BE(1);
          if (buf.length < 5 + len) return;
          return end('refused', { reason: buf.subarray(5, 5 + Math.min(len, 300)).toString('utf8') });
        }
        if (buf.length < 1 + count) return;
        return end('ok', describeTypes([...buf.subarray(1, 1 + count)]));
      }
      if (stage === 'type33') {
        if (buf.length < 4) return;
        const type = buf.readUInt32BE(0);
        if (type === 0) {
          if (buf.length < 8) return;
          const len = buf.readUInt32BE(4);
          if (buf.length < 8 + len) return;
          return end('refused', { reason: buf.subarray(8, 8 + Math.min(len, 300)).toString('utf8') });
        }
        return end('ok', describeTypes([type]));
      }
    });
  });
}

function describeTypes(types) {
  return {
    securityTypes: types.map((id) => ({ id, name: VNC_SECURITY_NAMES[id] ?? `type ${id}` })),
    needsPassword: !types.includes(1) && types.some((id) => [2, 18, 19, 30].includes(id)),
    supported: types.some((id) => VNC_SUPPORTED_SECURITY.includes(id)),
  };
}

/**
 * Plain-words explanation of a failed VNC session from a probeVnc() result.
 * `passwordGiven` says whether the user supplied a password for that attempt.
 * Returns { reason, message } or null when the probe adds nothing.
 */
export function explainVncFailure(check, { address, port, passwordGiven = false } = {}) {
  const where = `${address}:${port}`;
  switch (check?.status) {
    case 'unreachable':
      return { reason: 'vnc-unreachable', message: `Nothing answered at ${where}. Check the port in this computer’s desktop settings, then connect again.` };
    case 'timeout':
      return { reason: 'vnc-unreachable', message: `The desktop at ${where} didn’t answer in time. Connect again to retry.` };
    case 'not-vnc':
      return { reason: 'vnc-not-vnc', message: `Something answered at ${where}, but it isn’t a VNC desktop. Check the port in this computer’s desktop settings.` };
    case 'closed':
      return { reason: 'vnc-refused', message: `The desktop at ${where} closed the connection. Connect again to retry.` };
    case 'refused':
      return { reason: 'vnc-refused', message: 'The VNC desktop turned down the connection. Connect again to retry.' };
    case 'ok': {
      if (!check.supported) return { reason: 'vnc-unsupported-security', message: 'This VNC desktop uses a sign-in method RemoteHub can’t use. Try RDP instead, if this computer offers it.' };
      if (check.needsPassword) {
        return passwordGiven
          ? { reason: 'vnc-auth', message: 'That desktop password didn’t work. Enter it again and connect.' }
          : { reason: 'vnc-auth', message: 'This desktop needs a password. Enter it and connect again.' };
      }
      return null;
    }
    default:
      return null;
  }
}
