# RemoteHub regression checklist

Run this before asking for review on a PR. Use a real browser against a
server started from the branch. Record PASS or FAIL for each line and attach a
screenshot. Anything that used to work and now doesn't is a FAIL.

The **Coverage** column says how each line is checked:
- `auto: <file> › <test>` means `npm test` checks it.
- `manual only` means a person has to do it in a browser. Where it would be
  cheap to automate, the line says so.

Setup for the manual steps:
- A server on `127.0.0.1:<port>` with `GUACD_ENABLED=1`.
- guacd.
- A VNC server (Xvfb + xterm + x11vnc with a password).
- For RDP: xrdp with a test user.
- An SSH server for the terminal.

## Fresh install (do this first)

Start from an empty folder and follow only `README.md`. Any step the README does not
mention, or any message that confuses you, is a FAIL for that line.

| # | Item | Steps | Expected | Coverage |
|---|---|---|---|---|
| F1 | Get and start | In an empty folder: clone the repo, then run exactly what README "Run it" says (`npm install`, `npm start`). | One command starts it. The first page asks for the setup code and says where to find it. | manual only |
| F2 | First login | Enter the setup code and an owner password. | The app opens with an empty host list and an "+ Add host" button. | manual only (A1 automates the same screens) |
| F3 | Add a host | + Add host: name, address, port, user. Save. | It shows in the list with Terminal / Files / Desktop. | manual only (H1 is auto) |
| F4 | SSH | Terminal on that host, enter the password, trust it. | A shell prompt; typing works. | manual only |
| F5 | VNC desktop | Desktop on a host with a VNC server, enter its password, Connect. | The remote desktop shows; typing works. If a step outside the README was needed (for example installing or starting guacd), FAIL and name the step. | manual only |
| F6 | RDP desktop | Desktop on a host with an RDP server, answer the sign-in prompt. | The remote desktop shows; typing works. Same rule about extra steps. | manual only |

## Account

| # | Item | Steps | Expected | Coverage |
|---|---|---|---|---|
| A1 | First-run setup | Start with an empty data dir. Open `/`. Enter the setup code from `SETUP-CODE.txt` and an owner password. | The app opens. A wrong setup code is refused. | auto: test/e2e.test.js › first run requires the setup code |
| A2 | Login | Log out. Enter a wrong password, then the right one. | Wrong: "Wrong password." Right: the app opens. | auto: test/e2e.test.js › login, logout, and API protection |
| A3 | Logout | Click Log out. | Back to the login screen. API calls return 401. Open terminals close. | auto: test/e2e.test.js › login, logout, and API protection; › logout closes open terminals |

## Hosts

| # | Item | Steps | Expected | Coverage |
|---|---|---|---|---|
| H1 | Add host | + Add host, then enter name, address, port and user. Save. | The host shows in the list with Terminal / Files / Desktop buttons. Bad input shows a field error. | auto: test/e2e.test.js › host CRUD validates input |
| H2 | Edit host | Edit the host, change its name, save. | The list shows the new name. Capabilities are kept. | auto: test/capabilities.test.js › host edits never wipe capabilities and the API strips client-supplied capability blobs |
| H3 | Delete host | Delete the host. | It's gone from the list. A connect to it fails cleanly. | auto: test/api-regression.test.js › host delete removes the host and unknown ids 404 |

## SSH terminal

| # | Item | Steps | Expected | Coverage |
|---|---|---|---|---|
| T1 | Connect | Click Terminal and enter the SSH password. First time: Trust and connect. | A shell prompt. The fingerprint is saved. | auto: test/e2e.test.js › first connection asks to trust the fingerprint, then opens a working shell |
| T2 | Type | Type `echo hi` and press Enter. | `hi` is printed. | auto: same as T1 |
| T3 | Resize | Resize the browser window. | The terminal reflows. The size is clamped server-side. | auto: test/ssh-regression.test.js › resize dimensions are clamped before reaching the SSH server |
| T4 | Disconnect | Close the tab with ×. | The session ends and the dot clears. | auto: test/api-regression.test.js › the terminal slot limit rejects extra sockets with 503 and frees on close |
| T5 | Changed host key | Point the host at a server with a different key. | Blocked, with a mismatch screen. The stored key is not overwritten. | auto: test/e2e.test.js › a changed server key is blocked |

## Desktop: VNC

