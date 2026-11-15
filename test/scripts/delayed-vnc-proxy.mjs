// Test rig CLI (SAA-346): RH_TEST_VNC_TARGET_PORT=<real vnc> RH_TEST_VNC_PROXY_PORT=<listen>
// RH_TEST_VNC_FIRST_FRAME_DELAY_MS=3000 node test/scripts/delayed-vnc-proxy.mjs
// Holds the first picture back so "Loading the screen…" can be seen in a browser. Test only.
import { startDelayedVncProxy } from '../helpers/delayed-vnc-proxy.js';
const env = process.env;
const proxy = await startDelayedVncProxy({
  targetHost: env.RH_TEST_VNC_TARGET_HOST || '127.0.0.1',
  targetPort: Number(env.RH_TEST_VNC_TARGET_PORT),
  listenHost: env.RH_TEST_VNC_PROXY_HOST || '127.0.0.1',
  listenPort: Number(env.RH_TEST_VNC_PROXY_PORT || 0),
  firstFrameDelayMs: Number(env.RH_TEST_VNC_FIRST_FRAME_DELAY_MS || 0),
});
console.log(`delayed-vnc-proxy listening on ${env.RH_TEST_VNC_PROXY_HOST || '127.0.0.1'}:${proxy.port} delay=${Number(env.RH_TEST_VNC_FIRST_FRAME_DELAY_MS || 0)}ms`);
process.on('SIGTERM', async () => { await proxy.stop(); process.exit(0); });
