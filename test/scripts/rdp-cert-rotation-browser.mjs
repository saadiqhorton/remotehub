// Real browser -> RemoteHub (Compose) -> guacd -> xrdp certificate rotation acceptance.
// The existing CI RDP host must already have a pinned TLS certificate. The workflow
// rotates the xrdp certificate, then this probe proves fail-closed behavior and the
// owner's explicit trust-and-reconnect flow against the real xrdp endpoint.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { waitFirstFrameAndFocus, drawnFraction } from '../../harness/first-frame.mjs';

const req = createRequire(import.meta.url);
const { chromium } = process.env.PLAYWRIGHT_CORE ? req(process.env.PLAYWRIGHT_CORE) : req('playwright');
const BASE = process.env.BASE || 'http://127.0.0.1:8090';
const DATA_DIR = process.env.DATA_DIR || 'data';
const SETUP_FILE = process.env.SETUP_CODE_FILE || path.join(DATA_DIR, 'SETUP-CODE.txt');
const OWNER = process.env.OWNER_PASSWORD;
const HOST_NAME = process.env.RDP_HOST_NAME || 'CI RDP';
const RDP_PASSWORD = process.env.RDP_PASSWORD;
const MARKER_FILE = process.env.RDP_MARKER_FILE;
const OUT = process.env.OUT || 'compose-acceptance-shots';
fs.mkdirSync(OUT, { recursive: true });

if (!OWNER || !RDP_PASSWORD || !MARKER_FILE) throw new Error('OWNER_PASSWORD, RDP_PASSWORD and RDP_MARKER_FILE are required.');