| # | Item | Steps | Expected | Coverage |
|---|---|---|---|---|
| V1 | Connect | Click Desktop on a VNC host. Enter the VNC password. Connect. | The remote desktop renders. | auto: test/desktop-session.test.js › integration: real bridge → ready with frames; password reaches guacd once; guacd kill → 4502; reconnect |
| V2 | Type / mouse | Click into an xterm on the desktop, type `echo vnc-$((6*7))`, press Enter. | `vnc-42` appears. | auto (protocol level): test/desktop-session.test.js › keyboard and mouse are forwarded with keysyms and button masks; blur and hide release them. The real desktop part is manual only. |
| V3 | No password | Connect with an empty password. | The "This desktop needs you to sign in" prompt appears. The right password connects. | auto: test/desktop-session.test.js › real guacd order: ready, then required; answering it returns to ready on the first size |
| V4 | Wrong password | Connect with a wrong password. | Failed: "The VNC server rejected the password." | auto: test/vnc.test.js › view: a failed VNC session is explained by the pre-check (password flag only, no value) |
| V5 | Server down | Stop x11vnc, then connect. | Failed: "No VNC server answered at …". | auto: test/vnc.test.js › explainVncFailure gives one plain reason per VNC failure kind |
| V6 | 1000 close before any frame | guacd ends the session normally before it draws anything. | Failed: neutral "ended before anything was shown". It never says "session ended" and never says the password was wrong. | auto: test/desktop-session.test.js › SAA-346: a 1000 close before any frame is a neutral failure…; › SAA-346: the VNC pre-check never says the password was rejected after a plain 1000 |
| V7 | Idle, visible tab | Connect, then leave the tab in front without touching it for 5+ min. | Still connected. Typing works. | auto: test/desktop-idle.test.js › idle desktop session … stays open past guacd's 15 s user timeout (needs `RH_IDLE_RIG=1`, `RH_IDLE_GUACD_PORT` and `RH_IDLE_VNC_PORT` pointing at a running guacd and VNC server); test/desktop-keepalive.test.js. The 5-minute browser run is manual only. |
| V8 | Idle, hidden tab | Connect, put another tab in front for 15+ min (real headed Chrome), come back. | Still connected. Typing works. | manual only (background-timer throttling needs real headed Chrome). The catch-up logic is auto: test/desktop-keepalive.test.js › incoming traffic sends an overdue nop at once (throttled background timers) |
| V9 | Hidden tab without a server keep-alive | Connect, put another tab in front for 16+ min (real headed Chrome), come back and type. | Still connected; typing works. guacd never logs "User is not responding". The browser's own keep-alive is enough; the server does not send its own. | manual only (needs real background-tab throttling); the browser keep-alive is auto: test/desktop-keepalive.test.js |
| V10 | No false 4503 after a stall | Needs a whole-host freeze longer than 60 s (e.g. pausing the VM) with a session open, then resume. Freezing only the server process is not the same test: guacd keeps running and ends the user after 15 s, which is expected. | Still connected; server log says "watchdog tick … late … silence window restarted". | manual only for the host freeze (needs a VM pause); the logic is auto: test/desktop-bridge.test.js › SAA-346 watchdog: a stall longer than idleMs does not close a healthy session with 4503 |
| V11 | Real guacd silence | guacd stops sending for 60 s (e.g. `kill -STOP` the guacd child). | Unavailable 4503 "Desktop service stopped responding"; the server log names the last opcode from each side (never arguments). | auto: test/desktop-bridge.test.js › SAA-346 watchdog: real guacd silence still closes with 4503 and logs what each side last sent (opcodes only) |
| V12 | Quick retry keeps the explanation | Connect with a wrong password, close the tab, and at once connect again with a wrong password. | The second attempt also says "The VNC server rejected the password." (after up to 5 s). Until then the text ends with "Checking the VNC server for the exact cause…"; guacd's "Aborted. See logs." is never shown on its own. | auto: test/vnc-check-client.test.js › SAA-346 vnc-check client: a 429 waits for Retry-After and asks once more; test/vnc.test.js › SAA-346 view: while the pre-check runs, the failure says it is finding out why … |
| V13 | No "Connected" before the first frame | Connect to a VNC host with an empty password; watch the pane until the sign-in prompt. Then connect with the right password. | Empty password: "Starting the remote desktop…" then the sign-in prompt, never "Connected" over a blank screen. Right password: "Connected" only once the desktop is drawn. | auto: test/desktop-session.test.js › SAA-346: empty VNC password - never "Connected" over a blank screen before the sign-in prompt |
| V14 | "Loading the screen…" until the first picture | Restart the whole VNC desktop (X session and VNC server), then connect at once. Type as soon as the pane allows it. | The pane says "Starting the remote desktop…", then "Loading the screen…" while the screen is still empty, and "Connected" only with the picture. Typing is possible only once "Connected"; everything typed then shows on the remote screen. | auto: test/desktop-session.test.js › SAA-346: VNC order (size, sync with nothing drawn, drawing later) |

