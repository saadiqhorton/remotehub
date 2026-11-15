# RemoteHub agent

Cross-platform Rust agent for RemoteHub. It is the optional companion to the Node
server: a small binary that can run as a **persistent** service on a host, or as a
**temporary** helper uploaded for a single session. One codebase, one control
protocol, two execution modes. Native desktop streaming is explicitly out of scope
for this milestone.

This crate is the foundation for the milestone tracked by SAA-280:

| Ticket | Follow-on work |
| --- | --- |
| SAA-295 | Formalize and extend the versioned control protocol |
| SAA-297 | Native filesystem watcher (`files.watch`) and true live file events |
| SAA-299 | Temporary helper deployment over SSH/SFTP |
| SAA-307 | Windows screen-capture prototype |

## Modes

The mode is chosen at launch; the code path is the same from there on.

- **persistent** — either connects **outbound** over `ws://` / `wss://` to
  RemoteHub (SAA-296) or binds a TCP listener (default `127.0.0.1:8377`) for
  local peers. Outbound mode authenticates with a host-scoped credential,
  reconnects after a drop, and exits if the credential is revoked. A `shutdown`
  request ends the process.
- **temporary** — speaks the same protocol over stdin/stdout and exits when the
  peer disconnects or sends `shutdown`. This is the shape SAA-299 will launch on an
  existing SSH channel.

Both modes report their version and mode at startup (a line on stderr) and on the
wire (the `hello` event below).

## Build

Requires a Rust toolchain. Outbound TLS (`wss://`) uses `rustls`, `ring`, and
`webpki-roots`; the control protocol and inbound TCP listener stay dependency-free.

```sh
cd agent
cargo build --release
# binary: target/release/remotehub-agent  (remotehub-agent.exe on Windows)
```

Run the tests (unit tests cover config, JSON, protocol, transport, capabilities,
files, and the request loop):

```sh
cd agent
cargo test --all
cargo clippy --all-targets   # optional
```

### Cross-platform builds

The agent targets Windows, macOS, and Linux. System sound uses target-specific
native backends (WASAPI loopback on Windows and ScreenCaptureKit on macOS); native
hosts need the Rust toolchain; macOS capture requires macOS 13 or later and
Screen Recording permission:

```sh
cargo build --release --target x86_64-pc-windows-msvc       # Windows
cargo build --release --target aarch64-apple-darwin         # macOS (Apple silicon)
cargo build --release --target x86_64-unknown-linux-gnu     # Linux
```

Install a target with `rustup target add <triple>` before cross-compiling, and note
that the MSVC target additionally needs the MSVC build tools.

`.github/workflows/ci.yml` runs Clippy and `cargo test` on `ubuntu-latest`,
`macos-latest`, and `windows-latest` for every pull request and push to `main`.

## Usage

```sh
# Persistent service connecting outbound to RemoteHub (preferred).
remotehub-agent --mode persistent \
  --server wss://remotehub.example \
  --host-id <host-id> \
  --token-file /etc/remotehub/agent.token

# Local inbound listener (loopback only; useful for protocol tests).
remotehub-agent --mode persistent

# Temporary helper reading/writing newline-delimited JSON on stdin/stdout.
remotehub-agent --mode temporary

remotehub-agent --help
remotehub-agent --version

# Per-user background service (see "Install as a background service" below).
remotehub-agent install --server wss://remotehub.example --host-id <host-id> --token-file ./agent.token
remotehub-agent service-status
remotehub-agent uninstall
```

| Flag | Environment | Default | Meaning |
| --- | --- | --- | --- |
| `--mode <persistent\|temporary>` | `REMOTEHUB_AGENT_MODE` | `persistent` | Execution mode |
| `--listen <ADDR>` | `REMOTEHUB_AGENT_LISTEN` | `127.0.0.1:8377` | Persistent-mode bind address |
| `--root <DIR>` | `REMOTEHUB_AGENT_ROOT` | `.` | Directory the agent may read |
| `--server <URL>` | `REMOTEHUB_AGENT_SERVER` | — | Outbound `ws://` or `wss://` URL |
| `--host-id <ID>` | `REMOTEHUB_AGENT_HOST_ID` | — | Saved host id to bind to |
| `--token <TOKEN>` | `REMOTEHUB_AGENT_TOKEN` | — | Host-scoped credential (prefer `--token-file`) |
| `--token-file <PATH>` | `REMOTEHUB_AGENT_TOKEN_FILE` | — | Read the credential from a file |
| `--tls-ca <PATH>` | `REMOTEHUB_AGENT_TLS_CA` | — | Extra CA for `wss://` |
| `--insecure` | `REMOTEHUB_AGENT_TLS_INSECURE` | off | Skip TLS verification (dev only) |

