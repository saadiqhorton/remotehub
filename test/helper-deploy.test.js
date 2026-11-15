import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  CWD_COMMAND, HELPER_DIR_PREFIX, createHelperTokens, deployHelper, helperBinaryName, parsePlatform, shellQuote, sweepStaleHelpers,
} from '../server/helper-deploy.js';

test('parsePlatform maps uname output to supported helper builds only', () => {
  assert.deepEqual(parsePlatform('Linux x86_64\n'), { os: 'linux', arch: 'x86_64' });
  assert.deepEqual(parsePlatform('Linux aarch64'), { os: 'linux', arch: 'aarch64' });
  assert.deepEqual(parsePlatform('Darwin arm64'), { os: 'macos', arch: 'aarch64' });
  assert.deepEqual(parsePlatform('FreeBSD amd64'), null);
  assert.deepEqual(parsePlatform('Linux armv7l'), null);
  assert.deepEqual(parsePlatform(''), null);
  assert.equal(helperBinaryName({ os: 'macos', arch: 'aarch64' }), 'remotehub-agent-macos-aarch64');
});

test('shellQuote neutralises quotes and shell syntax', () => {
  assert.equal(shellQuote('/home/a b'), "'/home/a b'");
  assert.equal(shellQuote("it's; rm -rf /"), "'it'\\''s; rm -rf /'");
});

test('helper tokens are single-use, expire, and can be invalidated', () => {
  let clock = 1_000;
  const tokens = createHelperTokens({ ttlMs: 60_000, now: () => clock });
  const a = tokens.mint();
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.notEqual(tokens.mint(), a, 'fresh random token each time');
  assert.equal(tokens.consume(a), true);
  assert.equal(tokens.consume(a), false, 'a used token cannot be reused');

  const expiring = tokens.mint();
  clock += 60_000;
  assert.equal(tokens.consume(expiring), false, 'an expired token fails');

  const revoked = tokens.mint();
  tokens.invalidate(revoked);
  assert.equal(tokens.consume(revoked), false, 'an invalidated token fails');
  assert.equal(tokens.consume('f'.repeat(64)), false, 'an unknown token fails');
  assert.equal(tokens.consume(undefined), false);
  clock += 120_000;
  assert.equal(tokens.size, 0, 'expired entries are swept');
});

// ---- deployHelper against scripted ssh2 conn/sftp objects -----------------------

