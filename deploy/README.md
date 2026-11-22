# Deploy RemoteHub behind a public domain

## One-command Docker Compose deployment (hosting computer)

Install Docker Engine with the Compose plugin on the **computer that hosts RemoteHub**.
Docker is not needed on any SSH, SFTP, RDP, or VNC target.

Deploy only from the canonical checkout on a clean, up-to-date `main` branch. The
production command checks the branch, working tree, and `origin/main` commit before
it can change the running stack. Compose uses the fixed `remote-hub` project name so
a checkout in another worktree cannot silently start a second stack against the same
published port.

After updating that checkout with `git switch main && git pull --ff-only origin main`,
start or update the RemoteHub server and its compatible guacd build with:

```sh
bash deploy/production.sh
```

Open <http://127.0.0.1:8090>. On the first run, RemoteHub prints a one-time setup code;
retrieve it with `docker compose logs remotehub` and use it to create the owner account.
The server and guacd health checks must both report `healthy` (`docker compose ps`).
The first startup builds the pinned Apache guacd source and can take several minutes.

The default host binding is `127.0.0.1:8090`, suitable for the local HTTP quick start or a
reverse proxy on the same computer. Set `REMOTEHUB_PORT` to change the host port. The local
HTTP default leaves the session cookie's Secure flag off so browsers can complete setup
and log in; the port is loopback-only by default. For HTTPS terminated at a reverse proxy,
set `SESSION_COOKIE_SECURE=true` in `.env`. The proxy must preserve the public `Host` header.
Never set `REMOTEHUB_BIND_ADDRESS=0.0.0.0` for direct HTTP access. Use a non-loopback bind
only behind a TLS-terminating reverse proxy, firewall the published port so only that proxy
can reach it, and set `SESSION_COOKIE_SECURE=true` in `.env`.
Compose ignores all `X-Forwarded-*` headers because Docker forwarding can make proxy and
direct clients share a source address. If a proxy rewrites Host, add the public origin to
`ALLOWED_ORIGINS` in `.env`. Forwarded client IPs are intentionally not used for
rate-limiting in this deployment; clients that arrive through the published-port gateway
share its address for rate limits.

Keep the published port loopback-only for a same-computer proxy. The stock Compose config
pins `TRUST_PROXY=false`: forwarded protocol, host, and client-IP headers are untrusted on
this published port, even when it is bound to `0.0.0.0`. Keep that setting when exposing
the service through a proxy on another computer, and firewall the published port to that proxy.
Set `SESSION_COOKIE_SECURE=true` when TLS terminates at the proxy. The proxy must preserve
the public `Host` header or you must set `ALLOWED_ORIGINS`; rate limits use the address
visible to the container rather than forwarded client-IP headers.

RemoteHub and guacd share a Compose-only bridge network. Compose does not publish guacd's
port on the host; only RemoteHub uses the service name `guacd`. The bridge allows guacd to
make outbound connections to the authorized RDP/VNC targets. Do not add a `ports` mapping
for guacd or route its port through a reverse proxy. SSH Terminal and SFTP Files continue
to connect directly from RemoteHub to target machines.

Application state (owner account, saved hosts, and trusted host keys) lives in the named
`remotehub-data` volume and survives container rebuilds and `docker compose down`. Back up
that volume before moving the host. `docker compose down -v` deletes the volume and all
saved state.

### Agent builds (one-click install on target computers)

"Install agent on this computer" uploads an agent build to the target over SSH and starts it
as a per-user service. The server picks the build by the target's OS and architecture, so the
folder it reads must hold `remotehub-agent-<os>-<arch>` files.

Build them on the host with Docker (no Rust toolchain needed):

```sh
npm run build-agent                     # all supported targets into agent-build/
npm run build-agent -- --target linux-x86_64
```

