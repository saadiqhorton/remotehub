import net from 'node:net';
import tls from 'node:tls';
import { readFileSync } from 'node:fs';

/**
 * Minimal RDP endpoint for the SAA-304 certificate check: answers the X.224 Connection
 * Request with an RDP_NEG_RSP selecting TLS, then speaks TLS with a test-only cert.
 * mode: 'tls' | 'no-tls' (RDP_NEG_FAILURE) | 'not-rdp' (HTTP-like garbage).
 * `fake.cert = 'b'` swaps the certificate (simulates a changed/impersonated server).
 */
const fixture = (n) => ({ key: readFileSync(new URL(`../fixtures/rdp/key-${n}.pem`, import.meta.url)), cert: readFileSync(new URL(`../fixtures/rdp/cert-${n}.pem`, import.meta.url)) });
export const RDP_FIXTURES = { a: fixture('a'), b: fixture('b') };

export async function startFakeRdpServer({ mode = 'tls', cert = 'a' } = {}) {
  const fake = { mode, cert, probes: 0, bytesAfterTls: 0 };
  const server = net.createServer((socket) => {
    fake.probes += 1;
    socket.on('error', () => {});
    socket.once('data', () => {
      if (fake.mode === 'not-rdp') return socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
      const rsp = Buffer.from([0x03, 0x00, 0x00, 0x13, 0x0e, 0xd0, 0, 0, 0x12, 0x34, 0x00,
        fake.mode === 'no-tls' ? 0x03 : 0x02, 0x00, 0x08, 0x00, fake.mode === 'no-tls' ? 0x02 : 0x01, 0, 0, 0]);
      socket.write(rsp);
      if (fake.mode === 'no-tls') return socket.end();
      const t = new tls.TLSSocket(socket, { isServer: true, ...RDP_FIXTURES[fake.cert] });
      t.on('error', () => {});
      t.on('data', (d) => { fake.bytesAfterTls += d.length; });
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  fake.port = server.address().port;
  fake.stop = () => new Promise((r) => server.close(() => r()));
  return fake;
}
