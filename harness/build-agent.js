#!/usr/bin/env node
// Builds the RemoteHub agent binaries that the server installs on target computers.
//
// The server picks a build by the target's OS and architecture (see server/helper-deploy.js):
//   remotehub-agent-linux-x86_64, remotehub-agent-linux-aarch64,
//   remotehub-agent-macos-x86_64, remotehub-agent-macos-aarch64
//
// They are built with Docker so no Rust toolchain has to be installed on the host. macOS
// binaries are cross-compiled from Linux (the agent needs no Apple SDK for these targets).
//
// Usage:
//   npm run build-agent                 every supported target into agent-build/
//   npm run build-agent -- --target linux-x86_64
//   npm run build-agent -- --out ./somewhere/else
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const AGENT_DIR = path.join(ROOT, 'agent');
export const DEFAULT_OUT = path.join(ROOT, 'agent-build');

// os -> rust target triple, and how to build it.
//
// Linux targets cross-compile from Linux in Docker. macOS targets need the Apple SDK for the
// `ring` crate (the agent's TLS), which is not redistributable, so they are built natively on
// a Mac. `npm run build-agent` therefore builds the Linux targets in Docker and builds the
// macOS targets only when it runs on macOS.
const TARGETS = {
  'linux-x86_64': { rust: 'x86_64-unknown-linux-gnu', kind: 'linux' },
  'linux-aarch64': { rust: 'aarch64-unknown-linux-gnu', kind: 'linux' },
  'macos-x86_64': { rust: 'x86_64-apple-darwin', kind: 'macos' },
  'macos-aarch64': { rust: 'aarch64-apple-darwin', kind: 'macos' },
};

const RUST_IMAGE = 'rust:1-bookworm';

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', ...options });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${command} ${args.join(' ')} exited with ${code}`))));
  });
}

/** The name the server looks for, e.g. remotehub-agent-linux-x86_64. */
export function binaryName(target) {
  const [os, arch] = String(target).split('-');
  return `remotehub-agent-${os}-${arch}`;
}

export function knownTargets() {
  return Object.keys(TARGETS);
}

/** Parse --target <name> (repeatable) and --out <dir>. */
export function parseArgs(argv) {
  const targets = [];
  let out = DEFAULT_OUT;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--target') {
      const value = argv[index + 1];
      if (!value || !TARGETS[value]) throw new Error(`Unknown target "${value ?? ''}". Known: ${knownTargets().join(', ')}`);
      targets.push(value);
      index += 1;
    } else if (arg === '--out') {
      out = argv[index + 1];
      if (!out) throw new Error('--out needs a folder.');
      index += 1;
    } else {
      throw new Error(`Unknown argument "${arg}".`);
    }
  }
  return { targets: targets.length ? targets : knownTargets(), out: path.resolve(out) };
}

async function buildTarget(target, outDir) {
  const { rust, kind } = TARGETS[target];
  const name = binaryName(target);
  console.log(`building ${name} (${rust})…`);
  if (kind === 'macos') {
    // Built natively: the Apple SDK cannot be redistributed, and the agent's TLS (ring)
    // needs it. Run this on a Mac.
    if (process.platform !== 'darwin') {
      throw new Error(`${name} must be built on a Mac (it needs the Apple SDK). Run "npm run build-agent -- --target ${target}" on one, and copy the file into the agent-build folder.`);
    }
    await run('cargo', ['build', '--release', '--target', rust], { cwd: AGENT_DIR });
    await fs.copyFile(path.join(AGENT_DIR, 'target', rust, 'release', 'remotehub-agent'), path.join(outDir, name));
    console.log(`built ${name}`);
    return;
  }
  const cross = rust.startsWith('aarch64');
  const script = [
    'set -e',
    'export CARGO_HOME=/tmp/cargo',
    'export PATH="/usr/local/cargo/bin:$PATH"',
    'apt-get update -qq >/dev/null 2>&1',
    'apt-get install -y -qq gcc-aarch64-linux-gnu >/dev/null 2>&1',
    `rustup target add ${rust} 2>&1 | tail -1`,
    `export CC_${rust.replace(/-/g, '_')}=${cross ? 'aarch64-linux-gnu-gcc' : 'gcc'}`,
    `export CARGO_TARGET_${rust.replace(/-/g, '_').toUpperCase()}_LINKER=${cross ? 'aarch64-linux-gnu-gcc' : 'gcc'}`,
    `cargo build --release --target ${rust}`,
    `cp target/${rust}/release/remotehub-agent /out/${name}`,
  ];
  await run('docker', [
    'run', '--rm',
    '-v', `${AGENT_DIR}:/src`,
    '-v', `${outDir}:/out`,
    '-w', '/src',
    RUST_IMAGE,
    'bash', '-c', script.join('\n'),
  ]);
  console.log(`built ${name}`);
}

async function main() {
  const { targets, out } = parseArgs(process.argv.slice(2));
  await fs.mkdir(out, { recursive: true });
  const onMac = process.platform === 'darwin';
  // Without an explicit --target, build what this host can build and say what it skipped.
  const skipped = [];
  const buildable = targets.filter((target) => {
    if (TARGETS[target].kind !== 'macos' || onMac) return true;
    skipped.push(target);
    return false;
  });
  if (skipped.length) {
    console.log(`Skipping ${skipped.join(', ')}: the agent's TLS needs the Apple SDK, so those builds run on a Mac.`);
  }
  if (!buildable.length) {
    console.error('Nothing to build here. Run this on a Mac, or build a Linux target with --target linux-x86_64.');
    process.exit(1);
  }
  if (buildable.some((target) => TARGETS[target].kind === 'linux')) {
    try {
      await run('docker', ['version', '--format', '{{.Server.Version}}'], { stdio: 'ignore' });
    } catch {
      console.error('Docker is required to build the agent (no Rust toolchain needed on the host).');
      process.exit(1);
    }
  }
  for (const target of buildable) await buildTarget(target, out);
  console.log('');
  console.log(`Agent builds in ${out}:`);
  for (const file of await fs.readdir(out)) console.log(`  ${file}`);
  if (skipped.length) {
    console.log('');
    console.log(`Still missing: ${skipped.map((target) => binaryName(target)).join(', ')}. Build them on a Mac and copy them here.`);
  }
  console.log('');
  console.log('Point RemoteHub at this folder (HELPER_DIR) so "Install agent on this computer" works.');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