The supported names are `linux-x86_64`, `linux-aarch64`, `macos-x86_64`, and `macos-aarch64`.
Compose mounts `./agent-build` read-only at `/app/agent-build` and points `HELPER_DIR` there.
The owner can also run the agent by hand: "Create agent key" shows a ready-made command.

For logs and shutdown, use `docker compose logs -f` and `docker compose down`.
The default setup requires no `.env` file. Optional Compose values can be set in a local
`.env`; never commit it.

### Follow-on sequence

1. Prove this deployment with real SSH Terminal and SFTP Files, plus VNC and RDP when test
   targets are available. Report each protocol only with its actual runtime evidence.
2. RDP resize refusal (SAA-352) recovers automatically per tab; see deploy/guacd.md. Real
   Windows resizing still needs its own acceptance run on a Windows target.
3. After Milestone 1 has passed, evaluate replacing only the Desktop protocol/rendering
   implementation with Apache's official Guacamole JavaScript client. Keep the RemoteHub
   interface, authorization flow, SSH Terminal, and SFTP Files.
4. After that work, evaluate optional agent-first pairing for Windows, macOS, and Linux.
   Docker remains a hosting-computer option and is never a target-computer requirement.

RemoteHub is ready for a reverse proxy out of the box. HTTPS and certificates live on
the proxy; this app speaks plain HTTP on `127.0.0.1:8090`.

## Checklist (same machine — recommended)

1. **DNS** — create an `A` (or `AAAA`) record for your hostname pointing at the public IP of this machine (or your router).
2. **Firewall / router** — forward **80** and **443** to this machine. Do **not** expose port **8090** to the internet.
3. **RemoteHub `.env`** (defaults are already correct for this layout):

   ```env
   HOST=127.0.0.1
   PORT=8090
   TRUST_PROXY=loopback
   ```

   This block applies to the non-Compose `npm start` setup below. Compose instead ignores
   forwarded headers and sets session cookies Secure independently of them.

4. **Proxy config** — pick one:
   - **Caddy:** copy [`Caddyfile`](Caddyfile), change `remotehub.example.com` to your domain, reload Caddy.
   - **nginx:** copy [`nginx.conf`](nginx.conf), replace `YOUR_DOMAIN`, enable TLS certs, reload nginx.
5. **Start RemoteHub** — `npm start` on this machine.
6. Open `https://your-domain` and log in.

Caddy obtains certificates automatically when ports 80/443 are reachable
([Caddy reverse_proxy](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy)).
nginx needs certs configured (or certbot).

## Proxy on a different machine

On the RemoteHub host:

```env
HOST=0.0.0.0
PORT=8090
TRUST_PROXY=192.168.1.10
```

