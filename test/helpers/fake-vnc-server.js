import net from 'node:net';

/**
 * Minimal RFB server for the SAA-305 VNC pre-check tests. Speaks only the version and
 * security-type stages of RFC 6143, records what the client sent, then waits.
 * mode: 'types' (offer `types`), 'refuse' (count 0 + reason), 'v33' (RFB 3.3 single
 * type), 'not-vnc' (HTTP banner), 'silent' (accept, say nothing).
 */
export async function startFakeVncServer({ mode = 'types', types = [2], reason = 'Too many security failures', version = '003.008' } = {}) {
  const fake = { received: [], sockets: new Set() };
  const server = net.createServer((socket) => {
    fake.sockets.add(socket);
    socket.on('close', () => fake.sockets.delete(socket));
    socket.on('error', () => {});
    socket.on('data', (d) => {
      fake.received.push(d.toString('latin1'));
      if (mode === 'types') socket.write(Buffer.from([types.length, ...types]));
      if (mode === 'refuse') { const r = Buffer.from(reason); const len = Buffer.alloc(4); len.writeUInt32BE(r.length); socket.write(Buffer.concat([Buffer.from([0]), len, r])); }
      if (mode === 'v33') { const b = Buffer.alloc(4); b.writeUInt32BE(types[0]); socket.write(b); }
    });
    if (mode === 'not-vnc') socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
    else if (mode !== 'silent') socket.write(`RFB ${mode === 'v33' ? '003.003' : version}\n`);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  fake.port = server.address().port;
  fake.stop = () => new Promise((r) => { for (const s of fake.sockets) s.destroy(); server.close(() => r()); });
  return fake;
}
