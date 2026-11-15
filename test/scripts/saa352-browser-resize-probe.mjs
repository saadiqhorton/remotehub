// SAA-352 repro: real browser -> RemoteHub (Compose) -> guacd -> xrdp. Resizes the viewport and
// logs every guac `size` the browser sends/receives, image counts, pane state and whether typing repaints.
// EXPECT_FALLBACK=1: a refusing target. Must use fixed=1 after fallback and show a ready connection with fresh images.
// EXPECT_FALLBACK=0: normal resizing. No fixed=1 socket, and every size the browser sent is echoed back.
// Unset: no extra requirement. The fallback case never treats canvas clearing as proof of a live picture.
// SETUP_CODE_FILE, or DATA_DIR/SETUP-CODE.txt (default data/), supplies the setup code on first run.
import fs from 'node:fs'; import path from 'node:path'; import { createRequire } from 'node:module';
import {
  createFixedSocketReadinessTracker,
  createSAA352RecoveryBudget,
  getLatestActiveFixedSocket,
  getLatestFixedSocket,
  getSAA352ReadinessDeadline,
  isSAA352CurrentFixedSocket,
  parseSAA352GuacErrors,
  sanitizeSAA352LogMessage,
  SAA352_INPUT_BASELINE_TIMEOUT_MS,
  SAA352_INPUT_CLICK_TIMEOUT_MS,
  SAA352_INPUT_SETUP_TIMEOUT_MS,
  SAA352_INPUT_STATE_TIMEOUT_MS,
  SAA352_INPUT_TIMEOUT_MS,
  SAA352_MAX_FIXED_SOCKET_ATTEMPTS,
  SAA352_RECOVERY_TIMEOUT_MS,
  SAA352_REQUIRED_HEIGHT,
  SAA352_REQUIRED_WIDTH,
  SAA352_STABLE_READY_MS,
} from './saa352-probe-readiness.mjs';
const req = createRequire(new URL('../../package.json', import.meta.url));
const { chromium } = req('playwright');
const BASE = process.env.BASE; const ADDR = process.env.RDP_ADDR; const PORT = Number(process.env.RDP_PORT || 13389);
const USER = process.env.RDP_USER; const PASS = process.env.RDP_PASSWORD; const OWNER = process.env.OWNER_PASSWORD || 'Owner-352-probe-pw';
const PROTO = process.env.PROTO || 'rdp';
const EXPECT = process.env.EXPECT_FALLBACK;
const SETUP_FILE = process.env.SETUP_CODE_FILE || path.join(process.env.DATA_DIR || 'data', 'SETUP-CODE.txt');
const SIZES = (process.env.SIZES || '1600x1000,1000x700,1440x900,1280x860,1280x860').split(',');
const t0 = Date.now(); const ts = () => ((Date.now() - t0) / 1000).toFixed(2);
const events = []; // in order: open/size/mouse/key/image/error wire events
const urls = [];
const sockets = [];
let nextSocketId = 0;
const checks = []; const check = (ok, reason) => { checks.push(ok); console.log(ok ? 'PASS' : 'FAIL', reason); };
async function withTimeout(operation, timeoutMs, label) {
  const duration = Math.max(0, timeoutMs);
  if (!duration) throw new Error(label + ' exceeded its time budget');
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(label + ' timed out')), duration);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
let proofSocket = null;
let browser;
let p;
let primaryError = null;
const screenshotPath = process.env.SHOT || 'saa352-resize-final.png';
try {
browser = await chromium.launch();
p = await browser.newPage({ viewport: { width: 1280, height: 860 } });
const ev = { inImg: 0, inSync: 0 };
p.on('websocket', (ws) => {
  if (!ws.url().includes('desktop')) return;
  const socket = { id: ++nextSocketId, fixed: /[?&]fixed=1(&|$)/.test(ws.url()), closed: false, ready: false, images: 0, errors: [], errorMessages: [], sizes: [], receivedSizes: [], currentSize: null, sizeRevision: 0 };
  sockets.push(socket); urls.push(ws.url()); events.push({ kind: 'open', socketId: socket.id, fixed: socket.fixed });
  console.log(ts(), 'WS open', ws.url().replace(/token=[^&]+/, 'token=…'));
  ws.on('framesent', (f) => { const s = String(f.payload);
    for (const m of s.matchAll(/(?:^|;)5\.mouse,([^;]*);/g)) {
      const v = [...m[1].matchAll(/\d+\.([^,;]+)/g)].map((x) => x[1]);
      if (v.length >= 3) events.push({ kind: 'mouse', socketId: socket.id, x: Number(v[v.length - 3]), y: Number(v[v.length - 2]), buttons: Number(v[v.length - 1]) });
    }
    for (const m of s.matchAll(/(?:^|;)3\.key,([^;]*);/g)) events.push({ kind: 'key', socketId: socket.id, payload: m[1] });
    for (const m of s.matchAll(/(?:^|;)4\.size,([^;]*);/g)) {
      const v = [...m[1].matchAll(/\d+\.(\d+)/g)].map((x) => Number(x[1]));
      if (v.length >= 2) {
        const size = { kind: 'sent', socketId: socket.id, w: v[v.length - 2], h: v[v.length - 1] };
        socket.sizes.push(size); events.push(size);
      }
    }
    if (/(^|;)4\.size,/.test(s)) console.log(ts(), 'SENT', s.slice(0, 80)); });
  ws.on('framereceived', (f) => { const s = String(f.payload);
    const images = (s.match(/(?:^|;)3\.img,/g) || []).length;
    ev.inImg += images; ev.inSync += (s.match(/(?:^|;)4\.sync,/g) || []).length;
    if (images) { socket.images += images; events.push({ kind: 'image', socketId: socket.id, count: images }); }
    if (/(?:^|;)5\.ready,/.test(s)) { socket.ready = true; events.push({ kind: 'ready', socketId: socket.id }); }
    for (const m of s.matchAll(/4\.size,1\.0,(\d+)\.(\d+),(\d+)\.(\d+);/g)) {
      const size = { kind: 'recv', socketId: socket.id, fixed: socket.fixed, w: Number(m[2]), h: Number(m[4]) };
      if (!socket.currentSize || socket.currentSize.w !== size.w || socket.currentSize.h !== size.h) {
        socket.currentSize = { w: size.w, h: size.h };
        socket.sizeRevision += 1;
      }
      socket.receivedSizes.push(size); events.push(size); console.log(ts(), 'RECV size layer0', m[2] + 'x' + m[4]);
    }
    for (const error of parseSAA352GuacErrors(s)) {
      const message = sanitizeSAA352LogMessage(error.message);
      socket.errors.push(error.status); socket.errorMessages.push(message);
      events.push({ kind: 'error', socketId: socket.id, status: error.status, message });
      console.log(ts(), 'RECV guac error', error.status, JSON.stringify(message));
    }
    for (const m of s.matchAll(/10\.disconnect;/g)) console.log(ts(), 'RECV', m[0]); });
  ws.on('close', () => { socket.closed = true; events.push({ kind: 'close', socketId: socket.id }); console.log(ts(), 'WS close', socket.id); });
});
await p.goto(BASE); await p.locator('#auth-password').waitFor({ state: 'visible' });
if (await p.locator('#setup-code').isVisible()) await p.fill('#setup-code', fs.readFileSync(SETUP_FILE, 'utf8').trim());
await p.fill('#auth-password', OWNER); if (await p.locator('#auth-confirm').isVisible()) await p.fill('#auth-confirm', OWNER);
await p.click('#auth-submit'); await p.waitForSelector('#add-host-btn', { timeout: 15000 });
const name = `R352 ${Date.now()}`;
const put = await p.evaluate(async ({ name, addr, settings }) => {
  const h = await (await fetch('/api/hosts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, address: addr, port: 22, username: 'ci' }) })).json();
  const r = await fetch(`/api/hosts/${(h.host ?? h).id}/desktop`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(settings) });
  return { status: r.status, hostId: (h.host ?? h).id };
}, { name, addr: ADDR, settings: PROTO === 'vnc' ? { protocol: 'vnc', port: PORT } : { protocol: 'rdp', port: PORT, username: USER, security: 'any', ignoreCert: false } });
console.log(ts(), 'desktop settings', put.status);
await p.reload(); await p.waitForSelector('#add-host-btn');
await p.click(`button[aria-label="Desktop on ${name}"]`);
if (PROTO === 'vnc') { const vp = p.locator('input[name="desktop-password"]:visible'); await vp.waitFor({ timeout: 10000 }); await vp.fill(PASS); await p.locator('.desktop-connect-btn:visible').click(); }
else { await p.locator('.desktop-connect-btn:visible').last().click();
const pw = p.locator('input[name="argv-password"]:visible').last(); await pw.waitFor({ timeout: 15000 }); await pw.fill(PASS); await pw.press('Enter'); }
const canvas = p.locator('.desktop-pane:visible canvas.desktop-canvas');
const pane = p.locator('.desktop-pane:visible');
await canvas.waitFor({ state: 'visible', timeout: 30000 });
await p.waitForFunction(() => document.querySelector('.desktop-pane.active')?.dataset.state === 'ready', null, { timeout: 30000 });
if (PROTO === 'rdp') {
  const pin = await p.evaluate(async (hostId) => {
    const response = await fetch('/api/hosts');
    const data = await response.json();
    return { status: response.status, value: data.hosts?.find((host) => host.id === hostId)?.desktop?.certPin ?? null };
  }, put.hostId);
  const validPin = /^sha256:(?:[0-9a-f]{2}:){31}[0-9a-f]{2}$/.test(pin.value || '');
  check(pin.status === 200 && validPin, pin.status !== 200 ? `RDP certificate pin API HTTP ${pin.status}` : `RDP first connection pin ${pin.value || 'missing'}`);
}
await p.waitForTimeout(1500);
await p.locator('.desktop-pane.active .desktop-guac-display').click({ position: { x: 200, y: 150 } }); await p.waitForTimeout(300);
const pic = () => canvas.evaluate((c) => c.toDataURL());
const info = () => canvas.evaluate((c) => ({ w: c.width, h: c.height, css: `${c.style.width}x${c.style.height}`, state: document.querySelector('.desktop-pane.active')?.dataset.state }));
async function typeCheck(label) {
  const before = await pic(); const imgs = ev.inImg;
  await p.keyboard.type(`echo ${label}`, { delay: 30 }); await p.keyboard.press('Enter');
  let changed = false; for (let i = 0; i < 25 && !changed; i++) { await p.waitForTimeout(200); changed = (await pic()) !== before; }
  console.log(ts(), `TYPE ${label}: canvasChanged=${changed} newImgs=${ev.inImg - imgs}`, JSON.stringify(await info()));
  return changed;
}
let ok = true;
if (EXPECT === '1') {
  const FIXED_OPEN_TIMEOUT_MS = 12000;
  const RECOVERY_TIMEOUT_MS = SAA352_RECOVERY_TIMEOUT_MS;
  const STABLE_READY_MS = SAA352_STABLE_READY_MS;
  const INPUT_CLICK_TIMEOUT_MS = SAA352_INPUT_CLICK_TIMEOUT_MS;
  const INPUT_TIMEOUT_MS = SAA352_INPUT_TIMEOUT_MS;
  const display = p.locator('.desktop-pane.active .desktop-guac-display');
  p.setDefaultTimeout(2000);
  const deadline = (duration) => Date.now() + duration;
  const recovery = createSAA352RecoveryBudget(Date.now(), { timeoutMs: RECOVERY_TIMEOUT_MS });
  const liveUntil = recovery.deadline;
  const readinessUntil = getSAA352ReadinessDeadline(liveUntil);
  const trackStableSocket = createFixedSocketReadinessTracker();
  const waitUntil = async (until, delay = 200) => {
    const remaining = until - Date.now();
    if (remaining > 0) await p.waitForTimeout(Math.min(Math.max(1, delay), remaining));
  };
  const waitFor = async (predicate, until) => {
    while (Date.now() < until) {
      const result = await predicate();
      if (result) return result;
      await waitUntil(until);
    }
    return null;
  };

  const [w, h] = SIZES[0].split('x').map(Number);
  console.log(ts(), '>>> trigger one resize ' + w + 'x' + h);
  await withTimeout(() => p.setViewportSize({ width: w, height: h }), recovery.remainingMs(Date.now()), 'fallback resize');
  const firstFixed = await waitFor(() => {
    const candidate = sockets.find((socket) => socket.fixed && !recovery.hasAttempt(socket));
    return candidate && recovery.registerAttempt(candidate, Date.now()) ? candidate : null;
  }, Math.min(deadline(FIXED_OPEN_TIMEOUT_MS), liveUntil));
  check(Boolean(firstFixed), firstFixed
    ? 'fallback: observed fixed=1 attempt on socket ' + firstFixed.id
    : 'fallback: no fixed=1 attempt within ' + FIXED_OPEN_TIMEOUT_MS + ' ms');
  const fixedEventIndex = events.findIndex((event) => event.kind === 'open' && event.fixed);
  const sizesBeforeFallback = fixedEventIndex >= 0 ? events.slice(0, fixedEventIndex).filter((event) => event.kind === 'sent') : [];
  check(sizesBeforeFallback.length > 0, sizesBeforeFallback.length
    ? 'fallback: observed ' + sizesBeforeFallback.length + ' dynamic resize request(s) before fixed=1'
    : 'fallback: no dynamic resize request was observed before fixed=1');

  async function waitForStableSocket(until) {
    while (Date.now() < until) {
      const now = Date.now();
      for (const attempted of sockets) {
        if (attempted.fixed && recovery.hasAttempt(attempted) && (attempted.closed || attempted.errors?.length)) {
          recovery.noteFailure(attempted, now);
        }
      }
      const unregistered = sockets.filter((socket) => socket.fixed && !recovery.hasAttempt(socket));
      if (unregistered.length) {
        const backoff = recovery.retryDelayRemaining(now);
        if (backoff > 0) {
          await waitUntil(until, backoff);
          continue;
        }
        const nextAttempt = unregistered[0];
        if (!recovery.registerAttempt(nextAttempt, now)) return null;
        if (nextAttempt.closed || nextAttempt.errors?.length) {
          const nextBackoff = recovery.noteFailure(nextAttempt, Date.now());
          if (recovery.attemptCount >= SAA352_MAX_FIXED_SOCKET_ATTEMPTS) return null;
          await waitUntil(until, Math.max(nextBackoff, 200));
        }
        continue;
      }

      const latestAttempt = getLatestFixedSocket(sockets);
      if (!latestAttempt) {
        await waitUntil(until);
        continue;
      }
      if (!recovery.hasAttempt(latestAttempt)) return null;

      const active = getLatestActiveFixedSocket(sockets);
      if (!active) {
        const currentInfo = await withTimeout(info, Math.min(2000, until - Date.now()), 'readiness state');
        trackStableSocket(sockets, currentInfo.state, Date.now(), STABLE_READY_MS);
        if (latestAttempt.closed || latestAttempt.errors?.length) {
          const backoff = recovery.noteFailure(latestAttempt, Date.now());
          if (recovery.attemptCount >= SAA352_MAX_FIXED_SOCKET_ATTEMPTS) return null;
          await waitUntil(until, Math.max(backoff, 200));
        } else {
          await waitUntil(until);
        }
        continue;
      }

      const currentInfo = await withTimeout(info, Math.min(2000, until - Date.now()), 'readiness state');
      const candidate = trackStableSocket(sockets, currentInfo.state, Date.now(), STABLE_READY_MS);
      if (candidate && isSAA352CurrentFixedSocket(candidate, sockets)) return candidate;
      await waitUntil(until);
    }
    return null;
  }

  let liveSocket = await waitForStableSocket(readinessUntil);
  check(Boolean(liveSocket), liveSocket
    ? 'fallback: latest fixed socket ' + liveSocket.id + ' supplied its own ready event, 1032x716 size, and fresh images across ' + STABLE_READY_MS + ' ms'
    : 'fallback: no current fixed socket supplied its own ready event, 1032x716 size, and 2 fresh images across ' + STABLE_READY_MS + ' ms within ' + RECOVERY_TIMEOUT_MS + ' ms (reserved the final input proof window)');

  let inputLive = false;
  let testedSocket = null;
  let keysAfterInput = 0;
  let mouseAfterInput = 0;
  let imagesAfterInput = 0;
  let lastState = 'unknown';
  while (Date.now() < liveUntil && !inputLive) {
    if (!liveSocket) {
      liveSocket = await waitForStableSocket(readinessUntil);
      if (!liveSocket) break;
    }
    if (Date.now() >= liveUntil) break;

    const beforeAttempt = await withTimeout(info, Math.min(SAA352_INPUT_STATE_TIMEOUT_MS, liveUntil - Date.now()), 'pre-input state');
    lastState = beforeAttempt.state;
    if (!isSAA352CurrentFixedSocket(liveSocket, sockets)
        || trackStableSocket(sockets, beforeAttempt.state, Date.now(), STABLE_READY_MS) !== liveSocket) {
      liveSocket = null;
      continue;
    }

    const candidate = liveSocket;
    if (!candidate) {
      liveSocket = null;
      continue;
    }
    testedSocket = candidate;
    const mouseBeforeInput = events.filter((event) => event.kind === 'mouse' && event.socketId === candidate.id).length;
    const clickTimeout = Math.min(INPUT_CLICK_TIMEOUT_MS, liveUntil - Date.now());
    if (clickTimeout <= 0) break;
    await display.click({ position: { x: 200, y: 150 }, timeout: clickTimeout }).catch(() => {});
    const afterClick = await withTimeout(info, Math.min(SAA352_INPUT_STATE_TIMEOUT_MS, liveUntil - Date.now()), 'post-click state');
    lastState = afterClick.state;
    if (!isSAA352CurrentFixedSocket(candidate, sockets)
        || trackStableSocket(sockets, afterClick.state, Date.now(), STABLE_READY_MS) !== candidate) {
      liveSocket = null;
      continue;
    }

    const before = await withTimeout(pic, Math.min(SAA352_INPUT_BASELINE_TIMEOUT_MS, liveUntil - Date.now()), 'canvas input baseline');
    const imagesBeforeInput = candidate.images;
    const keysBeforeInput = events.filter((event) => event.kind === 'key' && event.socketId === candidate.id).length;
    const setupUntil = Math.min(deadline(SAA352_INPUT_SETUP_TIMEOUT_MS), liveUntil);
    await withTimeout(async () => {
      await p.keyboard.type('echo saa352-live-' + Date.now(), { delay: 25 });
      await p.keyboard.press('Enter');
    }, setupUntil - Date.now(), 'keyboard input setup');

    const inputUntil = Math.min(deadline(INPUT_TIMEOUT_MS), liveUntil);
    while (Date.now() < inputUntil) {
      const remaining = inputUntil - Date.now();
      const current = await withTimeout(info, Math.min(2000, remaining), 'input proof state');
      lastState = current.state;
      const stableSocket = trackStableSocket(sockets, current.state, Date.now(), STABLE_READY_MS);
      const stillCurrent = isSAA352CurrentFixedSocket(candidate, sockets);
      keysAfterInput = events.filter((event) => event.kind === 'key' && event.socketId === candidate.id).length - keysBeforeInput;
      mouseAfterInput = events.filter((event) => event.kind === 'mouse' && event.socketId === candidate.id).length - mouseBeforeInput;
      imagesAfterInput = candidate.images - imagesBeforeInput;
      if (!stillCurrent || stableSocket !== candidate) break;
      const canvasRemaining = inputUntil - Date.now();
      if (canvasRemaining <= 0) break;
      const changed = (await withTimeout(pic, Math.min(2000, canvasRemaining), 'input canvas response')) !== before;
      if (stillCurrent && stableSocket === candidate && keysAfterInput > 0 && mouseAfterInput > 0 && imagesAfterInput >= 2 && changed) {
        inputLive = true;
        proofSocket = candidate;
        break;
      }
      await waitUntil(inputUntil);
    }
    if (inputLive) break;

    const latest = getLatestActiveFixedSocket(sockets);
    if (!isSAA352CurrentFixedSocket(candidate, sockets) || latest?.id !== candidate.id) {
      liveSocket = null;
      continue;
    }
    break;
  }
  check(inputLive, inputLive
    ? 'fallback: mouse and keyboard input produced 2 fresh images and a canvas update on stable socket ' + proofSocket.id
    : 'fallback: input did not produce 2 fresh images and a canvas update on stable socket ' + (testedSocket?.id || 'none') + ' (keys +' + keysAfterInput + ', mouse +' + mouseAfterInput + ', images +' + imagesAfterInput + ', state ' + lastState + ', closed=' + (testedSocket?.closed ?? true) + ', status520=' + (testedSocket?.errors.includes(520) ?? false) + ') within ' + RECOVERY_TIMEOUT_MS + ' ms');

} else {
  ok = await typeCheck('before-resize');
  for (const [i, s] of SIZES.entries()) {
    const [w, h] = s.split('x').map(Number);
    console.log(ts(), `>>> viewport ${s}`); await p.setViewportSize({ width: w, height: h });
    await p.waitForTimeout(2500);
    await p.locator('.desktop-pane.active .desktop-guac-display').click({ position: { x: 100, y: 100 } }).catch(() => {});
    ok = (await typeCheck(`after-${i}-${s}`)) && ok;
  }
  check(ok, ok ? 'picture live: every typeCheck changed the canvas' : 'picture frozen: a typeCheck did not change the canvas');
}
const fixedOpens = events.filter((e) => e.kind === 'open' && e.fixed).length;
if (EXPECT === '1') {
  const opens = events.filter((e) => e.kind === 'open');
  const firstFixed = opens.findIndex((e) => e.fixed);
  const firstFixedEvent = events.findIndex((e) => e.kind === 'open' && e.fixed);
  check(fixedOpens > 0 && firstFixed > 0 && opens[0]?.fixed === false,
    `fallback: at least one fixed=1 attempt followed the initial dynamic socket (${opens.length} total, ${fixedOpens} fixed)`);
  const laterDynamic = firstFixed >= 0 ? opens.slice(firstFixed + 1).filter((e) => !e.fixed) : [];
  check(firstFixed >= 0 && laterDynamic.length === 0, firstFixed >= 0 && laterDynamic.length === 0
    ? 'fallback: no later fixed=0/dynamic-size WebSocket request'
    : `fallback: ${laterDynamic.length} later WebSocket request(s) were not fixed=1`);
  const sizesAfterFallback = firstFixedEvent >= 0 ? events.slice(firstFixedEvent + 1).filter((e) => e.kind === 'sent') : [];
  check(firstFixedEvent >= 0 && sizesAfterFallback.length === 0, firstFixedEvent >= 0 && sizesAfterFallback.length === 0
    ? 'fallback: no resize instruction sent after the first fixed=1 attempt'
    : `fallback: browser sent ${sizesAfterFallback.length} resize instruction(s) after fixed=1`);
  const fixedSockets = sockets.filter((socket) => socket.fixed);
  check(fixedSockets.length <= SAA352_MAX_FIXED_SOCKET_ATTEMPTS, fixedSockets.length <= SAA352_MAX_FIXED_SOCKET_ATTEMPTS
    ? 'fallback: fixed-size retries stayed within the ' + SAA352_MAX_FIXED_SOCKET_ATTEMPTS + '-attempt limit'
    : 'fallback: observed ' + fixedSockets.length + ' fixed-size attempts, exceeding the ' + SAA352_MAX_FIXED_SOCKET_ATTEMPTS + '-attempt limit');
  const unexplainedRetries = fixedSockets.slice(1).filter((_, index) => fixedSockets[index].errors.at(-1) !== 520);
  check(unexplainedRetries.length === 0, unexplainedRetries.length === 0
    ? `fallback: ${Math.max(0, fixedSockets.length - 1)} additional fixed-size retry/retries followed upstream-unavailable status 520`
    : `fallback: ${unexplainedRetries.length} fixed-size retry/retries were not preceded by upstream-unavailable status 520`);
  const fixedSizes = proofSocket?.receivedSizes ?? [];
  const finalSize = proofSocket?.currentSize ?? fixedSizes.at(-1);
  const stable = Boolean(proofSocket && finalSize
    && finalSize.w === SAA352_REQUIRED_WIDTH && finalSize.h === SAA352_REQUIRED_HEIGHT);
  check(stable, stable
    ? 'fallback: stable socket ' + proofSocket.id + ' stayed at supported ' + finalSize.w + 'x' + finalSize.h
    : 'fallback: stable socket size was not ' + SAA352_REQUIRED_WIDTH + 'x' + SAA352_REQUIRED_HEIGHT + ': ' + JSON.stringify(fixedSizes));
} else if (EXPECT === '0') {
  check(fixedOpens === 0, fixedOpens === 0 ? 'normal: no desktop WebSocket with fixed=1' : `normal: ${fixedOpens} desktop WebSocket(s) with fixed=1`);
  const sent = events.map((e, i) => ({ ...e, i })).filter((e) => e.kind === 'sent');
  const unanswered = sent.filter((s) => !events.slice(s.i + 1).some((r) => r.kind === 'recv' && r.socketId === s.socketId && Math.abs(r.w - s.w) <= 8 && Math.abs(r.h - s.h) <= 8));
  check(sent.length > 0 && unanswered.length === 0, sent.length === 0 ? 'normal: browser sent no size to check' : unanswered.length === 0
    ? `normal: all ${sent.length} sent size(s) echoed by a layer-0 size within 8 px`
    : `normal: ${unanswered.length} sent size(s) not echoed: ${unanswered.map((s) => `${s.w}x${s.h}`).join(' ')}`);
}
console.log(ts(), 'RESULT', checks.every(Boolean) ? 'PICTURE-LIVE' : 'PICTURE-FROZE', JSON.stringify({ ...ev, sockets: sockets.map(({ id, fixed, closed, ready, images, errors, errorMessages, currentSize, receivedSizes }) => ({ id, fixed, closed, ready, images, errors, errorMessages, currentSize, receivedSizes })) }));
} catch (error) {
  primaryError = error;
  throw error;
} finally {
  let screenshotError = null;
  if (p) {
    try {
      await p.screenshot({ path: screenshotPath });
      console.log(ts(), 'SCREENSHOT captured', screenshotPath);
    } catch (error) {
      screenshotError = error;
      console.error(ts(), 'SCREENSHOT failed', sanitizeSAA352LogMessage(error?.message ?? error));
    }
  }
  if (browser) {
    try {
      await browser.close();
    } catch (error) {
      console.error(ts(), 'Browser close failed', sanitizeSAA352LogMessage(error?.message ?? error));
    }
  }
  if (screenshotError && !primaryError && checks.every(Boolean)) throw screenshotError;
}
const failed = checks.filter((c) => !c).length;
if (failed) process.exitCode = 1;
