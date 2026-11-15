import net from 'node:net';

/**
 * A scripted stand-in for guacd (SAA-301). Modes:
 *  - 'up':        answers `select` with `args` like guacd 1.5 (optionally in tiny chunks)
 *  - 'hung':      accepts the TCP connection and never answers
 *  - 'close':     closes without a reply (guacd does this for an unknown protocol)
 *  - 'error':     answers with a Guacamole `error` instruction
 *  - 'garbage':   answers like an HTTP server
 *  - 'flood':     sends an endless stream without a terminator
 * `mode` can be changed while running. Every received request is recorded.
 */
export async function startFakeGuacd({ mode = 'up', chunked = false } = {}) {
  const fake = { mode, chunked, requests: [], connections: 0, sockets: new Set() };
  const server = net.createServer((socket) => {
    fake.connections += 1;
    fake.sockets.add(socket);
    socket.on('close', () => fake.sockets.delete(socket));
    socket.on('error', () => {});
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk;
      if (!buffer.includes(';')) return;
      fake.requests.push(buffer);
      const reply = (text) => {
        if (!fake.chunked) return socket.write(text);
        [...text].forEach((ch, i) => setTimeout(() => !socket.destroyed && socket.write(ch), i));
      };
      switch (fake.mode) {
        case 'up': return reply('4.args,13.VERSION_1_5_0,8.hostname,4.port,8.password;');
        case 'hung': return undefined;
        case 'close': return socket.end();
        case 'error': return reply('5.error,23.Protocol not supported.,3.519;');
        case 'garbage': return reply('HTTP/1.1 400 Bad Request\r\n\r\n');
        case 'flood': return socket.write('9'.repeat(16_384));
        default: return socket.destroy();
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  fake.port = server.address().port;
  fake.stop = () => new Promise((resolve) => {
    for (const s of fake.sockets) s.destroy();
    server.close(() => resolve());
  });
  return fake;
}
