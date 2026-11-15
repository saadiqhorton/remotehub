import net from 'node:net';
import { InstructionStream, encode } from '../../server/desktop-bridge.js';

/**
 * Scripted guacd that speaks the full connection handshake (SAA-302).
 * mode: 'ok' (args -> ready + size + sync + img), 'reject' (error after connect, like a
 * wrong VNC password), 'hung' (accepts, never answers), 'no-ready' (args, then silence), 'prompt' and 'reject-auth' (SAA-304 RDP),
 * 'audio' ('ok', then a remote-sound stream: audio + blob + end, like guacd RDP with sound on).
 * Records every instruction it receives per connection.
 */
export async function startFakeGuacdSession({ mode = 'ok', argNames = ['VERSION_1_5_0', 'hostname', 'port', 'password'] } = {}) {
  const fake = { mode, connections: 0, received: [], sockets: new Set() };
  const server = net.createServer((socket) => {
    fake.connections += 1;
    const log = [];
    fake.received.push(log);
    fake.sockets.add(socket);
    socket.on('close', () => fake.sockets.delete(socket));
    socket.on('error', () => {});
    const stream = new InstructionStream();
    socket.on('data', (chunk) => {
      for (const { elements } of stream.push(chunk.toString())) {
        log.push(elements);
        const [op] = elements;
        if (fake.mode === 'hung') continue;
        if (op === 'select') socket.write(encode('args', ...argNames));
        if (op === 'connect' && fake.mode === 'audio') {
          socket.write(encode('ready', '$fake') + encode('size', '0', '640', '480') + encode('sync', '1')
            + encode('audio', '3', 'audio/L16;rate=44100,channels=2') + encode('blob', '3', 'AAAAAAAAAAA=') + encode('end', '3') + encode('sync', '2'));
        }
        if (op === 'connect' && fake.mode === 'ok') {
          socket.write(encode('ready', '$fake') + encode('size', '0', '640', '480') + encode('img', '1', '14', '0', 'image/png', '0', '0') + encode('blob', '1', 'iVBORw0K') + encode('end', '1') + encode('sync', '1234'));
        }
        // SAA-304 'prompt': like guacd RDP with no password - ready, then `required password`;
        // frames start once an argv stream for it has ended. 'reject-auth': RDP auth error.
        if (op === 'connect' && fake.mode === 'prompt') { socket.write(encode('ready', '$fake') + encode('required', 'password')); socket.argvStreams = new Set(); }
        if (op === 'argv' && fake.mode === 'prompt') { socket.argvStreams.add(elements[1]); socket.write(encode('ack', elements[1], 'Ready for updated parameter.', '0')); }
        if (op === 'end' && fake.mode === 'prompt' && socket.argvStreams?.has(elements[1])) {
          socket.write(encode('size', '0', '640', '480') + encode('img', '1', '14', '0', 'image/png', '0', '0') + encode('blob', '1', 'iVBORw0K') + encode('end', '1') + encode('sync', '1234'));
        }
        if (op === 'connect' && fake.mode === 'reject-auth') { socket.write(encode('ready', '$fake') + encode('error', 'Authentication failure (invalid credentials?)', '769')); socket.end(); }
        if (op === 'connect' && fake.mode === 'reject') { socket.write(encode('error', 'Authentication failure', '769')); socket.end(); }
      }
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  fake.port = server.address().port;
  fake.dropAll = () => { for (const s of fake.sockets) s.destroy(); };
  fake.stop = () => new Promise((r) => { fake.dropAll(); server.close(() => r()); });
  return fake;
}