## Desktop: automatic reconnect (SAA-347)

| # | Item | Steps | Expected | Coverage |
|---|---|---|---|---|
| A1 | Comes back on its own | Connect to a VNC host with a password. Stop the desktop service (guacd) for ~5 s, then start it again. | "The connection to the desktop dropped. Reconnecting in 2…" counting down, then the desktop comes back without asking for the password. Typing works. | auto: test/desktop-reconnect.test.js › a recoverable drop counts down, reconnects with the held password and never asks for it; test/desktop-session.test.js › integration: real bridge … guacd kill → 4502; reconnect. Headed Chrome run is manual only. |
| A2 | Password prompt answered from memory | Connect with an empty password, sign in at the prompt, then do A1. | No sign-in prompt during the reconnect. | auto: test/desktop-reconnect.test.js › a password asked by the desktop during a reconnect is answered from memory, no prompt |
| A3 | Which drops reconnect | Table over every known close code. | Only 1006 (after a handshake), 1011 (not after a sign-in error), 4502, 4503 reconnect. 1000, 1003, 1007, 1008, 4401, 4404, 4409, 4410 and refused upgrades (HTTP 403/503) wait for the user. | auto: test/desktop-reconnect.test.js › reconnect decision table over every known close code …; test/desktop-reconnect.test.js › codes outside the allow-list stop and wait for the user |
| A4 | Disconnect never reconnects | Press Disconnect while connected, and during a countdown. Wait 15 s. | "You disconnected from the desktop." No new connection. The password is forgotten. | auto: test/desktop-reconnect.test.js › Disconnect during the countdown cancels it …; test/desktop-reconnect.test.js › Disconnect while connected never reconnects … |
| A5 | Log out never reconnects | Start a countdown (A1 without restarting), log out. Wait 20 s. | No new connection. | auto: test/desktop-reconnect.test.js › logging out (the tab is disposed) during a countdown never reconnects |
| A6 | Retry schedule and limit | Stop the desktop service and leave it off. | Countdowns of 2, 4, 8 and 16 s, then one every 30 s, for up to 5 minutes. Then "RemoteHub could not get the desktop back. Press Reconnect to try again." with a Reconnect button, and nothing more. Reconnect (after the service is back) connects without typing the password. | auto: test/desktop-reconnect.test.js › schedule: 2, 4, 8, 16 s, then every 30 s, for up to 5 minutes; then the plain failed state |
| A7 | A first try that never worked is not retried | Connect with a wrong password. | Fails once; no countdown; the password is not kept. | auto: test/desktop-reconnect.test.js › a first connection that fails before the desktop ever showed is not retried … |
| A8 | Password only in page memory | After A1, check localStorage, sessionStorage, cookies, IndexedDB and the address bar. | No password anywhere. | auto: test/desktop-reconnect.test.js › the password lives only in page memory …. The browser storage check is manual only. |
| A9 | Restarted service usable at once | Stop the desktop service, wait, start it, connect at once. | Connects. Never "plugin is not installed" because the service was briefly down. | auto: test/vnc.test.js › SAA-347: guacd being down is not remembered as "plugin missing" … |
| A10 | Plain words | Read every reconnect message. | No codes, no "guacd"/"TLS", never tells you to troubleshoot or change settings. | auto: test/desktop-reconnect.test.js › a recoverable drop … (jargon check); test/desktop-reconnect.test.js › retries are capped … (jargon check) |
| A11 | Retry at once when the tab comes back | During a countdown, switch to another tab and back. | The countdown is skipped and it reconnects right away. | auto: test/desktop-reconnect.test.js › the tab becoming visible again retries at once |
| A12 | Waiting for network | During a session, turn the network off (DevTools › Network › Offline), then on. | "Waiting for network…" with no countdown and no attempts while offline; reconnects as soon as the network is back. Time offline doesn't count toward the 5 minutes. | auto: test/desktop-reconnect.test.js › offline: "Waiting for network…", no retries burned, resumes at once when online. Browser check is manual only. |
| A13 | Events never override a stop | After Disconnect, logout or a stop code, go offline/online and switch tabs. | No reconnect. | auto: test/desktop-reconnect.test.js › online/visible events never reconnect after Disconnect, logout, or a stop code |
| A14 | 60 s outage recovers on its own | Stop the desktop service for 60 s, then start it. Don't click anything. | The desktop comes back on its own, no password prompt, typing works. | manual only |
| A15 | Editing the computer forgets the password | While connected (or during a countdown), edit the host's address or desktop port and save. | Any countdown stops with "This computer’s details changed. Press Reconnect to connect again." A later drop doesn't reconnect on its own, and the old password is never sent to the new address. | auto: test/desktop-reconnect.test.js › review: changing the desktop address, port or protocol forgets the password and stops any reconnect |
| A16 | RDP reconnect without a prompt | Connect to an RDP host and sign in at the prompt; stop the desktop service briefly. | It comes back without showing the sign-in prompt. | auto: test/desktop-reconnect.test.js › review: an RDP password answered at the prompt is reused from memory on an automatic reconnect. Browser check is manual only (needs xrdp). |
| A17 | Old drawing can't stall a reconnect | (Timing-dependent.) | The reconnected desktop shows "Connected" with fresh pixels only. | auto: test/desktop-reconnect.test.js › review: drawing work from a dropped connection can neither block nor draw into the reconnected one |
| A18 | RDP: early frame signal never ends a reconnect | Connect to an RDP host and sign in; stop the desktop service and start it again. Watch the pane while it comes back. | It goes from "Reconnecting…" straight to the desktop: no sign-in prompt and no "Connected" over a blank screen; typing works. guacd sends a frame-done signal before its sign-in request for RDP, and that signal is ignored until the screen size has arrived. | auto: test/desktop-reconnect.test.js › review: RDP order on auto-reconnect (ready, early sync, then required) |

