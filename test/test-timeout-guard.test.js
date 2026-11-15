// SAA-338: a hung test file must fail the run, not stall `npm test` forever.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

test('npm test runs with a --test-timeout guard', () => {
  assert.match(pkg.scripts.test, /--test-timeout=\d+/);
  assert.doesNotMatch(pkg.scripts.test, /--test-force-exit/);
  assert.match(pkg.scripts.test, /harness\/run-tests\.js/);
});

// Runs the same harness/run-tests.js that npm test uses, so Node 22 and Node 24 both get the per-file watchdog path.
test('a test file that never exits is reported as a timed-out failure', { timeout: 30_000 }, async () => {
  const fixture = fileURLToPath(new URL('./fixtures/leaked-handle.fixture.cjs', import.meta.url));
  const runner = fileURLToPath(new URL('../harness/run-tests.js', import.meta.url));
  // Drop the runner's own context so the child runs as a top-level test run.
  const { NODE_TEST_CONTEXT, ...childEnv } = process.env;
  const started = performance.now();
  const child = spawn(process.execPath, [runner, '--test-timeout=1500', fixture], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: childEnv,
  });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  // Hard stop if the child hangs after the timeout (seen on some Node/WSL hosts).
  const forceKill = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, 12_000);
  const code = await new Promise((resolve) => child.on('close', resolve));
  clearTimeout(forceKill);
  assert.notEqual(code, 0, out);
  assert.match(out, /timed out after 1500ms/);
  assert.ok(performance.now() - started >= 1400, `timeout should take ~1500ms, took ${performance.now() - started}ms`);
  assert.ok(performance.now() - started < 20_000, `guard took ${performance.now() - started}ms`);
});

test('a hang is never blamed on a file that already passed', { timeout: 30_000 }, async () => {
  const quickPass = fileURLToPath(new URL('./fixtures/quick-pass.fixture.cjs', import.meta.url));
  const leaked = fileURLToPath(new URL('./fixtures/leaked-handle.fixture.cjs', import.meta.url));
  const runner = fileURLToPath(new URL('../harness/run-tests.js', import.meta.url));
  // Drop the runner's own context so the child runs as a top-level test run.
  const { NODE_TEST_CONTEXT, ...childEnv } = process.env;
  const started = performance.now();
  const child = spawn(process.execPath, [runner, '--test-timeout=1500', quickPass, leaked], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: childEnv,
  });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  // Hard stop if the child hangs after the timeout (seen on some Node/WSL hosts).
  const forceKill = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, 12_000);
  const code = await new Promise((resolve) => child.on('close', resolve));
  clearTimeout(forceKill);
  assert.notEqual(code, 0, out);
  assert.doesNotMatch(out, /test file \S*quick-pass\.fixture\.cjs timed out/);
  assert.match(out, /timed out after 1500ms/);
  assert.ok(performance.now() - started < 20_000, `guard took ${performance.now() - started}ms`);
});
