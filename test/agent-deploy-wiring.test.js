import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { binaryName, knownTargets, parseArgs } from '../harness/build-agent.js';

// The one-click agent install only works when the server can read the agent builds.
// It reads them from HELPER_DIR, and every file there is named remotehub-agent-<os>-<arch>
// (server/helper-deploy.js picks the one matching the target it SSHed into).
//
// These checks keep the deployment wiring from silently regressing: a Compose file that
// forgets HELPER_DIR, or a build script that names its output differently from what the
// server looks for, breaks the install for every owner.

const compose = readFileSync(path.join('compose.yaml'), 'utf8');
const envExample = readFileSync(path.join('.env.example'), 'utf8');
const deployReadme = readFileSync(path.join('deploy', 'README.md'), 'utf8');

test('Compose passes HELPER_DIR and mounts the agent builds read-only', () => {
  assert.match(compose, /HELPER_DIR:\s*\$\{HELPER_DIR:-\/app\/agent-build\}/, 'the server needs the folder');
  assert.match(compose, /\.\/agent-build:\/app\/agent-build:ro/, 'the builds are mounted read-only');
});

test('the env example documents HELPER_DIR and the build command', () => {
  assert.match(envExample, /^HELPER_DIR=/m);
  assert.match(envExample, /npm run build-agent/);
});

test('the deploy guide explains how to build the agent builds', () => {
  assert.match(deployReadme, /npm run build-agent/);
  assert.match(deployReadme, /remotehub-agent-<os>-<arch>/);
});

test('the build script names every build the way the server looks for it', () => {
  const targets = knownTargets();
  assert.deepEqual(targets.sort(), ['linux-aarch64', 'linux-x86_64', 'macos-aarch64', 'macos-x86_64']);
  for (const target of targets) {
    const [os, arch] = target.split('-');
    assert.equal(binaryName(target), `remotehub-agent-${os}-${arch}`);
  }
});

test('the build script refuses an unknown target and honours --out', () => {
  assert.throws(() => parseArgs(['--target', 'solaris-sparc']), /Unknown target/);
  assert.throws(() => parseArgs(['--nope']), /Unknown argument/);
  const parsed = parseArgs(['--target', 'linux-x86_64', '--out', '/tmp/agent-builds']);
  assert.deepEqual(parsed.targets, ['linux-x86_64']);
  assert.equal(parsed.out, path.resolve('/tmp/agent-builds'));
  assert.deepEqual(parseArgs([]).targets, knownTargets(), 'no target means every supported target');
});
