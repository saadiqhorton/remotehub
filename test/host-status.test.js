import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultCapabilities, mergeCapabilities, sanitizeReportedCapabilities } from '../server/capabilities.js';
import { HostStatus, reportFromHello } from '../server/host-status.js';
import { agentFeatures, agentStatus, hostActions } from '../public/js/host-actions.js';

/**
 * Agent capability negotiation and live host status (SAA-300).
 */

const sshHost = { id: 'h1', capabilities: { version: 1, terminal: { ssh: true }, files: { sftp: true, watch: false }, desktop: { nativeStream: false, rdp: false, vnc: true } } };

function agentHello(extra = {}) {
  return {
    event: 'hello', protocol: 1, name: 'remotehub-agent', version: '0.1.0', mode: 'persistent',
    capabilities: { terminal: { ssh: false }, files: { sftp: false, watch: true }, desktop: { nativeStream: false, rdp: false, vnc: false }, agent: { available: true } },
    system: { os: 'linux', family: 'unix', arch: 'x86_64' },
    ...extra,
  };
}

test('reportFromHello keeps only known, bounded fields', () => {
  const report = reportFromHello(agentHello({ version: '0.1.0; rm -rf /', system: { os: 'x'.repeat(200), arch: 'aarch64' }, token: 'secret' }), 'registered');
  assert.deepEqual(report, { source: 'registered', mode: 'persistent', version: null, os: null, arch: 'aarch64', capabilities: { files: { watch: true }, commands: { exec: false }, desktop: { nativeStream: false } } });
  assert.equal(JSON.stringify(report).includes('secret'), false);
  assert.deepEqual(sanitizeReportedCapabilities({ files: { watch: 'yes', exfiltrate: true }, terminal: { ssh: true } }), { files: { watch: false }, commands: { exec: false }, desktop: { nativeStream: false } });
});

test('agentless capabilities come from the host; an agent can neither add nor remove them', () => {
  const reports = [reportFromHello(agentHello({ capabilities: { terminal: { ssh: false }, files: { sftp: false, watch: true }, desktop: { rdp: true } } }), 'registered')];
  const merged = mergeCapabilities(sshHost.capabilities, reports);
  assert.equal(merged.capabilities.terminal.ssh, true);
  assert.equal(merged.capabilities.files.sftp, true);
  assert.equal(merged.capabilities.desktop.vnc, true);
  assert.equal(merged.capabilities.desktop.rdp, false);
  assert.equal(merged.capabilities.files.watch, true);
  assert.deepEqual(merged.provenance, { 'terminal.ssh': 'ssh', 'files.sftp': 'ssh', 'desktop.vnc': 'ssh', 'files.watch': 'agent' });
  assert.deepEqual(merged.agent, { available: true, connected: true, source: 'registered', mode: 'persistent', version: '0.1.0', os: 'linux', arch: 'x86_64', count: 1 });
});

test('agent-dependent flags need a live agent: a stored value is ignored', () => {
  const stale = { ...sshHost.capabilities, files: { sftp: true, watch: true }, desktop: { nativeStream: true, vnc: true } };
  const merged = mergeCapabilities(stale, []);
  assert.equal(merged.capabilities.files.watch, false);
  assert.equal(merged.capabilities.desktop.nativeStream, false);
  assert.equal(merged.capabilities.files.sftp, true);
  assert.equal(merged.agent.connected, false);
  assert.equal(merged.capabilities.agent.available, false);
});