function scriptedHost({ uname = 'Linux x86_64\n', failMkdir = false, failUploadAt = null, refuseExec = false } = {}) {
  const files = new Map(); // path -> { type, mode, data }
  const calls = [];
  const handles = new Map();
  let nextHandle = 1;
  const channel = new EventEmitter();
  channel.stderr = new EventEmitter();
  channel.ended = false;
  channel.end = () => {
    channel.ended = true;
    // A well-behaved helper exits (and removes itself) on EOF.
    setImmediate(() => { channel.emit('exit', 0); channel.emit('close'); });
  };
  channel.signal = () => {};
  channel.close = () => channel.emit('close');
  const st = (entry) => ({ mode: (entry.type === 'dir' ? 0o040000 : 0o100000) | entry.mode, isDirectory: () => entry.type === 'dir' });
  const err = (code) => Object.assign(new Error(`status ${code}`), { code });
  const sftp = {
    mkdir(p, attrs, cb) { calls.push(['mkdir', p, attrs.mode]); if (failMkdir) return cb(err(3)); if (files.has(p)) return cb(err(4)); files.set(p, { type: 'dir', mode: attrs.mode }); cb(null); },
    lstat(p, cb) { const e = files.get(p); return e ? cb(null, st(e)) : cb(err(2)); },
    chmod(p, mode, cb) { calls.push(['chmod', p, mode]); const e = files.get(p); if (!e) return cb(err(2)); e.mode = mode; cb(null); },
    open(p, flags, attrs, cb) {
      calls.push(['open', p, flags, attrs.mode]);
      if (flags === 'wx' && files.has(p)) return cb(err(4));
      if (failUploadAt && p.endsWith(failUploadAt)) return cb(err(4));
      files.set(p, { type: 'file', mode: attrs.mode, data: Buffer.alloc(0) });
      const h = Buffer.from([nextHandle++]);
      handles.set(h.toString('hex'), p);
      cb(null, h);
    },
    write(h, buf, off, len, pos, cb) { const e = files.get(handles.get(h.toString('hex'))); e.data = Buffer.concat([e.data.subarray(0, pos), buf.subarray(off, off + len)]); cb(null); },
    close(h, cb) { handles.delete(h.toString('hex')); cb(null); },
    readdir(p, cb) { cb(null, []); },
    unlink(p, cb) { calls.push(['unlink', p]); return files.delete(p) ? cb(null) : cb(err(2)); },
    rmdir(p, cb) {
      calls.push(['rmdir', p]);
      if ([...files.keys()].some((k) => k.startsWith(`${p}/`))) return cb(err(4));
      return files.delete(p) ? cb(null) : cb(err(2));
    },
  };
  const conn = {
    execs: [],
    exec(command, cb) {
      conn.execs.push(command);
      if (command === 'id -u; date +%s' || command === 'ps -ww -A -o args=' || command === CWD_COMMAND || command.startsWith('find -P ')) {
        const s = new EventEmitter();
        s.stderr = new EventEmitter();
        s.close = () => {};
        cb(null, s);
        setImmediate(() => { s.emit('data', command.startsWith('id') ? '1000\n1800000000\n' : 'init\n'); s.emit('close'); });
        return;
      }
      if (command === 'uname -sm') {
        const s = new EventEmitter();
        s.stderr = new EventEmitter();
        s.close = () => {};
        cb(null, s);
        setImmediate(() => { s.emit('data', uname); s.emit('close'); });
        return;
      }
      if (refuseExec) return cb(new Error('refused'));
      cb(null, channel);
    },
  };
  return { files, calls, sftp, conn, channel };
}

async function helperDirWith(name) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'rh-helper-builds-'));
  await writeFile(path.join(dir, name), Buffer.alloc(100_000, 7));
  return dir;
}

test('deploy uploads a private binary and token, runs it, and the token redeems once', async () => {
  const helperDir = await helperDirWith('remotehub-agent-linux-x86_64');
  const host = scriptedHost();
  const tokens = createHelperTokens();
  const logs = [];
  try {
    const handle = await deployHelper({ conn: host.conn, sftp: host.sftp, helperDir, root: "/home/o'neil", tokens, log: (l) => logs.push(l) });
    assert.deepEqual(handle.platform, { os: 'linux', arch: 'x86_64' });
    assert.match(handle.dir, new RegExp(`^/tmp/${HELPER_DIR_PREFIX}[0-9a-f]{16}$`));
    assert.equal(host.files.get(handle.dir).mode, 0o700);
    assert.equal(host.files.get(`${handle.dir}/remotehub-agent`).mode, 0o700);
    assert.equal(host.files.get(`${handle.dir}/remotehub-agent`).data.length, 100_000, 'binary uploaded in full');
    const tokenFile = host.files.get(`${handle.dir}/session-token`);
    assert.equal(tokenFile.mode, 0o600);
    const token = tokenFile.data.toString().trim();
    assert.match(token, /^[0-9a-f]{64}$/);
    assert.ok(host.calls.filter(([op]) => op === 'open').every(([, , flags]) => flags === 'wx'), 'exclusive creates only');

    const command = host.conn.execs.at(-1);
    assert.equal(command, `exec '${handle.dir}/remotehub-agent' --mode temporary --root '/home/o'\\''neil' --helper-token-file '${handle.dir}/session-token' --helper-cleanup --helper-ttl 60`);
    assert.ok(!command.includes(token), 'token is never on the command line');

    const read = () => new Promise((resolve) => handle.readToken((e, t) => resolve(e ? e.message : t)));
    assert.equal(await read(), token);
    assert.equal(await read(), 'helper token expired or already used', 'reusing the token fails');
    const opened = await new Promise((resolve) => handle.open((e, s) => resolve(e ? null : s)));
    assert.equal(opened, host.channel);
    assert.equal(await new Promise((resolve) => handle.open((e) => resolve(e?.message))), 'the temporary connection has ended', 'one channel only');

    // Normal close: EOF to the helper, then RemoteHub removes whatever is left and confirms.
    const report = await handle.stop();
    assert.equal(host.channel.ended, true);
    assert.deepEqual(report, { cleaned: true, exitCode: 0 });
    assert.equal([...host.files.keys()].filter((k) => k.startsWith(handle.dir)).length, 0, 'nothing left on the host');
    assert.equal(await handle.stop(), report, 'stop is idempotent');
    assert.ok(logs.every((line) => !line.includes(token)), 'token never logged');
  } finally {
    await rm(helperDir, { recursive: true, force: true });
  }
});

