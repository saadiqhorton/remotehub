// SAA-338 fixture (not matched by test/*.test.js): passes, then leaks a timer so the
// process never exits on its own. Both Node 22 and Node 24 must report it as timed out
// via harness/run-tests.js ("timed out after 1500ms", non-zero exit), which is what npm test runs.
// A forever-pending Promise is cancelled by the parent in ~50ms without that timeout
// message (see CI on phase-1-stabilization), so do not use that form here.
const test = require('node:test');
test('passes but leaks a handle', () => { setInterval(() => {}, 1000); });