Flags override environment variables. `--root` confines every `fs.list` request to
that directory (see [Security](#security)).

Service subcommands. Each must be the first argument and is not a run-mode flag:

| Command | Flags | Meaning |
| --- | --- | --- |
| `install` | `--server <URL>` `--host-id <ID>` `--token-file <PATH>` `[--dry-run]` | Copy this binary and token into the per-user install location, define the service, and start it. `--dry-run` prints the plan and changes nothing. `--token` is refused: the credential comes only from a file. |
| `uninstall` | — | Stop and disable the service, then remove the files install created. Idempotent. |
| `service-status` | — | Show whether the service files exist and what the service manager reports. Read-only. |

## Protocol

Newline-delimited JSON: exactly one JSON value per line, in both directions. The
agent sends an unsolicited `hello` event as soon as a connection is ready, then
answers requests. `PROTOCOL_VERSION` is `1` and is bumped on any breaking change;
SAA-295 owns its evolution.

```text
agent -> {"event":"hello","protocol":1,"name":"remotehub-agent","version":"0.1.0",
          "mode":"persistent","capabilities":{...}}

peer  -> {"id":1,"op":"info"}
agent -> {"id":1,"ok":true,"result":{"os":"linux","arch":"x86_64",...}}

peer  -> {"id":2,"op":"fs.list","params":{"path":".","limit":100,"cursor":null}}
agent -> {"id":2,"ok":true,"result":{"entries":[...],"hasMore":true,"nextCursor":"last-name"}}

peer  -> {"id":3,"op":"shutdown"}
agent -> {"id":3,"ok":true,"result":{"stopping":true}}
```

The agent caps each serialized directory response at 900 KiB, below the 1 MiB outbound WebSocket
frame limit. Pages retain at most 257 candidate entries while scanning, and use `nextCursor` to
continue in name order. Legacy callers that omit pagination fields receive the first bounded page;
they should inspect `hasMore` and continue with `nextCursor`. The hello `operations` list advertises
`fs.list.page` when this contract is supported.

Current operations (SAA-295). Every request is decoded into a fixed, typed
`ClientMessage`; there is no generic command-string RPC. The separately gated `exec.run`
operation passes one executable and argv, and anything else is rejected with `unknown_op`.

| `op` | Params | Result |
| --- | --- | --- |
| `hello` | optional `{"protocol": N}` | `{"event":"authenticated","protocol":1,"mode":"..."}`, or `protocol_mismatch` if `N` differs |
| `ping` | — | `{"pong":true,"mode":"..."}` |
| `heartbeat` | — | `{"alive":true}` |
| `info` | — | OS, family, architecture, hostname, CPU count, version, mode |
| `capabilities` | — | The versioned host capability model |
| `fs.list` | `{"path":"...","cursor":"...","limit":N}`; path, cursor, and limit may be omitted | A name-sorted page with `entries`, `hasMore`, and `nextCursor`; default 100 entries, maximum 256 |
| `exec.run` | `{"executable":"...","args":[...],"stdin":"...","timeoutMs":N}` | Bounded exit status and stdout/stderr; advertised only on Windows builds with Job Object termination |
| `watchDirectory` | `{"path": "..."}` | `{"watchId":N,"path":"<absolute>"}`; non-recursive, confined to `--root` (`io_error` otherwise), at most 32 per connection (`limit_exceeded`) |
| `unwatchDirectory` | `{"watchId": N}` | `{"watchId":N,"stopped":true}`; `unknown_watch` if this connection has no such watch |
| `shutdownTemporary` | — | Stops a temporary helper; `wrong_mode` on a persistent service |
| `shutdown` | — | Acknowledges, then stops the agent (any mode) |
| `audio.start` | — | `{"mimetype":"audio/L16;rate=48000,channels=2"}`, then `audio` events; outbound connection only, advertised as `audio.capture` on Linux, macOS, and Windows; `unsupported` with the reason if no sound session runs |
| `audio.stop` | — | `{"stopped":true\|false}`; the recorder is stopped. Disconnecting stops it too |
| `desktopOffer`, `desktopAnswer`, `desktopIceCandidate`, `desktopClose` | — | Reserved: always `reserved` for now |

Unsolicited events carry `"event"` instead of `"id"`: `hello` on connect, and
`filesystemEvent` for each change in a watched directory (SAA-297):

```text
{"event":"filesystemEvent","watchId":1,"change":"rename","path":"/r/b","from":"/r/a"}
```

`change` is one of `create`, `delete`, `modify`, `rename`, `unavailable` (the
watched directory went away and the watch ended). Paths are absolute. A rename
whose other half is outside the watched directory is reported as `delete` or
`create`; repeated `modify` events for one path within 50 ms are coalesced. All
watches end when the connection closes.

Desktop sound (`audio.start`) streams `audio` events, each 20 ms of raw signed
16-bit little-endian stereo at 48 kHz, base64, and one `audioEnd` if the recorder
stops on its own:

```text
{"event":"audio","data":"<5120 base64 characters>"}
{"event":"audioEnd","reason":"pw-record stopped: ..."}
```

Capture uses the system output API for the signed-in user: `pw-record`/`parec` on
Linux, ScreenCaptureKit on macOS, and WASAPI loopback on Windows. macOS may prompt
for Screen Recording permission the first time; the agent must run in the user's
graphical session. On Windows it captures the default render device with no prompt.
At most 1 s of sound waits for the connection; older sound is dropped. RemoteHub
starts capture only while a Desktop tab listens (`server/desktop-sound.js`).
`REMOTEHUB_REAL_AUDIO=1 cargo test` checks real non-silent playback on supported hosts.

Errors are `{"ok":false,"error":{"code":...,"message":...}}` with a stable code:
`bad_request`, `unknown_op`, `invalid_params`, `protocol_mismatch`, `reserved`,
`unsupported`, `wrong_mode`, `io_error`, `unknown_watch`, `limit_exceeded`. The connection always stays open after an
error. `id` is echoed verbatim and is `null` when the request omitted it or the
frame could not be parsed.

The `capabilities` object mirrors `server/capabilities.js` exactly. The agent only
vouches for the surfaces it provides — it reports `terminal.ssh` and `files.sftp` as
false because those are SSH-transport features — so discovery (SAA-300) must merge
this report into the host record rather than replace it.

## Idle resource usage

The agent is built to sit idle cheaply:

- **No timers, no polling, no background threads.** Persistent mode blocks in
  `TcpListener::accept()` between connections, so an idle agent uses effectively no
  CPU. Temporary mode blocks reading its input line.
- **One connection at a time.** Handling is sequential; there is no thread or task
  spawned per connection, so no per-connection memory lingers.
- **A stripped release binary.** `[profile.release] strip = true` keeps the artifact
  small. Native audio dependencies are target-specific (ScreenCaptureKit on macOS and
  WASAPI on Windows); there is no audio runtime or thread pool to warm up when idle.

To measure on your own host:

```sh
# RSS and CPU of an idle persistent agent.
cargo build --release
/usr/bin/time -v ./target/release/remotehub-agent --mode persistent &
```

The design guarantees near-zero idle CPU; expect a small, single-digit-megabyte RSS
typical of a stripped `std`-only Rust binary. The numbers are host-dependent — treat
this paragraph as the expected shape, not a benchmark.

## Layout

```
agent/
├── Cargo.toml                     # workspace root
├── rust-toolchain.toml
└── crates/remotehub-agent/
    ├── Cargo.toml
    └── src/
        ├── main.rs                # binary entry: parse args, run lifecycle
        ├── lib.rs                 # module map and crate docs
        ├── config.rs              # flags, environment, Mode, usage text
        ├── protocol.rs            # versioned envelope, handshake, ops
        ├── transport.rs           # newline-delimited JSON framing (stdio / TCP)
        ├── capabilities.rs        # versioned host capability model (SAA-285)
        ├── files.rs               # listing + root confinement for the Files surface
        ├── system.rs              # OS / arch / hostname / CPU info
        ├── lifecycle.rs           # startup, request loop, shutdown, both modes
        ├── install.rs             # per-user service install, uninstall, status (SAA-317)
        ├── websocket.rs           # outbound ws:// and wss:// client (SAA-296)
        └── json.rs                # dependency-free JSON codec
```

## Install as a background service

`remotehub-agent install` makes the outbound agent start at logon, restart on failure, and
run as the signed-in user. It does not install a system service. The agent records the user's
desktop sound through that user's own session (their `XDG_RUNTIME_DIR`, their launchd GUI
session, their interactive logon). A system service or a Windows Service (session 0) cannot
reach that session.

```sh
remotehub-agent install --server wss://remotehub.example --host-id <host-id> --token-file ./agent.token
remotehub-agent install ... --dry-run    # print the files and commands; change nothing
remotehub-agent service-status
remotehub-agent uninstall
```

`install` copies the running executable and the token file into the per-user location, writes
the service definition, and starts it. The service runs
`<installed exe> --mode persistent --server <URL> --host-id <ID> --token-file <installed token>`.
The token is copied from the file you pass, never printed, and never placed in a command line or
a service definition.

| OS | Installed files | Service definition | Started by |
| --- | --- | --- | --- |
| Linux | `~/.local/share/remotehub/agent/` holds `remotehub-agent` and `agent.token` (0600) | `~/.config/systemd/user/remotehub-agent.service` (`WantedBy=default.target`, `Restart=on-failure`, `RestartPreventExitStatus=1 2`) | `systemctl --user daemon-reload`, then `enable --now` |
| macOS | `~/Library/Application Support/RemoteHub/agent/` holds `remotehub-agent` and `agent.token` (0600) | `~/Library/LaunchAgents/com.remotehub.agent.plist` (`RunAtLoad`, `KeepAlive` on a failed exit, `ThrottleInterval` 60) | `launchctl bootstrap gui/<uid>`, falling back to `launchctl load -w` |
| Windows | `%LOCALAPPDATA%\RemoteHub\agent\` holds `remotehub-agent.exe` and `agent.token` | Scheduled Task `RemoteHub Agent` (`ONLOGON`, `/RL LIMITED`) | `schtasks /Run` |

- **Restarts:** the agent retries network drops itself and exits only when RemoteHub refuses its
  credential (exit 1, for example after the credential is revoked) or its settings are invalid
  (exit 2). systemd does not restart those exits, so a revoked computer stops instead of retrying
  forever; it still restarts after a crash. launchd cannot filter by exit code, so on macOS a
  refused agent is retried at most once a minute. The Windows logon task starts the agent once
  per sign-in and does not restart it.
- **Check:** `service-status` reports whether each file exists and the service state from
  `systemctl --user is-active`, `launchctl print`, or `schtasks /Query`.
- **Upgrade:** run `install` again with the new binary. It stops the old instance, replaces the
  binary and token (written to a temporary file and renamed into place), and starts the new one.
- **Uninstall:** stops and disables the service, then removes the service definition,
  `agent.token`, the installed binary, and the `RemoteHub` agent directories if they are empty.
  It removes nothing else. Shared directories such as `~/.config/systemd/user` and
  `~/Library/LaunchAgents` are left in place, and so are any empty parent directories install
  created above them.
- **Linux:** needs a systemd user manager (`systemctl --user` must work in the user's session).
  Without one, `install` still writes the files, then reports the failing command and exits 1.
  `install` also runs `loginctl enable-linger` for the user (a failure there is not fatal). Linger
  keeps the user manager alive after the installing session ends; without it, a machine with no
  interactive login loses the agent seconds after the install, because systemd stops the user
  manager together with the last session.
- **macOS:** `launchctl bootstrap gui/<uid>` needs a graphical login session for that user, so
  it fails over plain SSH. Standard error is not redirected to a file by the plist.
- **Windows:** the task runs only while the user is logged on. Check the task's Settings tab in
  Task Scheduler for the execution time limit and battery options. Those settings are not set by
  `schtasks /Create`, and this has not been checked on a Windows host.

Run `install --dry-run` first to see the exact files and commands for your host.

## Temporary helper (SAA-299)

RemoteHub can run this same binary temporarily on a host that has no persistent
agent. Nothing is installed and no service is created. In Files, the user clicks
**Start temporary helper**. The server then:

1. detects the OS/architecture with `uname -sm` over the session's SSH connection;
2. picks `remotehub-agent-<linux|macos>-<x86_64|aarch64>` from the server's `HELPER_DIR`;
3. creates `/tmp/remotehub-helper-<random>` (0700, exclusive) over SFTP and uploads
   the binary (0700);
4. mints a 32-byte single-use token (60 s TTL; the server stores only its SHA-256)
   and writes it to `session-token` (0600, exclusive);
5. runs `remotehub-agent --mode temporary --root <home> --helper-token-file <file>
   --helper-cleanup --helper-ttl 60` over an SSH exec channel.

The helper reads the token and deletes the file at once. The token is never in
argv or env and never logged. The helper's control channel is the exec channel's
stdin/stdout, so the host opens no port and does not need to reach RemoteHub. The
first request must be `hello` carrying the token, compared in constant time. A
missing or wrong token gets one `unauthorized` reply, and the helper exits with code 3.
If nobody authenticates within `--helper-ttl` seconds, it also exits with code 3.

On every exit path the helper deletes its binary and its directory. That covers
the session ending (stdin EOF), a refusal, expiry, and an I/O error. It only ever
deletes a directory named `remotehub-helper-*`, and only when that directory is
otherwise empty. Unix unlinks the running binary directly. On Windows a detached
`cmd` deletes it right after exit.

RemoteHub then removes anything left over SFTP and confirms the directory is gone.
That covers a helper killed with SIGKILL. RemoteHub also invalidates the token.
Closing the Files tab does the same before the SSH connection is closed.

While the helper runs, the Files header shows **Live · temporary helper** (dashed)
and a "Temporary helper · <platform>" chip. With a persistent agent it shows
**Live · agent**.

## Security

- SSH passwords are never involved: the agent has no SSH credentials or key material.
- Command execution is available only on Windows builds that advertise `exec.run`. Requests use direct executable plus argv, with bounded stdin, arguments, output, and timeout. command-group uses a Windows Job Object; the agent terminates it and waits for the entire job before joining output readers. Unix builds fail closed because a deliberately detached process can retain inherited pipes indefinitely. Commands run with the agent service account's OS privileges and inherited environment. `--root` is only the working directory; it does not sandbox command execution. A shell executable remains powerful.
- File reads, writes, and listings resolve paths through cap-std directory capabilities
  rooted at `--root`. Relative traversal and symlinks that resolve outside the root are
  denied during capability-relative filesystem access. Symlinks whose targets remain
  inside the root are allowed. The configured root itself must be protected by the
  operator; this filesystem boundary is not a general-purpose sandbox.
- The inbound listener (SAA-298) binds `127.0.0.1` only; any other `--listen`
  address is refused at startup. On every start it generates a fresh 32-byte
  token from the OS CSPRNG and writes it, hex-encoded, to
  `~/.remotehub/agent-local-token` (override with `--local-token-file` or
  `REMOTEHUB_AGENT_LOCAL_TOKEN_FILE`). The file is created `0600` in a `0700`
  directory on Unix; on Windows its ACL is reset to the current user only
  (`icacls /inheritance:r /grant:r <user>:F`) before the token is written, and
  the agent refuses to start if that fails. Each connection's first request must be
  `{"op":"hello","params":{"protocol":1,"token":"<token>"}}`. The token is compared
  in constant time; a missing or wrong token gets one `unauthorized` reply and the
  connection is closed. RemoteHub reads the file over the user's own SSH session
  (SFTP) and re-reads it on every connect. The token is never logged: the agent
  prints only the file path.
- Outbound registration uses a host-scoped, revocable credential. The raw token is
  sent only on the control channel and is never written to logs. Prefer
  `--token-file` so the token does not appear in the process list.
- The per-user service keeps the credential in `agent.token` (0600 on Unix, in the user's own
  directory on Windows). `install` never prints it or writes it to a unit file, plist, or task
  argument. The `--server` and `--host-id` values are validated against a strict character set
  before they go into a generated file. `uninstall` removes the file. A revoked credential makes
  the agent exit with status 1, and the service manager restarts it, so each restart re-tries
  and is refused again.
- `wss://` is TLS via rustls. `--insecure` is for local self-signed tests only.


## MCP host operations

A persistent agent built with this revision advertises the correlated filesystem operations RemoteHub uses:
`fs.read` and `fs.write`. File operations resolve paths under the configured agent root; text reads
are capped at 64 KiB and writes at 1 MiB.

Keep the persistent agent running and connected for these operations. The server sends requests over the
authenticated WebSocket connection and correlates each response to its request ID. Older agents continue
to support the existing `fs.list` request but do not advertise the newer filesystem operations.
When `MCP_COMMANDS_ENABLED=true`, the server exposes `remotehub.commands.run` only for connected
Windows agents advertising `exec.run` and only for grants that include the separate `commands:exec` scope
and selected host. OAuth consent presents this permission as a distinct host-command authority toggle with a warning. Unix agents do not advertise or execute this operation. The agent accepts direct executable plus argv, optional UTF-8 stdin (64 KiB max),
up to 64 arguments (64 KiB combined), and a 1–300 second timeout. Stdout/stderr are bounded and
marked when truncated. Windows uses a Job Object for timeout cleanup and waits for all job processes before joining output readers. Unix agents do not advertise or execute commands because a deliberately detached process can retain inherited pipes indefinitely.
Commands run with the agent service account's privileges; `--root` sets only the working directory.
An explicit shell executable remains powerful, and there is no process or filesystem sandbox. Do not use this feature to contain untrusted code.

Windows Job Object cleanup cannot contain work deliberately launched through an external broker such as WMI: broker-launched processes are outside the agent's job. The agent account retains its full operating-system authority, so command execution is not a security boundary.