test('an unredeemed token expires: the deploy handle refuses it after the TTL', async () => {
  const helperDir = await helperDirWith('remotehub-agent-linux-x86_64');
  const host = scriptedHost();
  let clock = 0;
  const tokens = createHelperTokens({ ttlMs: 1_000, now: () => clock });
  try {
    const handle = await deployHelper({ conn: host.conn, sftp: host.sftp, helperDir, root: '/h', tokens });
    clock = 1_000;
    const result = await new Promise((resolve) => handle.readToken((e) => resolve(e?.message)));
    assert.equal(result, 'helper token expired or already used');
    await handle.stop();
  } finally {
    await rm(helperDir, { recursive: true, force: true });
  }
});

test('unsupported OS and missing builds fail before anything is uploaded', async () => {
  const helperDir = await helperDirWith('remotehub-agent-linux-x86_64');
  try {
    for (const [uname, code] of [['Windows_NT x86_64', 'unsupported'], ['Darwin arm64', 'no-binary']]) {
      const host = scriptedHost({ uname });
      await assert.rejects(deployHelper({ conn: host.conn, sftp: host.sftp, helperDir, root: '/h' }), (e) => e.code === code);
      assert.equal(host.files.size, 0);
      assert.deepEqual(host.conn.execs, ['uname -sm']);
    }
    const host = scriptedHost();
    await assert.rejects(deployHelper({ conn: host.conn, sftp: host.sftp, helperDir: null, root: '/h' }), (e) => e.code === 'disabled');
  } finally {
    await rm(helperDir, { recursive: true, force: true });
  }
});

test('a failure mid-deploy removes what was uploaded and invalidates the token', async () => {
  const helperDir = await helperDirWith('remotehub-agent-linux-x86_64');
  try {
    for (const options of [{ failUploadAt: '/session-token' }, { refuseExec: true }, { failUploadAt: '/remotehub-agent' }]) {
      const host = scriptedHost(options);
      const tokens = createHelperTokens();
      const error = await deployHelper({ conn: host.conn, sftp: host.sftp, helperDir, root: '/h', tokens }).catch((e) => e);
      assert.equal(error.cleaned, true, JSON.stringify(options));
      assert.equal(host.files.size, 0, `nothing left after ${JSON.stringify(options)}`);
      assert.equal(tokens.size, 0, 'no live token left behind');
    }
    const denied = scriptedHost({ failMkdir: true });
    const error = await deployHelper({ conn: denied.conn, sftp: denied.sftp, helperDir, root: '/h' }).catch((e) => e);
    assert.equal(error.code, 'deploy');
    assert.equal(denied.files.size, 0);
  } finally {
    await rm(helperDir, { recursive: true, force: true });
  }
});

