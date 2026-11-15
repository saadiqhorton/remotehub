import net from 'node:net';

/**
 * Test-only TCP proxy in front of a real VNC server (SAA-346). It passes the RFB handshake
 * (version, security, ServerInit) straight through, then holds back everything the server
 * sends after ServerInit, i.e. the first picture, for `firstFrameDelayMs`. That makes the
 * pane's "Loading the screen…" state visible in a real browser. Off (0) unless asked for;
 * nothing under server/ or public/ imports this file.
 * Supports security types 1 (None) and 2 (VNC password), which is what the rigs use.
 */
export function serverHandshakeLength(server, clientChoice) {
  // server: bytes the VNC server has sent so far; clientChoice: security type the client picked.
  let n = 12; // "RFB 003.008\n"
  if (server.length < n + 1) return null;
  const count = server[n];
  if (count === 0) return null; // refusal: never "init", keep passing through
  n += 1 + count;
  if (clientChoice == null) return null;
  if (clientChoice === 2) n += 16; // challenge
  n += 4; // SecurityResult
  if (server.length < n + 24) return null;
  const nameLength = server.readUInt32BE(n + 20);
  n += 24 + nameLength;
  return server.length >= n ? n : null;
}

export async function startDelayedVncProxy({ targetHost = '127.0.0.1', targetPort, firstFrameDelayMs = 0, listenHost = '127.0.0.1', listenPort = 0 } = {}) {
  const proxy = { sockets: new Set(), heldBytes: 0, events: [] };
  const server = net.createServer((client) => {
    const upstream = net.connect(targetPort, targetHost);
    for (const s of [client, upstream]) { proxy.sockets.add(s); s.on('close', () => proxy.sockets.delete(s)); s.on('error', () => { client.destroy(); upstream.destroy(); }); }
    let fromClient = Buffer.alloc(0); let fromServer = Buffer.alloc(0);
    let initDone = !(firstFrameDelayMs > 0); let holding = false; const held = [];
    client.on('data', (d) => { if (!initDone) fromClient = Buffer.concat([fromClient, d]); upstream.write(d); });
    upstream.on('data', (d) => {
      if (holding) { held.push(d); proxy.heldBytes += d.length; return; }
      if (initDone) { client.write(d); return; }
      const start = fromServer.length;
      fromServer = Buffer.concat([fromServer, d]);
      const choice = fromClient.length > 12 ? fromClient[12] : null;
      const end = serverHandshakeLength(fromServer, choice);
      if (end == null) { client.write(d); return; }
      initDone = true; holding = true;
      client.write(d.subarray(0, end - start));
      const rest = d.subarray(end - start); if (rest.length) { held.push(rest); proxy.heldBytes += rest.length; }
      proxy.events.push({ at: Date.now(), event: 'hold' });
      setTimeout(() => { holding = false; proxy.events.push({ at: Date.now(), event: 'release' }); for (const b of held.splice(0)) client.write(b); }, firstFrameDelayMs);
    });
    client.on('close', () => upstream.destroy()); upstream.on('close', () => client.destroy());
  });
  await new Promise((r) => server.listen(listenPort, listenHost, r));
  proxy.port = server.address().port;
  proxy.stop = () => new Promise((r) => { for (const s of proxy.sockets) s.destroy(); server.close(() => r()); });
  return proxy;
}
