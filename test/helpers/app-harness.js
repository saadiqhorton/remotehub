import fs from 'node:fs/promises';
import { rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { createServer } from '../../server/app.js';

/**
 * Shared harness for regression tests: a real RemoteHub server on an ephemeral port with a
 * throwaway data dir, a cookie-jar HTTP client, and a terminal WebSocket client.
 * (e2e.test.js keeps its own inline copies; this module is for the newer regression suites.)
 */

// Every data dir lives under the OS temp dir and is removed by stop(); any a test forgets to
// stop are removed when the test process exits, so a run never leaves files behind.
const liveDataDirs = new Set();
process.once('exit', () => { for (const dir of liveDataDirs) rmSync(dir, { recursive: true, force: true }); });

/** A local port that is free right now (listened on, then closed). */
export async function closedPort() {
  const net = await import('node:net');
  return new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
}

export async function startTestApp(configOverrides = {}, { log = () => {} } = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'remotehub-test-'));
  liveDataDirs.add(dataDir);
  // SAA-306: desktop discovery must never probe the real 3389/5900 in tests (on shared boxes
  // those belong to other users' desktops): default discovery ports are closed local ports.
  const discoveryDefaultPorts = { rdp: await closedPort(), vnc: await closedPort() };
  const app = await createServer(
    {
      dataDir,
      discoveryDefaultPorts,
      trustProxy: 'loopback',
      allowedOrigins: [],
      sessionTtlMs: 60_000,
      maxTerminals: 8,
      maxFiles: 8,
      maxAgents: 8,
      ...configOverrides,
    },
    { log },
  );
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  return {
    app,
    dataDir,
    base,
    origin: base,
    async stop() {
      app.closeTerminals();
      app.closeFiles();
      app.closeDesktops?.();
      app.closeAgents?.();
      // SAA-338: server.close() waits for every open connection, with no limit. A socket that
      // never finishes closing would hang teardown (and the whole npm test run) forever.
      // Give connections a short grace period, then force them closed.
      const force = setTimeout(() => app.server.closeAllConnections(), 2000);
      force.unref();
      await new Promise((resolve) => app.server.close(resolve));
      clearTimeout(force);
      await fs.rm(dataDir, { recursive: true, force: true });
      liveDataDirs.delete(dataDir);
    },
  };
}

// Minimal fetch wrapper with a cookie jar, mirroring how the browser client behaves.
export function httpClient(base, origin) {
  const jar = { cookie: '' };
  const request = async (pathname, { method = 'GET', body, headers = {} } = {}) => {
    const response = await fetch(`${base}${pathname}`, {
      method,
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(jar.cookie ? { Cookie: jar.cookie } : {}),
        Origin: origin,
        ...headers,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) jar.cookie = setCookie.split(';')[0];
    return { status: response.status, body: await response.json().catch(() => null) };
  };
  return {
    request,
    get cookie() { return jar.cookie; },
    set cookie(value) { jar.cookie = value; },
    // The raw session token, for tests that drive Sessions directly.
    sessionToken() {
      const match = /(?:^|;\s*)rh_session=([^;]*)/.exec(jar.cookie);
      return match ? match[1] : null;
    },
  };
}

// Opens a WebSocket and collects control messages (JSON text frames) and output (binary).
export function openWs(base, pathname, { headers } = {}) {
  const ws = new WebSocket(`${base.replace('http', 'ws')}${pathname}`, { headers });
  const control = [];
  const binaries = [];
  let output = '';
  const waiters = [];
  const check = () => {
    for (const waiter of [...waiters]) {
      if (waiter.predicate()) {
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve();
      }
    }
  };
  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      const buf = Buffer.isBuffer(data) ? Buffer.from(data) : Buffer.from(data);
      binaries.push(buf);
      output += buf.toString('utf8');
    } else control.push(JSON.parse(data.toString('utf8')));
    check();
  });
  ws.on('close', check);
  const until = (predicate, label, ms = 8000) =>
    new Promise((resolve, reject) => {
      // Poll too: some conditions (e.g. fake-server events) change without a socket message.
      const poll = setInterval(check, 20);
      const timer = setTimeout(() => {
        clearInterval(poll);
        reject(new Error(`Timed out waiting for ${label}. Control: ${JSON.stringify(control)} Output: ${JSON.stringify(output)}`));
      }, ms);
      waiters.push({ predicate, resolve: () => { clearTimeout(timer); clearInterval(poll); resolve(); } });
      check();
    });
  return {
    ws,
    control,
    binaries,
    get output() { return output; },
    // Bounded like the other waits (SAA-338): an upgrade that never answers must fail, not hang.
    opened: new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timed out waiting for the socket to open.')), 8000);
      timer.unref();
      ws.once('open', () => { clearTimeout(timer); resolve(); });
      ws.once('unexpected-response', (_req, res) => clearTimeout(timer) || reject(Object.assign(new Error('rejected'), { status: res.statusCode })));
      ws.once('error', (err) => { clearTimeout(timer); reject(err); });
    }),
    send: (message) => ws.send(JSON.stringify(message)),
    sendRaw: (data) => ws.send(data),
    until,
    untilControl: (predicate, label) => until(() => control.some(predicate), label),
    untilOutput: (text) => until(() => output.includes(text), `output "${text}"`),
    closed: () => until(() => ws.readyState === WebSocket.CLOSED, 'socket close'),
    // Bounded wait for the close code: regressions must fail, not hang the suite.
    closedWithCode: (ms = 8000) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timed out waiting for the socket to close.')), ms);
      ws.once('close', (code) => { clearTimeout(timer); resolve(code); });
    }),
  };
}

// Opens a terminal socket and collects control messages (JSON text frames) and output (binary).
export function openTerminal(base, { headers } = {}) {
  return openWs(base, '/ws/terminal', { headers });
}

// Opens a file (SFTP) socket with the same collector shape as openTerminal.
export function openFiles(base, { headers } = {}) {
  return openWs(base, '/ws/files', { headers });
}

export function openDesktop(base, query = '', { headers } = {}) {
  return openWs(base, `/ws/desktop${query}`, { headers });
}

export function openAgent(base, { headers } = {}) {
  return openWs(base, '/ws/agent', { headers });
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// A port that is (almost certainly) not accepting connections, for network-error tests.
/** Pick a TCP port that nothing is accepting. Settles briefly after close (WSL can still accept for a few ms). */
export async function unusedPort() {
  const { default: net } = await import('node:net');
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  await new Promise((resolve) => setTimeout(resolve, 25));
  return port;
}