test('a helper that ignores EOF is killed after the stop timeout and still cleaned up', { timeout: 15_000 }, async () => {
  const helperDir = await helperDirWith('remotehub-agent-linux-x86_64');
  const host = scriptedHost();
  host.channel.end = () => { host.channel.ended = true; }; // hung helper
  let signalled = null;
  host.channel.signal = (name) => { signalled = name; };
  try {
    const handle = await deployHelper({ conn: host.conn, sftp: host.sftp, helperDir, root: '/h' });
    const report = await handle.stop();
    assert.equal(signalled, 'KILL');
    assert.equal(report.cleaned, true);
    assert.equal(host.files.size, 0);
  } finally {
    await rm(helperDir, { recursive: true, force: true });
  }
});

// ---- stale helper sweep ------------------------------------------------------------

const NOW = 1_800_000_000;
const HOUR = 3600;
const hex = (c) => c.repeat(16);

// Host model: path -> { type: 'dir'|'file'|'symlink', uid, mtime, target? }
function sweepHost(entries, { uid = 1000, ps = 'init\n', idOutput, cwd = 'C /home/me\nRH_CWD_OK\n', hardlinks = [] } = {}) {
  const tree = new Map(entries);
  const err = (code) => Object.assign(new Error(`status ${code}`), { code });
  const bits = { dir: 0o040000, file: 0o100000, symlink: 0o120000 };
  const attrsOf = (e) => ({ mode: bits[e.type] | (e.perm ?? 0o700), uid: e.uid ?? uid, mtime: e.mtime ?? NOW });
  const ops = [];
  const sftp = {
    lstat(p, cb) { ops.push(['lstat', p]); const e = tree.get(p); return e ? cb(null, attrsOf(e)) : cb(err(2)); },
    readdir(p, cb) {
      ops.push(['readdir', p]);
      const e = tree.get(p);
      if (!e) return cb(err(2));
      if (e.type === 'symlink') return cb(new Error('readdir followed a symlink'));
      const names = [...tree.keys()].filter((k) => k.startsWith(`${p}/`) && !k.slice(p.length + 1).includes('/'));
      cb(null, names.map((k) => ({ filename: k.slice(p.length + 1), attrs: attrsOf(tree.get(k)) })));
    },
    unlink(p, cb) { ops.push(['unlink', p]); const e = tree.get(p); if (!e || e.type === 'dir') return cb(err(4)); tree.delete(p); cb(null); },
    rmdir(p, cb) {
      ops.push(['rmdir', p]);
      if ([...tree.keys()].some((k) => k.startsWith(`${p}/`))) return cb(err(4));
      return tree.delete(p) ? cb(null) : cb(err(2));
    },
  };
  const conn = {
    execs: [],
    exec(command, cb) {
      conn.execs.push(command);
      const s = new EventEmitter();
      s.stderr = new EventEmitter();
      s.close = () => {};
      cb(null, s);
      let out = command === 'id -u; date +%s' ? (idOutput ?? `${uid}\n${NOW}\n`) : command === 'ps -ww -A -o args=' ? ps : command === CWD_COMMAND ? cwd : '';
      const find = /^find -P '([^']+)' /.exec(command);
      if (find) {
        // Model `find -P dir -mindepth 1 ( -type l -o ( ! -type d -links +1 ) ) -print`.
        const inside = [...tree.keys()].filter((k) => k.startsWith(`${find[1]}/`));
        const hits = inside.filter((k) => tree.get(k).type === 'symlink' || hardlinks.includes(k));
        out = `${hits.map((k) => `${k}\n`).join('')}RH_FIND_OK\n`;
      }
      setImmediate(() => { if (out) s.emit('data', out); s.emit('close'); });
    },
  };
  return { tree, sftp, conn, ops };
}

