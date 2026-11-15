#!/usr/bin/env node
// SAA-338: Node 24 does not enforce --test-timeout on a test-file child (nodejs/node#57672), so a file whose
// child never exits (for example a leaked setInterval) would stall npm test. This runner arms a per-file
// watchdog that fails the file and aborts the run when it fires. On Node 22 the native file timeout normally fires first.
import fs from 'node:fs';
import path from 'node:path';
import { run } from 'node:test';
import { spec } from 'node:test/reporters';

const args = process.argv.slice(2);
const timeoutArg = args.find((a) => a.startsWith('--test-timeout='));
const timeout = Number(timeoutArg?.slice('--test-timeout='.length));
if (!timeoutArg || !Number.isInteger(timeout) || timeout <= 0) {
  console.error('harness/run-tests.js needs --test-timeout=<ms> (a positive integer).');
  process.exit(1);
}

/** Expands `dir/*.ext`-style patterns (`*` in the basename only). Plain paths pass through. */
function expandFiles(patterns) {
  const files = [];
  for (const p of patterns) {
    if (!p.includes('*')) { files.push(p); continue; }
    const dir = path.dirname(p);
    const re = new RegExp(`^${path.basename(p).split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/\\\\]*')}$`);
    const matched = fs.readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && re.test(e.name))
      .map((e) => e.name)
      .sort();
    files.push(...matched.map((name) => path.posix.join(dir.replace(/\\/g, '/'), name)));
  }
  return files;
}

const files = expandFiles(args.filter((a) => !a.startsWith('--')));
if (files.length === 0) {
  console.error('harness/run-tests.js: no test files matched.');
  process.exit(1);
}

const controller = new AbortController();
const watchdogs = new Map(); // file name as given -> timer
let watchdogFired = false;
let failed = false;

const stream = run({ files, timeout, concurrency: true, signal: controller.signal });

// Each file's watchdog is armed on its file-level test:dequeue (name = path as given) and cleared on its test:complete.
stream.on('test:dequeue', (d) => {
  if (d.nesting !== 0 || path.resolve(d.name) !== d.file) return;
  const timer = setTimeout(() => {
    watchdogFired = true;
    process.exitCode = 1;
    console.error(`test file ${d.name} timed out after ${timeout}ms (it never finished or never exited — look for a leaked handle)`);
    controller.abort();
  }, timeout);
  timer.unref();
  watchdogs.set(d.name, timer);
});

const settleFile = (d) => {
  if (d.nesting !== 0 || !watchdogs.has(d.name)) return;
  clearTimeout(watchdogs.get(d.name));
  watchdogs.delete(d.name);
};
stream.on('test:pass', settleFile);
stream.on('test:complete', settleFile); // Node 24 never emits a file-level test:pass for a passing file
stream.on('test:fail', (d) => { settleFile(d); failed = true; });

// The global summary (no file) reports overall success, which also covers failures inside files.
let summarySuccess = true;
stream.on('test:summary', (d) => { if (d.file == null && d.success === false) summarySuccess = false; });

stream.compose(spec).pipe(process.stdout);

stream.on('end', () => {
  if (watchdogFired || failed || !summarySuccess) process.exitCode = 1;
});