test('disconnecting an agent removes only the capabilities that depended on it', () => {
  const status = new HostStatus();
  const changes = [];
  status.on('change', (id) => changes.push(id));
  const detachAgent = status.attach('h1', 'registered:1', reportFromHello(agentHello(), 'registered'));
  const detachHelper = status.attach('h1', 'files:1:helper', reportFromHello(agentHello({ mode: 'temporary' }), 'helper'));
  let view = status.view(sshHost);
  assert.equal(view.capabilities.files.watch, true);
  assert.equal(view.provenance['files.watch'], 'agent', 'persistent agent preferred over helper');
  assert.equal(view.agent.count, 2);

  detachAgent();
  view = status.view(sshHost);
  assert.equal(view.capabilities.files.watch, true, 'the helper still provides it');
  assert.equal(view.provenance['files.watch'], 'helper');
  assert.equal(view.agent.mode, 'temporary');

  detachHelper();
  detachHelper(); // idempotent
  view = status.view(sshHost);
  const without = mergeCapabilities(sshHost.capabilities, []);
  assert.deepEqual(view, without);
  assert.equal(view.capabilities.files.watch, false);
  for (const flag of ['terminal.ssh', 'files.sftp', 'desktop.vnc']) assert.equal(view.provenance[flag], 'ssh');
  assert.deepEqual(changes, ['h1', 'h1', 'h1', 'h1']);
  assert.equal(status.hosts.size, 0);
});

test('the merged view is a copy; the stored host capabilities are never mutated', () => {
  const stored = structuredClone(sshHost.capabilities);
  mergeCapabilities(stored, [reportFromHello(agentHello(), 'local')]);
  assert.deepEqual(stored, sshHost.capabilities);
});

test('features and actions never depend on the OS name', () => {
  const host = (os) => {
    const report = reportFromHello(agentHello({ system: { os, arch: 'x86_64' } }), 'registered');
    const merged = mergeCapabilities(sshHost.capabilities, [report]);
    return { id: 'h1', capabilities: sshHost.capabilities, effectiveCapabilities: merged.capabilities, capabilityProvenance: merged.provenance, liveAgent: merged.agent, agent: { registered: true, connected: true } };
  };
  const linux = host('linux');
  for (const os of ['windows', 'macos', 'freebsd', 'unknown']) {
    assert.deepEqual(host(os).effectiveCapabilities, linux.effectiveCapabilities, os);
    assert.deepEqual(hostActions(host(os)), hostActions(linux), os);
    assert.deepEqual(agentFeatures(host(os)), agentFeatures(linux), os);
  }
  // A Windows-looking host without a desktop capability still gets no desktop action.
  const bare = { capabilities: defaultCapabilities(), liveAgent: { connected: true, os: 'windows', arch: 'x86_64' }, desktopServerEnabled: true, desktopProtocols: { rdp: true, vnc: true } };
  assert.equal(hostActions(bare)[2].reason, 'No remote desktop is available on this computer.');
});

test('hostActions prefers the negotiated capabilities over the stored ones', () => {
  const host = { capabilities: { terminal: { ssh: true }, files: { sftp: true } }, effectiveCapabilities: { terminal: { ssh: true }, files: { sftp: false } } };
  assert.equal(hostActions(host)[1].enabled, false);
});

test('agentStatus shows connected state, mode, version and OS/arch', () => {
  const persistent = agentStatus({ agent: { registered: true, connected: true }, liveAgent: { connected: true, source: 'registered', mode: 'persistent', version: '0.1.0', os: 'linux', arch: 'x86_64' } });
  assert.equal(persistent.summary, 'Connected · persistent · v0.1.0 · linux/x86_64');
  const helper = agentStatus({ agent: { registered: false, connected: false }, liveAgent: { connected: true, source: 'helper', mode: 'temporary', version: '0.1.0', os: 'linux', arch: 'aarch64' } });
  assert.equal(helper.summary, 'Connected · temporary · temporary connection · v0.1.0 · linux/aarch64');
  assert.equal(helper.state, 'connected');
  const down = agentStatus({ agent: { registered: true, connected: false }, liveAgent: { connected: false } });
  assert.equal(down.summary, 'Not connected right now');
  assert.equal(agentStatus({ agent: { registered: false }, liveAgent: { connected: false } }).state, 'none');
  assert.deepEqual(agentFeatures({ effectiveCapabilities: { files: { watch: true } }, capabilityProvenance: { 'files.watch': 'helper' } }), ['Live file updates (helper)']);
});
