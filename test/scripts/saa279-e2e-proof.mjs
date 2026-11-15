/**
 * One-shot SAA-279 Files milestone proof: fake SSH + real RemoteHub + /ws/files UI-equivalent flows.
 * Not part of the test suite; run: node test/scripts/saa279-e2e-proof.mjs
 */
import assert from 'node:assert/strict';
import { fingerprintOf } from '../../server/ssh-bridge.js';
import { TRANSFER_CHUNK_BYTES } from '../../server/sftp-bridge.js';
import { startFakeSshServer } from '../helpers/fake-ssh-server.js';
import { httpClient, openFiles, startTestApp } from '../helpers/app-harness.js';

const OWNER_PASSWORD = 'owner-password-123';
const SSH_PASSWORD = 'correct horse';
const HOME = '/home/tester';

const checklist = [];

function record(name, pass, detail = '') {
  checklist.push({ name, pass, detail });
  const mark = pass ? 'PASS' : 'FAIL';
  console.log(`[${mark}] ${name}${detail ? `: ${detail}` : ''}`);
}

const isReady = (m) => m.t === 'status' && m.s === 'ready';
const resultFor = (id) => (m) => m.t === 'result' && m.id === id;
const opErrorFor = (id) => (m) => m.t === 'error' && m.id === id;
const phase = (id, name) => (m) => m.t === 'transfer' && m.id === id && m.phase === name;

async function main() {
  const env = await startTestApp();
  const client = httpClient(env.base, env.origin);
  const ssh = await startFakeSshServer({ password: SSH_PASSWORD });

  console.log('\n=== SAA-279 E2E proof environment ===');
  console.log(`RemoteHub base: ${env.base}`);
  console.log(`Fake SSH: 127.0.0.1:${ssh.port} user tester`);
  console.log(`Owner setup code: ${env.app.setupCode}`);
  console.log('=====================================\n');

  let hostId;
  try {
    const setup = await client.request('/api/auth/setup', {
      method: 'POST',
      body: { setupCode: env.app.setupCode, password: OWNER_PASSWORD },
    });
    record('Owner setup (API)', setup.status === 200, `status ${setup.status}`);

    const created = await client.request('/api/hosts', {
      method: 'POST',
      body: { name: 'E2E Fake box', address: '127.0.0.1', port: ssh.port, username: 'tester' },
    });
    hostId = created.body?.host?.id;
    record('Add host 127.0.0.1:fakePort', created.status === 201 && hostId, hostId || `status ${created.status}`);

    await env.app.store.setKnownHost('127.0.0.1', ssh.port, {
      keyType: 'ssh-ed25519',
      fingerprint: fingerprintOf(ssh.publicBlob),
    });
    record('Trust host fingerprint (store)', true, fingerprintOf(ssh.publicBlob).slice(0, 16) + '…');

    const f = openFiles(env.base, { headers: { Cookie: client.cookie, Origin: env.origin } });
    await f.opened;
    f.send({ t: 'connect', hostId, password: SSH_PASSWORD });
    await f.untilControl(isReady, 'ready');
    const statuses = f.control.filter((m) => m.t === 'status').map((m) => m.s);
    record(
      'Connect with password',
      statuses.includes('connecting') && statuses.includes('authenticating') && statuses.includes('ready'),
      statuses.join(' → '),
    );

    f.send({ t: 'list', id: 1, path: HOME });
    await f.untilControl(resultFor(1), 'list home');
    const home = f.control.find(resultFor(1));
    const homeNames = home.entries.map((e) => e.name);
    record(
      'List home directory',
      home.op === 'list' && homeNames.includes('documents') && homeNames.includes('photo.jpg'),
      homeNames.join(', '),
    );

    f.send({ t: 'list', id: 2, path: '/srv' });
    await f.untilControl(resultFor(2), 'list srv');
    const srvNames = f.control.find(resultFor(2)).entries.map((e) => e.name);
    record('Navigate folder (/srv)', srvNames.includes('notes.txt'), srvNames.join(', '));

    f.send({ t: 'read', id: 3, path: '/srv/notes.txt' });
    await f.untilControl(resultFor(3), 'read notes');
    const readResult = f.control.find(resultFor(3));
    record(
      'Open small text file (read)',
      readResult.op === 'read' && readResult.text === 'alpha\n    beta\n',
      `${readResult.text?.length ?? 0} chars`,
    );

    f.send({ t: 'mkdir', id: 4, path: `${HOME}/saa279-proof-dir` });
    await f.untilControl(resultFor(4), 'mkdir');
    record('Mutation: mkdir', f.control.find(resultFor(4)).op === 'mkdir', `${HOME}/saa279-proof-dir`);

    f.send({ t: 'search', id: 5, path: HOME, query: 'photo' });
    await f.untilControl(resultFor(5), 'search');
    const search = f.control.find(resultFor(5));
    record(
      'Search by name (optional)',
      search.entries.some((e) => e.name === 'photo.jpg'),
      `hits: ${search.entries.map((e) => e.name).join(', ')}`,
    );

    const payload = Buffer.from('saa279-upload-proof');
    f.send({ t: 'put', id: 'up', path: `${HOME}/saa279-upload.txt`, size: payload.length });
    await f.untilControl(phase('up', 'start'), 'upload start');
    f.sendRaw(payload);
    await f.untilControl((m) => m.t === 'transfer' && m.id === 'up' && m.phase === 'ack', 'upload ack');
    f.send({ t: 'put-end', id: 'up' });
    await f.untilControl(phase('up', 'complete'), 'upload complete');
    record('Upload file', true, `${payload.length} bytes → ${HOME}/saa279-upload.txt`);

    f.send({ t: 'get', id: 'dl', path: `${HOME}/saa279-upload.txt` });
    await f.untilControl(phase('dl', 'start'), 'download start');
    const dlSize = f.control.find(phase('dl', 'start')).size;
    let loaded = 0;
    const binStart = f.binaries.length;
    while (loaded < dlSize) {
      f.send({ t: 'ack', id: 'dl' });
      await f.untilControl(
        (m) => m.t === 'transfer' && m.id === 'dl' && (m.phase === 'progress' || m.phase === 'complete') && m.loaded > loaded,
        'download chunk',
      );
      const latest = [...f.control].reverse().find((m) => m.t === 'transfer' && m.id === 'dl');
      loaded = latest.loaded;
    }
    await f.untilControl(phase('dl', 'complete'), 'download complete');
    const downloaded = Buffer.concat(f.binaries.slice(binStart));
    record('Download file', downloaded.equals(payload), `${downloaded.length} bytes round-trip`);

    f.ws.close();
    await f.closed();
    record('Session closes cleanly', true);

    const allPass = checklist.every((c) => c.pass);
    console.log('\n=== Checklist summary ===');
    for (const row of checklist) {
      console.log(`  ${row.pass ? '✓' : '✗'} ${row.name}`);
    }
    console.log(`\nVerdict SAA-279 ready: ${allPass ? 'YES' : 'NO'}\n`);
    process.exitCode = allPass ? 0 : 1;
  } finally {
    await env.stop();
    await ssh.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
