import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import fs from 'node:fs';
import { startDelayedVncProxy, serverHandshakeLength } from './helpers/delayed-vnc-proxy.js';

// Upstream that speaks a None-auth RFB handshake, then sends a "picture" (FramebufferUpdate).
const NAME = Buffer.from('rig');
const INIT = Buffer.concat([Buffer.from('RFB 003.008\n'), Buffer.from([1, 1])]);
const RESULT_AND_SERVERINIT = (() => { const b = Buffer.alloc(4 + 24); b.writeUInt16BE(64, 4); b.writeUInt16BE(48, 6); b.writeUInt32BE(NAME.length, 24); return Buffer.concat([b, NAME]); })();
const PICTURE = Buffer.from([0, 0, 0, 1]);
async function upstream() {
  const s = net.createServer((sock) => {
    sock.on('error', () => {});
    sock.write(INIT);
    let n = 0; let sentInit = false; let sentPicture = false;
    // client sends 12 (version) + 1 (security choice) + 1 (ClientInit) + 1 (stand-in for a request)
    sock.on('data', (d) => { n += d.length; if (n >= 13 && !sentInit) { sentInit = true; sock.write(RESULT_AND_SERVERINIT); } if (n >= 15 && !sentPicture) { sentPicture = true; sock.write(PICTURE); } });
  });
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  return s;
}
async function run(delay) {
  const up = await upstream();
  const proxy = await startDelayedVncProxy({ targetPort: up.address().port, firstFrameDelayMs: delay });
  const c = net.connect(proxy.port, '127.0.0.1');
  let got = Buffer.alloc(0); let tInit = 0; let tPicture = 0;
  const handshakeLen = INIT.length + RESULT_AND_SERVERINIT.length;
  await new Promise((resolve) => {
    c.on('data', (d) => {
      const before = got.length; got = Buffer.concat([got, d]);
      if (before < 12 && got.length >= 12) c.write('RFB 003.008\n');
      if (before < INIT.length && got.length >= INIT.length) c.write(Buffer.from([1]));
      if (!tInit && got.length >= handshakeLen) { tInit = Date.now(); c.write(Buffer.from([1, 1])); }
      if (got.length >= handshakeLen + PICTURE.length) { tPicture = Date.now(); resolve(); }
    });
  });
  c.destroy(); await proxy.stop(); await new Promise((r) => up.close(r));
  return { gap: tPicture - tInit, got };
}

test('delayed VNC proxy: ServerInit passes at once, the first picture is held for the delay', async () => {
  const { gap, got } = await run(600);
  assert.ok(gap >= 550, `picture arrived ${gap} ms after ServerInit, expected about 600`);
  assert.deepEqual(got.subarray(-4), PICTURE);
});

test('delayed VNC proxy: off by default, nothing is held', async () => {
  const { gap } = await run(undefined);
  assert.ok(gap < 300, `picture held ${gap} ms with no delay asked for`);
});

test('delayed VNC proxy: handshake length covers None and VNC-password auth', () => {
  const base = Buffer.concat([Buffer.from('RFB 003.008\n'), Buffer.from([2, 1, 2])]);
  const tail = RESULT_AND_SERVERINIT;
  assert.equal(serverHandshakeLength(Buffer.concat([base, tail]), 1), base.length + tail.length);
  assert.equal(serverHandshakeLength(Buffer.concat([base, Buffer.alloc(16), tail]), 2), base.length + 16 + tail.length);
  assert.equal(serverHandshakeLength(base, 1), null);
});

test('the delay is test-only: no product file references the proxy or its env var', () => {
  const files = fs.readdirSync(new URL('../server/', import.meta.url), { recursive: true }).map((f) => new URL(`../server/${f}`, import.meta.url))
    .concat(fs.readdirSync(new URL('../public/js/', import.meta.url), { recursive: true }).map((f) => new URL(`../public/js/${f}`, import.meta.url)));
  for (const f of files) {
    if (!String(f).endsWith('.js')) continue;
    const text = fs.readFileSync(f, 'utf8');
    assert.ok(!/RH_TEST_VNC_FIRST_FRAME_DELAY_MS|delayed-vnc-proxy/.test(text), `${f} references the test-only delay`);
  }
});
