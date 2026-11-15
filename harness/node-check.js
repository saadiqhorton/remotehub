#!/usr/bin/env node
// SAA-348: runs before npm test, npm start, npm run harness and npm run doctor. npm only
// warns about "engines", so on an old Node the next command fails with a confusing error
// (for example "Could not find test/*.test.js" on Node 20). This prints one plain sentence
// instead. Keep this file free of newer syntax so it runs on old Node versions too.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const MIN = [22, 9];

/** The plain message for a too-old Node, or '' when the version is fine. */
export function nodeVersionProblem(version = process.versions.node) {
  const [major, minor] = String(version).replace(/^v/, '').split('.').map(Number);
  const ok = major > MIN[0] || (major === MIN[0] && minor >= MIN[1]);
  return ok ? '' : `RemoteHub needs Node ${MIN.join('.')} or newer. You have ${String(version).replace(/^v/, '')}.`;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const problem = nodeVersionProblem();
  if (problem) {
    console.error(problem);
    console.error('Get it from https://nodejs.org, then run the command again.');
    process.exit(1);
  }
}