## Desktop: RDP

| # | Item | Steps | Expected | Coverage |
|---|---|---|---|---|
| R1 | Connect | Click Desktop on an RDP host. Answer the password prompt. | The desktop renders. On first use the certificate is pinned. | auto: test/rdp.test.js › rdp end to end: first use pins, password only via required/argv once, frames flow, nothing stored or logged |
| R2 | Type | Type into the session's xterm. | The text appears. | manual only |
| R3 | 4409 cert changed | Swap xrdp's certificate, then connect. | Failed: "certificate changed" with a Trust button. Trusting resets the pin and reconnects. | auto: test/rdp.test.js › rdp: changed certificate fails closed with 4409 …; test/desktop-rdp-view.test.js › 4409: failed + cert-changed explanation + Trust button … |
| R4 | 4410 cert can't be checked | Point the RDP host at a closed port. | Unavailable: "could not check the remote desktop's certificate". No pin is saved. | auto: test/desktop-rdp-view.test.js › 4410: unavailable with explanation …; test/rdp.test.js › … no TLS -> 4410 … |
| R5 | Idle, visible / hidden | Same as V7 / V8 on RDP. | Still connected. | manual only |
| R6 | RDP: no "Connected" before the sign-in prompt | Desktop on an RDP host; watch the pane until the sign-in prompt, then sign in. | "Starting the remote desktop…" then the sign-in prompt, never "Connected" over a blank screen; "Connected" only once the desktop is drawn. | auto: test/desktop-session.test.js › SAA-346: RDP order (ready, sync, required) |
| R7 | Resize follows the browser (SAA-352) | On a normal RDP target (xrdp + xorgxrdp, Windows), resize the browser window a few times; type after each. | The remote screen takes the new size each time; the picture and typing stay live; the tunnel URL never has `fixed=1`. | auto: test/desktop-resize-fallback.test.js › normal resizing keeps working; CI: compose-acceptance › normal xrdp resizing still follows the browser |
| R8 | Computer refuses a resize (SAA-352) | On an RDP target that refuses resizes (xrdp relaying to Xvnc `-AcceptSetDesktopSize=0`, or to a fixed-size VNC), connect, then resize the browser window. | Within a few seconds the tab says "This computer can’t change its screen size. Reconnecting at its own size…", reconnects once by itself (`fixed=1`), keeps the same remote session, and stays live; later resizes only scale locally; typing still works. No new sign-in is asked. | auto: test/desktop-resize-fallback.test.js, test/desktop-resize-fixed.test.js; CI: compose-acceptance › RDP resize refused → automatic fixed-size fallback |
| R9 | Full screen fills the screen | On a normal RDP or resizable VNC target, click Full-screen capture on a laptop screen and on a wide or tall monitor. Point at the Controls tab; leave it; press Ctrl+Alt+Shift+Escape. Then Capture input, press F11, and release. | The desktop fills the whole screen with no bars at any edge; the remote takes the screen size once on entry and the window size once on exit. The toolbar shows for about 3 s, then hides behind a Controls tab that brings it back. Capturing or releasing input alone sends no resize; F11 while captured also fills the screen. In a pane under 560 px wide the controls sit in two fixed rows and none is cut off. | auto: test/desktop-capture-resolution.test.js; layout is manual |
| R10 | Remote sound | On Windows (or xrdp with `pulseaudio-module-xrdp`), connect, click the desktop once, play a sound there. Click Sound on to mute, then unmute; reload and reconnect. | The sound plays in the browser. Muted, nothing plays and nothing piles up; unmuted, it is live again. The choice survives a reload. The remote computer's microphone is never used. | auto: test/desktop-sound.test.js; test/desktop-bridge.test.js › remote sound; test/rdp.test.js; the speakers are manual |
| R11 | Sound from the agent, any desktop | On Linux, macOS, and Windows computers with the RemoteHub agent connected in the signed-in desktop session, open Desktop over VNC or stock xrdp with no Terminal or Files tab; click the desktop once and play a sound. On macOS, grant the Screen Recording permission when prompted. Mute, unmute, close the tab, reconnect, then stop the agent. | The playing computer’s output reaches the tab on all three operating systems. `pw-record` or `parec`, ScreenCaptureKit, or WASAPI capture runs only while a tab listens and stops on mute, tab close, and disconnect. macOS capture prompts for permission; Windows does not. With the agent stopped, the Sound button says "No sound" and why. On Windows RDP sessions that already redirect sound, it is not duplicated. | auto: test/desktop-sound-agent.test.js; test/desktop-sound.test.js; agent `cargo test` (`REMOTEHUB_REAL_AUDIO=1` for real capture); Linux, Mac, and Windows real devices are manual |
| R12 | One-click agent install | In a computer's dialog (RemoteHub opened by its network address, not localhost, and HELPER_DIR holding that system's agent build), click Install agent on this computer and enter its SSH password. On a computer seen for the first time, check and trust the fingerprint. | The agent installs as a per-user service (Linux: `systemctl --user status remotehub-agent`), the dialog says it is installed, and within seconds the agent shows Connected. `/tmp/remotehub-install-*` is gone on that computer; the password is not stored or logged. A wrong password or a failed install shows a plain reason and leaves no agent key. | auto: test/agent-install.test.js (fake SSH computer); the real service start is manual |