const steps = [];
const step = (name, pass, detail = '') => {
  steps.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`);
};
const requireStep = (name, pass, detail = '') => {
  step(name, pass, detail);
  if (!pass) throw new Error(`${name}${detail ? `: ${detail}` : ''}`);
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
await page.addInitScript(() => {
  const NativeWebSocket = window.WebSocket;
  window.__rhDesktopSockets = [];
  window.__rhDesktopCloseCodes = [];
  window.WebSocket = new Proxy(NativeWebSocket, {
    construct(target, args) {
      const socket = Reflect.construct(target, args);
      if (String(args[0]).includes('/ws/desktop')) {
        window.__rhDesktopSockets.push(socket);
        socket.addEventListener('close', (event) => window.__rhDesktopCloseCodes.push(event.code));
      }
      return socket;
    },
  });
});

const screenshot = (name) => page.screenshot({ path: path.join(OUT, `${name}.png`) });
const readHost = async (hostId) => page.evaluate(async (id) => {
  const response = await fetch('/api/hosts');
  if (!response.ok) return { status: response.status, host: null };
  const data = await response.json();
  return { status: response.status, host: data.hosts?.find((host) => host.id === id) ?? null };
}, hostId);

try {
  await page.goto(BASE);
  await page.locator('#auth-password').waitFor({ state: 'visible' });
  if (await page.locator('#setup-code').isVisible()) {
    await page.fill('#setup-code', fs.readFileSync(SETUP_FILE, 'utf8').trim());
  }
  await page.fill('#auth-password', OWNER);
  if (await page.locator('#auth-confirm').isVisible()) await page.fill('#auth-confirm', OWNER);
  await page.click('#auth-submit');
  await page.waitForSelector('#add-host-btn', { timeout: 15000 });
  step('owner login', true);

  const saved = await page.evaluate(async (name) => {
    const response = await fetch('/api/hosts');
    const data = await response.json();
    return { status: response.status, host: data.hosts?.find((host) => host.name === name) ?? null };
  }, HOST_NAME);
  const host = saved.host;
  const oldPin = host?.desktop?.certPin;
  const validPin = /^sha256:(?:[0-9a-f]{2}:){31}[0-9a-f]{2}$/.test(oldPin || '');
  requireStep('existing RDP host has a saved certificate pin and certificate checks enabled',
    saved.status === 200 && host?.desktop?.protocol === 'rdp' && validPin && host.desktop.ignoreCert !== true,
    saved.status !== 200 ? `host API HTTP ${saved.status}` : `host ${HOST_NAME}; pin ${oldPin || 'missing'}; ignoreCert=${host?.desktop?.ignoreCert}`);

  await page.click(`button[aria-label="Desktop on ${HOST_NAME}"]`);
  await page.locator('.desktop-pane.active').waitFor({ state: 'visible', timeout: 10000 });
  await page.locator('.desktop-connect-btn:visible').last().click();
  const pane = page.locator('.desktop-pane.active');
  await page.waitForFunction(() => {
    const active = document.querySelector('.desktop-pane.active');
    return active?.dataset.state === 'failed' && active.dataset.reason === 'cert-changed';
  }, null, { timeout: 20000 });

  const unchanged = await readHost(host.id);
  requireStep('changed certificate fails closed with WebSocket code 4409',
    await page.evaluate(() => window.__rhDesktopCloseCodes.includes(4409)),
    `close codes ${(await page.evaluate(() => window.__rhDesktopCloseCodes)).join(',') || 'none'}`);
  requireStep('changed certificate shows the explicit owner trust action',
    await page.locator('.desktop-trust-cert:visible').isVisible(), 'Trust this computer again is visible');
  requireStep('changed certificate does not ask for the RDP password',
    await page.locator('input[name="argv-password"]:visible').count() === 0,
    'no RDP password prompt before owner approval');
  requireStep('stored pin remains unchanged before owner approval',
    unchanged.status === 200 && unchanged.host?.desktop?.certPin === oldPin,
    `stored pin ${unchanged.host?.desktop?.certPin || 'missing'}`);
  await screenshot('rdp-cert-changed');

  await page.locator('.desktop-trust-cert:visible').click();
  const passwordPrompt = page.locator('input[name="argv-password"]:visible').last();
  await passwordPrompt.waitFor({ state: 'visible', timeout: 20000 });
  const trusted = await readHost(host.id);
  const newPin = trusted.host?.desktop?.certPin;
  requireStep('owner approval re-pins the rotated certificate',
    trusted.status === 200 && /^sha256:(?:[0-9a-f]{2}:){31}[0-9a-f]{2}$/.test(newPin || '') && newPin !== oldPin,
    `old ${oldPin}; new ${newPin || 'missing'}`);

  await passwordPrompt.fill(RDP_PASSWORD);
  await passwordPrompt.press('Enter');
  const canvas = pane.locator('canvas.desktop-canvas');
  await canvas.waitFor({ state: 'visible', timeout: 30000 });
  const frameMs = await waitFirstFrameAndFocus(page, canvas, { x: 200, y: 150 }, { timeoutMs: 30000 });
  const lit = await drawnFraction(canvas);
  requireStep('approved certificate reconnects to a live RDP picture',
    await pane.getAttribute('data-state') === 'ready' && lit > 0.05,
    `state ${await pane.getAttribute('data-state')}; first frame ${frameMs} ms; ${(lit * 100).toFixed(1)}% sampled pixels lit`);

  await pane.locator('.desktop-guac-display').click({ position: { x: 200, y: 150 } });
  const marker = `ci-cert-rotation-${Date.now()}`;
  const before = await canvas.evaluate((node) => node.toDataURL());
  await page.keyboard.type(`echo ${marker} > ${MARKER_FILE}`, { delay: 30 });
  await page.keyboard.press('Enter');
  let observed = null;
  for (let i = 0; i < 50 && observed !== marker; i++) {
    await page.waitForTimeout(200);
    try { observed = fs.readFileSync(MARKER_FILE, 'utf8').trim(); } catch {}
  }
  const after = await canvas.evaluate((node) => node.toDataURL());
  requireStep('keyboard input works after explicit certificate trust', observed === marker,
    `${MARKER_FILE} says "${observed}"`);
  requireStep('picture updates after certificate trust and input', after !== before,
    'canvas pixels changed after typing');
  await screenshot('rdp-cert-rotation-live');
} catch (error) {
  if (!steps.some((item) => !item.pass)) step('error', false, String(error?.message ?? error).split('\n')[0]);
  await screenshot('rdp-cert-rotation-error').catch(() => {});
} finally {
  await browser.close();
  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY,
      `### RDP certificate rotation acceptance\n\n${steps.map((item) => `- **${item.pass ? 'PASS' : 'FAIL'}** ${item.name}${item.detail ? `: ${item.detail}` : ''}`.replace(/[\r\n]+/g, ' ')).join('\n')}\n\n`);
  }
}

process.exit(steps.every((item) => item.pass) ? 0 : 1);
