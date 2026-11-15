import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  CAPABILITIES_VERSION,
  availableDesktopBackends,
  defaultCapabilities,
  isEnabled,
  normalizeCapabilities,
} from '../server/capabilities.js';
import { STORE_VERSION, Store } from '../server/store.js';
import { httpClient, startTestApp } from './helpers/app-harness.js';

/**
 * Versioned host capability model (SAA-285).
 *
 * Covers: the ssh/sftp/file-watch/rdp/vnc/native-stream/agent representation,
 * safe handling of unknown/future capabilities, migration of pre-capability
 * hosts without data loss, and the API surfacing capabilities on host records.
 */

const SSH_BASELINE = {
  version: CAPABILITIES_VERSION,
  terminal: { ssh: true },
  files: { sftp: true, watch: false },
  commands: { exec: false },
  desktop: { nativeStream: false, rdp: false, vnc: false },
  agent: { available: false, mode: null, version: null },
};

test('default capabilities match the spec baseline for an agentless SSH host', () => {
  assert.deepEqual(defaultCapabilities(), SSH_BASELINE);
  // Fresh object every call: mutating one result must not affect the next.
  const first = defaultCapabilities();
  first.desktop.rdp = true;
  assert.equal(defaultCapabilities().desktop.rdp, false);
});

test('normalizeCapabilities repairs garbage input to the baseline', () => {
  for (const raw of [undefined, null, 'caps', 42, true, [], ['terminal']]) {
    assert.deepEqual(normalizeCapabilities(raw), SSH_BASELINE, `raw: ${JSON.stringify(raw)}`);
  }
});

test('normalizeCapabilities coerces wrong types to safe defaults but keeps explicit false', () => {
  assert.deepEqual(
    normalizeCapabilities({
      terminal: { ssh: 'yes' },
      files: { sftp: 1, watch: 'no' },
      desktop: 'rdp',
      agent: { available: 'yes', mode: 'ephemeral', version: 7 },
    }),
    SSH_BASELINE,
  );
  const explicit = normalizeCapabilities({ terminal: { ssh: false }, files: { sftp: false } });
  assert.equal(explicit.terminal.ssh, false, 'explicit false must survive normalization');
  assert.equal(explicit.files.sftp, false);
  assert.equal(explicit.files.watch, false);
});

test('normalizeCapabilities keeps the model version and tolerates future versions', () => {
  assert.equal(normalizeCapabilities({}).version, CAPABILITIES_VERSION);
  assert.equal(normalizeCapabilities({ version: 0 }).version, CAPABILITIES_VERSION);
  assert.equal(normalizeCapabilities({ version: '2' }).version, CAPABILITIES_VERSION);
  assert.equal(normalizeCapabilities({ version: 3 }).version, 3, 'future versions must not be downgraded');
});

test('agent metadata is validated and extensible', () => {
  assert.deepEqual(normalizeCapabilities({ agent: { available: true, mode: 'persistent', version: '0.1.0' } }).agent, {
    available: true,
    mode: 'persistent',
    version: '0.1.0',
  });
  const temporary = normalizeCapabilities({ agent: { available: true, mode: 'temporary', version: '0.2.0' } }).agent;
  assert.equal(temporary.mode, 'temporary');
  const extra = normalizeCapabilities({ agent: { available: true, build: 'abc123' } }).agent;
  assert.equal(extra.build, 'abc123', 'unknown agent metadata must round-trip');
});

test('unknown capabilities round-trip but stay inert', () => {
  const normalized = normalizeCapabilities({
    version: 2,
    desktop: { rdp: true, hologram: true },
    quantum: { entangled: true },
  });
  assert.deepEqual(normalized, {
    version: 2,
    terminal: { ssh: true },
    files: { sftp: true, watch: false },
    commands: { exec: false },
    desktop: { nativeStream: false, rdp: true, vnc: false, hologram: true },
    agent: { available: false, mode: null, version: null },
    quantum: { entangled: true },
  });
  assert.equal(isEnabled(normalized, 'desktop', 'hologram'), false, 'unknown keys must never enable behavior');
  assert.equal(isEnabled(normalized, 'quantum', 'entangled'), false, 'unknown surfaces must never enable behavior');
  assert.deepEqual(availableDesktopBackends(normalized), ['rdp']);
});

