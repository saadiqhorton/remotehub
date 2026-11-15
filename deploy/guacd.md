# Desktop: running guacd alongside RemoteHub (SAA-301)

RemoteHub's Desktop sessions (RDP, VNC) use [Apache guacd](https://guacamole.apache.org/doc/gug/guacamole-architecture.html)
as a separate protocol daemon. **It is optional.** Without it, RemoteHub's terminal and
Files work exactly as before; Desktop just reports `disabled`.

## 1. Start guacd

Pick one:

- **Docker (recommended):** `docker compose -f deploy/docker-compose.guacd.yml up -d --build`
  builds guacd from the tested source (see [guacd version](#guacd-version-saa-304)) and starts it on `127.0.0.1:4822`.
- **Debian/Ubuntu package** (where available, e.g. Debian 12): `sudo apt install guacd`, then
  `guacd -b 127.0.0.1 -l 4822`. Debian 13 has no package; use Docker or build from source.
- **From source:** build `guacamole-server` at the tested commit below (FreeRDP 3 for RDP, libvncserver for VNC),
  then run `guacd -f -b 127.0.0.1 -l 4822`.

guacd has **no authentication**. Bind it to loopback or a private network only, and never
expose its port through your reverse proxy or firewall.

## 2. Point RemoteHub at it

In `.env`:

| Variable | Default | Meaning |
|---|---|---|
| `GUACD_ENABLED` | off | `1` turns Desktop on. Off means RemoteHub never contacts guacd. |
| `GUACD_HOST` | `127.0.0.1` | guacd host name or IP. |
| `GUACD_PORT` | `4822` | guacd port. |
| `GUACD_HEALTH_PROTOCOL` | `rdp` | Protocol the health check asks guacd for (`rdp` or `vnc`). Must be built into your guacd. |
| `GUACD_HEALTH_TIMEOUT_MS` | `3000` | Upper bound for one health check (connect + handshake). |
| `GUACD_HEALTH_CACHE_MS` | `5000` | How long a result is reused, so status polling never floods guacd. |

Invalid values stop RemoteHub at startup with a clear message.

## 3. Check it

- `npm run guacd:check` runs one fresh check and prints the result (exit 0 = ready).
- `GET /api/health` (no login) returns `{ "ok": true, "desktop": { "enabled", "status", "healthy" } }`.
  It is always HTTP 200 because RemoteHub itself is up; it reveals no address or error text.
- `GET /api/desktop/status` (owner session) returns the full result: host, port, protocol,
  status, a human-readable message, latency and guacd's protocol version. Add `?fresh=1` to bypass the cache.
- When enabled, the server logs one line at startup, e.g.
  `desktop: guacd up at 127.0.0.1:4822 (rdp): guacd is ready for rdp.`

The check is a real Guacamole handshake: TCP connect, send `select <protocol>`, expect
`args`, then hang up before any remote connection is made.

| `status` | Meaning |
|---|---|
| `disabled` | `GUACD_ENABLED` is not set. |
| `up` | guacd answered the handshake for the protocol. |
| `down` | Connection refused, unreachable, or the name did not resolve. |
| `timeout` | No connection, or connected but no answer, within the timeout: a hung guacd, a firewall drop, **or a guacd without the plugin for `GUACD_HEALTH_PROTOCOL`** (real guacd 1.5.5 logs `Support for protocol "rdp" is not installed` and never answers). |
| `protocol-unavailable` | guacd closed the handshake or answered with an `error`, e.g. it refused the protocol. |
| `bad-response` | Something other than guacd is listening on that port. |

## Desktop bridge (SAA-302)

The browser opens `/ws/desktop?hostId=<id>&width=<px>&height=<px>&dpi=<n>` on RemoteHub, using the normal session cookie and the same Origin check as `/ws/terminal`. guacd is never exposed to the browser. RemoteHub looks up the host's desktop settings (protocol, address, port, username) on the server, runs the Guacamole handshake itself, and then relays instructions in both directions. The browser can set only width, height and dpi, and those are clamped. The server drops any `select` or `connect` the browser sends.

Desktop settings are saved with `PUT /api/hosts/:id/desktop` (`{ protocol: "vnc"|"rdp", port, username?, security?, ignoreCert? }`) and removed with `DELETE`.

**Passwords are never stored.** A body that contains `password` is rejected with 400, and any password left by an older build is removed from `data/remotehub.json` when it loads. The browser's **first** WebSocket message must be a `credentials` instruction, either `11.credentials,8.password,<len>.<pw>;` or a bare `11.credentials;` when there is no password. RemoteHub puts that value into guacd's `connect` instruction once and then drops it. It is never logged.

### Refusals and close codes

The same table is in the header comments of `server/desktop-bridge.js` and `public/js/desktop-tunnel.js`.

| Code | Meaning | Suggested view state |
|------|---------|----------------------|
| HTTP 503 | Upgrade refused: desktop session limit reached (`MAX_DESKTOPS`, default 8) | unavailable |
| 1000 | Normal end: the browser sent `disconnect` or closed, or guacd sent `disconnect` | disconnected |
| 1003 | The browser sent a binary frame. Desktop is text-only | failed |
| 1007 | The browser sent a malformed Guacamole instruction | failed |
| 1008 | Protocol violation: the first message was not a valid `credentials` | failed |
| 1011 | guacd reported an error, e.g. a wrong VNC password. The `error` instruction is forwarded just before the close | failed |
| 4401 | RemoteHub login missing, expired or logged out | failed, then go to login |
| 4403 | Origin not allowed (same check as `/ws/terminal`). The upgrade is accepted and closed at once, before the login check; it doesn't count toward `MAX_DESKTOPS` | failed |
| 4404 | No desktop configured for this host, or unknown host | unavailable |
| 4409 | RDP: the target's certificate differs from the pinned one (SAA-304). Fails closed before guacd gets `connect` | failed, with an owner-only **Trust this computer again** (the button that resets the certificate pin) action (resets the pin, then reconnects) |
| 4410 | RDP: the certificate could not be checked (unreachable, not RDP, or no TLS) | unavailable, with the server's reason |
| 4502 | guacd crashed or dropped the connection mid-session | disconnected, offer reconnect |
| 4503 | Desktop disabled (`GUACD_ENABLED` off; guacd is not contacted), guacd unreachable, or the handshake timed out | unavailable |

### Browser instructions after the handshake

Only `mouse`, `key`, `size`, `sync`, `ack`, `clipboard`, `blob`, `end`, `argv` and `nop` are forwarded to guacd. `disconnect` ends the session with 1000. Everything else is dropped, including `select`, `connect`, `args`, `audio`, `video`, `image` and unknown opcodes. `argv` (the reply to guacd's `required` prompt) is forwarded only for a parameter name that guacd listed in a `required` instruction during this session, and only once per name. An argv sent before any `required`, for an unlisted name such as `hostname` or `port`, or a repeat of a name already sent, is dropped along with the `blob`/`end` on that stream. Drops are counted in the close log line; their contents are never logged. A mid-session `size` goes through the same limits as the handshake: width 320–8192, height 240–8192, dpi 48–384.

Timeouts: guacd TCP connect 5 s, handshake including credentials 15 s, idle (nothing from guacd) 60 s.

## guacd version (SAA-304)

RemoteHub's RDP layer is tested against one guacd build. Use the same one.

| | |
|---|---|
| Source | `apache/guacamole-server` main @ `ecca029b13c36fc9dba0f7f6b897eaf952239c22` |
| `configure.ac` version | 1.6.1 (unreleased main) |
| Guacamole protocol version it reports | `VERSION_1_5_0` |
| RDP library | FreeRDP 3 (tested with Debian 13 `libfreerdp3-3` 3.15.0) |
| Compose image | `remotehub/guacd:1.6.1-ecca029b`, built by `compose.yaml` (or the standalone `deploy/docker-compose.guacd.yml`) from that commit's upstream Dockerfile with `FREERDP_VERSION=3` |

The released `guacamole/guacd:1.5.5` image is no longer used. RemoteHub relies on
`cert-fingerprints` (certificate pinning), the `required`/`argv` password prompt and
FreeRDP 3 behaviour from this build. Moving to another commit or release means repeating
the SAA-304 real run (RDP frames, pin accepted, changed certificate refused).

## RDP (SAA-304)

Configure a host's RDP desktop with `PUT /api/hosts/:id/desktop`:

```json
{ "protocol": "rdp", "port": 3389, "username": "alice", "domain": "CORP", "security": "any" }
```

- **Saved on the host:** username, domain, port, `security` (`any`, `nla`, `tls`, `rdp`, `vmconnect`), `ignoreCert`, and the certificate pin.
- **Password: never stored or logged.** A `password` field is refused. RemoteHub sends no
  password in `connect`, and it ignores one sent in the browser's `credentials` message for RDP.
  The Desktop view hides its up-front password field for RDP. guacd then asks with
  `required password`, the view's sign-in form answers once with an `argv` stream, and the
  bridge forwards only one answer per name.
  A reconnect asks again.
- **Fixed options the browser cannot change:** remote sound on (`disable-audio=false`),
  microphone never (`enable-audio-input=false`), clipboard on, no drive or printer redirection, no file upload or download, no recording,
  gateway, Wake-on-LAN or RemoteApp, font smoothing on, `resize-method=display-update`,
  client name `RemoteHub`, timeout 10 s.
- **Remote sound.** The handshake offers `audio/L8` and `audio/L16` (raw PCM, what the
  browser's Guacamole client plays through Web Audio); guacd streams the remote computer's
  sound in one of them. Windows plays it with no setup. An xrdp computer needs
  `pulseaudio-module-xrdp` (or the PipeWire equivalent) installed there. The browser's own
  `audio` opcode (microphone) is not on the allow-list. The Desktop toolbar's Sound
  toggle mutes a tab at once, including sound already queued (per browser); playback starts on the first click or key in the tab,
  as browsers require. guacd's VNC sound (`enable-audio`) stays off: it needs a PulseAudio
  server on the target open to the network. Instead, the computer's own RemoteHub agent
  records its sound and streams it over `/ws/desktop-sound`, for VNC and RDP alike
  (`server/desktop-sound.js`, agent `audio.start`). The tab uses the agent's sound until RDP
  actually delivers some (a stock xrdp opens a stream that stays silent), then switches so
  nothing plays twice.
- **Resize refused (SAA-352).** guacd sends a display-update for each browser size and keeps
  re-sending it every 500 ms until the target's screen matches. A target that refuses (for
  example xrdp relaying to a VNC server that rejects resizes) answers by resetting the screen
  back, over and over, and the FreeRDP session freezes or aborts. RDP never reports the refusal
  itself. So the Desktop view watches each size it asks for: if the remote size bounces back
  to something it did not ask for, or no answer arrives within 5 s, that tab reconnects once
  at the computer's own size with `fixed=1`. For that connection only, the server then sends
  an empty `resize-method` (no resizing); `fixed=1` is the only resize input the browser has
  and it can only turn resizing off. Saved sign-in answers are reused, and xrdp reattaches the
  same session. The view then scales locally. Targets that accept resizes (xorgxrdp,
  Windows) are unaffected, and so is VNC.

### Certificate pinning (trust on first use)

Before every RDP connect, RemoteHub reads the target's TLS certificate itself. It sends an
X.224 negotiation request asking for TLS, completes a TLS handshake, sends no credentials,
and takes the SHA-256 fingerprint.

- **First connect:** the fingerprint is stored on the host (`certPin`, `certPinnedAt`, both shown in the host's `desktop` view).
- **Every connect:** the fingerprint must match the pin. RemoteHub also passes it to guacd as
  `cert-fingerprints`, so FreeRDP refuses any other certificate on its own connection too
  (this closes the gap between the check and guacd's connection).
- **Certificate changed:** the session closes with **4409** before guacd receives `connect`.
  Nothing is re-pinned automatically. The Desktop view shows "Connection failed" with an
  explanation and a **Trust this computer again** (the button that resets the certificate pin) button. After you have checked the new
  certificate, that button (owner session) calls `DELETE /api/hosts/:id/desktop/cert-pin`
  and reconnects, and the connect pins whatever certificate the machine presents then.
- **The pin is learned again** when the host's address or the desktop port changes. It cannot be
  set through the API.
- **Check failed** (target unreachable, not RDP, or offers no TLS): close **4410**. The one
  exception is `security: "rdp"` (legacy RDP encryption without TLS), which has no certificate
  to pin. The owner has to choose it explicitly.
- **`ignoreCert`** is off by default and can be set only by the owner through the settings API.
  When on, RemoteHub skips the check and guacd gets `ignore-cert=true`. Use it only for a lab machine.

| Close | Meaning |
|---|---|
| 4409 | RDP certificate differs from the pinned one (fails closed). Reset the pin after checking. |
| 4410 | RDP certificate could not be checked (unreachable, not RDP, or no TLS). |
| 1011 | guacd reported an error, e.g. auth failure `0x0301`/`0x0303`, security negotiation failure, or an unreachable target. The `error` instruction comes first. |

### Known limits

- **NLA is not verified (SAA-340).** The test target was xrdp 0.10.1, which has no NLA. With
  `security: "nla"`, xrdp makes guacd fail with `error 769` ("Security negotiation failed") and
  close 1011. A Windows target with NLA has not been tested, nor has whether guacd's `required`
  prompt runs before CredSSP there.
- **A wrong password on xrdp is not a 1011.** xrdp accepts the RDP connection and shows its own
  login dialog ("User does not exist, or could not be authenticated") inside the session. guacd
  reports no error, so the user sees that dialog. Windows and NLA targets report auth failures
  to guacd, which RemoteHub forwards and closes with 1011. The bridge is unit-tested for that, but
  it has not been run against a real Windows target.

## What the user sees (SAA-349)

The Desktop view only shows plain sentences that say what to do inside RemoteHub. The
technical cause stays here and in the server log.

| Cause (technical) | Close code / API | Message the user sees |
|---|---|---|
| RDP certificate differs from the pin | 4409 | This computer's remote desktop looks different from the last time you connected. If you expected that (for example, the computer was reinstalled), click "Trust this computer again". If not, don't connect. |
| RDP target offers no TLS, refuses TLS negotiation, or sends no certificate | 4410 | RemoteHub can't open a remote desktop on this computer. Try VNC instead. |
| RDP target is not RDP (bad X.224 reply) | 4410 | This computer isn't offering a Windows remote desktop on that port. Check the port in this host's desktop settings. |
| RDP TCP connect error / TLS error / timeout / early close | 4410 | RemoteHub couldn't reach (or couldn't open a safe connection to) this computer's remote desktop, or it didn't answer in time / closed the connection. Click Reconnect to try again. |
| guacd lacks the rdp/vnc plugin | 400 / 4503 | RemoteHub can't open RDP (or VNC) desktops right now. |
| guacd `error` instruction (any status code) | 1011 | The remote desktop ran into a problem. Click Reconnect to try again. (guacd's text and status code go to the log only.) |
| Desktop WS refused (session cap, Origin) | HTTP 503 / close 4403 | RemoteHub couldn't open this desktop. Close any desktop tabs you aren't using, then click Reconnect. |
| VNC: ECONNREFUSED etc. / not RFB / unsupported security types | vnc-check | Nothing answered at host:port … / … isn't a VNC desktop … / This VNC desktop uses a sign-in method RemoteHub can't use. |

`test/plain-words.test.js` fails if a user-visible desktop message mentions certificates,
TLS, pins, fingerprints, guacd, plugins, handshakes, protocols, errno names or status codes.

## Desktop backend discovery and Auto (SAA-306)

RemoteHub decides which desktop backends a host offers by **probing**, never by the host's OS name.

- **RDP:** the same read-only check as RDP certificate pinning (X.224 negotiation request, then a
  TLS handshake). **Discovery never sends credentials** (no username, domain, password or cookie)
  and sends nothing after TLS. It **never records or updates a certificate pin**: only a real
  connection pins (see "Certificate pinning" above). **RDP without TLS is unsupported** (it can't be pinned): discovery
  reports it (`tls: false`); the UI label and the 400 for an explicit pick (`preference: "rdp"`) or a
  settings save of RDP on that port both say "RemoteHub can't open a remote desktop on this computer. Try VNC instead."
  Auto skips it. **To fix it on the remote machine:** Windows: Group Policy → Computer Configuration →
  Administrative Templates → Windows Components → Remote Desktop Services → Remote Desktop Session Host →
  Security → "Require use of specific security layer for remote (RDP) connections" = Negotiate or SSL (or leave it
  Not configured; the default negotiates TLS). xrdp: in `xrdp.ini` set `security_layer=negotiate` (or `tls`) with a
  valid `certificate`/`key_file`, then restart xrdp.
- **VNC:** SAA-305's read-only RFB check. It reads the server's version and offered sign-in methods,
  answers only with its own version, and never picks a security type or sends a password.
  A VNC server that **refuses** the check connection is reported **not available**.
- **Native RemoteHub stream:** reported live by the RemoteHub agent when it is connected on that computer.

**Which ports are probed:** every protocol is checked on all of these at the host's address:

1. the port the owner **saved** for that protocol on the host (if any);
2. `DESKTOP_DISCOVERY_PORTS`, server environment only, e.g. `DESKTOP_DISCOVERY_PORTS=vnc=5901,rdp=3390`;
3. the protocol's **default**: RDP 3389, VNC 5900. You can change the defaults on the server with
   `DESKTOP_DISCOVERY_DEFAULT_PORTS` (same syntax), for example on a shared machine where those
   ports belong to someone else.

Duplicates are probed once. The result for a protocol is the first available candidate, in the
order above; for RDP a TLS candidate wins over a no-TLS one. `tried` lists every port checked.
The browser can never add, pick or change a probed port: query and body are ignored.
A VNC server on display :N listens on 5900+N. Discovery reports whatever answers at those
address:port pairs, which is why unsaved ports need confirmation (below).

**Unsaved ports need the owner's confirmation.** A backend found **only** on a port the owner has
not saved for it (a default port or a `DESKTOP_DISCOVERY_PORTS` port) is shown as available
("found on port N, not saved; confirm on first use"), but **Auto never chooses it**, and an
explicit pick needs a confirmation too. This applies to RDP and VNC alike.
- On the first click, the host card shows the exact address:port ("Use VNC at
  192.168.1.20:5901?") and saves only after **Confirm**.
- The server enforces this. A preference save without a confirmation returns 400 with
  `needsConfirm: { protocol, address, port }`.
- `PUT …/desktop` must then carry `confirm: { protocol, address, port }` matching **exactly** the
  host's address and the port the last discovery found. Anything else returns 400, as does a
  `confirm` sent without a preference.
- Once saved, that port is the owner's, and later discoveries on it need no confirmation.
- The last discovery is kept when a save stores exactly the protocol and port it found (e.g. the
  confirmed first click). It is dropped when the address changes, when a saved desktop port changes
  to something discovery did not find, or when desktop settings are removed. A protocol with no
  discovery data shows "not checked".

State-changing API requests (POST/PUT/DELETE, including discover and the desktop save) must carry an allowed `Origin`; a missing or foreign `Origin` gets 403. Browsers always send it on these requests.

**API (owner session):**

- `POST /api/hosts/:id/desktop/discover` probes the host's address on the ports listed above.
  Each probe has a 3 s limit.
  - The result is stored on the host as `desktopDiscovery`, separately from the desktop settings,
    so it can never touch the certificate pin.
  - It is limited to **one run per host per 10 s**; a second run gets 429 with `Retry-After`.
    Deleting a host also drops its limiter slot.
  - This limiter is separate from SAA-305's `GET …/desktop/vnc-check` (one per host per 5 s).
    Discovery probes RDP and VNC together, and the explanation the Desktop view fetches after a
    failed VNC session must not be blocked by a discovery that just ran.
- Every host view carries `desktopBackends` (one entry per backend: `available`, `selectable`,
  `source` probe/configured/agent, `reason`), `desktopDiscovery` and `desktopPreference`
  (default `auto`), plus `insecure`, `unconfirmed`, `port` and `note` per backend. Building the
  view never probes anything.
- `PUT /api/hosts/:id/desktop` with `{ "preference": "auto" | "rdp" | "vnc" }` (plus `confirm`
  when needed) picks the backend and saves it. The port comes from discovery. The preference is
  remembered.
  - If nothing fits, the answer is 400 with `error`, a per-backend `reasons` map, `helper: true`
  when the agent/helper path should be offered, and `needsConfirm` when only an unsaved port was
  found.
  - `"nativeStream"` returns 400 until SAA-311. A `protocol` and a `preference` that disagree
  return 400.
  - `password` and `certPin` return 400 on every path.
  - Settings, capabilities and preference are saved in **one atomic store write**.
  - An explicit `protocol` without a preference still works as in SAA-305.

**UI:** while not connected, the Desktop view shows "Desktop connection: Auto: RDP" (or the
explicit choice), the Advanced chooser with every backend and its reason, and **Check again**,
which runs discovery. When nothing is available, it shows the per-backend explanation plus the
agent/helper path, with a **Set up agent** button that opens the host dialog (agent
registration and temporary helper). For a host with no desktop set up yet, the Desktop action stays disabled (as
in SAA-303), but its reason text reports what the last discovery found.

**Check desktop options (owner-only host action):** every host card shows a
**Check desktop options** button to the signed-in owner, even when Desktop is disabled. (The
whole host list needs the owner session; the API answers 401 without one.) It calls the
discover route and lists the result for each backend, or "Try again in N s" on 429; the body
also carries `retryAfterSeconds`. When discovery finds RDP or VNC, the host view reports it in
`effectiveCapabilities.desktop` with provenance `discovery`. That is computed per request,
never stored, and never written to the desktop settings or pin. Desktop then becomes enabled
through the normal capability path, as long as Desktop is on and guacd has the plugin.
Opening it first saves desktop settings from the owner's preference
(`PUT …/desktop {preference}`, no credentials). The real connection then pins as usual.
A host with no settings and no discovery hit keeps Desktop disabled, as in SAA-303.

A preference-only save (`PUT …/desktop` with `preference` and no `protocol`) goes through the
same route, so it has the same owner-session and Origin checks (401 / 403), and it uses the same
`validateDesktopSettings` and capability code. It may only pick a backend the **last discovery**
found available; otherwise it returns 400. The port comes from that discovery result and the
address from the host record. A client-supplied `port`, `address` or `host` is refused (400),
as are `password` and `certPin`. Pin rules are unchanged from SAA-304: the pin is kept when the
protocol and port stay the same, and is re-learned by the next real connection when the port
moves.

**Auto preference (fixed):**

1. RDP
2. VNC
3. Native RemoteHub stream: listed when an agent reports it, but not selectable until SAA-311.

An explicit choice in the Advanced "Desktop connection" selector wins when that backend is
available; otherwise the view says why. If nothing is available, each backend's reason is
shown, and the optional agent/helper path is offered.

This fixed order **intentionally differs from the product spec §12**, which suggests a per-OS
order (Windows: RDP, native, VNC; macOS/Linux: native first). The order was approved by the
owner for SAA-306 because selection must not depend on OS assumptions. RDP comes first because
it has TLS with a pinned certificate. Native is last only while it is not selectable; revisit
the order in SAA-311.
