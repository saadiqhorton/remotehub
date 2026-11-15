import ssh2 from 'ssh2';

const { Server, utils } = ssh2;
const { OPEN_MODE } = utils.sftp;

const S_IFDIR = 0o040000;
const S_IFREG = 0o100000;
const S_IFLNK = 0o120000;
const HOME = '/home/tester';

// In-memory tree the SFTP handlers serve. Timestamps are fixed so assertions are exact.
function defaultTree() {
  const dir = (mode) => ({ type: 'dir', mode });
  const file = (size, mode, mtime) => ({ type: 'file', size, mode, mtime, atime: mtime });
  return new Map([
    ['/', dir(0o755)],
    ['/home', dir(0o755)],
    [HOME, dir(0o755)],
    [`${HOME}/documents`, dir(0o755)],
    [`${HOME}/photo.jpg`, { ...file(2048, 0o644, 1700000100), content: Buffer.alloc(2048, 0x62) }],
    [`${HOME}/.hidden`, { ...file(3, 0o644, 1700000200), content: Buffer.from('hid') }],
    [`${HOME}/link-to-documents`, { type: 'symlink', target: `${HOME}/documents`, mode: 0o777, mtime: 1700000300, atime: 1700000300 }],
    ['/denied', { type: 'dir', mode: 0o755, deny: true }],
    ['/srv', dir(0o755)],
    ['/srv/notes.txt', { type: 'file', size: 15, mode: 0o644, mtime: 1700000400, atime: 1700000400, content: Buffer.from('alpha\n    beta\n') }],
    ['/srv/private.key', { type: 'file', size: 8, mode: 0o600, mtime: 1700000400, atime: 1700000400, deny: true, content: Buffer.from('not-sent') }],
    ['/srv/icon.bin', { type: 'file', size: 5, mode: 0o644, mtime: 1700000400, atime: 1700000400, content: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00]) }],
    ['/srv/big.log', { type: 'file', size: 1024 * 1024, mode: 0o644, mtime: 1700000400, atime: 1700000400, content: Buffer.alloc(0) }],
    ['/srv/essay.txt', { type: 'file', size: 96 * 1024, mode: 0o644, mtime: 1700000400, atime: 1700000400, content: Buffer.alloc(96 * 1024, 0x61) }],
  ]);
}

function freshTree(entries) {
  const tree = defaultTree();
  for (const [path, entry] of entries) tree.set(path, entry);
  return tree;
}

// Arms one SSH_FX_FAILURE (status 4, not EOF or not-found), then clears the flag.
function takeFailure(hooks, flag) {
  if (!hooks[flag]) return false;
  hooks[flag] = false;
  return true;
}

