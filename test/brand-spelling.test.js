import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** Review: the brand is "RemoteHub", one word, everywhere a user can see it. */
function files(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : /\.(js|mjs|html|css)$/.test(name) ? [path] : [];
  });
}

test('no "Remote Hub" (two words) in public/ or server/ text', () => {
  const two = /Remote\s+Hub/;
  const hits = [...files('public'), ...files('server')]
    .flatMap((path) => readFileSync(path, 'utf8').split('\n').map((line, i) => [path, i + 1, line]))
    .filter(([, , line]) => two.test(line))
    .map(([path, n, line]) => `${path}:${n}: ${line.trim()}`);
  assert.deepEqual(hits, []);
});

test('SAA-306 user-visible strings use "RemoteHub"', async () => {
  const { NO_TLS_RDP, BACKEND_LABELS } = await import('../public/js/desktop-auto.js');
  assert.equal(NO_TLS_RDP, "RemoteHub can't open a remote desktop on this computer. Try VNC instead.");
  assert.equal(BACKEND_LABELS.nativeStream, 'RemoteHub stream');
});
