// SAA-330 regression: test host keys must always be parseable by ssh2.
import test from 'node:test';
import assert from 'node:assert/strict';
import ssh2 from 'ssh2';
import { generateTestHostKey } from './helpers/fake-ssh-server.js';

const { utils } = ssh2;

test('generateTestHostKey never returns a key ssh2 rejects (2000 keys)', () => {
  for (let i = 0; i < 2000; i += 1) {
    const keys = generateTestHostKey();
    const parsed = utils.parseKey(keys.private);
    assert.ok(!(parsed instanceof Error), `key ${i}: ${parsed && parsed.message}`);
    assert.equal(parsed.getPublicSSH().length, 51);
  }
});

test('generateTestHostKey skips a truncated (leading-zero) key from ssh2', () => {
  // Generate until ssh2 produces a broken key, proving the bug is real here.
  let broken;
  for (let i = 0; i < 20000 && !broken; i += 1) {
    const k = utils.generateKeyPairSync('ed25519');
    if (utils.parseKey(k.private) instanceof Error) broken = k;
  }
  assert.ok(broken, 'expected ssh2 to produce at least one malformed key in 20000');
  // The retry key comes from generateTestHostKey itself so it is known-good;
  // a raw ssh2 key here would make this test flaky 1 time in 256.
  const good = generateTestHostKey();
  let calls = 0;
  const keys = generateTestHostKey({
    generate: () => (calls++ === 0 ? broken : good),
  });
  assert.equal(calls, 2);
  assert.equal(keys, good);
  assert.ok(!(utils.parseKey(keys.private) instanceof Error));
});
