# Security

## Reporting a vulnerability

Please report security issues privately through GitHub:
**Security → Report a vulnerability** on this repository. Do not open a public issue.

Include what you found, how to reproduce it, and which version or commit you tested. You will
get an acknowledgement, and a fix will be released before details are made public.

## Supported versions

Only the latest release receives security fixes.

## What RemoteHub protects, and what it does not

RemoteHub is a remote-access tool. Anyone who signs in as the owner can open terminals, read and
write files, and see desktops on every saved computer. Treat the owner password like a key to
all of them.

- **One owner account.** The owner password is stored only as a scrypt hash in `data/`.
- **SSH passwords are never stored.** They are held in memory for the login exchange only.
- **Host identity is pinned.** SSH host keys and RDP certificates are confirmed on first connect;
  later connections are refused if they change until the owner trusts the new identity.
- **Same-origin checks.** HTTP routes that change state and every WebSocket upgrade check the
  request's `Origin`.
- **MCP access is opt-in and scoped.** OAuth grants are bound to the computers and permissions
  the owner selects on the consent page. Command execution (`commands:exec`) is off unless the
  server sets `MCP_COMMANDS_ENABLED=true`, and is never a sandbox: commands run with the full
  privileges of the agent's account.

Deployment guidance:

- Serve RemoteHub over HTTPS only, behind a reverse proxy ([`deploy/README.md`](deploy/README.md)).
  Keep port 8090 reachable only from that proxy.
- Set `SESSION_COOKIE_SECURE=true` behind HTTPS.
- Back up and protect the `data/` directory (or the `remotehub-data` volume); it holds the owner
  hash, saved computers, trusted host keys, agent credentials, and OAuth grants.
- Run one server process per data directory.
