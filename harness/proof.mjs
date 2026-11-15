// SAA-348: real-browser proof against a running harness instance: log in, SSH add/connect/type,
// VNC and RDP add/connect/render/type (typing checked through a file the remote shell writes).
//   node harness/proof.mjs [name ...]      (default: "default"; several names run at the same time)
// Needs playwright-core: set PLAYWRIGHT_CORE to its folder. Screenshots and results go to
// OUT (default: <instance dir>/proof), never into the repo. REMOTEHUB_URL overrides the web URL
// (to point the same rig at another RemoteHub checkout started against this instance's services).
// Rig timing (r11 type-once "fixed"): before typing into a desktop, wait until the canvas has
// drawn its first frame, click to focus, and confirm the canvas really has focus.
import { createRequire } from 'node:module'; import fs from 'node:fs'; import path from 'node:path'; import os from 'node:os';
let chromium;
try { ({ chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_CORE || 'playwright-core')); }
catch { console.error("The browser proof can't start: playwright-core isn't installed.\nSet PLAYWRIGHT_CORE to its folder, or run: npm install --no-save playwright-core"); process.exit(1); }
const HOME = process.env.HARNESS_HOME || path.join(os.tmpdir(), `remotehub-harness-${os.userInfo().username}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
import { waitFirstFrameAndFocus } from './first-frame.mjs';

async function run(name) {
  const s = JSON.parse(fs.readFileSync(path.join(HOME, name + '.json')));
  if (process.env.REMOTEHUB_URL) s.urls.remotehub = process.env.REMOTEHUB_URL;
  const OUT = process.env.OUT || path.join(s.dir, 'proof'); fs.mkdirSync(OUT, { recursive: true });
  const res = []; const rec = (step, pass, detail = '') => { res.push({ instance: name, step, pass, detail, at: new Date().toISOString() }); };
  const texts = []; const snap = async (label) => { try { texts.push({ label, at: new Date().toISOString(), text: await p.evaluate(() => document.body.innerText) }); } catch {} };
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } }); const p = await ctx.newPage();
  try {
    await p.goto(s.urls.remotehub);
    await p.fill('#auth-password', s.credentials.ownerPassword); await p.click('#auth-submit');
    await p.waitForSelector('#add-host-btn', { timeout: 10000 }); await snap('log in'); rec('log in', true);
    const add = async (hostName, port) => {
      await p.click('#add-host-btn');
      await p.fill('#host-form [name=name]', hostName); await p.fill('#host-form [name=address]', '127.0.0.1');
      await p.fill('#host-form [name=port]', String(port)); await p.fill('#host-form [name=username]', 'tester');
      await p.click('#host-save-btn'); await p.locator('.host-name', { hasText: hostName }).waitFor();
    };
    // SSH
    await add('Harness SSH', s.ports.ssh); rec('add SSH host', true);
    await p.click('button[aria-label="Terminal on Harness SSH"]');
    const pw = p.locator('input[aria-label^="SSH password"]');
    await pw.waitFor({ timeout: 10000 }); await pw.fill(s.credentials.ssh.password); await pw.press('Enter');
    await p.getByRole('button', { name: 'Trust and connect' }).click({ timeout: 10000 });
    await p.locator('.xterm-rows', { hasText: 'fake-shell $' }).first().waitFor({ timeout: 10000 }); await snap('SSH connect'); rec('SSH connect', true);
    await p.locator('.xterm').first().click(); await p.keyboard.type(`hello-${name}`); await p.keyboard.press('Enter');
    await p.locator('.xterm-rows', { hasText: `you typed: hello-${name}` }).first().waitFor({ timeout: 10000 });
    await snap('SSH type'); rec('SSH type', true, `echoed "you typed: hello-${name}"`);
    await p.screenshot({ path: path.join(OUT, `${name}-ssh.png`) });
    // VNC
    await add('Harness VNC', s.ports.ssh);
    const st = await p.evaluate(async (port) => {
      const hosts = await (await fetch('/api/hosts')).json();
      const h = (hosts.hosts ?? hosts).find((x) => x.name === 'Harness VNC');
      const r = await fetch(`/api/hosts/${h.id}/desktop`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ protocol: 'vnc', port }) });
      return r.status;
    }, s.ports.vnc);
    await p.reload(); await p.waitForSelector('#add-host-btn');
    await snap('add VNC host'); rec('add VNC host', st === 200, `desktop settings HTTP ${st}`);
    await p.click('button[aria-label="Desktop on Harness VNC"]');
    const dpw = p.locator('input[name="desktop-password"]');
    await dpw.waitFor({ timeout: 10000 }); await dpw.fill(s.credentials.vnc.password);
    await p.locator('.desktop-connect-btn').click();
    const canvas = p.locator('canvas.desktop-canvas');
    await canvas.waitFor({ state: 'visible', timeout: 15000 }); await sleep(3000);
    const lit = await canvas.evaluate((c) => { const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 0; i < d.length; i += 4) if (d[i] || d[i + 1] || d[i + 2]) n++; return { w: c.width, h: c.height, nonBlack: n }; });
    await snap('VNC connect + render'); rec('VNC connect + render', lit.w >= 1024 && lit.nonBlack > 1000, `canvas ${lit.w}x${lit.h}, ${lit.nonBlack} non-black px`);
    await p.screenshot({ path: path.join(OUT, `${name}-vnc-before.png`) });
    const file = path.join(s.dir, 'home', 'vnc-typed.txt');
    const vff = await waitFirstFrameAndFocus(p, canvas, { x: 300, y: 200 }); rec('VNC first frame + focus', true, `${vff} ms`);
    await p.keyboard.type(`echo vnc-${name} > vnc-typed.txt`, { delay: 30 }); await p.keyboard.press('Enter');
    for (let i = 0; i < 30 && !fs.existsSync(file); i++) await sleep(200);
    const typed = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim() : null;
    await sleep(800); await p.screenshot({ path: path.join(OUT, `${name}-vnc-typed.png`) });
    await snap('VNC type'); rec('VNC type', typed === `vnc-${name}`, `file in instance home says "${typed}"`);
    // RDP (private unprivileged xrdp)
    await add('Harness RDP', s.ports.ssh);
    const st2 = await p.evaluate(async ({ port, username }) => {
      const hosts = await (await fetch('/api/hosts')).json();
      const h = (hosts.hosts ?? hosts).find((x) => x.name === 'Harness RDP');
      const r = await fetch(`/api/hosts/${h.id}/desktop`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ protocol: 'rdp', port, username, security: 'any', ignoreCert: true }) });
      return r.status;
    }, { port: s.ports.rdp, username: s.credentials.rdp.username });
    await p.reload(); await p.waitForSelector('#add-host-btn');
    await snap('add RDP host'); rec('add RDP host', st2 === 200, `desktop settings HTTP ${st2}`);
    await p.click('button[aria-label="Desktop on Harness RDP"]');
    await p.locator('.desktop-connect-btn').last().click();
    const rpw = p.locator('input[name="argv-password"]').last();
    await rpw.waitFor({ timeout: 15000 }); await rpw.fill(s.credentials.rdp.password); await rpw.press('Enter');
    const rc = p.locator('canvas.desktop-canvas').last();
    await rc.waitFor({ state: 'visible', timeout: 20000 });
    let rlit = { nonGreenish: 0 };
    for (let i = 0; i < 20; i++) {
      await sleep(1000);
      rlit = await rc.evaluate((c) => { const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let g = 0; for (let i = 0; i < d.length; i += 4) if (d[i + 1] > 80 && d[i] < 40 && d[i + 2] < 40) g++; return { w: c.width, h: c.height, green: g }; });
      if (rlit.green > 5000) break;
    }
    await snap('RDP connect + render'); rec('RDP connect + render', rlit.green > 5000, `canvas ${rlit.w}x${rlit.h}, ${rlit.green} green xterm px`);
    await p.screenshot({ path: path.join(OUT, `${name}-rdp-before.png`) });
    const rfile = path.join(s.dir, 'rdp', 'home', 'rdp-typed.txt');
    const rff = await waitFirstFrameAndFocus(p, rc, { x: 200, y: 150 }); rec('RDP first frame + focus', true, `${rff} ms`);
    await p.keyboard.type(`echo rdp-${name} > rdp-typed.txt`, { delay: 40 }); await p.keyboard.press('Enter');
    for (let i = 0; i < 40 && !fs.existsSync(rfile); i++) await sleep(200);
    const rtyped = fs.existsSync(rfile) ? fs.readFileSync(rfile, 'utf8').trim() : null;
    await sleep(800); await p.screenshot({ path: path.join(OUT, `${name}-rdp-typed.png`) });
    await snap('RDP type'); rec('RDP type', rtyped === `rdp-${name}`, `file in instance RDP home says "${rtyped}"`);
  } catch (err) { rec('error', false, err.message.split('\n')[0]); await p.screenshot({ path: path.join(OUT, `${name}-error.png`) }).catch(() => {}); }
  await snap('end'); fs.writeFileSync(path.join(OUT, `${name}-visible-text.json`), JSON.stringify(texts, null, 2));
  await ctx.close(); return res;
}

const browser = await chromium.launch();
const names = process.argv.slice(2).length ? process.argv.slice(2) : ['default'];
const all = (await Promise.all(names.map(run))).flat();
for (const r of all) console.log(`[${r.pass ? 'PASS' : 'FAIL'}] ${r.instance} ${r.step}${r.detail ? ': ' + r.detail : ''}`);
if (process.env.OUT) fs.writeFileSync(path.join(process.env.OUT, 'proof-results.json'), JSON.stringify(all, null, 2));
await browser.close(); process.exit(all.every((r) => r.pass) ? 0 : 1);