Set `TRUST_PROXY` to the proxy’s IP (Express [trust proxy](https://expressjs.com/en/guide/behind-proxies.html) syntax).
Allow **8090** only from that proxy IP. Point the proxy’s upstream at
`http://<remotehub-lan-ip>:8090` instead of `127.0.0.1:8090`.

You normally do **not** need `ALLOWED_ORIGINS` — RemoteHub accepts requests whose
`Origin` matches the `Host` / `X-Forwarded-Host` the proxy sends.

## Desktop (optional, non-Compose setup)

Desktop sessions need the guacd sidecar. See [`guacd.md`](guacd.md). Without it the terminal deployment above is unchanged. Never route guacd's port through the proxy.


### Remote MCP OAuth

Set `MCP_PUBLIC_URL` in the host `.env` file to the exact public HTTPS origin (scheme and hostname,
no path). Docker Compose passes it to RemoteHub. Set `MCP_ALLOWED_ORIGINS` to the exact comma-separated
browser origins permitted to send an `Origin` header to `/mcp`; any supplied origin not in this list
is rejected. Requests without an `Origin` header are allowed for server-to-server clients. The
`/oauth/*` pages accept the `MCP_PUBLIC_URL` origin itself (browsers navigating there) plus the
public `Host` / trusted `X-Forwarded-Host`, so no extra origin list is needed for them. The reverse
proxy must forward `/mcp`, `/oauth/*`, and `/.well-known/*` without rewriting paths.

Run one RemoteHub server process per data directory. OAuth client registrations, grants,
authorization-code records, and token records are persisted in the local `mcp-oauth.json` file.
Pending consent requests, MCP sessions, connected agent sockets, and rate-limit state are in
process memory. Processes do not coordinate writes to that file or share their in-memory
state. Do not mount one RemoteHub data volume or OAuth JSON file into multiple server replicas.

MCP sessions expire after eight hours and end on server restart. Tool calls are limited to 30 per token
and 300 per OAuth client per minute; excess calls return HTTP 429 with `Retry-After`. Password fallback
is throttled at five failed attempts per source IP in 15 minutes, followed by a ten-minute lockout.
There is also an aggregate five-failure counter across all IPs in each process; reaching it pauses all
password fallback for 60 seconds, even for a correct password. A successful password clears that
aggregate count. Both throttles use bounded process-local memory and reset on restart. The aggregate
counter is not shared between server processes. The tool-call limiter fails closed at capacity without
evicting active counters.

Agent file reads, writes, and listings use cap-std directory capabilities rooted at the configured
agent directory. Path traversal and symlink targets outside that root are denied; symlinks resolving
within the root remain allowed. The configured root path itself must be controlled by the operator.

#### Client availability and reachability

- **ChatGPT:** Custom MCP servers and full MCP support are available on Business and Enterprise/Edu
  on the web. Use a public HTTPS MCP endpoint or OpenAI Secure MCP Tunnel for a private deployment.
  Pro supports custom MCP with read/fetch permissions. See [OpenAI's connection guide](https://help.openai.com/en/articles/12584461-connecting-custom-mcp-servers-in-chatgpt).
- **Claude:** Remote MCP connectors are available on Free, Pro, Max, Ultra, Team, and Enterprise.
  Claude connects from Anthropic's cloud, so the server must be reachable from the public internet and
  Anthropic's published IP ranges must be allowed. See [Anthropic's network requirements](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp).
- **Cursor:** Cursor documents remote Streamable HTTP MCP with OAuth. Cursor-hosted Cloud Agents connect
  to HTTP MCP servers from Cursor's backend, so that endpoint must be reachable there. See the
  [Cursor MCP guide](https://cursor.com/docs/mcp) and [Cloud Agent network notes](https://cursor.com/docs/cloud-agent/self-hosted/my-machines).

Command execution is opt-in: set `MCP_COMMANDS_ENABLED=true` to expose `remotehub.commands.run` for connected agents that advertise `exec.run`. Each OAuth grant must separately include `commands:exec` and select the target host. The agent passes an executable and argv directly (no command-string parsing), limits arguments to 64 items and 64 KiB combined, stdin to 64 KiB, execution to 300 seconds, and captured output to bounded/truncated stdout and stderr. Only Windows agent builds currently advertise this command capability. The agent uses a Job Object, terminates the job on timeout, and waits for every job process before joining output readers. Unix agents fail closed because detached descendants can keep inherited pipes open indefinitely.

Commands run as the agent service account with its inherited environment and operating-system privileges. The configured filesystem root only becomes the command working directory; it is not a sandbox and does not confine files, network, or child processes. Passing a shell executable and shell arguments remains powerful. Treat `commands:exec` as host-level command authority, not containment for untrusted commands. Unix agents do not advertise or execute this capability.

Windows Job Object cleanup cannot contain work deliberately launched through an external broker such as WMI: broker-launched processes are outside the agent's job. The agent account retains its full operating-system authority, so command execution is not a security boundary.

OAuth client registrations expire after 90 days and can be removed by the owner at `/oauth/manage`, which also lists and revokes grants. Clients can revoke tokens through the RFC 7009-compatible `POST /oauth/revoke` endpoint; public clients identify themselves with their registered `client_id` and may only revoke tokens issued to that client.
