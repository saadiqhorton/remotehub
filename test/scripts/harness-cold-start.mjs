// SAA-348 (#27): cold-start check for the desktop typing wait.
//   node test/scripts/harness-cold-start.mjs [runs=5]     (needs PLAYWRIGHT_CORE, HARNESS_GUACD as for the harness)
// For every run and protocol (VNC, RDP) and mode (wait, nowait) it brings up a brand-new harness
// instance (fresh Xvfb/xterm/x11vnc or private xrdp: the whole desktop is new), connects at once,
// types a marker command, and checks whether the marker file appeared.
//   wait:   harness/first-frame.mjs (first frame + canvas focus) before typing
//   nowait: click + type the moment the canvas exists
// Results: one JSON line per attempt in OUT (default: a new temp folder), never in the repo.
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import { createRequire } from 'node:module';
import { main as harness, readState } from '../../harness/cli.js';
import { waitFirstFrameAndFocus, drawnFraction } from '../../harness/first-frame.mjs';
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_CORE || 'playwright-core');
const runs = Number(process.argv[2] || 5);
const OUT = process.env.OUT || fs.mkdtempSync(path.join(os.tmpdir(), 'rh-cold-'));
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const quiet = async (fn) => { const log = console.log; console.log = () => {}; try { return await fn(); } finally { console.log = log; } };
const browser = await chromium.launch();
const results = [];
for (let i = 1; i <= runs; i++) for (const proto of ['vnc', 'rdp']) for (const mode of ['wait', 'nowait']) {
  const name = `cold-${proto}-${mode}-${i}`;
  const r = { run: i, proto, mode, at: new Date().toISOString() };
  await quiet(() => harness(['up', name]));
  const s = readState(name);
  r.pids = s.processes.map((p) => `${p.name}=${p.pid}`).join(' ');
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } }); const p = await ctx.newPage();
  try {
    await p.goto(s.urls.remotehub);
    await p.fill('#auth-password', s.credentials.ownerPassword); await p.click('#auth-submit'); await p.waitForSelector('#add-host-btn');
    const body = proto === 'vnc' ? { protocol: 'vnc', port: s.ports.vnc } : { protocol: 'rdp', port: s.ports.rdp, username: s.credentials.rdp.username, security: 'any', ignoreCert: true };
    const st = await p.evaluate(async ({ body, sshPort }) => {
      const h = await (await fetch('/api/hosts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Cold', address: '127.0.0.1', port: sshPort, username: 'tester' }) })).json();
      const id = (h.host ?? h).id;
      return (await fetch(`/api/hosts/${id}/desktop`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).status;
    }, { body, sshPort: s.ports.ssh });
    if (st !== 200) throw new Error(`desktop settings HTTP ${st}`);
    await p.reload(); await p.waitForSelector('#add-host-btn');
    await p.click('button[aria-label="Desktop on Cold"]');
    if (proto === 'vnc') { const pw = p.locator('input[name="desktop-password"]'); await pw.waitFor({ timeout: 10000 }); await pw.fill(s.credentials.vnc.password); await p.locator('.desktop-connect-btn').click(); }
    else { await p.locator('.desktop-connect-btn').last().click(); const pw = p.locator('input[name="argv-password"]').last(); await pw.waitFor({ timeout: 15000 }); await pw.fill(s.credentials.rdp.password); await pw.press('Enter'); }
    const canvas = p.locator('canvas.desktop-canvas').last();
    await canvas.waitFor({ state: 'visible', timeout: 20000 });
    const t0 = Date.now();
    const pos = proto === 'vnc' ? { x: 300, y: 200 } : { x: 200, y: 150 };
    if (mode === 'wait') r.firstFrameMs = await waitFirstFrameAndFocus(p, canvas, pos);
    else await p.locator('.desktop-pane.active .desktop-guac-display').click({ position: pos });
    r.drawnAtType = Number((await drawnFraction(canvas)).toFixed(3));
    r.msFromCanvasToType = Date.now() - t0;
    const marker = `${proto}-${mode}-${i}`;
    const file = proto === 'vnc' ? path.join(s.dir, 'home', 'cold.txt') : path.join(s.dir, 'rdp', 'home', 'cold.txt');
    await p.keyboard.type(`echo ${marker} > cold.txt`, { delay: 30 }); await p.keyboard.press('Enter');
    for (let k = 0; k < 40 && !fs.existsSync(file); k++) await sleep(200);
    r.marker = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim() : null;
    r.markerOk = r.marker === marker;
    await p.screenshot({ path: path.join(OUT, `${name}.png`) });
  } catch (e) { r.error = e.message.split('\n')[0]; r.markerOk = false; await p.screenshot({ path: path.join(OUT, `${name}-error.png`) }).catch(() => {}); }
  await ctx.close();
  await quiet(() => harness(['down', name]));
  results.push(r); fs.appendFileSync(path.join(OUT, 'cold-start.jsonl'), JSON.stringify(r) + '\n');
  console.log(`${r.markerOk ? 'MARKER OK ' : 'MARKER LOST'} ${proto} ${mode.padEnd(6)} run ${i}: ${r.mode === 'wait' ? `first frame after ${r.firstFrameMs} ms, ` : ''}typed ${r.msFromCanvasToType} ms after canvas, drawn ${r.drawnAtType}${r.error ? ` error: ${r.error}` : ''}`);
}
await browser.close();
for (const proto of ['vnc', 'rdp']) for (const mode of ['wait', 'nowait']) {
  const g = results.filter((r) => r.proto === proto && r.mode === mode);
  console.log(`SUMMARY ${proto} ${mode}: markers ${g.filter((r) => r.markerOk).length}/${g.length}`);
}
console.log(`Results: ${OUT}`);
process.exit(results.filter((r) => r.mode === 'wait').every((r) => r.markerOk) ? 0 : 1);