test('sweep removes only stale, own, unused helper folders and never follows symlinks', async () => {
  const stale = `/tmp/remotehub-helper-${hex('a')}`;
  const fresh = `/tmp/remotehub-helper-${hex('b')}`;
  const inUse = `/tmp/remotehub-helper-${hex('c')}`;
  const otherOwner = `/tmp/remotehub-helper-${hex('d')}`;
  const linked = `/tmp/remotehub-helper-${hex('e')}`;
  const nested = `/tmp/remotehub-helper-${hex('f')}`;
  const withSymlink = `/tmp/remotehub-helper-${hex('1')}`;
  const withHardlink = `/tmp/remotehub-helper-${hex('2')}`;
  const cwdInUse = `/tmp/remotehub-helper-${hex('3')}`;
  const cwdNested = `/tmp/remotehub-helper-${hex('4')}`;
  const shared = `/tmp/remotehub-helper-${hex('5')}`;
  const host = sweepHost([
    ['/tmp', { type: 'dir', uid: 0 }],
    [stale, { type: 'dir', mtime: NOW - 2 * HOUR }],
    [`${stale}/remotehub-agent`, { type: 'file' }],
    [`${stale}/session-token`, { type: 'file' }],
    // A symlink inside an otherwise stale folder keeps the whole folder.
    [withSymlink, { type: 'dir', mtime: NOW - 5 * HOUR }],
    [`${withSymlink}/remotehub-agent`, { type: 'file' }],
    [`${withSymlink}/escape`, { type: 'symlink', target: '/home/me/precious' }],
    ['/home/me/precious', { type: 'file' }],
    // A hard link (nlink > 1) inside keeps it too; only the host can tell.
    [withHardlink, { type: 'dir', mtime: NOW - 5 * HOUR }],
    [`${withHardlink}/remotehub-agent`, { type: 'file' }],
    // A shell sitting in the folder (working directory) keeps it.
    [cwdInUse, { type: 'dir', mtime: NOW - 5 * HOUR }],
    [`${cwdInUse}/remotehub-agent`, { type: 'file' }],
    [cwdNested, { type: 'dir', mtime: NOW - 5 * HOUR }],
    [`${cwdNested}/remotehub-agent`, { type: 'file' }],
    // Not private: not how RemoteHub creates it.
    [shared, { type: 'dir', mtime: NOW - 5 * HOUR, perm: 0o755 }],
    [`${shared}/remotehub-agent`, { type: 'file' }],
    [fresh, { type: 'dir', mtime: NOW - 10 * 60 }],
    [`${fresh}/remotehub-agent`, { type: 'file' }],
    [inUse, { type: 'dir', mtime: NOW - 5 * HOUR }],
    [`${inUse}/remotehub-agent`, { type: 'file' }],
    [otherOwner, { type: 'dir', uid: 1001, mtime: NOW - 5 * HOUR }],
    [`${otherOwner}/remotehub-agent`, { type: 'file', uid: 1001 }],
    // A stale-looking symlink named like a helper folder, pointing at a real directory.
    [linked, { type: 'symlink', mtime: NOW - 5 * HOUR, target: '/home/me' }],
    [nested, { type: 'dir', mtime: NOW - 5 * HOUR }],
    [`${nested}/sub`, { type: 'dir' }],
    ['/tmp/remotehub-helper-manual', { type: 'dir', mtime: NOW - 5 * HOUR }],
    ['/tmp/unrelated', { type: 'dir', mtime: NOW - 5 * HOUR }],
  ], {
    ps: `sshd: me\n${inUse}/remotehub-agent --mode temporary --root /home/me\n`,
    cwd: `C /home/me\nC ${cwdInUse}\nC ${cwdNested}/deeper\nC /tmp/remotehub-helper-${hex('a')}0\nRH_CWD_OK\n`,
    hardlinks: [`${withHardlink}/remotehub-agent`],
  });
  const logs = [];
  const result = await sweepStaleHelpers({ conn: host.conn, sftp: host.sftp, log: (l) => logs.push(l) });

  assert.deepEqual(result.removed, [`remotehub-helper-${hex('a')}`], 'stale removed');
  assert.ok(!host.tree.has(stale) && !host.tree.has(`${stale}/session-token`));
  assert.ok(host.tree.has(`${withSymlink}/escape`) && host.tree.has('/home/me/precious'), 'link and target untouched');
  assert.ok(host.tree.has(`${withHardlink}/remotehub-agent`), 'hard-linked file untouched');
  const reasons = Object.fromEntries(result.kept.map(({ name, reason }) => [name, reason]));
  assert.deepEqual(reasons, {
    [`remotehub-helper-${hex('b')}`]: 'fresh',
    [`remotehub-helper-${hex('c')}`]: 'in use',
    [`remotehub-helper-${hex('d')}`]: 'other owner',
    [`remotehub-helper-${hex('e')}`]: 'symlink',
    [`remotehub-helper-${hex('f')}`]: 'unexpected contents',
    [`remotehub-helper-${hex('1')}`]: 'contains a link',
    [`remotehub-helper-${hex('2')}`]: 'contains a link',
    [`remotehub-helper-${hex('3')}`]: 'in use (working directory)',
    [`remotehub-helper-${hex('4')}`]: 'in use (working directory)',
    [`remotehub-helper-${hex('5')}`]: 'shared permissions',
  });
  // Nothing inside a kept folder was ever removed.
  for (const dir of [withSymlink, withHardlink, cwdInUse, cwdNested, shared]) {
    assert.ok(!host.ops.some(([op, p]) => (op === 'unlink' || op === 'rmdir') && (p === dir || p.startsWith(`${dir}/`))), `${dir} untouched`);
  }
  for (const kept of [fresh, inUse, otherOwner, linked, nested, `${nested}/sub`, '/tmp/remotehub-helper-manual', '/tmp/unrelated']) {
    assert.ok(host.tree.has(kept), `${kept} kept`);
  }
  // Nothing was ever read, listed, or removed through the symlinked folder.
  assert.ok(!host.ops.some(([op, p]) => p.startsWith(`${linked}/`) || (p === linked && op !== 'lstat')), JSON.stringify(host.ops));
  assert.ok(!host.ops.some(([op, p]) => op !== 'lstat' && p.startsWith(otherOwner)), 'other owner never listed or touched');
  assert.deepEqual(logs, ['swept 1 stale temporary helper folder(s)']);
});

