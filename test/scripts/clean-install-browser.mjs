// SAA-348 (#27): clean-install browser check for a clean-install acceptance run.
// Against a RemoteHub started with plain `npm start`: first-run setup with the printed setup code,
// add an SSH host, connect, type, then click Desktop.
//   BASE (default http://127.0.0.1:8090), DATA_DIR (where SETUP-CODE.txt is), SSH_PORT, SSH_PASSWORD,
//   EXPECT_DESKTOP=works|off, EXPECT_SECURE_COOKIE=true|false, LOGIN_ONLY=1, OUT (screenshots).
//   Needs playwright (or PLAYWRIGHT_CORE).
// EXPECT_DESKTOP=works: Desktop must open its pane and reach the remote side (a plain "nothing
//   answered" message for an empty port is fine; it proves guacd is there).
// EXPECT_DESKTOP=real: a real VNC desktop (VNC_ADDR, VNC_PORT, VNC_PASSWORD, VNC_MARKER_FILE) and a real
//   RDP desktop (RDP_ADDR, RDP_PORT, RDP_USER, RDP_PASSWORD, RDP_MARKER_FILE): click Desktop, wait for a
//   drawn frame (non-black pixels), type `echo <marker> > <file>` and check the file on disk.
// EXPECT_DESKTOP=off: Desktop must be shown as not available, with a plain reason.
import fs from 'node:fs'; import path from 'node:path'; import { createRequire } from 'node:module';
import { waitFirstFrameAndFocus, drawnFraction } from '../../harness/first-frame.mjs';
// The sentence #26 shows when this RemoteHub has no desktop helper (public/js/desktop-auto.js DESKTOP_NOT_SET_UP_HERE).
export const DESKTOP_NOT_SET_UP_HERE = 'Remote desktop isn’t set up in this copy of RemoteHub yet. You can still connect with the terminal.';
const req = createRequire(import.meta.url);
const { chromium } = process.env.PLAYWRIGHT_CORE ? req(process.env.PLAYWRIGHT_CORE) : req('playwright');
const BASE = process.env.BASE || 'http://127.0.0.1:8090';
const OUT = process.env.OUT || 'clean-install-shots'; fs.mkdirSync(OUT, { recursive: true });
const HOST = process.env.HOST_NAME || 'CI SSH';
const SSH_ADDR = process.env.SSH_ADDR || '127.0.0.1';
const expectDesktop = process.env.EXPECT_DESKTOP || 'works';
const steps = []; const step = (name, pass, detail = '') => {
  steps.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`);
};
function inspectClipboardPaste(frames, text) {
  const clipboard = frames.find((frame) => frame.opcode === 'clipboard' && frame.args[1] === 'text/plain');
  const end = clipboard && frames.findIndex((frame) => frame.opcode === 'end' && frame.args[0] === clipboard.args[0]);
  const streamId = clipboard?.args[0];
  const streamText = streamId ? Buffer.concat(frames
    .filter((frame) => frame.opcode === 'blob' && frame.args[0] === streamId)
    .map((frame) => Buffer.from(frame.args[1], 'base64'))).toString('utf8') : '';
  const vDown = frames.findIndex((frame) => frame.opcode === 'key' && frame.args[1] === '1' && ['86', '118'].includes(frame.args[0]));
  return { clipboard, end, streamText, vDown, ordered: end >= 0 && vDown >= 0 && end < vDown && streamText === text };
}
function clipboardTrace(frames) {
  return frames.map(({ opcode, args }) => opcode === 'blob' ? `blob(${args[0]},${args[1]?.length ?? 0} chars)` : `${opcode}${args.length ? `(${args.join(',')})` : ''}`).join(' → ') || 'no instructions';
}
async function realDesktop(proto) {
  const E = (k) => process.env[`${proto.toUpperCase()}_${k}`];
  const name = E('HOST_NAME') || `CI ${proto.toUpperCase()}`;
  const settings = proto === 'vnc' ? { protocol: 'vnc', port: Number(E('PORT')) } : { protocol: 'rdp', port: Number(E('PORT')), username: E('USER'), security: 'any', ignoreCert: false };
  const put = await p.evaluate(async ({ name, addr, settings }) => {
    const h = await (await fetch('/api/hosts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, address: addr, port: 22, username: 'ci' }) })).json();
    const r = await fetch(`/api/hosts/${(h.host ?? h).id}/desktop`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(settings) });
    return { status: r.status, body: (await r.text()).slice(0, 300), hostId: (h.host ?? h).id };
  }, { name, addr: E('ADDR'), settings });
  step(`${proto.toUpperCase()}: save desktop settings for ${E('ADDR')}:${E('PORT')}`, put.status === 200, put.status === 200 ? `HTTP ${put.status}` : `HTTP ${put.status} ${put.body}`);
  await p.reload(); await p.waitForSelector('#add-host-btn');
  await p.click(`button[aria-label="Desktop on ${name}"]`);
  if (proto === 'vnc') { const pw = p.locator('input[name="desktop-password"]:visible'); await pw.waitFor({ timeout: 10000 }); await pw.fill(E('PASSWORD')); await p.locator('.desktop-connect-btn:visible').click(); }
  else await p.locator('.desktop-connect-btn:visible').last().click();
  const canvas = p.locator('.desktop-pane:visible canvas.desktop-canvas');
  if (proto === 'rdp') {
    // A guacd that asks for the password (1.5+) shows RemoteHub's password box. An older guacd (Ubuntu's
    // package) doesn't, so xrdp shows its own sign-in box on the desktop: type the password there.
    const pw = p.locator('input[name="argv-password"]:visible').last();
    const asked = await pw.waitFor({ timeout: 10000 }).then(() => true, () => false);
    step('RDP: RemoteHub\'s password box asks for the sign-in', asked);
    if (!asked) throw new Error('RemoteHub did not ask for the RDP password');
    await pw.fill(E('PASSWORD')); await pw.press('Enter');
  }
  await canvas.waitFor({ state: 'visible', timeout: 30000 });
  const ms = await waitFirstFrameAndFocus(p, canvas, { x: 200, y: 150 }, { timeoutMs: 30000 });
  const lit = await drawnFraction(canvas);
  await shot(`${proto}-desktop-rendered`);
  const paneState = await p.locator('.desktop-pane:visible').getAttribute('data-state');
  step(`${proto.toUpperCase()}: desktop pane state is ready`, paneState === 'ready', `data-state ${paneState}`);
  if (proto === 'rdp') {
    const pin = await p.evaluate(async (hostId) => {
      const response = await fetch('/api/hosts');
      const data = await response.json();
      return { status: response.status, value: data.hosts?.find((host) => host.id === hostId)?.desktop?.certPin ?? null };
    }, put.hostId);
    const validPin = /^sha256:(?:[0-9a-f]{2}:){31}[0-9a-f]{2}$/.test(pin.value || '');
    step('RDP: first connection securely pins the remote certificate', pin.status === 200 && validPin,
      pin.status !== 200 ? `HTTP ${pin.status}` : `certificate pin ${pin.value || 'missing'}`);
  }
  step(`${proto.toUpperCase()}: click Desktop, real desktop rendered`, lit > 0.05, `first frame after ${ms} ms, ${(lit * 100).toFixed(1)}% of sampled pixels non-black`);
  {
    const idleMs = Number(process.env.DESKTOP_IDLE_MS || 20000);
    await p.waitForTimeout(idleMs);
    const idle = await p.evaluate(() => ({
      state: document.querySelector('.desktop-pane.active')?.dataset.state,
      socketOpen: window.__rhDesktopSockets?.filter((socket) => socket.readyState === WebSocket.OPEN).length ?? 0,
    }));
    step(`${proto.toUpperCase()}: idle desktop stays ready beyond guacd idle timeout`, idle.state === 'ready' && idle.socketOpen > 0,
      `${idleMs} ms quiet; state ${idle.state}, open desktop sockets ${idle.socketOpen}`);
  }
  const marker = `ci-${proto}-${Date.now()}`; const file = E('MARKER_FILE'); const markerReadFile = E('MARKER_READ_FILE') || file;
  const pic = () => canvas.evaluate((c) => c.toDataURL());
  const before = await pic();
  await p.keyboard.type(`echo ${marker} > ${file}`, { delay: 40 }); await p.keyboard.press('Enter');
  let changed = false; for (let i = 0; i < 25 && !changed; i++) { await p.waitForTimeout(200); changed = (await pic()) !== before; }
  step(`${proto.toUpperCase()}: picture in the browser changed after typing (typed text is shown)`, changed, changed ? 'canvas pixels changed' : `canvas identical 5 s after typing: picture frozen${proto === 'rdp' ? ' (SAA-352)' : ''}`);
  let got = null; for (let i = 0; i < 50 && got !== marker; i++) { await p.waitForTimeout(200); try { got = fs.readFileSync(markerReadFile, 'utf8').trim(); } catch {} }
  await shot(`${proto}-desktop-typed`);
  step(`${proto.toUpperCase()}: typed marker arrived`, got === marker, `${markerReadFile} says "${got}"`);

  // Exercise native browser paste ordering through the real browser, RemoteHub, guacd and desktop.
  // Prime the remote clipboard first so the test proves NEW replaced stale remote content.
  const oldClipboard = `ci-clipboard-old-${proto}-${Date.now()}`;
  await p.keyboard.type(`printf '%s' '${oldClipboard}' | xclip -selection clipboard`, { delay: 20 });
  await p.keyboard.press('Enter');
  let primedClipboard = '';
  for (let i = 0; i < 50 && primedClipboard !== oldClipboard; i++) {
    await p.waitForTimeout(200);
    try { primedClipboard = await p.evaluate(() => navigator.clipboard.readText()); } catch {}
  }
  step(`${proto.toUpperCase()}: prime remote clipboard with OLD`, primedClipboard === oldClipboard,
    `browser clipboard says "${primedClipboard}"`);

  const pasted = `ci-clipboard-new-${proto}-${Date.now()}`;
  const pasteFile = E('MARKER_FILE');
  const pasteReadFile = E('MARKER_READ_FILE') || pasteFile;
  if (!pasteFile) throw new Error(`${proto.toUpperCase()}_MARKER_FILE is required for clipboard acceptance`);
  const focusBeforeWrite = await p.evaluate(() => {
    const display = document.querySelector('.desktop-pane.active .desktop-display');
    return Boolean(display && document.activeElement && display.contains(document.activeElement));
  });
  await p.evaluate((text) => navigator.clipboard.writeText(text), pasted);
  const focusAfterWrite = await p.evaluate(() => {
    const display = document.querySelector('.desktop-pane.active .desktop-display');
    return Boolean(display && document.activeElement && display.contains(document.activeElement));
  });
  const frameStart = await p.evaluate(() => window.__rhDesktopFrames.length);
  // Native paste data is available to the paste event even when the async Clipboard API is denied.
  // This prevents focus-time readText() from accidentally masking a broken native paste path.
  await p.evaluate(() => {
    Object.defineProperty(navigator.clipboard, 'readText', {
      configurable: true,
      value: async () => { throw new DOMException('Permission denied', 'NotAllowedError'); },
    });
  });
  await p.keyboard.press('Control+V');
  await p.evaluate(() => { delete navigator.clipboard.readText; });
  const pasteFrames = await p.evaluate((start) => window.__rhDesktopFrames.slice(start), frameStart);
  const pasteProof = inspectClipboardPaste(pasteFrames, pasted);
  step(`${proto.toUpperCase()}: native Ctrl+V queues NEW clipboard end before V-down`,
    focusBeforeWrite && focusAfterWrite && pasteProof.ordered,
    `display focus ${focusBeforeWrite ? 'retained' : 'missing'} across clipboard write; stream text ${pasteProof.streamText === pasted ? 'matches NEW' : 'does not match NEW'}; outbound ${clipboardTrace(pasteFrames)}`);
  await p.keyboard.type(`xclip -o -selection clipboard > ${pasteFile}`, { delay: 20 });
  await p.keyboard.press('Enter');
  let pastedValue = null;
  for (let i = 0; i < 50 && pastedValue !== pasted; i++) {
    await p.waitForTimeout(200);
    try { pastedValue = fs.readFileSync(pasteReadFile, 'utf8').trim(); } catch {}
  }
  step(`${proto.toUpperCase()}: native browser paste updates remote clipboard`, pastedValue === pasted,
    `${pasteReadFile} says "${pastedValue}"`);

  const copied = `ci-clipboard-copy-${proto}-${Date.now()}`;
  await p.keyboard.type(`printf '%s' '${copied}' | xclip -selection clipboard`, { delay: 20 });
  await p.keyboard.press('Enter');
  let clipboardText = '';
  for (let i = 0; i < 50 && clipboardText !== copied; i++) {
    await p.waitForTimeout(200);
    try { clipboardText = await p.evaluate(() => navigator.clipboard.readText()); } catch {}
  }
  step(`${proto.toUpperCase()}: remote clipboard copy reaches the browser`, clipboardText === copied,
    `browser clipboard says "${clipboardText}"`);

  // Keep Control physically held across a retryable drop. The fresh native paste must rebuild
  // its remote Ctrl+V chord on the replacement Guacamole client before Control is released.
  const socketsBeforeDrop = await p.evaluate(() => window.__rhDesktopSockets?.filter((socket) => socket.url.includes('/ws/desktop')).length ?? 0);
  await p.locator('.desktop-pane.active .desktop-guac-display').click({ position: { x: 200, y: 150 } });
  await canvas.focus();
  const displayFocusBeforeDrop = await p.evaluate(() => {
    const display = document.querySelector('.desktop-pane.active .desktop-display');
    return Boolean(display && document.activeElement?.tagName === 'CANVAS' && display.contains(document.activeElement));
  });
  const retryClipboard = `ci-clipboard-retry-${proto}-${Date.now()}`;
  let retryFrames = [];
  let retryFocus = false;
  let retryFrameStart = 0;
  // Keep focus-time clipboard reads denied across the reconnect and native paste.
  await p.evaluate(() => {
    Object.defineProperty(navigator.clipboard, 'readText', {
      configurable: true,
      value: async () => { throw new DOMException('Permission denied', 'NotAllowedError'); },
    });
  });
  await p.keyboard.down('Control');
  try {
    await p.evaluate(() => {
      const socket = window.__rhDesktopSockets?.filter((item) => item.url.includes('/ws/desktop')).at(-1);
      if (!socket || socket.readyState !== WebSocket.OPEN) throw new Error('no open desktop WebSocket to drop');
      socket.close(4502, 'acceptance reconnect probe');
    });
    await p.waitForFunction((count) => {
      const state = document.querySelector('.desktop-pane.active')?.dataset.state;
      const sockets = window.__rhDesktopSockets?.filter((socket) => socket.url.includes('/ws/desktop')).length ?? 0;
      return state === 'ready' && sockets > count;
    }, socketsBeforeDrop, { timeout: 30000 });
    const reconnects = await p.evaluate(() => window.__rhDesktopSockets?.filter((socket) => socket.url.includes('/ws/desktop')).length ?? 0);
    step(`${proto.toUpperCase()}: desktop reconnects with physical Control held`, reconnects > socketsBeforeDrop,
      `desktop WebSockets ${socketsBeforeDrop} → ${reconnects}; display focused before drop ${displayFocusBeforeDrop}`);

    await p.evaluate((text) => navigator.clipboard.writeText(text), retryClipboard);
    retryFocus = await p.evaluate(() => {
      const display = document.querySelector('.desktop-pane.active .desktop-display');
      return Boolean(display && document.activeElement && display.contains(document.activeElement));
    });
    retryFrameStart = await p.evaluate(() => window.__rhDesktopFrames.length);
    await p.keyboard.down('V');
    await p.keyboard.up('V');
  } finally {
    await p.keyboard.up('Control').catch(() => {});
    await p.evaluate(() => { delete navigator.clipboard.readText; }).catch(() => {});
  }
  retryFrames = await p.evaluate(({ start, socketId }) => window.__rhDesktopFrames.slice(start).filter((frame) => frame.socketId === socketId),
    { start: retryFrameStart, socketId: socketsBeforeDrop });
  const retryPasteProof = inspectClipboardPaste(retryFrames, retryClipboard);
  const retryCtrlDown = retryFrames.findIndex((frame) => frame.opcode === 'key' && frame.args[0] === '65507' && frame.args[1] === '1');
  const retryCtrlUp = retryFrames.findIndex((frame) => frame.opcode === 'key' && frame.args[0] === '65507' && frame.args[1] === '0');
  const retryChordOrdered = retryPasteProof.ordered && retryCtrlDown >= 0 && retryCtrlDown < retryPasteProof.vDown
    && retryCtrlUp > retryPasteProof.vDown;
  step(`${proto.toUpperCase()}: retry paste sends fresh clipboard and Ctrl+V before physical Control release`,
    displayFocusBeforeDrop && retryFocus && retryChordOrdered,
    `display focus ${retryFocus ? 'retained' : 'missing'}; clipboard text ${retryPasteProof.streamText === retryClipboard ? 'matches NEW' : 'does not match NEW'}; outbound ${clipboardTrace(retryFrames)}`);

  await p.keyboard.type(`xclip -o -selection clipboard > ${pasteFile}`, { delay: 20 });
  await p.keyboard.press('Enter');
  let retryClipboardValue = null;
  for (let i = 0; i < 50 && retryClipboardValue !== retryClipboard; i++) {
    await p.waitForTimeout(200);
    try { retryClipboardValue = fs.readFileSync(pasteReadFile, 'utf8').trim(); } catch {}
  }
  step(`${proto.toUpperCase()}: retry paste reaches the remote clipboard`, retryClipboardValue === retryClipboard,
    `${pasteReadFile} says "${retryClipboardValue}"`);

  const reconnectMarker = `ci-reconnected-${proto}-${Date.now()}`;
  await p.keyboard.type(`echo ${reconnectMarker} > ${file}`, { delay: 30 }); await p.keyboard.press('Enter');
  let reconnectedValue = null;
  for (let i = 0; i < 50 && reconnectedValue !== reconnectMarker; i++) {
    await p.waitForTimeout(200);
    try { reconnectedValue = fs.readFileSync(markerReadFile, 'utf8').trim(); } catch {}
  }
  step(`${proto.toUpperCase()}: input works after automatic reconnect`, reconnectedValue === reconnectMarker,
    `${markerReadFile} says "${reconnectedValue}"`);
  await p.locator('.desktop-pane:visible').getByRole('button', { name: /close tab/i }).first().click().catch(() => {});
}

const browser = await chromium.launch(); const p = await browser.newPage({ viewport: { width: 1280, height: 860 } });
await p.addInitScript(() => {
  const NativeWebSocket = window.WebSocket;
  window.__rhDesktopSockets = [];
  window.__rhDesktopFrames = [];
  window.WebSocket = new Proxy(NativeWebSocket, {
    construct(target, args) {
      const socket = Reflect.construct(target, args);
      if (String(args[0]).includes('/ws/desktop')) {
        const socketId = window.__rhDesktopSockets.length;
        window.__rhDesktopSockets.push(socket);
        const send = socket.send.bind(socket);
        socket.send = (data) => {
          if (typeof data === 'string' && window.Guacamole?.Parser) {
            const parser = new window.Guacamole.Parser();
            parser.oninstruction = (opcode, args) => {
              if (['clipboard', 'blob', 'end', 'key'].includes(opcode)) window.__rhDesktopFrames.push({ socketId, opcode, args: [...args] });
            };
            parser.receive(data);
          }
          return send(data);
        };
      }
      return socket;
    },
  });
});
await p.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(BASE).origin });
const shot = (n) => p.screenshot({ path: path.join(OUT, `${n}.png`) }).catch(() => {});
try {
  const code = fs.existsSync(path.join(process.env.DATA_DIR || 'data', 'SETUP-CODE.txt')) ? fs.readFileSync(path.join(process.env.DATA_DIR || 'data', 'SETUP-CODE.txt'), 'utf8').trim() : '';
  const owner = process.env.OWNER_PASSWORD || `Owner-${Date.now()}-pw`;
  await p.goto(BASE); await p.locator('#auth-password').waitFor({ state: 'visible' });
  // First run: setup code + new password. Later runs (same server): just log in.
  if (await p.locator('#setup-code').isVisible()) await p.fill('#setup-code', code);
  await p.fill('#auth-password', owner);
  if (await p.locator('#auth-confirm').isVisible()) await p.fill('#auth-confirm', owner);
  await p.click('#auth-submit'); await p.waitForSelector('#add-host-btn', { timeout: 15000 }); step('log in (first-run setup)', true); await shot('1-login');
  if (process.env.EXPECT_SECURE_COOKIE !== undefined) {
    const expectedSecure = process.env.EXPECT_SECURE_COOKIE === 'true';
    const sessionCookie = (await p.context().cookies(BASE)).find((item) => item.name === 'rh_session');
    step('session cookie Secure flag matches the expected mode', Boolean(sessionCookie) && sessionCookie.secure === expectedSecure,
      `expected secure=${expectedSecure}, got ${sessionCookie ? `secure=${sessionCookie.secure}` : 'no session cookie'}`);
  }
  if (process.env.LOGIN_ONLY === '1') throw 'done';
  if (process.env.DESKTOPS !== 'rdp') { // the RDP-only run reuses this server; SSH was already checked
  await p.click('#add-host-btn');
  await p.fill('#host-form [name=name]', HOST); await p.fill('#host-form [name=address]', SSH_ADDR);
  await p.fill('#host-form [name=port]', String(process.env.SSH_PORT)); await p.fill('#host-form [name=username]', 'tester');
  await p.click('#host-save-btn'); await p.locator('.host-name', { hasText: HOST }).waitFor(); step('add SSH host', true);
  await p.click(`button[aria-label="Terminal on ${HOST}"]`);
  const pw = p.locator('input[aria-label^="SSH password"]'); await pw.waitFor({ timeout: 10000 }); await pw.fill(process.env.SSH_PASSWORD); await pw.press('Enter');
  // First connection to this address asks to trust the computer ID; a later run on the same server doesn't.
  const trust = p.getByRole('button', { name: 'Trust and connect' });
  await Promise.race([trust.waitFor({ timeout: 10000 }).then(() => trust.click()), p.locator('.xterm-rows', { hasText: 'fake-shell $' }).first().waitFor({ timeout: 10000 })]);
  await p.locator('.xterm-rows', { hasText: 'fake-shell $' }).first().waitFor({ timeout: 15000 }); step('SSH connect', true);
  await p.locator('.xterm').first().click(); await p.keyboard.type('hello-ci'); await p.keyboard.press('Enter');
  await p.locator('.xterm-rows', { hasText: 'you typed: hello-ci' }).first().waitFor({ timeout: 10000 }); step('SSH type', true); await shot('2-ssh');

  await p.click(`button[aria-label="Files on ${HOST}"]`);
  const filePassword = p.locator('input[aria-label^="SSH password"]:visible').last();
  await filePassword.waitFor({ timeout: 10000 }); await filePassword.fill(process.env.SSH_PASSWORD); await filePassword.press('Enter');
  await p.locator('.files-row[data-files-key="photo.jpg"]').waitFor({ timeout: 15000 });
  step('SFTP connect and list files', true, 'photo.jpg appears in the remote folder'); await shot('2-sftp');
  }
  if (expectDesktop === 'real') {
    const protocols = (process.env.DESKTOPS ?? 'vnc,rdp').split(',').map((d) => d.trim()).filter((d) => ['vnc', 'rdp'].includes(d));
    for (const protocol of protocols) await realDesktop(protocol);
    throw 'done';
  }
  // Desktop: saved VNC settings on an empty port (no VNC server on the runner), then click Desktop.
  const st = await p.evaluate(async (host) => {
    const h = (await (await fetch('/api/hosts')).json()).hosts.find((x) => x.name === host);
    return (await fetch(`/api/hosts/${h.id}/desktop`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ protocol: 'vnc', port: 15999 }) })).status;
  }, HOST);
  await p.reload(); await p.waitForSelector('#add-host-btn');
  const open = p.locator(`button[aria-label="Desktop on ${HOST}"]`);
  if (expectDesktop === 'works') {
    if (!(await open.count())) throw new Error(`Desktop button is not available (settings HTTP ${st}): ${await p.locator(`.host:has-text("${HOST}") [aria-label^="Desktop unavailable"]`).first().getAttribute('aria-label').catch(() => '?')}`);
    await open.click();
    const dpw = p.locator('input[name="desktop-password"]'); await dpw.waitFor({ timeout: 10000 }); await dpw.fill('nopass12');
    await p.locator('.desktop-connect-btn').click();
    const pane = p.locator('.desktop-pane:visible');
    let state = null; for (let i = 0; i < 100; i++) { state = await pane.getAttribute('data-state').catch(() => null); if (['ready', 'failed', 'unavailable', 'authentication'].includes(state)) break; await p.waitForTimeout(200); }
    const text = (await pane.innerText()).replace(/\s+/g, ' ').trim();
    await shot('3-desktop');
    step('click Desktop: desktop is ready', state === 'ready', `state ${state}; "${text.slice(0, 200)}"`);
  } else {
    const off = p.locator(`.host:has-text("${HOST}") [aria-label^="Desktop unavailable"]`).first();
    const reason = (await off.count()) ? await off.getAttribute('aria-label') : null;
    await shot('3-desktop');
    step('Desktop shown as not available, with the exact not-set-up sentence', reason === `Desktop unavailable: ${DESKTOP_NOT_SET_UP_HERE}`, reason || 'no unavailable Desktop button found');
  }
} catch (e) { if (e !== 'done') { step('error', false, String(e?.message ?? e).split('\n')[0]); await shot('error'); } }
await browser.close();
// Real result of every check in the job summary, so a green job never hides a failed desktop.
if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY,
  `### ${process.env.SUMMARY_TITLE ?? `clean-install (${expectDesktop}${process.env.DESKTOPS ? `, ${process.env.DESKTOPS}` : ''})`}\n\n` +
  steps.map((s) => `- **${s.pass ? 'PASS' : 'FAIL'}** ${s.name}${s.detail ? `: ${s.detail}` : ''}`.replace(/[\r\n]+/g, ' ')).join('\n') + '\n\n');
process.exit(steps.every((s) => s.pass) ? 0 : 1);
