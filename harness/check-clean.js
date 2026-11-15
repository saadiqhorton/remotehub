#!/usr/bin/env node
// SAA-348: `npm run test:clean` runs the whole test suite and fails if it left any
// file in the repo created, changed or deleted (git status --porcelain must not change).
import { spawnSync } from 'node:child_process';

const porcelain = () => spawnSync('git', ['status', '--porcelain', '--untracked-files=all'], { encoding: 'utf8' }).stdout;
const before = porcelain();
const run = spawnSync('npm', ['test'], { stdio: 'inherit', shell: process.platform === 'win32' });
const after = porcelain();
if (before !== after) {
  console.error('The test suite changed files in the repo:\n' + after);
  process.exit(1);
}
console.log('Working tree unchanged by the test suite.');
process.exit(run.status ?? 1);