test('sweep keeps everything when the process list or host identity cannot be read', async () => {
  const stale = `/tmp/remotehub-helper-${hex('a')}`;
  const entries = [['/tmp', { type: 'dir', uid: 0 }], [stale, { type: 'dir', mtime: NOW - 5 * HOUR }], [`${stale}/remotehub-agent`, { type: 'file' }]];
  const noPs = sweepHost(entries, { ps: '' });
  const result = await sweepStaleHelpers({ conn: noPs.conn, sftp: noPs.sftp });
  assert.deepEqual(result, { removed: [], kept: [{ name: `remotehub-helper-${hex('a')}`, reason: 'process list unavailable' }] });
  assert.ok(noPs.tree.has(stale));

  const noId = sweepHost(entries, { idOutput: 'garbage\n' });
  await assert.rejects(sweepStaleHelpers({ conn: noId.conn, sftp: noId.sftp }), (e) => e.code === 'sweep');
  assert.ok(noId.tree.has(stale));
});

test('sweep keeps everything when working directories cannot all be read', async () => {
  const stale = `/tmp/remotehub-helper-${hex('a')}`;
  const entries = [['/tmp', { type: 'dir', uid: 0 }], [stale, { type: 'dir', mtime: NOW - 5 * HOUR }], [`${stale}/remotehub-agent`, { type: 'file' }]];
  for (const cwd of ['', 'RH_CWD_NONE\n', 'C /home/me\nRH_CWD_UNREADABLE\nRH_CWD_OK\n', 'C /home/me\n' /* cut short */]) {
    const host = sweepHost(entries, { cwd });
    const result = await sweepStaleHelpers({ conn: host.conn, sftp: host.sftp });
    assert.deepEqual(result, { removed: [], kept: [{ name: `remotehub-helper-${hex('a')}`, reason: 'working directories unavailable' }] }, JSON.stringify(cwd));
    assert.ok(host.tree.has(`${stale}/remotehub-agent`));
  }
});

