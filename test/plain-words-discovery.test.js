// Review ruling (PR #26): these exact old phrases must never reach the user again.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoveryResultLines } from '../public/js/host-actions.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OLD = ['Nothing is accepting connections on port', 'agent or helper', 'a required add-on is missing',
  // Review ruling 2 (PR #26): SSH and host-dialog wording.
  'Nothing is accepting SSH connections', 'Issue credential', 'Replace credential', 'Revoke credential', 'Revoke the agent credential',
  'Credential — shown once', 'Launch command', 'Trusted fingerprint', 'Forget fingerprint', 'Agent features:',
  'Check the server fingerprint', "machine's fingerprint", 'presented a different fingerprint', 'Server identity changed', 'Trusted · ', 'Received · ',
  // Review ruling 3: agent status and first-connect hint.
  'Not registered', 'To check, run this on the server', 'ssh-keygen -lf', '_key.pub',
  'SFTP is unavailable', 'SSH terminal is unavailable', 'The SFTP session ended',
  // Review ruling 4: Check desktop options card.
  'Remote desktop is turned off in this RemoteHub.'];
const files = (dir) => fs.readdirSync(path.join(ROOT, dir), { recursive: true }).filter((f) => f.endsWith('.js')).map((f) => path.join(dir, f));

test('old technical phrases are gone from every server and browser file', () => {
  for (const file of [...files('server'), ...files('public/js'), 'public/index.html']) {
    // Comments are developer notes, not words the user sees; strip them before checking.
    const code = fs.readFileSync(path.join(ROOT, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/ .*$/gm, '');
    for (const phrase of OLD) assert.ok(!code.includes(phrase), `${file} still says "${phrase}"`);
  }
});

test('discovery and result lines use the new plain sentences', async () => {
  const { probeRdpBackend } = await import('../server/desktop-discovery.js');
  const net = await import('node:net');
  const srv = net.createServer(); await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port; await new Promise((r) => srv.close(r));
  const r = await probeRdpBackend({ host: '127.0.0.1', port });
  assert.equal(r.reason, 'Nothing answered when RemoteHub looked for a remote desktop.');
  const lines = discoveryResultLines({ desktopBackends: [{ backend: 'rdp', available: false, selectable: false, reason: r.reason }] });
  assert.ok(lines.includes('No remote desktop found. Turn on remote desktop on that computer, or install the RemoteHub agent on it.'));
  for (const l of lines) for (const phrase of OLD) assert.ok(!l.includes(phrase));
});

test('docs and code comments name the RemoteHub agent, never "agent or helper"', () => {
  for (const file of [...files('server'), ...files('public/js'), 'public/index.html', 'deploy/guacd.md']) {
    assert.ok(!fs.readFileSync(path.join(ROOT, file), 'utf8').includes('agent or helper'), `${file} still says "agent or helper"`);
  }
});