// Resolves "." and ".."; "." and "" mean the home directory for our test user.
function normalizePath(raw) {
  if (!raw || raw === '.') return HOME;
  // Like OpenSSH's sftp-server, a relative path is resolved from the login directory.
  const parts = (raw.startsWith('/') ? raw : `${HOME}/${raw}`).split('/');
  const out = [];
  for (const part of parts) {
    if (part === '' || part === '.') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  return `/${out.join('/')}`;
}

function attrsOf(entry) {
  const bits = entry.type === 'dir' ? S_IFDIR : entry.type === 'symlink' ? S_IFLNK : S_IFREG;
  return {
    mode: bits | entry.mode,
    size: entry.type === 'symlink' ? 0 : entry.size || 0,
    mtime: entry.mtime || 0,
    atime: entry.atime || entry.mtime || 0,
    // The test user is uid 1000; entries may claim another owner.
    uid: entry.uid ?? 1000,
    gid: entry.gid ?? 1000,
  };
}

// Serves one tree over a server-mode SFTP stream. Reads and writes are chunked the
// way a client asks for them; nothing here assembles a second copy beyond the file itself.
function wireSftp(sftp, events, tree, hooks, onSftpTree) {
  onSftpTree?.(tree);
  const handles = new Map();
  let nextHandle = 1;

  const at = (path) => tree.get(path);
  const childrenOf = (dirPath) => {
    const prefix = dirPath === '/' ? '/' : `${dirPath}/`;
    const names = [];
    for (const key of tree.keys()) {
      if (key === dirPath || !key.startsWith(prefix)) continue;
      const rest = key.slice(prefix.length);
      if (rest && !rest.includes('/')) names.push({ name: rest, entry: tree.get(key) });
    }
    return names;
  };
  const name = (filename, entry) => ({ filename, longname: filename, attrs: attrsOf(entry) });
  const later = (fn) => {
    if (!events.lagMs) fn();
    else setTimeout(fn, events.lagMs);
  };
  const parentOf = (resolved) => {
    const slash = resolved.lastIndexOf('/');
    if (slash <= 0) return '/';
    return resolved.slice(0, slash);
  };

  sftp.on('REALPATH', (reqID, path) => {
    const resolved = normalizePath(path);
    const entry = at(resolved);
    if (!entry) return sftp.status(reqID, 2, 'No such file');
    // realpathRoot: non-root directory whose REALPATH is "/", so recursive delete hits the root guard.
    const answer = entry.type === 'dir' && entry.realpathRoot ? '/' : resolved;
    sftp.name(reqID, [{ filename: answer, longname: answer }]);
  });

  sftp.on('OPENDIR', (reqID, path) => {
    let resolved = normalizePath(path);
    events.sftp.opendirPaths.push(resolved);
    let entry = at(resolved);
    // Follow a symlink to a directory, the way an SFTP server does.
    if (entry && entry.type === 'symlink') {
      resolved = normalizePath(entry.target);
      entry = at(resolved);
    }
    if (!entry) return sftp.status(reqID, 2, 'No such file');
    if (entry.deny) return sftp.status(reqID, 3, 'Permission denied');
    if (entry.type !== 'dir') return sftp.status(reqID, 4, 'Not a directory');
    const handle = Buffer.alloc(4);
    handle.writeUInt32BE(nextHandle++, 0);
    handles.set(handle.toString('hex'), { path: resolved, sent: false });
    sftp.handle(reqID, handle);
  });

  sftp.on('READDIR', (reqID, handle) => {
    const found = handles.get(handle.toString('hex'));
    if (!found) return sftp.status(reqID, 4, 'Invalid handle');
    if (found.sent) return sftp.status(reqID, 1, 'End of file');
    found.sent = true;
    const dot = at(found.path);
    const dotdot = at(normalizePath(`${found.path}/..`)) || dot;
    const names = [name('.', dot), name('..', dotdot)];
    for (const child of childrenOf(found.path)) names.push(name(child.name, child.entry));
    if (events.readdirDelayMs) setTimeout(() => sftp.name(reqID, names), events.readdirDelayMs).unref();
    else sftp.name(reqID, names);
  });

  sftp.on('OPEN', (reqID, filename, flags = 0, attrs = {}) => {
    const resolved = normalizePath(filename);
    events.sftp.opens.push(resolved);
    if (resolved.endsWith('/scratch.bin')) return sftp.status(reqID, 3, 'Permission denied');
    const writing = (flags & OPEN_MODE.WRITE) !== 0;
    let entry = at(resolved);
    if (writing) {
      if (entry?.deny) return sftp.status(reqID, 3, 'Permission denied');
      if (entry && entry.type !== 'file') return sftp.status(reqID, 4, 'Not a file');
      if (entry && (flags & OPEN_MODE.EXCL)) return sftp.status(reqID, 4, 'Already exists');
      if (!entry) {
        const parent = at(parentOf(resolved));
        if (!parent || parent.type !== 'dir') return sftp.status(reqID, 2, 'No such file');
        if (parent.deny) return sftp.status(reqID, 3, 'Permission denied');
        entry = { type: 'file', size: 0, mode: attrs?.mode ?? 0o644, mtime: 1700000500, atime: 1700000500, content: Buffer.alloc(0) };
        tree.set(resolved, entry);
      }
      if (flags & OPEN_MODE.TRUNC) {
        entry.content = Buffer.alloc(0);
        entry.size = 0;
      }
      if (!Buffer.isBuffer(entry.content)) entry.content = Buffer.from(entry.content || '');
      const handle = Buffer.alloc(4);
      handle.writeUInt32BE(nextHandle++, 0);
      handles.set(handle.toString('hex'), { path: resolved, entry, file: true, write: true });
      return sftp.handle(reqID, handle);
    }
    if (!entry) return sftp.status(reqID, 2, 'No such file');
    if (entry.deny) return sftp.status(reqID, 3, 'Permission denied');
    if (entry.type !== 'file') return sftp.status(reqID, 4, 'Not a file');
    const handle = Buffer.alloc(4);
    handle.writeUInt32BE(nextHandle++, 0);
    const content = Buffer.isBuffer(entry.content) ? entry.content : Buffer.from(entry.content || '');
    handles.set(handle.toString('hex'), { path: resolved, content, file: true });
    sftp.handle(reqID, handle);
  });

  sftp.on('READ', (reqID, handle, offset, length) => {
    if (takeFailure(hooks, 'failNextRead')) return sftp.status(reqID, 4, 'Failure');
    const found = handles.get(handle.toString('hex'));
    if (!found?.file || found.write) return sftp.status(reqID, 4, 'Invalid handle');
    const start = Number(offset);
    const bytes = Number(length);
    if (start >= found.content.length) return sftp.status(reqID, 1, 'End of file');
    const slice = found.content.subarray(start, Math.min(found.content.length, start + bytes));
    events.sftp.readBytes[found.path] = (events.sftp.readBytes[found.path] || 0) + slice.length;
    events.sftp.readLengths.push(slice.length);
    later(() => sftp.data(reqID, slice));
  });

  sftp.on('WRITE', (reqID, handle, offset, data) => {
    if (takeFailure(hooks, 'failNextWrite')) return sftp.status(reqID, 4, 'Failure');
    const found = handles.get(handle.toString('hex'));
    if (!found?.write) return sftp.status(reqID, 4, 'Invalid handle');
    const start = Number(offset);
    const chunk = Buffer.from(data);
    const end = start + chunk.length;
    if (found.entry.content.length < end) {
      const grown = Buffer.alloc(end);
      found.entry.content.copy(grown);
      found.entry.content = grown;
    }
    chunk.copy(found.entry.content, start);
    found.entry.size = Math.max(found.entry.size || 0, end);
    events.sftp.writeBytes[found.path] = (events.sftp.writeBytes[found.path] || 0) + chunk.length;
    events.sftp.writeLengths.push(chunk.length);
    later(() => sftp.status(reqID, 0, 'OK'));
  });

  sftp.on('CLOSE', (reqID, handle) => {
    handles.delete(handle.toString('hex'));
    sftp.status(reqID, 0, 'OK');
  });

  sftp.on('LSTAT', (reqID, path) => {
    if (takeFailure(hooks, 'failNextLstat')) return sftp.status(reqID, 4, 'Failure');
    const entry = at(normalizePath(path));
    if (!entry) return sftp.status(reqID, 2, 'No such file');
    sftp.attrs(reqID, attrsOf(entry));
  });

  sftp.on('STAT', (reqID, path) => {
    let entry = at(normalizePath(path));
    if (entry && entry.type === 'symlink') entry = at(normalizePath(entry.target));
    if (!entry) return sftp.status(reqID, 2, 'No such file');
    sftp.attrs(reqID, attrsOf(entry));
  });

  sftp.on('REMOVE', (reqID, path) => {
    const resolved = normalizePath(path);
    const entry = at(resolved);
    if (!entry) return sftp.status(reqID, 2, 'No such file');
    if (entry.deny || at(parentOf(resolved))?.deny) return sftp.status(reqID, 3, 'Permission denied');
    if (entry.type === 'dir') return sftp.status(reqID, 4, 'Not a file');
    tree.delete(resolved);
    events.sftp.removes.push(resolved);
    sftp.status(reqID, 0, 'OK');
  });

  sftp.on('SETSTAT', (reqID, path, attrs = {}) => {
    const entry = at(normalizePath(path));
    if (!entry) return sftp.status(reqID, 2, 'No such file');
    if (attrs.mode !== undefined) entry.mode = attrs.mode & 0o7777;
    events.sftp.chmods.push({ path: normalizePath(path), mode: attrs.mode & 0o7777 });
    sftp.status(reqID, 0, 'OK');
  });

  sftp.on('MKDIR', (reqID, path, attrs = {}) => {
    const resolved = normalizePath(path);
    events.sftp.mkdirs.push(resolved);
    const parent = at(parentOf(resolved));
    if (parent?.deny) return sftp.status(reqID, 3, 'Permission denied');
    if (!parent || parent.type !== 'dir') return sftp.status(reqID, 2, 'No such directory');
    if (at(resolved)) return sftp.status(reqID, 4, 'Already exists');
    later(() => {
      tree.set(resolved, { type: 'dir', mode: attrs?.mode ?? 0o755 });
      sftp.status(reqID, 0, 'OK');
    });
  });

  sftp.on('RENAME', (reqID, source, destination) => {
    source = normalizePath(source); destination = normalizePath(destination);
    events.sftp.renames.push({ source, destination });
    const item = at(source), parent = at(parentOf(destination));
    if (!item) return sftp.status(reqID, 2, 'No such file');
    if (item.deny || at(parentOf(source))?.deny || parent?.deny) return sftp.status(reqID, 3, 'Permission denied');
    if (!parent || parent.type !== 'dir') return sftp.status(reqID, 2, 'No such directory');
    if (at(destination) || destination.startsWith(source+'/')) return sftp.status(reqID, 4, 'Invalid destination');
    later(() => {
      for (const key of [...tree.keys()]) if (key === source || key.startsWith(source+'/')) {
        tree.set(destination+key.slice(source.length), tree.get(key)); tree.delete(key);
      }
      sftp.status(reqID, 0, 'OK');
    });
  });

  sftp.on('RMDIR', (reqID, path) => {
    const resolved = normalizePath(path), item = at(resolved);
    if (!item) return sftp.status(reqID, 2, 'No such directory');
    if (item.deny || at(parentOf(resolved))?.deny) return sftp.status(reqID, 3, 'Permission denied');
    if (item.type !== 'dir' || childrenOf(resolved).length) return sftp.status(reqID, 4, 'Directory is not empty');
    tree.delete(resolved); events.sftp.rmdirs.push(resolved);
    sftp.status(reqID, 0, 'OK');
  });
}

/**
 * A minimal SSH server for tests: password auth, a PTY, and a "shell" that echoes each line back.
 * With `keyboardInteractive: true` only keyboard-interactive auth is offered, like servers that
 * disable password auth in favor of PAM. Also serves a small fixed SFTP tree.
 * persistTree, rejectSftp, and the failNext* flags default off.
 */
// SAA-330: ssh2 1.17.0's generateKeyPairSync('ed25519') strips every leading
// 0x00 byte from the public key (it means to drop only the BIT STRING
// unused-bits byte). About 1 key in 256 starts with 0x00, gets written as a
// 31-byte key, and ssh2 then rejects it with "Malformed OpenSSH private key".
// Only hand out keys that ssh2 itself can parse back with a 32-byte public key.
export function generateTestHostKey({ maxAttempts = 16, generate = () => utils.generateKeyPairSync('ed25519') } = {}) {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const keys = generate();
    const parsed = utils.parseKey(keys.private);
    if (parsed instanceof Error || Array.isArray(parsed)) continue;
    const pub = parsed.getPublicSSH();
    // ssh-ed25519 public blob: string "ssh-ed25519" (4+11) + string key (4+32).
    if (!pub || pub.length !== 51) continue;
    return keys;
  }
  throw new Error(`generateTestHostKey: no valid ed25519 key after ${maxAttempts} attempts`);
}

