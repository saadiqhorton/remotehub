import os from 'node:os';
import path from 'node:path';
import { config } from './config.js';
import { createServer } from './app.js';

const log = (message) => console.log(`[${new Date().toISOString()}] ${message}`);

function lanAddresses() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((iface) => iface && iface.family === 'IPv4' && !iface.internal)
    .map((iface) => iface.address);
}

const remotehub = await createServer(config, { log });

remotehub.server.listen(config.port, config.host, () => {
  const urls =
    config.host === '0.0.0.0' || config.host === '::'
      ? ['127.0.0.1', ...lanAddresses()].map((ip) => `http://${ip}:${config.port}`)
      : [`http://${config.host}:${config.port}`];

  log(`RemoteHub listening on ${urls.join(', ')}`);
  if (config.guacd.enabled) {
    remotehub.guacd.check().then((health) => log(`desktop: guacd ${health.status} at ${health.host}:${health.port} (${health.protocol}): ${health.message}`));
  }
  if (config.host === '127.0.0.1' || config.host === 'localhost') {
    log('Only reachable from this machine. Point your reverse proxy here, or set HOST=0.0.0.0.');
  }
  if (remotehub.setupCode) {
    console.log('');
    console.log('  ┌──────────────────────────────────────────┐');
    console.log(`  │  First-run setup code:  ${remotehub.setupCode}        │`);
    console.log('  │  Enter it in the browser to create your  │');
    console.log('  │  owner password.                         │');
    console.log('  └──────────────────────────────────────────┘');
    console.log(`  Also saved to ${path.join(config.dataDir, 'SETUP-CODE.txt')}`);
    console.log('');
  }
});

remotehub.server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${config.port} is already in use. Set PORT to another value.`);
  } else {
    console.error(err);
  }
  process.exit(1);
});

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`${signal} received, closing sessions`);
  remotehub.closeTerminals();
  remotehub.closeFiles();
  remotehub.closeDesktops();
  remotehub.closeAgents();
  remotehub.server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
