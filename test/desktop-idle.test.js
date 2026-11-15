// SAA-346: an idle desktop session must stay open. guacd drops a user it has not heard
// from for ~15 s ("User is not responding" -> bridge 1011). This drives the real browser
// view (DesktopSession + WebSocket tunnel) through RemoteHub's /ws/desktop bridge to a
// REAL guacd + VNC server, sends no user input, and checks the session is still up
// after 20 s. Needs a guacd/VNC rig and RH_IDLE_RIG=1; skipped otherwise.
//   RH_IDLE_GUACD_PORT and RH_IDLE_VNC_PORT (required, no defaults),
//   RH_IDLE_VNC_PASSWORD (never printed). Skipped cleanly when any is missing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import fs from 'node:fs/promises';
import WebSocket from 'ws';
import { httpClient, startTestApp } from './helpers/app-harness.js';
import { makeDocument } from './helpers/fake-dom.js';

globalThis.document ??= makeDocument();
const { DesktopSession } = await import('../public/js/desktop-session.js');
const { RemoteHubTunnel } = await import('../public/js/desktop-tunnel.js');

const GUACD_PORT = Number(process.env.RH_IDLE_GUACD_PORT) || 0;
const VNC_PORT = Number(process.env.RH_IDLE_VNC_PORT) || 0;
const IDLE_MS = 20_000;

const listening = (port) => new Promise((resolve) => {
  const s = net.connect({ host: '127.0.0.1', port }, () => { s.destroy(); resolve(true); });
  s.on('error', () => resolve(false));
});
// Opt-in (RH_IDLE_RIG=1): a plain `npm test` must not depend on whatever happens to be
// listening on these ports on a dev box.
const rig = process.env.RH_IDLE_RIG === '1' && GUACD_PORT > 0 && VNC_PORT > 0 && (await listening(GUACD_PORT)) && (await listening(VNC_PORT));
const until = async (pred, ms) => { const end = Date.now() + ms; while (!pred()) { if (Date.now() > end) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 20)); } };

test('idle desktop session through the real bridge + guacd stays open past guacd\'s 15 s user timeout', { skip: rig ? false : 'set RH_IDLE_RIG=1, RH_IDLE_GUACD_PORT and RH_IDLE_VNC_PORT (both listening) to run', timeout: 90_000 }, async () => {
  const t = await startTestApp({ guacd: { enabled: true, host: '127.0.0.1', port: GUACD_PORT, protocol: 'vnc', timeoutMs: 2000, cacheMs: 0 } }, { log: () => {} });
  const client = httpClient(t.base, t.origin);
  const code = (await fs.readFile(`${t.dataDir}/SETUP-CODE.txt`, 'utf8')).trim();
  await client.request('/api/auth/setup', { method: 'POST', body: { setupCode: code, password: 'owner-password-1' } });
  const host = (await client.request('/api/hosts', { method: 'POST', body: { name: 'idle', address: '127.0.0.1', port: 22, username: 'me' } })).body.host;
  await client.request(`/api/hosts/${host.id}/desktop`, { method: 'PUT', body: { protocol: 'vnc', port: VNC_PORT } });
  const WS = class extends WebSocket { constructor(url) { super(url, { headers: { Origin: t.origin, Cookie: client.cookie } }); } };
  const closes = [];
  const makeView = () => new DesktopSession({
    host: { ...host, desktop: { protocol: 'vnc', port: VNC_PORT } },
    createTunnel: (o) => {
      const tunnel = new RemoteHubTunnel({ url: `${t.base.replace('http', 'ws')}/ws/desktop?hostId=${o.host.id}&width=800&height=600`, WebSocketImpl: WS, password: o.password });
      return tunnel;
    },
  });
  // Warm-up: the first session after x11vnc/guacd start survived 20 s of silence on main
  // (2 of 2 cold starts), so open, hold and close one session before the measured one.
  const warm = makeView();
  warm.mount(document.createElement('div'));
  warm.connectPassword.value = process.env.RH_IDLE_VNC_PASSWORD || '';
  warm.connect();
  await until(() => warm.state === 'ready' && warm.remoteSize.width > 0, 10_000);
  // a freshly started x11vnc sends one late update ~5 s after the first client connects;
  // let the warm-up session absorb it
  await new Promise((r) => setTimeout(r, 8000));
  warm.dispose();
  await new Promise((r) => setTimeout(r, 500));
  const s = makeView();
  try {
    s.mount(document.createElement('div'));
    s.connectPassword.value = process.env.RH_IDLE_VNC_PASSWORD || '';
    s.connect();
    const tunnel = s.tunnel;
    const onclose = tunnel.onclose;
    tunnel.onclose = (e) => { closes.push({ code: e?.code, at: Date.now() }); onclose(e); };
    // Reliability: wait for the first frame AND the view's sync reply for it, then for
    // guacd to go quiet (no frame/sync for 3 s; a fresh x11vnc keeps sending updates for a
    // few seconds after the first client connects), so the idle window really is idle.
    const syncs = [];
    const send = tunnel.send.bind(tunnel);
    tunnel.send = (opcode, ...args) => { if (opcode === 'sync') syncs.push(Date.now()); return send(opcode, ...args); };
    await until(() => s.state === 'ready' && s.remoteSize.width > 0, 10_000);
    await until(() => syncs.length > 0, 10_000);
    await until(() => Date.now() - syncs.at(-1) > 3000, 20_000);
    const start = Date.now();
    const syncsBefore = syncs.length;
    // Idle = 20 s with no sync answered (any late frame + reply restarts guacd's timer,
    // which is why a cold first run could pass on main), capped at 45 s overall.
    while (!closes.length && (Date.now() - Math.max(start, syncs.at(-1)) < IDLE_MS || Date.now() - start < 40_000) && Date.now() - start < 60_000) {
      await new Promise((r) => setTimeout(r, 100));
    }
    console.log(`idle window: ${Date.now() - start} ms, syncs answered while idle: ${syncs.length - syncsBefore}`);
    assert.deepEqual(closes.map((c) => ({ code: c.code, afterMs: c.at - start, framesWhileIdle: syncs.length - syncsBefore })), [], 'no close while idle');
    assert.equal(s.state, 'ready');
    assert.equal(s.tunnel, tunnel);
  } finally {
    s.dispose();
    await t.stop();
  }
});
