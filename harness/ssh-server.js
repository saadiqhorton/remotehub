// Harness SSH test server: the project's own test SSH server (Node, no system sshd needed)
// on a given port. The password comes from the environment, never argv, so ps can't show it.
import { startFakeSshServer } from '../test/helpers/fake-ssh-server.js';

const port = Number(process.argv[2]);
const password = process.env.HARNESS_SSH_PASSWORD;
delete process.env.HARNESS_SSH_PASSWORD;
const host = process.env.HARNESS_SSH_HOST || '127.0.0.1';
const server = await startFakeSshServer({ username: process.env.HARNESS_SSH_USER || 'tester', password, port, listenHost: host });
console.log(`ssh test server listening on ${host}:${server.port}`);
const stop = () => server.close().then(() => process.exit(0));
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
