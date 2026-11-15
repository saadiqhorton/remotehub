// SAA-348: RDP display-block reservation. A temp dir stands in for /tmp (xDir), so these
// tests never read or write the real /tmp/.X11-unix.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pickDisplayRange, displayBlockFree, reserveDisplaysForLaunch, releaseDisplays } from '../harness/providers/rdp.js';

let root; let xDir; let lockDir;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-harness-xdisp-'));
  xDir = path.join(root, 'tmp'); lockDir = path.join(root, 'locks');
  fs.mkdirSync(path.join(xDir, '.X11-unix'), { recursive: true });
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
const takeSocket = (d) => fs.writeFileSync(path.join(xDir, '.X11-unix', `X${d}`), '');
const takeLock = (d) => fs.writeFileSync(path.join(xDir, `.X${d}-lock`), '12345\n');

test('a block with any X socket in it is skipped', () => {
  takeSocket(207);
  assert.equal(displayBlockFree(200, 10, xDir), false);
  assert.deepEqual(pickDisplayRange({ lockDir, xDir }), [210, 219]);
});

test('a block with any X lock file in it is skipped', () => {
  takeLock(200); takeLock(219);
  assert.deepEqual(pickDisplayRange({ lockDir, xDir }), [220, 229]);
});

test('two reservations made back to back never overlap', () => {
  const a = pickDisplayRange({ lockDir, xDir });
  const b = pickDisplayRange({ lockDir, xDir });
  assert.deepEqual(a, [200, 209]);
  assert.deepEqual(b, [210, 219]);
  assert.ok(a[1] < b[0]);
});

test('a released block can be reserved again', () => {
  const a = pickDisplayRange({ lockDir, xDir });
  releaseDisplays({ displays: a, lockDir });
  assert.deepEqual(pickDisplayRange({ lockDir, xDir }), a);
});

test('right before launch the block is checked again; if a display was taken meanwhile it moves on', () => {
  let calls = 0;
  const r = reserveDisplaysForLaunch({ lockDir, xDir, beforeRecheck: ([start]) => { calls++; if (start === 200) takeSocket(204); } });
  assert.deepEqual(r, [210, 219]);
  assert.equal(calls, 2);
  // The abandoned block's reservation was released (it is not leaked), and is busy only because of X204.
  assert.equal(fs.existsSync(path.join(lockDir, 'displays-200.lock')), false);
  assert.equal(fs.existsSync(path.join(lockDir, 'displays-210.lock')), true);
});

test('launch recheck keeps the block when nothing changed', () => {
  assert.deepEqual(reserveDisplaysForLaunch({ lockDir, xDir }), [200, 209]);
});