test('isEnabled only answers known flags that are strictly true', () => {
  assert.equal(isEnabled(SSH_BASELINE, 'terminal', 'ssh'), true);
  assert.equal(isEnabled(SSH_BASELINE, 'files', 'sftp'), true);
  assert.equal(isEnabled(SSH_BASELINE, 'files', 'watch'), false);
  assert.equal(isEnabled(SSH_BASELINE, 'desktop', 'rdp'), false);
  // Missing input normalizes to the baseline: an SSH transport is always assumed
  // (every saved host is an SSH host), while agent/desktop features stay off.
  assert.equal(isEnabled(undefined, 'terminal', 'ssh'), true);
  assert.equal(isEnabled(undefined, 'desktop', 'rdp'), false);
  assert.equal(isEnabled(SSH_BASELINE, 'terminal', 'telnet'), false);
  assert.equal(isEnabled(SSH_BASELINE, 'nope', 'ssh'), false);
  // Raw (unnormalized) input is safe to query directly.
  assert.equal(isEnabled({ terminal: { ssh: 1 } }, 'terminal', 'ssh'), false, 'truthy non-booleans must not count');
  assert.equal(isEnabled({ desktop: { rdp: 'yes' } }, 'desktop', 'rdp'), false);
  assert.equal(isEnabled({ desktop: { rdp: true } }, 'desktop', 'rdp'), true);
});

test('availableDesktopBackends lists enabled backends in stable order', () => {
  assert.deepEqual(availableDesktopBackends(SSH_BASELINE), []);
  const all = normalizeCapabilities({ desktop: { vnc: true, nativeStream: true, rdp: true } });
  assert.deepEqual(availableDesktopBackends(all), ['nativeStream', 'rdp', 'vnc']);
});