test('sweep keeps a folder when the hard-link check cannot run', async () => {
  const stale = `/tmp/remotehub-helper-${hex('a')}`;
  const host = sweepHost([['/tmp', { type: 'dir', uid: 0 }], [stale, { type: 'dir', mtime: NOW - 5 * HOUR }], [`${stale}/remotehub-agent`, { type: 'file' }]]);
  const exec = host.conn.exec;
  host.conn.exec = (command, cb) => (command.startsWith('find ') ? cb(new Error('no exec')) : exec(command, cb));
  const result = await sweepStaleHelpers({ conn: host.conn, sftp: host.sftp });
  assert.deepEqual(result.kept, [{ name: `remotehub-helper-${hex('a')}`, reason: 'link check unavailable' }]);
  assert.ok(host.tree.has(`${stale}/remotehub-agent`));
});

test('with no candidate folder the sweep runs no process, cwd or link scan', async () => {
  const host = sweepHost([
    ['/tmp', { type: 'dir', uid: 0 }],
    [`/tmp/remotehub-helper-${hex('b')}`, { type: 'dir', mtime: NOW - 60 }], // fresh
    [`/tmp/remotehub-helper-${hex('d')}`, { type: 'dir', uid: 1001, mtime: NOW - 5 * HOUR }], // other owner
    [`/tmp/remotehub-helper-${hex('5')}`, { type: 'dir', perm: 0o755, mtime: NOW - 5 * HOUR }], // shared
    ['/tmp/unrelated', { type: 'dir', mtime: NOW - 5 * HOUR }],
  ]);
  const result = await sweepStaleHelpers({ conn: host.conn, sftp: host.sftp });
  assert.equal(result.removed.length, 0);
  assert.deepEqual(host.conn.execs, ['id -u; date +%s'], 'only the identity/clock probe ran');
  const empty = sweepHost([['/tmp', { type: 'dir', uid: 0 }]]);
  await sweepStaleHelpers({ conn: empty.conn, sftp: empty.sftp });
  assert.deepEqual(empty.conn.execs, ['id -u; date +%s']);
});

test('sweep uses the host clock, not the RemoteHub server clock', async () => {
  const dir = `/tmp/remotehub-helper-${hex('a')}`;
  // Host clock says the folder is 30 minutes old, whatever Date.now() says here.
  const host = sweepHost([['/tmp', { type: 'dir' }], [dir, { type: 'dir', mtime: NOW - 30 * 60 }]]);
  const result = await sweepStaleHelpers({ conn: host.conn, sftp: host.sftp });
  assert.deepEqual(result.kept, [{ name: `remotehub-helper-${hex('a')}`, reason: 'fresh' }]);
});

test('a large process list is read in full: an in-use folder listed after 4 KB of other processes is kept', async () => {
  const inUse = `/tmp/remotehub-helper-${hex('c')}`;
  const noise = Array.from({ length: 2000 }, (_, i) => `/usr/bin/some-daemon --worker ${i} --config /etc/some-daemon/config.toml`).join('\n');
  const host = sweepHost([
    ['/tmp', { type: 'dir', uid: 0 }],
    [inUse, { type: 'dir', mtime: NOW - 5 * HOUR }],
    [`${inUse}/remotehub-agent`, { type: 'file' }],
  ], { ps: `${noise}\n${inUse}/remotehub-agent --mode temporary\n` });
  assert.ok(noise.length > 100_000);
  const result = await sweepStaleHelpers({ conn: host.conn, sftp: host.sftp });
  assert.deepEqual(result, { removed: [], kept: [{ name: `remotehub-helper-${hex('c')}`, reason: 'in use' }] });
  assert.ok(host.tree.has(`${inUse}/remotehub-agent`));
});
