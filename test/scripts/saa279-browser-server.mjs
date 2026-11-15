/** Keeps RemoteHub + fake SSH up for browser E2E; writes state to stdout line JSON. */
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fingerprintOf } from '../../server/ssh-bridge.js';
import { startFakeSshServer } from '../helpers/fake-ssh-server.js';
import { httpClient, startTestApp } from '../helpers/app-harness.js';

const OWNER_PASSWORD = 'browser-e2e-owner-99';
const SSH_PASSWORD = 'correct horse';
const statePath = path.join(os.tmpdir(), 'remotehub-saa279-browser.json');

const env = await startTestApp();
const client = httpClient(env.base, env.origin);
const ssh = await startFakeSshServer({ password: SSH_PASSWORD });

await client.request('/api/auth/setup', {
  method: 'POST',
  body: { setupCode: env.app.setupCode, password: OWNER_PASSWORD },
});

const created = await client.request('/api/hosts', {
  method: 'POST',
  body: { name: 'Browser E2E', address: '127.0.0.1', port: ssh.port, username: 'tester' },
});
const hostId = created.body.host.id;

await env.app.store.setKnownHost('127.0.0.1', ssh.port, {
  keyType: 'ssh-ed25519',
  fingerprint: fingerprintOf(ssh.publicBlob),
});

const state = {
  base: env.base,
  ownerPassword: OWNER_PASSWORD,
  sshPassword: SSH_PASSWORD,
  hostId,
  sshPort: ssh.port,
};
await fs.writeFile(statePath, JSON.stringify(state, null, 2));
console.log(JSON.stringify(state));

const shutdown = async () => {
  await env.stop();
  await ssh.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
