// SAA-348: rig timing shared by harness/proof.mjs and the cold-start check (r11 type-once "fixed").
// Typing before the desktop has drawn and has focus loses keys, so wait for both.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Fraction of sampled canvas pixels that are not black (0 = nothing drawn yet).
export const drawnFraction = (canvas) => canvas.evaluate((c) => {
  if (!c.width) return 0; const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let n = 0, t = 0;
  for (let i = 0; i < d.length; i += 4 * 97) { t++; if (d[i] + d[i + 1] + d[i + 2] > 30) n++; } return n / t;
}).catch(() => 0);
export async function waitFirstFrameAndFocus(p, canvas, position, { timeoutMs = 15000 } = {}) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs && (await drawnFraction(canvas)) < 0.05) await sleep(100);
  const firstFrameMs = Date.now() - t0;
  if ((await drawnFraction(canvas)) < 0.05) throw new Error(`The desktop drew nothing within ${timeoutMs / 1000} s.`);
  const display = p.locator('.desktop-pane.active .desktop-guac-display');
  await display.click({ position });
  await p.waitForFunction(() => document.activeElement?.classList.contains('desktop-display'), null, { timeout: 5000 });
  await sleep(300); // the remote window manager applies click-to-focus
  return firstFrameMs;
}

