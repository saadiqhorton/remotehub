import { el } from './dom.js';
import { DesktopInputCapture } from './desktop-input-capture.js';
import { DESKTOP_CLOSE, createWebSocketTunnel } from './desktop-tunnel.js';
import { api } from './api.js';
import { fetchVncExplanation } from './vnc-check.js';
import { createBackendChooser, describeSelection, missingServiceExplanation } from './desktop-backends.js'; // SAA-306
import { selectDesktopBackend } from './desktop-auto.js';
import { readSoundOn, saveSoundOn } from './desktop-sound-pref.js'; // remote sound on/off, per browser
import { DesktopAudio } from './desktop-audio.js';
import { AgentSoundChannel } from './desktop-sound-channel.js';

export const VNC_CHECKING_SUFFIX = 'Finding out why…'; // SAA-346
// SAA-352: after a size request (or the connection's first remote size), a different remote size
// within this many ms counts as this computer refusing the resize.
export const RESIZE_CONFIRM_MS = 5000;
// Full-screen toolbar: shown this long on entry, and hidden this long after the pointer leaves.
export const TOOLBAR_INTRO_MS = 3000;
export const TOOLBAR_LEAVE_MS = 500;
const RESIZE_FALLBACK_MESSAGE = 'This computer can’t change its screen size. Reconnecting at its own size…'; // SAA-352

// Browser desktop surface (SAA-303). Apache Guacamole.Client owns protocol parsing, streams,
// display rendering, synchronization, keyboard/mouse events, and keep-alives. RemoteHub
// retains the bridge lifecycle, credential prompts, resize fallback, reconnect and trust UI.
//
// View states: idle → connecting → (authentication) → ready → disconnected, plus the
// error states unavailable and failed. `reason` (also data-reason on the pane) says
// exactly which refusal or close code produced the state.
export const DESKTOP_STATES = Object.freeze(['idle', 'connecting', 'authentication', 'ready', 'unavailable', 'failed', 'disconnected']);
const LIVE = new Set(['connecting', 'authentication', 'ready']);
const ARGV_LABELS = { password: 'Password', username: 'Username', domain: 'Domain' };

// Close code → [state, reason, message]. See deploy/guacd.md "Refusals and close codes".
export const CLOSE_STATES = Object.freeze({
  1000: ['disconnected', 'normal', 'The desktop session ended.'],
  1003: ['failed', 'binary-frame', 'Something went wrong with the desktop connection. Click Reconnect to try again.'],
  1007: ['failed', 'malformed', 'Something went wrong with the desktop connection. Click Reconnect to try again.'],
  1008: ['failed', 'protocol', 'The desktop connection didn’t start properly. Click Reconnect to try again.'],
  1011: ['failed', 'remote-error', 'The remote desktop ran into a problem. Click Reconnect to try again.'],
  4401: ['failed', 'login', 'Your RemoteHub session expired. Log in again to reconnect.'],
  4403: ['failed', 'origin', 'RemoteHub didn’t accept this page’s address. Open RemoteHub from its usual address, or ask whoever set it up to add this address.'],
  4404: ['unavailable', 'not-configured', 'No desktop is set up for this computer.'],
  // SAA-304 RDP certificate pinning. 4409 fails closed; only the owner's explicit
  // "Trust new certificate" (DELETE /api/hosts/:id/desktop/cert-pin) moves past it.
  4409: ['failed', 'cert-changed', 'This computer’s remote desktop looks different from the last time you connected. If you expected that (for example, the computer was reinstalled), click “Trust this computer again”. If not, don’t connect.'],
  4410: ['unavailable', 'cert-check-failed', 'RemoteHub couldn’t reach this computer’s remote desktop. Click Reconnect to try again.'],
  4502: ['disconnected', 'backend-lost', 'Desktop stopped unexpectedly in RemoteHub. Click Reconnect to try again.'],
  4503: ['unavailable', 'backend-down', 'Desktop isn’t available in RemoteHub right now. Try again in a minute.'],
});
// HTTP 403 (Origin) and 503 (session limit) refuse the upgrade itself; a browser sees only
// an error and close 1006 with no open, so both land here.
const REFUSED = ['unavailable', 'refused', 'RemoteHub couldn’t open this desktop. Close any desktop tabs you aren’t using, then click Reconnect.'];

// ── Automatic reconnect (SAA-347) ─────────────────────────────
// Same idea as the Apache Guacamole web client (guacamole-client, guacamole/src/main/
// frontend/src/app/client/directives/guacClientNotification.js: CLIENT_AUTO_RECONNECT /
// TUNNEL_AUTO_RECONNECT allow-lists of "upstream unreachable / busy / timed out" status
// codes, and RECONNECT_COUNTDOWN shown as "Reconnecting in N seconds..." (translations/
// en.json TEXT_RECONNECT_COUNTDOWN) and ticked once a second by notification/directives/
// guacNotification.js). guacamole-common-js maps WebSocket close 1006 to UPSTREAM_NOT_FOUND
// (modules/Status.js, Status.Code.fromWebSocketCode), one of those auto-reconnect codes.
// Only an allow-list reconnects; everything else waits for the user. Differences from
// Guacamole: a shorter countdown, a retry cap with backoff, and the desktop password held
// in page memory only (a private field, never storage, cookies, the URL or the server).
export const RECONNECT_CODES = Object.freeze(new Set([1006, 1011, 4502, 4503]));
// Retry schedule: 2, 4, 8, 16 s, then every 30 s, within a 5-minute
// budget counted from the drop (time spent offline is not counted). Then the failed state.
export const RECONNECT_BACKOFF_SEC = Object.freeze([2, 4, 8, 16]);
export const RECONNECT_STEADY_SEC = 30;
export const RECONNECT_BUDGET_MS = 5 * 60 * 1000;
const WAITING_FOR_NETWORK = 'Waiting for network…';
const isOffline = () => globalThis.navigator?.onLine === false;
const RECONNECT_FAILED_MESSAGE = 'RemoteHub could not get the desktop back. Press Reconnect to try again.';
// 1006 with no completed handshake is an HTTP refusal (403 Origin, 503 session limit):
// those never reconnect on their own.
// A 1011 that follows a forwarded guacd `error` reconnects only for upstream errors
// (Guacamole status 0x02xx, e.g. UPSTREAM_TIMEOUT/UNAVAILABLE); client errors such as a
// failed sign-in (0x03xx) would just fail again, so they wait for the user.
export function reconnectDecision({ code, opened, guacStatus } = {}) {
  if (!RECONNECT_CODES.has(code)) return false;
  if (code === 1006 && opened !== true) return false;
  if (code === 1011 && Number.isFinite(guacStatus) && !(guacStatus >= 0x0200 && guacStatus < 0x0300)) return false;
  return true;
}

let nextDesktopId = 0;

// SAA-352: guacd rounds the width to even and a target may round a little more.
function nearSize(a, width, height) { return Math.abs(a.width - width) <= 8 && Math.abs(a.height - height) <= 8; }


export class DesktopSession {
  #heldPassword = ''; // SAA-347: page memory only; cleared on Disconnect, close tab, logout
  #heldArgv = new Map(); // SAA-347: answers given at the desktop's sign-in prompt (VNC and RDP), same rules