test('legacy v1 store files migrate without losing host data', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'remotehub-caps-'));
  try {
    const legacyHost = {
      id: 'legacy1',
      name: 'Old NAS',
      address: '10.0.0.5',
      port: 2222,
      username: 'admin',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
    };
    const legacyFile = {
      version: 1,
      owner: null,
      hosts: [
        legacyHost,
        {
          ...legacyHost,
          id: 'future1',
          capabilities: {
            version: 2,
            desktop: { rdp: true, hologram: true },
            agent: { mode: 'persistent', version: '0.1.0' },
          },
        },
      ],
      knownHosts: {
        '10.0.0.5:2222': { keyType: 'ssh-ed25519', fingerprint: 'SHA256:abc', addedAt: '2026-01-01T00:00:00.000Z' },
      },
    };
    await fs.writeFile(path.join(dataDir, 'remotehub.json'), JSON.stringify(legacyFile, null, 2));

    const store = await new Store(dataDir).load();

    // The legacy host gains the SSH baseline with every original field intact.
    const { capabilities, ...rest } = store.getHost('legacy1');
    assert.deepEqual(rest, legacyHost, 'no existing terminal host data may be lost');
    assert.deepEqual(capabilities, SSH_BASELINE);

    // Future capabilities survive normalization untouched.
    const future = store.getHost('future1').capabilities;
    assert.equal(future.version, 2);
    assert.equal(future.desktop.rdp, true);
    assert.equal(future.desktop.hologram, true);
    assert.equal(future.agent.mode, 'persistent');

    // Owner, fingerprints, and the store version are persisted on disk.
    const saved = JSON.parse(await fs.readFile(path.join(dataDir, 'remotehub.json'), 'utf8'));
    assert.equal(saved.version, STORE_VERSION);
    assert.deepEqual(saved.knownHosts, legacyFile.knownHosts);
    assert.deepEqual(saved.hosts.find((h) => h.id === 'legacy1').capabilities, SSH_BASELINE);

    // Reloading is idempotent: the file is stable after the first migration.
    const snapshot = await fs.readFile(path.join(dataDir, 'remotehub.json'), 'utf8');
    await new Store(dataDir).load();
    assert.equal(await fs.readFile(path.join(dataDir, 'remotehub.json'), 'utf8'), snapshot);
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test('addHost assigns baseline capabilities and updateHost preserves them unless replaced', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'remotehub-caps-'));
  try {
    const store = await new Store(dataDir).load();
    const host = await store.addHost({ name: 'Box', address: '10.0.0.1', port: 22, username: 'root' });
    assert.deepEqual(host.capabilities, SSH_BASELINE);

    // Ordinary edits keep capabilities.
    const renamed = await store.updateHost(host.id, { name: 'Renamed' });
    assert.equal(renamed.name, 'Renamed');
    assert.deepEqual(renamed.capabilities, SSH_BASELINE);

    // Explicit replacement is normalized.
    const evolved = await store.updateHost(host.id, { capabilities: { desktop: { rdp: true, vnc: 'yes' } } });
    assert.equal(evolved.capabilities.desktop.rdp, true);
    assert.equal(evolved.capabilities.desktop.vnc, false, 'non-boolean flags must not enable');
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

const OWNER_PASSWORD = 'owner-password-123';
let env;
let client;

before(async () => {
  env = await startTestApp();
  client = httpClient(env.base, env.origin);
  const setup = await client.request('/api/auth/setup', {
    method: 'POST',
    body: { setupCode: env.app.setupCode, password: OWNER_PASSWORD },
  });
  assert.equal(setup.status, 200);
});

after(async () => {
  await env.stop();
});

test('new hosts are created with baseline capabilities and served over the API', async () => {
  const created = await client.request('/api/hosts', {
    method: 'POST',
    body: { name: 'Box', address: '127.0.0.1', port: 2222, username: 'tester' },
  });
  assert.equal(created.status, 201);
  assert.deepEqual(created.body.host.capabilities, SSH_BASELINE);
  assert.equal(created.body.host.name, 'Box');

  const listed = await client.request('/api/hosts');
  assert.deepEqual(listed.body.hosts.find((h) => h.id === created.body.host.id).capabilities, SSH_BASELINE);
});

test('host edits never wipe capabilities and the API strips client-supplied capability blobs', async () => {
  const created = await client.request('/api/hosts', {
    method: 'POST',
    body: { name: 'Evolving', address: '127.0.0.1', port: 2223, username: 'tester' },
  });
  const id = created.body.host.id;

  // Simulate a later discovery step recording an RDP backend (server-side, SAA-306).
  await env.app.store.updateHost(id, { capabilities: { desktop: { rdp: true } } });

  // A plain edit keeps the recorded capabilities.
  const renamed = await client.request(`/api/hosts/${id}`, {
    method: 'PUT',
    body: { name: 'Evolved', address: '127.0.0.1', port: 2223, username: 'tester' },
  });
  assert.equal(renamed.status, 200);
  assert.equal(renamed.body.host.capabilities.desktop.rdp, true);

  // Client-supplied capabilities are not valid host fields: validation drops them.
  const tampered = await client.request(`/api/hosts/${id}`, {
    method: 'PUT',
    body: {
      name: 'Evolved',
      address: '127.0.0.1',
      port: 2223,
      username: 'tester',
      capabilities: { desktop: { rdp: 'yes', hologram: true } },
    },
  });
  assert.equal(tampered.status, 200);
  assert.equal(tampered.body.host.capabilities.desktop.rdp, true, 'server-side capabilities must survive client blobs');
  assert.equal(tampered.body.host.capabilities.desktop.hologram, undefined);
});
