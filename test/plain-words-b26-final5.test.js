// #26 (SAA-349) final5: no user-visible "host"; plain path wording.
// Expected sentences are inlined on purpose (no new imports), so this file loads on older code
// and fails there on the wording itself.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

const cases = [
  ['../public/js/app.js', ["'No computers match that filter.'", "'No matching computers.'"], ["No hosts match that filter.", "No matching hosts."]],
  ['../server/sftp-bridge.js', ["'That computer no longer exists.'", ' Use a full path without . or .. in it.'], ['That host no longer exists.', 'Root and dot segments are not allowed.']],
  ['../server/ssh-bridge.js', ["'That computer no longer exists.'"], ['That host no longer exists.']],
  ['../server/vnc.js', ['Check the port in this computer’s desktop settings, then connect again.', 'but it isn’t a VNC desktop. Check the port in this computer’s desktop settings.'], ['this host’s desktop settings']],
  ['../server/rdp.js', ['This computer isn’t offering a Windows remote desktop on that port. Check the port in this computer’s desktop settings.'], ['this host’s desktop settings']],
  ['../server/helper-deploy.js', ["'The computer refused to run a command.'", "'The computer did not answer in time.'", "'The computer printed more output than expected.'", "'Could not upload the temporary connection to the computer.'", "'The computer refused to start the temporary connection.'", "'the temporary connection has ended'", "'Temporary connections are not set up on this RemoteHub server.'"], ["'the temporary helper has ended'", "'Temporary helpers are not configured", 'temporary helper to the computer', 'start the temporary helper.', 'The host refused', 'The host did not', 'The host printed', 'helper to the host', 'host user or clock']],
  ['../server/app.js', ["'Computer not found.'", "'No VNC desktop for this computer.'", "'No RDP desktop for this computer.'", "'No desktop for this computer.'"], ['Host not found.', 'for this host.']],
  ['../server/validate.js', ["'Computer details are required.'", 'Address must be a computer name or IP address, e.g. 192.168.1.20 or nas.local.'], ['Host details are required.', 'must be a hostname']],
  ['../public/index.html', ['aria-label="Computers"'], ['aria-label="Hosts"']],
  ['../server/guacd.js', ['GUACD_HOST must be a computer name or IP address.'], ['must be a host name']],
  ['../server/sftp-bridge.js', ["'Temporary connections are not set up on this RemoteHub server.'", "'The temporary connection ended.'", "'Could not start the temporary connection.'"], ["'Temporary helpers are not configured", "'The temporary helper exited.'", "'Could not start the temporary helper.'"]],
  ['../public/js/desktop-auto.js', ["nativeStream: 'RemoteHub stream'"], ["'RemoteHub stream (coming soon)'"]],
  ['../server/desktop-discovery.js', ["'Nothing answered when RemoteHub looked for a remote desktop.'"], ['Nothing answered on port ${p}']],
  ['../server/ssh-bridge.js', ["'Nothing answered when RemoteHub tried to connect to this computer.'"], ['Nothing answered on port ${host.port}', 'SSH is turned on.', 'tried to open a terminal']],
];
for (const [file, want, gone] of cases) {
  test(`plain words in ${file}`, () => {
    const src = read(file);
    for (const s of want) assert.ok(src.includes(s), `missing: ${s}`);
    for (const s of gone) assert.ok(!src.includes(s), `still present: ${s}`);
  });
}

test('fresh desktop-options card: nothing found shows one line, no RDP:/VNC: labels, no repeats', async () => {
  const { discoveryResultLines } = await import('../public/js/host-actions.js');
  const down = 'Nothing answered when RemoteHub looked for a remote desktop.';
  const lines = discoveryResultLines({ desktopBackends: [
    { backend: 'rdp', available: false, selectable: false, reason: down },
    { backend: 'vnc', available: false, selectable: false, reason: down },
    { backend: 'nativeStream', available: false, selectable: false, reason: 'Needs the RemoteHub agent installed on this computer.' },
  ] });
  assert.deepEqual(lines, ['No remote desktop found. Turn on remote desktop on that computer, or install the RemoteHub agent on it.']);
  assert.ok(!lines.some((l) => /^(RDP|VNC):/.test(l)));
  assert.equal(new Set(lines).size, lines.length);
});

test('desktop-check reasons say no port number', async () => {
  const { discoveryReason } = await import('../server/desktop-discovery.js');
  const want = {
    'rdp timeout': 'No answer in time from the RDP remote desktop.',
    'vnc timeout': 'No answer in time from the VNC remote desktop.',
    'rdp closed': 'Something answered, but it hung up during the RDP check.',
    'rdp protocol': "Something answered, but it isn't an RDP remote desktop.",
    'vnc not-vnc': 'Something answered, but it isn’t a VNC remote desktop.',
    'rdp failed': "RemoteHub couldn't check the RDP remote desktop.",
    'rdp tls': 'The RDP remote desktop couldn’t set up a secure connection.',
    'rdp no-cert': 'The RDP remote desktop didn’t identify itself securely.',
    'vnc refused': 'The VNC remote desktop turned RemoteHub away.',
    'vnc unsupported': 'The VNC remote desktop uses a sign-in method RemoteHub doesn’t support.',
  };
  for (const [k, v] of Object.entries(want)) { const [p, c] = k.split(' '); assert.equal(discoveryReason(p, c, 3389), v, k); }
  const auto = read('../public/js/desktop-auto.js');
  assert.ok(auto.includes("'found; you’ll be asked to confirm before first use'"));
  assert.ok(auto.includes('was found in a place you haven’t used for this computer before. Confirm it to use it.'));
  assert.ok(!/on port \$\{/.test(auto) && !/on port \$\{/.test(read('../server/desktop-discovery.js')));
});

test('desktop confirm prompt says "in a place", not "on a port"', () => {
  const src = read('../public/js/host-actions.js');
  assert.ok(src.includes("RemoteHub found it in a place you haven't used for this computer before."));
  assert.ok(!src.includes('RemoteHub found it on a port'));
});