  get hasHeldPassword() { return this.#heldPassword !== '' || this.#heldArgv.size > 0; }
  forgetPassword() { this.#heldPassword = ''; this.#heldArgv.clear(); }

  constructor({
    host,
    onChange = () => {},
    onClose = () => {},
    onConnectionLost = () => {},
    createTunnel = createWebSocketTunnel,
    clipboard = globalThis.navigator?.clipboard ?? null,
    // Owner-only (every /api route needs the owner session): forget the RDP pin.
    resetCertPin = (hostId) => api(`/api/hosts/${encodeURIComponent(hostId)}/desktop/cert-pin`, { method: 'DELETE' }),
    // SAA-306: Desktop connection choice and discovery (owner-only API routes).
    setPreference = (hostId, preference) => api(`/api/hosts/${encodeURIComponent(hostId)}/desktop`, { method: 'PUT', body: { preference } }),
    discover = (hostId) => api(`/api/hosts/${encodeURIComponent(hostId)}/desktop/discover`, { method: 'POST' }),
    onSetUpAgent = null,
    // The computer's own sound via its RemoteHub agent (server/desktop-sound.js).
    createSoundChannel = (options) => new AgentSoundChannel(options),
  }) {
    this.id = `desktop-${++nextDesktopId}`;
    this.host = host;
    this.surfaceType = 'desktop';
    this.state = 'idle';
    this.reason = '';
    this.message = '';
    this.required = [];
    this.argvSent = new Set();
    this.remoteSize = { width: 0, height: 0 };
    this.fixedSize = null; // SAA-352: {width,height} once this computer refused a resize; this tab then never asks for another size
    this.resizeWatch = null;
    this.scale = 1;
    this.remoteClipboard = '';
    this.clipboardReadGeneration = 0;
    this.canvasFocused = false;
    this.deferredMetaKeys = new Set();
    this.remoteMetaKeys = new Set();
    this.suspendedMetaKeys = new Set();
    this.remoteCtrlKeys = new Set();
    this.forwardedKeysyms = new Map();
    this.soundOn = readSoundOn();
    this.audio = new DesktopAudio({ muted: !this.soundOn });
    this.hasAudio = false; // set once guacd (RDP) has opened a sound stream
    this.rdpSoundLive = false; // set once that stream delivered sound, for this connection
    this.agentSound = { type: 'idle' }; // last status from the agent sound channel
    this.soundChannel = null;
    this.agentPlayer = null;
    this.modifierProfile = 'super'; // Capture defaults to the requested Linux/Windows shortcut semantics.
    this.suppressedKeyUps = new Set();
    this.nativeKeyupKeys = new Set();
    this.resettingInput = false;
    this.pendingPaste = null;
    this.client = null;
    this.display = null;
    this.mouse = null;
    this.keyboard = null;
    Object.assign(this, { onChange, onClose, onConnectionLost, createTunnel, clipboard, resetCertPin, setPreference, discover, onSetUpAgent, createSoundChannel });
    this.backendArea = el('div', { class: 'desktop-backend-area' }); // SAA-306
    this.tunnel = null;
    this.disposed = false;

    this.canvas = el('div', { class: 'desktop-display', tabindex: '0', 'aria-label': `Remote desktop of ${host.name}` });
    this.bindDisplayShellInput();
    this.heading = el('h2', {}, host.name);
    this.statusLabel = el('span', { class: 'label' }, 'Desktop');
    this.statusText = el('p', { class: 'desktop-status-text' }, '');
    // Initial credentials: sent as the tunnel's first `credentials` message, then cleared.
    this.connectPassword = el('input', { type: 'password', name: 'desktop-password', autocomplete: 'off', 'aria-label': 'Desktop password (optional)', placeholder: 'Password (optional)' });
    this.connectForm = el('form', { class: 'desktop-connect', onsubmit: (event) => { event.preventDefault?.(); this.connect(); } },
      this.connectPassword,
      el('div', { class: 'overlay-actions' }, this.connectButton = el('button', { type: 'submit', class: 'btn primary desktop-connect-btn' }, 'Connect')));
    // guacd `required` prompt (argv): fields are built per prompt.
    this.argvFields = el('div', { class: 'desktop-argv-fields' });
    this.argvInputs = new Map();
    this.authForm = el('form', { class: 'desktop-auth', hidden: true, onsubmit: (event) => { event.preventDefault?.(); this.submitCredentials(); } },
      this.argvFields,
      el('div', { class: 'overlay-actions' }, el('button', { type: 'submit', class: 'btn primary' }, 'Sign in')));
    // RDP passwords are asked by guacd's prompt (SAA-304), never sent up front.
    if (this.isRdp) this.connectPassword.hidden = true;
    this.trustCertButton = el('button', { type: 'button', class: 'btn desktop-trust-cert', hidden: true, onclick: () => this.trustNewCertificate() }, 'Trust this computer again');
    this.disconnectButton = el('button', { type: 'button', class: 'btn desktop-disconnect', onclick: () => this.disconnect() }, 'Disconnect');
    this.closeButton = el('button', { type: 'button', class: 'btn desktop-close', onclick: () => this.onClose(this.id) }, 'Close tab');
    this.overlay = el('div', { class: 'overlay desktop-overlay' },
      el('div', { class: 'overlay-card bracketed', role: 'status', 'aria-live': 'polite' },
        this.statusLabel, this.heading, this.statusText, this.backendArea, this.connectForm, this.authForm,
        el('div', { class: 'overlay-actions' }, this.trustCertButton, this.closeButton)));
    this.captureButton = el('button', { type: 'button', class: 'btn desktop-capture', onclick: () => this.inputCapture.enter() }, 'Capture input');
    this.releaseCaptureButton = el('button', { type: 'button', class: 'btn desktop-release-capture', hidden: true, onclick: () => this.inputCapture.exit() }, 'Release input');
    this.fullscreenCaptureButton = el('button', { type: 'button', class: 'btn desktop-fullscreen-capture', hidden: true, onclick: () => this.inputCapture.enter({ fullscreen: true }) }, 'Full-screen capture');
    this.captureStatus = el('span', { class: 'desktop-capture-status', role: 'status', 'aria-live': 'polite' });
    this.modifierProfileSelect = el('select', { class: 'desktop-modifier-profile', 'aria-label': 'Remote Win or Command key', onchange: () => {
      this.releaseInput(); // Release the old mapping before changing the meaning of a held key.
      this.modifierProfile = this.modifierProfileSelect.value === 'meta' ? 'meta' : 'super';
    } }, el('option', { value: 'super' }, 'Super / Windows'), el('option', { value: 'meta' }, 'Meta / Command'));
    this.modifierProfileSelect.value = this.modifierProfile;
    this.soundButton = el('button', { type: 'button', class: 'btn desktop-sound', hidden: true, onclick: () => this.toggleSound() }, this.soundOn ? 'Sound on' : 'Sound off');
    this.modifierProfileLabel = el('label', { class: 'desktop-modifier-label' }, el('span', { class: 'desktop-modifier-text' }, 'Remote Win/Command key '), this.modifierProfileSelect);
    // In full screen the toolbar floats over the desktop and hides, so the remote gets the
    // whole screen. This tab (shown only in full screen) brings it back.
    this.toolbarHandle = el('button', { type: 'button', class: 'desktop-toolbar-handle', 'aria-label': 'Show desktop controls', 'aria-expanded': 'false',
      // Held like the entry reveal, so it also hides if the pointer never reaches the toolbar.
      onclick: () => this.revealToolbar({ holdMs: TOOLBAR_INTRO_MS }), onmouseenter: () => this.revealToolbar({ holdMs: TOOLBAR_INTRO_MS }) }, 'Controls');
    this.toolbar = el('div', { class: 'desktop-toolbar', onmouseenter: () => { this.toolbarHovered = true; this.revealToolbar(); },
      onmouseleave: () => { this.toolbarHovered = false; this.hideToolbarSoon(TOOLBAR_LEAVE_MS); },
      onfocusin: () => this.revealToolbar(), onfocusout: () => this.hideToolbarSoon(TOOLBAR_LEAVE_MS) },
      this.captureStatus, this.modifierProfileLabel, this.soundButton, this.captureButton, this.fullscreenCaptureButton, this.releaseCaptureButton, this.disconnectButton);
    this.viewport = el('div', { class: 'desktop-viewport' }, this.canvas);
    this.pane = el('div', { class: 'pane desktop-pane bracketed', role: 'tabpanel', id: `pane-${this.id}`, tabindex: '-1', 'data-state': 'idle' },
      this.viewport, this.toolbarHandle, this.toolbar, this.overlay);
    // Browsers start Web Audio suspended until a user gesture; any click or key in this
    // tab (Connect, the desktop, the toolbar) unlocks sound.
    for (const type of ['pointerdown', 'keydown']) this.pane.addEventListener(type, () => this.unlockAudio(), true);
    this.pane.addEventListener('keydown', (event) => {
      if (this.inputCapture?.requested && event.ctrlKey && event.altKey && event.shiftKey && (event.key === 'Escape' || event.code === 'Escape')) {
        event.preventDefault?.(); event.stopImmediatePropagation?.();
        this.inputCapture.exit();
      }
    }, true);
    this.inputCapture = new DesktopInputCapture({ element: this.pane,
      canEnter: () => !this.disposed && this.state === 'ready' && this.pane.classList.contains('active'),
      onRelease: () => this.releaseInput(), onFocus: () => this.focus(), onChange: () => this.renderCapture() });
    this.renderState();
  }

  get isRdp() { return this.host?.desktop?.protocol === 'rdp'; }
  get label() { return `${this.host.name} · Desktop`; }
  get endpoint() {
    const d = this.host.desktop;
    return d ? `${d.protocol}://${this.host.address}:${d.port}` : `${this.host.username}@${this.host.address}${this.host.port === 22 ? '' : `:${this.host.port}`}`;
  }

  // ── workspace contract ────────────────────────────────────────
  mount(stage) {
    stage.append(this.pane);
    if (typeof ResizeObserver === 'function') {
      // Rescale at once so the picture never overflows while the size settles; ask the
      // remote for the new size only after the debounce.
      this.resizeObserver = new ResizeObserver(() => { this.applyScale(); this.scheduleFit(); });
      this.resizeObserver.observe(this.viewport);
    }
    // Keys held when the page is hidden or unloaded would otherwise stay pressed remotely.
    this.onVisibility = () => {
      if (globalThis.document?.visibilityState === 'hidden' || globalThis.document?.hidden === true) {
        this.canvasFocused = false;
        this.inputCapture.exit();
      } else {
        if (this.pane.classList.contains('active') && this.canvas.contains(globalThis.document?.activeElement)) this.canvasFocused = true;
        this.retryNow(); // SAA-347: tab visible again → retry a pending reconnect at once
      }
    };
    this.onPageHide = () => { this.canvasFocused = false; this.inputCapture.exit(); };
    this.onWindowBlur = () => { this.canvasFocused = false; this.inputCapture.exit(); };
    this.onWindowFocus = () => {
      if (this.pane.classList.contains('active') && this.canvas.contains(globalThis.document?.activeElement)) this.canvasFocused = true;
    };
    this.onFullscreen = () => { this.inputCapture.fullscreenChanged(); this.fullscreenToolbarChanged(); };
    globalThis.document?.addEventListener?.('fullscreenchange', this.onFullscreen);
    this.onOnline = () => this.retryNow(); // SAA-347
    this.onOffline = () => this.pauseForNetwork(); // SAA-347
    globalThis.document?.addEventListener?.('visibilitychange', this.onVisibility);
    globalThis.window?.addEventListener?.('pagehide', this.onPageHide);
    globalThis.window?.addEventListener?.('blur', this.onWindowBlur);
    globalThis.window?.addEventListener?.('focus', this.onWindowFocus);
    globalThis.window?.addEventListener?.('online', this.onOnline);
    globalThis.window?.addEventListener?.('offline', this.onOffline);
  }
  show() { this.pane.classList.add('active'); this.scheduleFit(); this.focus(); }
  hide() { this.pane.classList.remove('active'); this.canvasFocused = false; this.inputCapture.exit(); }
  focus() {
    if (!this.pane.classList.contains('active')) return;
    if (this.state === 'ready') { this.canvas.focus(); this.canvasFocused = true; }
    else if (this.state === 'authentication') this.argvInputs.values().next().value?.focus();
    else this.pane.focus();
  }
  setTheme() {}
  updateHost(host) {
    // SAA-347 review: a held password belongs to the endpoint it was typed for. If the
    // address, port or protocol changes, forget it, stop any pending reconnect, and never
    // reconnect on our own to the new endpoint (the user connects again explicitly).
    const was = this.host;
    const moved = was?.address !== host?.address || was?.desktop?.port !== host?.desktop?.port || was?.desktop?.protocol !== host?.desktop?.protocol;
    if (moved) {
      this.forgetPassword();
      this.wasLive = false;
      // In-flight auto-retry has a tunnel and no countdown; still abort it before the new host applies.
      const wasAuto = this.autoReconnecting;
      const counting = this.cancelReconnect() || this.reason === 'waiting-network' || wasAuto;
      this.autoReconnecting = false;
      if (wasAuto && this.tunnel) {
        const tunnel = this.tunnel;
        const client = this.client;
        this.tunnel = null;
        this.client = null; this.display = null;
        this.releaseInput();
        if (client) client.disconnect(); else tunnel.close();
      }
      if (counting && !this.tunnel) {
        this.host = host;
        this.setState('disconnected', 'host-changed', 'This computer’s details changed. Press Reconnect to connect again.');
      }
      this.fixedSize = null; this.endResizeWatch(); this.pane.removeAttribute?.('data-resize'); // SAA-352: a new endpoint may resize fine
    }
    this.host = host; this.heading.textContent = host.name; this.canvas.setAttribute('aria-label', `Remote desktop of ${host.name}`); }
  dispose() {
    this.disposed = true;
    this.disconnect({ silent: true });
    this.syncSound(); // disposed: closes the agent sound channel
    this.cancelReconnect();
    this.endResizeWatch(); // SAA-352
    this.forgetPassword();
    this.resizeObserver?.disconnect();
    globalThis.document?.removeEventListener?.('visibilitychange', this.onVisibility);
    globalThis.document?.removeEventListener?.('fullscreenchange', this.onFullscreen);
    globalThis.window?.removeEventListener?.('pagehide', this.onPageHide);
    globalThis.window?.removeEventListener?.('blur', this.onWindowBlur);
    globalThis.window?.removeEventListener?.('focus', this.onWindowFocus);
    globalThis.window?.removeEventListener?.('online', this.onOnline);
    globalThis.window?.removeEventListener?.('offline', this.onOffline);
    clearTimeout(this.fitTimer);
    clearTimeout(this.toolbarTimer);
    this.pane.remove();
  }

  // ── connection lifecycle ──────────────────────────────────────
  viewportSize() {
    return {
      width: Math.max(320, Math.round(this.viewport.clientWidth || 1024)),
      height: Math.max(240, Math.round(this.viewport.clientHeight || 768)),
    };
  }

  // User-initiated connect (Connect / Reconnect button): a fresh retry budget.
  connect() {
    if (this.disposed || LIVE.has(this.state)) return;
    this.cancelReconnect();
    this.reconnectAttempt = 0;
    this.autoReconnecting = false;
    // A drop reconnects on its own only once this chain has shown the desktop.
    this.wasLive = false;
    const typed = this.isRdp ? '' : (this.connectPassword.value || '');
    if (typed) this.#heldPassword = typed;
    this.openTunnel();
  }

  openTunnel() {
    this.inputCapture.exit();
    this.rdpSoundLive = false; // a new connection proves RDP sound afresh
    // A new client has no remote key state. Reset Guac's physical-key and modifier
    // snapshots before binding it so keys held through a drop cannot bleed across.
    this.releaseInput();
    this.drawGeneration = (this.drawGeneration ?? 0) + 1;
    const password = this.isRdp ? '' : this.#heldPassword;
    this.connectPassword.value = '';
    this.everReady = false;
    this.noteVncAttempt(Boolean(password));
    this.argvSent = new Set();
    this.required = [];
    this.lastSentSize = null;
    this.endResizeWatch();
    this.remoteSize = { width: 0, height: 0 };
    this.visibleImageStreams = new Set();
    this.painted = false;
    this.remoteError = null;
    this.remoteErrorStatus = undefined;
    if (!this.autoReconnecting) this.setState('connecting', 'connecting', 'Connecting to the desktop…');
    else this.setState('connecting', 'reconnecting-now', 'Reconnecting to the desktop…');
    let tunnel;
    const size = this.fixedSize ?? this.viewportSize();
    try { tunnel = this.createTunnel({ host: this.host, ...size, dpi: 96, password, ...(this.fixedSize ? { fixed: true } : {}) }); }
    catch { this.setState('unavailable', 'no-tunnel', 'Desktop is unavailable. Reload the page and try again.'); return; }
    this.tunnel = tunnel;
    this.watchResize(size.width, size.height, { handshake: true });
    const Guac = globalThis.Guacamole;
    const generation = this.drawGeneration;
    const client = this.client = new Guac.Client(tunnel);
    this.display = client.getDisplay();
    const displayElement = this.display.getElement();
    displayElement.classList?.add('desktop-guac-display');
    this.canvas.replaceChildren(displayElement);
    const markCanvas = () => {
      const canvas = this.display.getDefaultLayer().getCanvas();
      canvas.classList?.add('desktop-canvas');
      canvas.tabIndex = 0;
      canvas.setAttribute?.('aria-label', `Remote desktop of ${this.host.name}`);
    };
    this.display.onresize = (width, height) => {
      if (this.tunnel !== tunnel || this.drawGeneration !== generation) return;
      this.remoteSize = { width, height };
      markCanvas();
      this.scheduleFit();
    };
    client.onerror = (status) => {
      if (this.tunnel !== tunnel || this.drawGeneration !== generation) return;
      this.remoteErrorStatus = Number(status?.code);
      this.remoteError = 'The remote desktop ran into a problem. Click Reconnect to try again.';
    };
    client.onstatechange = (state) => {
      if (this.tunnel !== tunnel || this.drawGeneration !== generation) return;
      if (state === Guac.Client.State.CONNECTED) this.everReady = true;
      markCanvas();
    };
    client.onrequired = (names) => { if (this.tunnel === tunnel && this.drawGeneration === generation) this.onRequired(names); };
    client.onsync = () => {
      if (this.tunnel !== tunnel || this.drawGeneration !== generation) return;
      markCanvas();
      if (this.state !== 'connecting' || !this.remoteSize.width) return;
      if (!this.painted) { if (this.reason !== 'loading') this.setState('connecting', 'loading', 'Loading the screen…'); return; }
      this.display.flush(() => {
        if (this.tunnel !== tunnel || this.client !== client || this.drawGeneration !== generation || this.state !== 'connecting' || !this.painted) return;
        this.wasLive = true;
        this.reconnectAttempt = 0;
        this.autoReconnecting = false;
        this.setState('ready', 'ready', '');
      });
    };
    client.onclipboard = (stream, mimetype) => { if (this.tunnel === tunnel && this.drawGeneration === generation) this.receiveClipboard(stream, mimetype); };
    client.onaudio = (stream, mimetype) => (this.tunnel === tunnel && this.drawGeneration === generation ? this.playAudio(Guac, stream, mimetype) : null);
    this.bindOfficialInput(displayElement);
    tunnel.onrawinstruction = (opcode, args) => {
      if (this.tunnel !== tunnel || this.client !== client || this.drawGeneration !== generation) return false;
      this.observeInstruction(opcode, args);
      return this.tunnel === tunnel && this.client === client && this.drawGeneration === generation;
    };
    tunnel.onclose = (event) => {
      if (this.tunnel !== tunnel) return;
      this.inputCapture.exit();
      if (this.client) this.client.disconnect();
      this.endResizeWatch();
      this.lastCloseCode = event?.code;
      if (this.maybeAutoReconnect(event)) return;
      this.handleClose(event);
      this.endedBeforeFirstFrame(event);
      this.explainVncFailure(event);
      this.afterStop();
    };
    tunnel.onerror = (error) => { this.lastError = error?.message || 'Desktop connection error'; };
    try { this.client.connect(); }
    catch {
      this.tunnel = null;
      this.setState('unavailable', 'no-tunnel', 'Desktop is unavailable. Reload the page and try again.');
    }
  }

  observeInstruction(opcode, args) {
    if (opcode === 'size' && args[0] === '0') {
      const activeTunnel = this.tunnel;
      const width = Number(args[1]), height = Number(args[2]);
      this.noteRemoteSize(width, height);
      if (this.tunnel !== activeTunnel) return;
      this.remoteSize = { width, height };
      this.scheduleFit();
    }
    else if (opcode === 'ready') {
      this.everReady = true;
      if (this.state === 'connecting') this.setState('connecting', 'starting', 'Starting the remote desktop…');
    }
    else if (opcode === 'error') {
      this.remoteErrorStatus = args[1] ? Number(args[1]) : undefined;
      this.remoteError = 'The remote desktop ran into a problem. Click Reconnect to try again.';
      if (this.resizeWatch && !this.resizeWatch.handshake) this.fallBackToFixedSize(this.resizeWatch.accepted.width, this.resizeWatch.accepted.height);
    }
    if (opcode === 'sync') this.lastSync = args[0];
    const visibleLayer = (value) => Number.isFinite(Number(value)) && Number(value) >= 0;
    if ((['png', 'jpeg', 'webp'].includes(opcode) && visibleLayer(args[1]))
      || (opcode === 'cfill' && visibleLayer(args[1]))
      || (opcode === 'copy' && visibleLayer(args[6]))
      || (opcode === 'transfer' && visibleLayer(args[6]))) this.painted = true;
    if (opcode === 'img' && visibleLayer(args[2])) this.visibleImageStreams.add(args[0]);
    if (opcode === 'end' && this.visibleImageStreams.delete(args[0])) this.painted = true;
  }

  onRequired(names) {
    const required = names.filter((name) => !this.argvSent.has(name));
    if (!required.length) return;
    const held = (name) => this.#heldArgv.get(name) ?? (name === 'password' && this.#heldPassword ? this.#heldPassword : undefined);
    if (this.autoReconnecting && required.every((name) => held(name) !== undefined)) {
      for (const name of required) this.sendArgv(name, held(name));
      this.setState('connecting', 'reconnecting-now', 'Reconnecting to the desktop…');
      return;
    }
    this.required = required;
    this.buildArgvForm(required);
    this.setState('authentication', 'required', 'This desktop needs you to sign in.');
  }

  buildArgvForm(names) {
    this.argvInputs = new Map(names.map((name) => [name, el('input', {
      type: name === 'password' ? 'password' : 'text', name: `argv-${name}`, autocomplete: 'off', 'aria-label': ARGV_LABELS[name] || name, placeholder: ARGV_LABELS[name] || name,
    })]));
    this.argvFields.replaceChildren(...this.argvInputs.values());
  }

  submitCredentials() {
    if (this.state !== 'authentication' || !this.client) return;
    for (const name of this.required) {
      if (this.argvSent.has(name)) continue;
      const input = this.argvInputs.get(name);
      const value = input?.value ?? '';
      this.sendArgv(name, value);
      this.#heldArgv.set(name, value);
      if (input) input.value = '';
    }
    this.required = [];
    this.argvInputs = new Map();
    this.argvFields.replaceChildren();
    this.setState('connecting', 'signing-in', 'Signing in…');
  }

  sendArgv(name, value) {
    const stream = this.client.createArgumentValueStream('text/plain', name);
    const writer = new globalThis.Guacamole.StringWriter(stream);
    writer.sendText(value);
    writer.sendEnd();
    this.argvSent.add(name);
    if (name === 'password') this.vncPasswordGiven = true;
  }

  disconnect({ silent = false } = {}) {
    this.inputCapture.exit();
    const tunnel = this.tunnel;
    // Offline wait clears the countdown timer already, so cancelReconnect() is false there;
    // still leave connecting/waiting-network (and any other auto-reconnect) for Disconnect.
    const wasReconnecting = this.cancelReconnect() || this.autoReconnecting || this.reason === 'waiting-network';
    this.autoReconnecting = false;
    this.endResizeWatch(); // SAA-352
    this.forgetPassword(); // SAA-347: Disconnect forgets the desktop password
    this.releaseInput();
    const client = this.client;
    this.tunnel = null;
    this.client = null; this.display = null;
    this.audio.stopAll(); // nothing keeps playing after Disconnect
    if (client) client.disconnect(); else if (tunnel) tunnel.close();
    if (!silent && (tunnel || wasReconnecting)) this.setState('disconnected', 'user', 'You disconnected from the desktop.');
  }

  handleClose({ code, reason, opened } = {}) {
    this.tunnel = null;
    this.audio.stopAll();
    if (this.client) this.client.disconnect();
    // A local parser failure is a concrete protocol error (1007). The Client may
    // also report its generic transport status before the adapter's close callback;
    // keep the more specific public close classification in that case.
    if (code === 1007) this.remoteError = null;
    if (this.remoteError) {
      const message = this.remoteError;
      this.remoteError = null;
      return this.setState('failed', 'remote-error', message);
    }
    if (opened === false && !CLOSE_STATES[code]) return this.setState(...REFUSED);
    const known = CLOSE_STATES[code];
    if (known) {
      const [state, why, fallback] = known;
      const message = code === 1000 || code === 4401 || code === DESKTOP_CLOSE.ORIGIN || code === DESKTOP_CLOSE.CERT_CHANGED ? fallback
        : (reason || fallback);
      this.setState(state, why, message);
      if (code === DESKTOP_CLOSE.AUTH) this.onConnectionLost();
      return;
    }
    if (!this.everReady) this.setState('failed', `code-${code}`, 'Could not connect to the desktop. Click Reconnect to try again.');
    else this.setState('disconnected', `code-${code}`, 'The desktop connection was lost. Click Reconnect to try again.');
  }

  // ── automatic reconnect (SAA-347) ─────────────────────────────
  // Returns true when the close was taken over by a countdown or the capped failed state.
  maybeAutoReconnect(event = {}) {
    if (this.disposed) return false;
    const chain = this.wasLive || this.autoReconnecting;
    const guacStatus = this.remoteError ? this.remoteErrorStatus : undefined;
    if (!chain || !reconnectDecision({ ...event, guacStatus })) return false;
    this.tunnel = null;
    this.remoteError = null;
    if (!this.autoReconnecting) { this.budgetUsedMs = 0; this.budgetSince = Date.now(); }
    this.autoReconnecting = true;
    this.scheduleNextAttempt();
    return true;
  }

  // Budget time used so far (offline time excluded: the clock stops while waiting).
  budgetUsed() { return this.budgetUsedMs + (this.budgetSince == null ? 0 : Date.now() - this.budgetSince); }

  scheduleNextAttempt() {
    if (isOffline()) return this.pauseForNetwork();
    const delay = RECONNECT_BACKOFF_SEC[this.reconnectAttempt] ?? RECONNECT_STEADY_SEC;
    if (this.budgetUsed() + delay * 1000 > RECONNECT_BUDGET_MS) {
      this.autoReconnecting = false;
      this.setState('failed', 'reconnect-failed', RECONNECT_FAILED_MESSAGE);
      return;
    }
    this.startCountdown(delay);
  }

  startCountdown(seconds) {
    this.cancelReconnect();
    let remaining = seconds;
    const show = () => this.setState('connecting', 'reconnecting', `The connection to the desktop dropped. Reconnecting in ${remaining}…`);
    show();
    this.reconnectTimer = setInterval(() => {
      remaining -= 1;
      if (remaining > 0) return show();
      this.attemptReconnect();
    }, 1000);
    this.reconnectTimer.unref?.();
  }

  attemptReconnect() {
    this.cancelReconnect();
    if (this.disposed || !this.autoReconnecting || this.tunnel) return;
    this.reconnectAttempt += 1;
    this.openTunnel();
  }

  // A reconnect is pending (countdown or waiting for network) and no attempt is in flight.
  get reconnectPending() { return this.autoReconnecting && !this.tunnel && !this.disposed && ['reconnecting', 'waiting-network'].includes(this.reason); }

  // Tab visible again or network back: skip the rest of the countdown.
  retryNow() {
    if (!this.reconnectPending || isOffline()) return;
    if (this.budgetSince == null) this.budgetSince = Date.now(); // resume the budget clock
    this.attemptReconnect();
  }

  // Offline: stop counting down and stop the budget clock; no attempt is used up.
  pauseForNetwork() {
    if (!this.reconnectPending && !(this.autoReconnecting && !this.tunnel)) return;
    this.cancelReconnect();
    if (this.budgetSince != null) { this.budgetUsedMs += Date.now() - this.budgetSince; this.budgetSince = null; }
    this.setState('connecting', 'waiting-network', WAITING_FOR_NETWORK);
  }

  cancelReconnect() {
    const pending = Boolean(this.reconnectTimer);
    clearInterval(this.reconnectTimer);
    this.reconnectTimer = null;
    return pending;
  }

  // A stop that waits for the user: keep the password only for the capped failed state's
  // Reconnect button; a session that never worked (e.g. wrong password) forgets it.
  afterStop() {
    this.autoReconnecting = false;
    if (!this.wasLive) this.forgetPassword();
    if (this.reason === 'login') this.forgetPassword();
  }

  // ── clipboard (text/plain both ways), using Apache Client streams ──
  receiveClipboard(stream, mimetype) {
    if (mimetype !== 'text/plain') { stream.sendAck('Unsupported clipboard type', 0x0100); return; }
    const reader = new globalThis.Guacamole.StringReader(stream);
    const decodeBlob = stream.onblob;
    stream.onblob = (data) => { decodeBlob(data); stream.sendAck('OK', 0); };
    let text = '';
    reader.ontext = (chunk) => { text += chunk; };
    reader.onend = () => {
      this.remoteClipboard = text;
      this.lastSentClipboard = text;
      this.clipboard?.writeText?.(text).catch?.(() => {});
    };
  }

  sendClipboard(text) {
    if (this.state !== 'ready' || !this.client || typeof text !== 'string' || text === this.lastSentClipboard) return;
    this.lastSentClipboard = text;
    const stream = this.client.createClipboardStream('text/plain');
    const writer = new globalThis.Guacamole.StringWriter(stream);
    writer.sendText(text);
    writer.sendEnd();
  }

  async syncLocalClipboard() {
    const readGeneration = ++this.clipboardReadGeneration;
    const client = this.client;
    const tunnel = this.tunnel;
    const drawGeneration = this.drawGeneration;
    try {
      const text = await this.clipboard?.readText?.();
      if (text && readGeneration === this.clipboardReadGeneration && this.canvasFocused
          && this.pane.classList.contains('active') && !this.disposed && this.state === 'ready'
          && this.client === client && this.tunnel === tunnel && this.drawGeneration === drawGeneration) this.sendClipboard(text);
    } catch { /* clipboard permission denied */ }
  }

  // ── display and local scaling (Apache owns rendering and remote dimensions) ──
  // The remote desktop always follows the space this tab has: the window, the browser's
  // full screen, or full-screen capture. Normal mode only downscales; while input is
  // captured the picture may also upscale, so a computer that refused a resize (SAA-352)
  // still fills the screen.
  applyScale() {
    const { width, height } = this.remoteSize;
    if (!width || !height || !this.display) return;
    const fit = Math.min((this.viewport.clientWidth || width) / width, (this.viewport.clientHeight || height) / height);
    this.scale = this.inputCapture?.requested ? fit : Math.min(1, fit);
    this.display.scale(this.scale);
  }
  scheduleFit() { clearTimeout(this.fitTimer); this.fitTimer = setTimeout(() => this.fit(), 120); }
  fit() {
    this.applyScale();
    if (this.state !== 'ready' || !this.client || !this.remoteSize.width || this.fixedSize) return;
    const { width, height } = this.viewportSize();
    if (width === this.lastSentSize?.width && height === this.lastSentSize?.height) return;
    this.lastSentSize = { width, height };
    this.client.sendSize(width, height);
    if (!nearSize(this.remoteSize, width, height)) this.watchResize(width, height);
  }

  // ── remote sound ───────────────────────────────────────────────
  // guacd sends raw PCM (audio/L16 or L8) once the desktop has sound on (RDP; see
  // server/rdp.js). This tab's DesktopAudio plays it through Web Audio and tracks every
  // scheduled chunk, so muting silences queued sound at once (desktop-audio.js).
  //
  // Two sources, picked automatically:
  //  - RDP sound from guacd, once it actually delivers sound (a stock xrdp opens a stream
  //    that stays silent, so an open stream alone proves nothing);
  //  - otherwise the computer's own sound from its RemoteHub agent, which works for RDP
  //    and VNC alike. It plays until RDP sound arrives, then stops, so nothing doubles.
  playAudio(Guac, stream, mimetype) {
    const player = this.audio.play(Guac, stream, mimetype, { onData: () => {
      if (this.rdpSoundLive) return;
      this.rdpSoundLive = true;
      this.syncSound(); // RDP carries sound: stop the agent's copy
      this.renderCapture();
    } });
    if (!player) return null; // Guacamole then tries its own player, else acks "BAD TYPE"
    if (!this.hasAudio) { this.hasAudio = true; this.renderCapture(); }
    return player;
  }
  // The agent channel is open exactly while this tab shows a desktop, wants sound, and
  // RDP isn't already delivering it.
  syncSound() {
    const wanted = !this.disposed && this.state === 'ready' && this.soundOn && !this.rdpSoundLive;
    if (wanted && !this.soundChannel) {
      this.soundChannel = this.createSoundChannel({
        hostId: this.host.id,
        onStatus: (status) => this.agentSoundStatus(status),
        onPcm: (data) => this.agentPlayer?.push(data),
      });
      this.soundChannel.open();
    } else if (!wanted && this.soundChannel) {
      this.soundChannel.close();
      this.soundChannel = null;
      this.agentPlayer?.stop();
      this.agentPlayer = null;
      this.agentSound = { type: 'idle' };
      this.renderCapture();
    }
  }
  agentSoundStatus(status) {
    if (!this.soundChannel) return;
    this.agentPlayer?.stop();
    this.agentPlayer = status.type === 'format' ? this.audio.playPcm(globalThis.Guacamole, status.mimetype) : null;
    this.agentSound = status.type === 'format' && !this.agentPlayer
      ? { type: 'unavailable', reason: 'This browser can’t play the computer’s sound.' }
      : status;
    this.renderCapture();
  }
  unlockAudio() {
    // Any desktop may have sound now (RDP, or the agent for RDP and VNC alike).
    if (!this.soundOn) return;
    try {
      const context = globalThis.Guacamole?.AudioContextFactory?.getAudioContext?.();
      if (context?.state === 'suspended') Promise.resolve(context.resume?.()).catch(() => {});
    } catch { /* Web Audio unavailable */ }
  }
  toggleSound() {
    this.soundOn = !this.soundOn;
    this.audio.setMuted(!this.soundOn);
    saveSoundOn(this.soundOn);
    this.syncSound(); // muted: the agent stops recording; unmuted: it starts again
    this.renderCapture();
    this.unlockAudio();
  }
  // What the Sound button says: on, off, or why there's nothing to hear.
  soundSummary() {
    if (!this.soundOn) return { label: 'Sound off', detail: 'Sound off. Turn remote sound on' };
    const agent = this.agentSound;
    const silent = !this.hasAudio && (agent.type === 'waiting' || agent.type === 'unavailable' || agent.type === 'closed');
    if (!silent) return { label: 'Sound on', detail: 'Sound on. Turn remote sound off' };
    const why = agent.type === 'unavailable'
      ? agent.reason
      : 'This computer’s RemoteHub agent isn’t connected, so its sound can’t reach you. Set up the agent for this computer to hear it.';
    return { label: 'No sound', detail: `No sound. ${why}` };
  }

  // ── full-screen toolbar ────────────────────────────────────────
  get isFullscreen() { return globalThis.document?.fullscreenElement === this.pane; }
  revealToolbar({ holdMs = 0 } = {}) {
    clearTimeout(this.toolbarTimer);
    this.pane.setAttribute('data-toolbar', 'shown');
    this.toolbarHandle.setAttribute('aria-expanded', 'true');
    if (holdMs) this.hideToolbarSoon(holdMs);
  }
  hideToolbarSoon(ms) {
    clearTimeout(this.toolbarTimer);
    this.toolbarTimer = setTimeout(() => {
      // Stay open while the pointer is on it or keyboard focus is inside it.
      if (this.toolbarHovered || this.toolbar.contains(globalThis.document?.activeElement)) return;
      this.pane.removeAttribute('data-toolbar');
      this.toolbarHandle.setAttribute('aria-expanded', 'false');
    }, ms);
  }
  fullscreenToolbarChanged() {
    // Show the controls (and the exit hint) briefly on entering full screen.
    if (this.isFullscreen) this.revealToolbar({ holdMs: TOOLBAR_INTRO_MS });
    else { clearTimeout(this.toolbarTimer); this.toolbarHovered = false; this.pane.removeAttribute('data-toolbar'); this.toolbarHandle.setAttribute('aria-expanded', 'false'); }
  }

  bindDisplayShellInput() {
    // Create paste intent only from DOM keydowns. Guac.Keyboard also calls its
    // callbacks internally for key repeat, which must not create phantom intent.
    this.canvas.addEventListener('keydown', (event) => {
      if (this.inputCapture?.requested) {
        // Upstream deliberately buffers a standalone Meta until another DOM event.
        // Press it now through its public API; the queued press is idempotent and
        // upstream still owns physical keyup, modifiers and queue/reset cleanup.
        const meta = event.key === 'Meta' || (event.key !== 'Super' && (event.code === 'MetaLeft' || event.code === 'MetaRight'));
        if (meta && this.keyboard && this.state === 'ready') {
          const right = event.location === 2 || event.code === 'MetaRight' || (event.which || event.keyCode) === 92;
          this.keyboard.press(65511 + (right ? 1 : 0));
          event.preventDefault?.();
        }
        return; // Forward original remote chords, including Super+V, instead of native paste.
      }
      const isPasteKey = event.key === 'v' || event.key === 'V' || event.code === 'KeyV'
        || (event.which || event.keyCode) === 86;
      if (this.pendingPaste) this.cancelPendingPaste();
      if (!isPasteKey) return;
      this.nativeKeyupKeys.delete(0x76);
      this.nativeKeyupKeys.delete(0x56);
      const keysym = event.key === 'V' ? 0x56 : 0x76;
      this.suppressedKeyUps.delete(keysym);
      const pasteChord = Boolean(event.ctrlKey || event.metaKey);
      if (!pasteChord) return;

      const commandMetaKeys = new Set([...this.deferredMetaKeys, ...this.remoteMetaKeys]);
      ++this.clipboardReadGeneration;
      for (const meta of this.remoteMetaKeys) {
        this.sendKey(meta, 0);
        this.remoteMetaKeys.delete(meta);
        this.suspendedMetaKeys.add(meta);
      }
      if (event.metaKey) {
        for (const meta of this.deferredMetaKeys) this.suspendedMetaKeys.add(meta);
        for (const meta of commandMetaKeys) {
          this.suppressedKeyUps.add(meta);
          this.suspendedMetaKeys.add(meta);
        }
        this.deferredMetaKeys.clear();
      }
      this.pendingPaste = {
        kind: event.metaKey ? 'command' : 'control', keysym,
        client: this.client, tunnel: this.tunnel, drawGeneration: this.drawGeneration,
      };
      this.suppressedKeyUps.add(keysym);
    }, true);
    this.canvas.addEventListener('keyup', (event) => {
      const isPasteKey = event.key === 'v' || event.key === 'V' || event.code === 'KeyV'
        || (event.which || event.keyCode) === 86;
      if (!isPasteKey) return;
      this.nativeKeyupKeys.add(0x76);
      this.nativeKeyupKeys.add(0x56);
    }, true);
    this.canvas.addEventListener('focus', (event) => {
      this.canvasFocused = true;
      if (event.target === this.canvas) this.syncLocalClipboard();
    }, true);
    this.canvas.addEventListener('blur', () => { this.canvasFocused = false; this.cancelPendingPaste(); this.releaseInput(); }, true);
    this.canvas.addEventListener('contextmenu', (event) => event.preventDefault?.());
    this.canvas.addEventListener('paste', (event) => {
      if (this.inputCapture?.requested) { event.preventDefault?.(); return; }
      const text = event.clipboardData?.getData?.('text/plain');
      ++this.clipboardReadGeneration; // A native paste is newer than any focus snapshot still in flight.
      if (!text || !this.canvasFocused || !this.pane.classList.contains('active') || this.disposed || this.state !== 'ready' || !this.client) {
        this.cancelPendingPaste();
        return;
      }
      event.preventDefault?.();
      this.sendClipboard(text);
      const pending = this.pendingPaste;
      this.pendingPaste = null;
      if (pending && this.state === 'ready' && this.client === pending.client && this.tunnel === pending.tunnel
          && this.drawGeneration === pending.drawGeneration) {
        const synthesizeControl = (pending.kind === 'command' || pending.kind === 'control') && this.remoteCtrlKeys.size === 0;
        if (synthesizeControl) this.client.sendKeyEvent(1, 65507); // Command+V is Ctrl+V remotely.
        this.client.sendKeyEvent(1, pending.keysym);
        this.client.sendKeyEvent(0, pending.keysym);
        if (synthesizeControl) this.client.sendKeyEvent(0, 65507);
      }
    });
  }

  cancelPendingPaste() {
    ++this.clipboardReadGeneration;
    this.pendingPaste = null;
    for (const keysym of this.deferredMetaKeys) this.suppressedKeyUps.add(keysym);
    this.deferredMetaKeys.clear();
  }

  sendKey(keysym, pressed) {
    if (this.state !== 'ready' || !this.client) return;
    // VNC forwards X11 keysyms unchanged. Linux Super (Mod4) is distinct from
    // legacy Meta; RDP accepts either. Keep the actual symbol for the full press
    // so an exit/profile change cannot release a different remote modifier.
    let remote = this.forwardedKeysyms.get(keysym);
    if (remote === undefined) {
      remote = keysym;
      if (this.inputCapture?.requested) {
        if (this.modifierProfile === 'super' && (keysym === 65511 || keysym === 65512)) remote += 4;
        if (this.modifierProfile === 'meta' && (keysym === 65515 || keysym === 65516)) remote -= 4;
      }
    }
    // Some browsers expose both a named Super and a Meta modifier snapshot for
    // one physical key. Do not double-press or prematurely release the alias.
    const aliasHeld = [...this.forwardedKeysyms].some(([key, value]) => key !== keysym && value === remote);
    if (pressed) this.forwardedKeysyms.set(keysym, remote);
    else this.forwardedKeysyms.delete(keysym);
    if (!aliasHeld) this.client.sendKeyEvent(pressed, remote);
  }

  bindOfficialInput(displayElement) {
    const Guac = globalThis.Guacamole;
    this.mouse = new Guac.Mouse(displayElement);
    this.mouse.onEach(['mousedown', 'mouseup', 'mousemove'], (event) => {
      if (this.state === 'ready') this.client?.sendMouseState(event.state, true);
    });
    displayElement.addEventListener?.('mousedown', () => this.canvas.focus?.());
    if (!this.keyboard) {
      this.keyboard = new Guac.Keyboard(this.canvas);
      this.keyboard.onkeydown = (keysym) => {
        if (this.inputCapture?.requested) {
          this.sendKey(keysym, 1);
          return false;
        }
        const modifiers = this.keyboard.modifiers;
        const pasteKey = keysym === 0x76 || keysym === 0x56;

        // Guac reports the Meta key before it knows whether this is Command+V.
        // Hold that one key locally until the next key tells us whether to preserve
        // the ordinary remote shortcut or convert the paste chord to Ctrl+V.
        if (keysym === 65511 || keysym === 65512) {
          if (this.pendingPaste?.kind === 'command') {
            this.suspendedMetaKeys.add(keysym);
            this.suppressedKeyUps.add(keysym);
            return false;
          }
          this.deferredMetaKeys.add(keysym);
          return false;
        }

        if (pasteKey && (modifiers.ctrl || modifiers.meta)) {
          return true; // Raw DOM keydown created the chord; Guac repeats never create one.
        }

        // Any other key resolves a buffered Meta press as an ordinary remote key.
        for (const meta of this.deferredMetaKeys) { this.sendKey(meta, 1); this.remoteMetaKeys.add(meta); }
        this.deferredMetaKeys.clear();
        for (const meta of this.suspendedMetaKeys) {
          this.suppressedKeyUps.delete(meta);
          this.sendKey(meta, 1);
          this.remoteMetaKeys.add(meta);
        }
        this.suspendedMetaKeys.clear();
        this.sendKey(keysym, 1);
        if (keysym === 65507 || keysym === 65508) this.remoteCtrlKeys.add(keysym);
        return false; // Keep browser shortcuts such as Ctrl+W captured remotely.
      };
      this.keyboard.onkeyup = (keysym) => {
        const pasteKey = keysym === 0x76 || keysym === 0x56;
        const physicalKeyup = this.nativeKeyupKeys.delete(keysym);
        if (keysym === 0x76 || keysym === 0x56) {
          this.nativeKeyupKeys.delete(keysym === 0x76 ? 0x56 : 0x76);
        }
        if (this.suppressedKeyUps.has(keysym)) {
          if (!pasteKey || physicalKeyup || this.resettingInput) this.suppressedKeyUps.delete(keysym);
          this.suspendedMetaKeys.delete(keysym);
          return;
        }
        if (this.deferredMetaKeys.delete(keysym)) {
          // A standalone Meta tap still behaves like a remote key tap.
          this.sendKey(keysym, 1);
          this.sendKey(keysym, 0);
          return;
        }
        this.remoteMetaKeys.delete(keysym);
        this.remoteCtrlKeys.delete(keysym);
        this.sendKey(keysym, 0);
      };
    }
  }

  releaseInput() {
    this.cancelPendingPaste();
    if (this.state === 'ready') this.mouse?.reset?.();
    this.resettingInput = true;
    this.keyboard?.reset?.();
    this.resettingInput = false;
    if (this.state === 'ready') for (const remote of new Set(this.forwardedKeysyms.values())) this.client?.sendKeyEvent(0, remote);
    this.forwardedKeysyms.clear();
    if (this.keyboard && globalThis.Guacamole?.Keyboard?.ModifierState) {
      this.keyboard.modifiers = new globalThis.Guacamole.Keyboard.ModifierState();
    }
    this.deferredMetaKeys.clear();
    this.remoteMetaKeys.clear();
    this.suspendedMetaKeys.clear();
    this.remoteCtrlKeys.clear();
    this.suppressedKeyUps.clear();
    this.nativeKeyupKeys.clear();
  }

  // ── RDP resize fallback (SAA-352) ─────────────────────────────
  // guacd's resize-method=display-update: some RDP targets refuse a size change and guacd
  // keeps retrying, then aborts (deploy/guacd.md). Watch each request: a different size after
  // a request (a bounce), or no answer within RESIZE_CONFIRM_MS, means this computer refused.
  // The only recovery that held on the real target is a new connection at its own size with
  // resizing off (fixed=1), so this tab reconnects once and never asks for another size.
  endResizeWatch() { clearTimeout(this.resizeWatch?.timer); this.resizeWatch = null; }

  startResizeTimer(watch) {
    watch.timer = setTimeout(() => this.resizeWatchExpired(), RESIZE_CONFIRM_MS);
    watch.timer.unref?.(); // node tests only; browsers return a number
  }

  watchResize(width, height, { handshake = false } = {}) {
    if (!this.isRdp || this.fixedSize) return;
    const watch = this.resizeWatch;
    if (watch && !watch.handshake && !handshake) {
      // Only the latest browser request can acknowledge this watch. A late response
      // for an older request is a refusal of the current size, not a successful echo.
      watch.requested = [{ width, height }];
      watch.seen = []; // only echoes of this request can answer it; a stale echo must not hide a refusal
      watch.accepted = { ...this.remoteSize }; // the last size the computer confirmed
      clearTimeout(watch.timer);
      this.startResizeTimer(watch);
      return;
    }
    // A request replaces the handshake watch: the handshake's own sizes no longer count.
    this.endResizeWatch();
    this.resizeWatch = { requested: [{ width, height }], seen: [], handshake, timer: null, accepted: { ...this.remoteSize } };
    if (!handshake) this.startResizeTimer(this.resizeWatch);
  }

  noteRemoteSize(width, height) {
    const watch = this.resizeWatch;
    if (!watch) return;
    if (watch.handshake && !watch.timer) this.startResizeTimer(watch);
    const asked = watch.requested.some((r) => nearSize(r, width, height));
    if (!asked) {
      // Older resize replies can arrive after newer requests were pipelined. Ignore
      // those until the latest request has been acknowledged; only a subsequent
      // different size proves the remote rejected that acknowledged size.
      const latestWasSeen = watch.seen.some((seen) => watch.requested.some((r) => nearSize(r, seen.width, seen.height)));
      if (latestWasSeen) this.fallBackToFixedSize(width, height);
      return;
    }
    watch.seen.push({ width, height });
  }

  resizeWatchExpired() {
    const watch = this.resizeWatch;
    this.resizeWatch = null;
    if (!watch || watch.handshake) return; // a handshake that never bounced is fine
    const last = watch.seen.at(-1);
    if (!last) return this.fallBackToFixedSize(this.remoteSize.width, this.remoteSize.height); // no reply at all
    if (!watch.requested.some((r) => nearSize(r, last.width, last.height))) this.fallBackToFixedSize(last.width, last.height);
  }

  fallBackToFixedSize(width, height) {
    this.endResizeWatch();
    if (!this.isRdp || this.fixedSize || this.disposed || !(width > 0 && height > 0)) return;
    this.fixedSize = { width, height };
    this.pane.setAttribute('data-resize', 'fixed');
    const tunnel = this.tunnel;
    if (!tunnel) return;
    this.tunnel = null;
    this.releaseInput();
    if (this.client) this.client.disconnect(); else tunnel.close();
    // Same as an automatic reconnect: held sign-in answers and the 5-minute budget carry over.
    if (!this.autoReconnecting) { this.budgetUsedMs = 0; this.budgetSince = Date.now(); }
    this.autoReconnecting = true;
    this.openTunnel();
    this.setState('connecting', 'resize-fallback', RESIZE_FALLBACK_MESSAGE);
  }

  // SAA-304: after a 4409 the owner may accept the new certificate. The pin is cleared on
  // the server, and the reconnect re-pins whatever certificate the machine presents then.
  async trustNewCertificate() {
    if (this.reason !== 'cert-changed' || this.trusting) return;
    this.trusting = true;
    this.trustCertButton.disabled = true;
    try {
      const result = await this.resetCertPin(this.host.id);
      if (result?.host) this.host = { ...this.host, ...result.host };
    } catch (error) {
      this.trusting = false;
      this.trustCertButton.disabled = false;
      if (error?.status === 401) { this.setState('failed', 'login', CLOSE_STATES[4401][2]); this.onConnectionLost(); return; }
      return this.setState('failed', 'cert-changed', 'RemoteHub couldn’t trust this computer again. Try again in a moment.');
    }
    this.trusting = false;
    this.trustCertButton.disabled = false;
    this.connect();
  }

  // ── status ────────────────────────────────────────────────────
  setState(state, reason, message) {
    if (state !== 'ready') this.inputCapture?.exit();
    this.state = state;
    this.reason = reason;
    this.message = message;
    this.syncSound();
    this.renderState();
    this.focus();
    this.onChange(this);
  }
  // ── SAA-306: Desktop connection chooser (Auto / RDP / VNC / Native) ─────────
  renderBackends() {
    const backends = this.host?.desktopBackends;
    if (LIVE.has(this.state) || !Array.isArray(backends)) { this.backendArea.replaceChildren(); return; }
    const preference = this.host.desktopPreference ?? 'auto';
    const selection = selectDesktopBackend(backends, preference);
    const using = describeSelection(selection);
    this.backendArea.replaceChildren(
      using ? el('p', { class: 'desktop-backend-using' }, `Desktop connection: ${using}`) : '',
      createBackendChooser({ backends, preference, checking: this.discovering === true,
        onSelect: (pref) => this.chooseBackend(pref), onCheckAgain: () => this.checkBackends() }),
      missingServiceExplanation(selection, { onSetUpAgent: this.onSetUpAgent ? () => this.onSetUpAgent(this.host) : null }) ?? '',
      this.backendError ? el('p', { class: 'form-error', role: 'alert' }, this.backendError) : '');
  }
  async chooseBackend(preference) {
    this.backendError = '';
    try { const result = await this.setPreference(this.host.id, preference); if (result?.host) this.updateHost({ ...this.host, ...result.host }); }
    catch (error) { if (error?.status === 401) return this.onConnectionLost(); this.backendError = error?.message || 'Could not change the desktop connection.'; }
    this.renderState();
    this.onChange(this);
  }
  async checkBackends() {
    if (this.discovering) return;
    this.discovering = true; this.backendError = '';
    this.renderBackends();
    try { const result = await this.discover(this.host.id); if (result?.host) this.updateHost({ ...this.host, ...result.host }); }
    catch (error) { if (error?.status === 401) { this.discovering = false; return this.onConnectionLost(); } this.backendError = error?.message || 'Could not check the desktop services.'; }
    this.discovering = false;
    this.renderState();
    this.onChange(this);
  }

  renderState() {
    const titles = {
      idle: 'Desktop', connecting: 'Connecting', authentication: 'Sign in required', ready: 'Connected',
      unavailable: 'Desktop unavailable', failed: 'Connection failed', disconnected: 'Disconnected',
    };
    this.pane.setAttribute('data-state', this.state);
    this.pane.setAttribute('data-reason', this.reason || '');
    this.statusLabel.textContent = titles[this.state];
    this.statusText.textContent = this.message;
    this.overlay.hidden = this.state === 'ready';
    this.authForm.hidden = this.state !== 'authentication';
    this.connectForm.hidden = LIVE.has(this.state) || this.reason === 'login';
    const button = this.connectButton;
    if (button) button.textContent = this.state === 'idle' ? 'Connect' : 'Reconnect';
    this.disconnectButton.hidden = !LIVE.has(this.state);
    this.trustCertButton.hidden = this.reason !== 'cert-changed';
    this.connectPassword.hidden = this.isRdp; // RDP: guacd prompt only; follows the protocol if the choice changes (SAA-306)
    this.renderCapture();
    this.renderBackends?.(); // SAA-306
  }

  renderCapture() {
    const capture = this.inputCapture;
    if (!capture) return;
    this.pane.setAttribute('data-input-capture', capture.state);
    this.captureButton.hidden = this.state !== 'ready' || capture.requested;
    this.captureButton.disabled = capture.pending;
    this.releaseCaptureButton.hidden = !capture.requested;
    // Capture changes the scale rule (it may upscale), not the remote size.
    if (capture.requested !== this.captureWasRequested) { this.captureWasRequested = capture.requested; this.applyScale(); }
    this.fullscreenCaptureButton.hidden = this.state !== 'ready' || capture.requested;
    this.fullscreenCaptureButton.disabled = capture.pending;
    this.modifierProfileLabel.hidden = this.state !== 'ready';
    // Sound: RDP desktops send it; another desktop shows the toggle once it does.
    // Every desktop can have sound (RDP or the agent), so its place is always reserved.
    this.pane.setAttribute('data-sound', '');
    this.soundButton.hidden = this.state !== 'ready';
    const sound = this.soundSummary();
    this.soundButton.textContent = sound.label;
    this.soundButton.setAttribute('aria-label', sound.detail);
    this.soundButton.title = sound.detail;
    const exit = ' Release input or press Ctrl+Alt+Shift+Escape to exit.';
    this.captureStatus.textContent = this.captureStatus.title = capture.state === 'locked'
      ? 'Keyboard lock active. Some system shortcuts may still act locally.' + exit
      : capture.state === 'partial'
        ? 'Partial capture. ' + capture.detail + ' System shortcuts may act locally.' + exit
        : capture.state === 'entering'
          ? 'Requesting input capture…' + exit
          : (capture.detail || (this.state === 'ready' ? 'Capture input to send more shortcuts to this desktop.' : ''));
  }

  // ── VNC failure explanation (SAA-305) ─────────────────────────
  // guacd reports most VNC failures (wrong password, server down, not VNC, unsupported
  // sign-in method) as the same "Aborted. See logs." error, so after a VNC session fails
  // before its first frame, ask RemoteHub's read-only RFB pre-check what the server actually offers and
  // replace the message with a plain one. The password itself is never sent anywhere;
  // only whether one was given for this attempt.
  noteVncAttempt(passwordGiven) {
    this.vncAttempt = (this.vncAttempt || 0) + 1;
    this.vncPasswordGiven = passwordGiven;
  }

  async explainVncFailure(event = {}) {
    // guacd sends `ready` before its VNC client connects, so "failed before the first
    // frame" (no layer-0 size yet this attempt) is the signal, not everReady.
    // guacd sometimes just ends a VNC session it could not open (1000, no error), which
    // lands in `disconnected`; with no frame drawn that is a failure too.
    // These RemoteHub close codes (login 4401, Origin 4403, RDP 4409) already say why;
    // asking the VNC check would replace that with a wrong password message (SAA-349).
    // 'unavailable' codes (4404, 4410, 4503) are already excluded by the state check below.
    if ([4401, 4403, 4409].includes(this.lastCloseCode) || [4401, 4403, 4409].includes(event.code)) return;
    if (this.host.desktop?.protocol !== 'vnc' || !['failed', 'disconnected'].includes(this.state) || this.reason === 'user' || this.remoteSize?.width) return;
    const attempt = this.vncAttempt;
    // SAA-346: the pre-check can take a few seconds (it waits out its rate limit), so say
    // that the cause is being checked instead of leaving guacd's vague text on its own.
    const before = { state: this.state, reason: this.reason, message: this.message };
    const checking = `${before.message} ${VNC_CHECKING_SUFFIX}`.trim();
    this.setState(before.state, before.reason, checking);
    const stillOurs = () => !this.disposed && attempt === this.vncAttempt && this.state === before.state && this.message === checking;
    let result = null;
    try { result = await (this.vncExplain ?? fetchVncExplanation)(this.host, { passwordGiven: this.vncPasswordGiven === true }); } catch { result = null; }
    if (!stillOurs()) return;
    if (!result) { this.setState(before.state, before.reason, before.message); return; }
    // A plain 1000 end says nothing about the password, so never claim it was wrong (SAA-346).
    const message = event.code === 1000 && result.reason === 'vnc-auth'
      ? 'The desktop closed before anything was shown. It needs a password: enter it and click Connect.'
      : result.message;
    this.setState('failed', result.reason, message);
  }

  // SAA-346: a normal close (1000) before the first frame is not "the session ended": show
  // a neutral failure that does not guess the cause (a VNC pre-check may refine it).
  endedBeforeFirstFrame(event = {}) {
    if (event.code !== 1000 || this.remoteSize?.width || this.state !== 'disconnected' || this.reason === 'user') return;
    this.setState('failed', 'ended-early', 'The desktop closed before anything was shown. Click Reconnect to try again.');
  }

}