## Password hygiene

| # | Item | Steps | Expected | Coverage |
|---|---|---|---|---|
| P1 | Desktop passwords never stored or logged | After V1/R1, grep the data file, server log and guacd log for the passwords. | No match. Settings responses carry no password. | auto: test/desktop-bridge.test.js › settings: validation, password kept server-side, public view hides it …; test/rdp.test.js › … nothing stored or logged. The log grep is manual (cheap to automate with a log capture). |

## vnc-check and desktop discovery

| # | Item | Steps | Expected | Coverage |
|---|---|---|---|---|
| D1 | Discovery | `GET /api/desktop/status` | `protocols: {vnc, rdp}` reflects the guacd plugins. | auto: test/vnc.test.js › PUT desktop records the protocol capability … |
| D2 | Capability-driven Desktop button | A host without a desktop capability. | Desktop is disabled, with a reason. | auto: test/vnc.test.js › hostActions: Desktop needs the protocol capability and the guacd plugin |
| D3 | vnc-check owner-only | Call it with no session. | 401 | auto: test/vnc.test.js › vnc-check: owner-only, saved address/port only, 3 s timeout, per-host rate limit |
| D4 | vnc-check foreign Origin | Call it with `Origin: http://evil.example`. | 403. The VNC server is not dialed. | auto: test/vnc.test.js › vnc-check refuses a foreign Origin with 403 and never dials (SAA-346) |
| D5 | vnc-check rate limit | Two calls for the same host within 5 s. | The second returns 429 with `Retry-After`. | auto: same as D3 |
| D6 | vnc-check saved target only | Add `?address=&port=` to the URL. | Ignored. Only the saved host/port is dialed. | auto: same as D3 |

## Error screens

| # | Item | Steps | Expected | Coverage |
|---|---|---|---|---|
| E1 | 401 (login lost) | Log out in another tab, then connect a desktop. | Failed: "login". You're sent to login. | auto: test/desktop-session.test.js › integration: wrong password … login lost → 4401 |
| E2 | 403 (foreign origin) | A WebSocket or API request from a foreign Origin. | Refused, 403. | auto: test/desktop-bridge.test.js › unauthenticated / expired / logged-out sessions get 4401; bad origin is refused; origin checked |
| E3 | 429 | See D5. | 429 | auto: see D5 |
| E4 | 503 | Desktop turned off, or the slot limit is full. | Unavailable: "backend-down", or the upgrade is refused with 503. | auto: test/desktop-bridge.test.js › flag off: 4503 and zero guacd connections …; test/api-regression.test.js › the terminal slot limit rejects extra sockets with 503 and frees on close |
