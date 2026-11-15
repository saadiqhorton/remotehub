// SAA-349 (#26 review): Desktop card and Files view wording stays plain.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { hostActions, DESKTOP_NOT_SET_UP_HERE } from '../public/js/host-actions.js';

const caps = { terminal: { ssh: true }, files: { sftp: true }, desktop: { vnc: true } };
const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

test('Desktop card never says "turned off" when the server has desktop off', () => {
  const r = hostActions({ capabilities: caps, desktop: { protocol: 'vnc', port: 5901 } })[2].reason;
  assert.equal(r, DESKTOP_NOT_SET_UP_HERE);
  assert.doesNotMatch(r, /turned off/i);
});

test('Desktop card says "computer", not "host"', () => {
  const src = read('../public/js/host-actions.js');
  assert.doesNotMatch(src, /turned off on this RemoteHub server/);
  assert.doesNotMatch(src, /not set up for this host/);
  assert.match(src, /Desktop is not set up for this computer yet\./);
});

test('Files view says "folder" and gives a next step when a folder fails to open', () => {
  const src = read('../public/js/file-session.js');
  assert.doesNotMatch(src, /return to the directory\.'/);
  assert.doesNotMatch(src, /The listing failed\./);
  assert.match(src, /Close this view to return to the folder\./);
  assert.match(src, /RemoteHub couldn’t open this folder\. Click Refresh to try again\./);
});

test('Files view never shows "helper", "directory" or "host" in its visible strings', () => {
  const lines = read('../public/js/file-session.js').split('\n')
    .filter((l) => !/^\s*(\/\/|\*)/.test(l) && /['`]/.test(l));
  const hits = lines.filter((l) => /Start temporary helper|Stop temporary helper|Temporary helper|temporary helper'|\bdirectory\b|\bdirectories\b|\bDirectory\b|this host|the host\b|The host\b/.test(l)
    && !/'helper-status'|case '/.test(l));
  assert.deepEqual(hits, []);
  assert.match(lines.join('\n'), /'Start a temporary connection for this visit'/);
});

test('#26 final wording: computer, temporary connection, file actions, paths, delete warning', () => {
  const html = read('../public/index.html'); const app = read('../public/js/app.js');
  const files = read('../public/js/file-session.js'); const term = read('../public/js/terminal-session.js');
  const sftp = read('../server/sftp-bridge.js'); const backends = read('../public/js/desktop-backends.js'); const actions = read('../public/js/host-actions.js');
  for (const s of ['<span class="label">Computers</span>', '>+ Add computer<', '>Save computer<', '>Delete computer<', '>New computer<', 'placeholder="Filter computers"']) assert.ok(html.includes(s), s);
  for (const s of ['>+ Add host<', '>Save host<', '>Delete host<', 'Filter hosts', 'Jump to a host']) assert.ok(!html.includes(s), s);
  for (const src of [app, files, term]) assert.doesNotMatch(src, /'(\+ Add host|Save host|Edit host|New host|Open host settings|Add a host|No hosts yet\.)'/);
  assert.match(files, /'Open computer settings'/); assert.match(files, /'Changes on the computer appear automatically'/);
  assert.match(files, /'Start a temporary connection for this visit'/); assert.match(files, /'Stop the temporary connection'/);
  assert.match(files, /`Temporary connection for this visit\$\{/); assert.match(files, /`Temporary connection couldn’t start:/);
  for (const src of [files, backends, actions]) assert.doesNotMatch(src, /RemoteHub agent for this visit|'[^'\n]*temporary helper[^'\n]*'/);
  assert.match(sftp, /'RemoteHub couldn’t finish that file action\. Try again\.'/);
  assert.match(sftp, /'RemoteHub couldn’t finish that file action in time\. Try again\.'/);
  assert.doesNotMatch(sftp, /SFTP operation failed|must be absolute and free|absolute destination/);
  assert.doesNotMatch(files, /absolute folder|recycle bin/);
  assert.match(files, /Deleted files can’t be recovered\./);
});

test('Check desktop options says the not-set-up sentence once, and says a desktop was found', async () => {
  const { discoveryResultLines } = await import('../public/js/host-actions.js');
  const NOT_HERE = 'Remote desktop isn’t set up in this copy of RemoteHub yet. You can still connect with the terminal.';
  const host = { address: '127.0.0.2', desktopBackends: [
    { backend: 'rdp', available: false, selectable: false, reason: NOT_HERE },
    { backend: 'vnc', available: false, selectable: false, reason: NOT_HERE },
    { backend: 'nativeStream', available: false, selectable: false, reason: 'Needs the RemoteHub agent installed on this computer.' }] };
  const lines = discoveryResultLines(host);
  assert.equal(lines.filter((l) => l.includes(NOT_HERE)).length, 1, JSON.stringify(lines));
  assert.ok(lines.includes('This computer has a remote desktop, but RemoteHub can’t open it yet.'), JSON.stringify(lines));
});

test('a failed file transfer says the plain sentence, never "SFTP error"', () => {
  const sftp = read('../server/sftp-bridge.js');
  assert.match(sftp, /fail\('sftp', 'RemoteHub couldn’t finish that file transfer\. Try again\.'\)/);
  assert.doesNotMatch(sftp, /SFTP error/);
});
