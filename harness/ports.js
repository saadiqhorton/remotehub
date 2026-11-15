// Port picking for the test harness (SAA-348). Pure Node, works on Linux, macOS and Windows.
// The harness only binds 127.0.0.1 on ports the OS hands out (listen on port 0), so it
// never guesses or probes a port. An optional, gitignored .harness.local.json can list
// extra ports this computer must never use, e.g. {"blockedPorts": [3389, "5902-5914"]}.
import fs from 'node:fs';
import net from 'node:net';

export function parseBlocklist(json) {
  const blocked = new Set();
  for (const item of json?.blockedPorts ?? []) {
    const m = /^(\d+)(?:-(\d+))?$/.exec(String(item).trim());
    if (!m) throw new Error(`Bad entry "${item}" in blockedPorts (use 3389 or "5902-5914").`);
    const lo = Number(m[1]); const hi = Number(m[2] ?? m[1]);
    for (let p = lo; p <= hi; p++) blocked.add(p);
  }
  return blocked;
}

export function loadBlocklist(file) {
  if (!file || !fs.existsSync(file)) return new Set();
  return parseBlocklist(JSON.parse(fs.readFileSync(file, 'utf8')));
}

function osPort(host) {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen({ port: 0, host }, () => { const p = srv.address().port; srv.close(() => resolve(p)); });
  });
}

// Returns an OS-assigned free port that is not blocked and not already handed out.
export async function pickFreePort({ taken = new Set(), blocked = new Set(), attempts = 50, host = '127.0.0.1', bind = () => osPort(host) } = {}) {
  for (let i = 0; i < attempts; i++) {
    const port = await bind();
    if (blocked.has(port) || taken.has(port)) continue;
    taken.add(port);
    return port;
  }
  throw new Error('Could not find a free port.');
}