export function startFakeSshServer({
  username = 'tester',
  password = 'correct horse',
  hostKey,
  keyboardInteractive = false,
  lagMs = 0,
  readdirDelayMs = 0,
  sftpEntries = [],
  onSftpTree,
  // (info, accept, reject) for direct-tcpip channels (ssh -L / forwardOut). Without
  // it every forward is refused, like a server with AllowTcpForwarding no.
  onTcpip,
  // (command, accept, reject) for exec requests. Without it every exec is refused.
  onExec,
  persistTree = false,
  rejectSftp = false,
  failNextRead = false,
  failNextWrite = false,
  failNextLstat = false,
  port = 0,
  listenHost = '127.0.0.1',
} = {}) {
  const keys = hostKey || generateTestHostKey();
  const events = {
    lagMs,
    readdirDelayMs,
    ptys: [],
    resizes: [],
    passwordsTried: 0,
    keyboardTried: 0,
    sftp: { sessions: 0, opendirPaths: [], opens: [], readBytes: {}, readLengths: [], writeBytes: {}, writeLengths: [], removes: [], mkdirs: [], renames: [], rmdirs: [], chmods: [] },
    execs: [],
  };
  const clients = new Set();
  const sftpStreams = new Set();
  const hooks = { failNextRead, failNextWrite, failNextLstat };
  // Omitted persistTree keeps a fresh tree per SFTP session, including sftpEntries.
  let sharedTree = null;
  const treeForSession = () => {
    if (!persistTree) return freshTree(sftpEntries);
    if (!sharedTree) sharedTree = freshTree(sftpEntries);
    return sharedTree;
  };

  const server = new Server({ hostKeys: [keys.private] }, (client) => {
    clients.add(client);
    // Like a real sshd, answer each small SFTP request at once. With Nagle on both ends,
    // every lstat round trip waits on a delayed ACK and a 1,000-item delete preflight
    // takes longer than the 30s operation timeout.
    client.setNoDelay(true);
    client.on('close', () => clients.delete(client));

    client.on('authentication', (ctx) => {
      if (keyboardInteractive) {
        if (ctx.method !== 'keyboard-interactive') return ctx.reject(['keyboard-interactive']);
        events.keyboardTried += 1;
        return ctx.prompt([{ prompt: 'Password: ', echo: false }], (responses) => {
          if (ctx.username === username && responses[0] === password) return ctx.accept();
          ctx.reject(['keyboard-interactive']);
        });
      }
      if (ctx.method === 'password') {
        events.passwordsTried += 1;
        if (ctx.username === username && ctx.password === password) return ctx.accept();
      }
      ctx.reject(['password']);
    });

    client.on('ready', () => {
      client.on('tcpip', (accept, reject, info) => {
        events.tcpip = events.tcpip || [];
        events.tcpip.push({ destIP: info.destIP, destPort: info.destPort });
        if (!onTcpip) return reject();
        onTcpip(info, accept, reject);
      });
      client.on('session', (acceptSession) => {
        const session = acceptSession();
        session.on('sftp', (accept, reject) => {
          if (rejectSftp) {
            reject();
            return;
          }
          events.sftp.sessions += 1;
          const stream = accept();
          if (!stream) return;
          sftpStreams.add(stream);
          stream.on('close', () => sftpStreams.delete(stream));
          wireSftp(stream, events, treeForSession(), hooks, onSftpTree);
        });
        session.on('exec', (accept, reject, info) => {
          events.execs.push(info.command);
          if (!onExec) return reject();
          onExec(info.command, accept, reject);
        });
        session.on('pty', (accept, _reject, info) => {
          events.ptys.push({ term: info.term, cols: info.cols, rows: info.rows });
          accept?.();
        });
        session.on('window-change', (accept, _reject, info) => {
          events.resizes.push({ cols: info.cols, rows: info.rows });
          accept?.();
        });
        session.on('shell', (accept) => {
          const stream = accept();
          let line = '';
          stream.write('fake-shell $ ');
          stream.on('data', (chunk) => {
            for (const char of chunk.toString('utf8')) {
              if (char === '\r') {
                if (line === 'exit') {
                  stream.write('\r\nbye\r\n');
                  stream.exit(0);
                  stream.end();
                  return;
                }
                stream.write(`\r\nyou typed: ${line}\r\nfake-shell $ `);
                line = '';
              } else {
                line += char;
                stream.write(char);
              }
            }
          });
        });
      });
    });

    client.on('error', () => {});
  });

  return new Promise((resolve) => {
    server.listen(port, listenHost, () => {
      const publicBlob = utils.parseKey(keys.public).getPublicSSH();
      resolve({
        port: server.address().port,
        keys,
        publicBlob,
        events,
        // Simulates the server dropping every connection (restart, crash, OOM kill).
        closeClients: () => { for (const client of clients) client.end(); },
        clientCount: () => clients.size,
        // Closes the SFTP channel only. The SSH connection stays up until the client drops it.
        endSftp: () => { for (const stream of [...sftpStreams]) stream.end(); },
        get failNextRead() { return hooks.failNextRead; },
        set failNextRead(value) { hooks.failNextRead = Boolean(value); },
        get failNextWrite() { return hooks.failNextWrite; },
        set failNextWrite(value) { hooks.failNextWrite = Boolean(value); },
        get failNextLstat() { return hooks.failNextLstat; },
        set failNextLstat(value) { hooks.failNextLstat = Boolean(value); },
        // End clients first so a failing test that left terminals open can't hang teardown.
        close: () => new Promise((done) => {
          for (const client of clients) client.end();
          server.close(() => done());
          setTimeout(done, 2000).unref();
        }),
      });
    });
  });
}
