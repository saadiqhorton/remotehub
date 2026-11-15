import { el } from './dom.js';

const THEMES = {
  dark: {
    background: '#141412',
    foreground: '#EDE6D6',
    cursor: '#E6FF2B',
    cursorAccent: '#141412',
    selectionBackground: 'rgba(230, 255, 43, 0.28)',
    black: '#1C1B18',
    red: '#F2735E',
    green: '#C5E03A',
    yellow: '#E6FF2B',
    blue: '#86A9D6',
    magenta: '#C79AC8',
    cyan: '#7FCFC4',
    white: '#EDE6D6',
    brightBlack: '#8C8474',
    brightRed: '#FF9580',
    brightGreen: '#DAF25A',
    brightYellow: '#F3FF85',
    brightBlue: '#A9C4E8',
    brightMagenta: '#DDB6DE',
    brightCyan: '#A5E3DA',
    brightWhite: '#FFFFFF',
  },
  light: {
    background: '#EDE6D6',
    foreground: '#141412',
    cursor: '#3D4500',
    cursorAccent: '#EDE6D6',
    selectionBackground: '#E6FF2B',
    selectionForeground: '#141412',
    selectionInactiveBackground: 'rgba(230, 255, 43, 0.5)',
    black: '#141412',
    red: '#A8321F',
    green: '#4A6300',
    yellow: '#6E5A00',
    blue: '#1F4E8C',
    magenta: '#7B3A7D',
    cyan: '#1D6B63',
    white: '#5C564B',
    brightBlack: '#6B6456',
    brightRed: '#C2452F',
    brightGreen: '#5C7A00',
    brightYellow: '#857000',
    brightBlue: '#2E64AD',
    brightMagenta: '#944A96',
    brightCyan: '#258277',
    brightWhite: '#2A2824',
  },
};

let counter = 0;

async function copyText(text) {
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch {
    // The async clipboard API needs HTTPS; fall back for plain-HTTP LAN access.
  }
  const area = el('textarea', { style: 'position:fixed;opacity:0' });
  area.value = text;
  document.body.append(area);
  area.select();
  document.execCommand('copy');
  area.remove();
}

/**
 * One tab = one terminal = one WebSocket = one SSH shell.
 * States: password → connecting → (verify) → authenticating → ready → ended.
 */
export class TerminalSession {
  constructor({ host, theme, onChange, onClose, onEditHost, onConnectionLost }) {
    this.id = `s${++counter}`;
    this.host = host;
    this.state = 'password';
    this.everReady = false;
    this.ws = null;
    this.callbacks = { onChange, onClose, onEditHost, onConnectionLost };

    this.termHost = el('div', { class: 'term-host' });
    this.overlay = el('div', { class: 'overlay' });
    this.pane = el('div', { class: 'pane bracketed', role: 'tabpanel', id: `pane-${this.id}` }, this.termHost, this.overlay);

    this.term = new window.Terminal({
      fontFamily: '"Space Mono", ui-monospace, Menlo, Consolas, monospace',
      fontSize: 14,
      lineHeight: 1.25,
      cursorBlink: true,
      scrollback: 5000,
      theme: THEMES[theme] || THEMES.dark,
    });
    this.fitAddon = new window.FitAddon.FitAddon();
    this.term.loadAddon(this.fitAddon);
    this.opened = false;

    this.term.onData((data) => {
      if (this.state === 'ready') this.send({ t: 'in', d: data });
    });
    this.term.onResize(({ cols, rows }) => {
      if (this.state === 'ready') this.send({ t: 'resize', cols, rows });
    });
    this.term.attachCustomKeyEventHandler((event) => {
      if (event.type !== 'keydown' || !event.ctrlKey || !event.shiftKey) return true;
      const key = event.key.toLowerCase();
      if (key === 'k') return false; // app-level launcher shortcut
      if (key === 'c') {
        event.preventDefault();
        copyText(this.term.getSelection());
        return false;
      }
      if (key === 'v') return false; // let the browser paste natively
      return true;
    });

    this.resizeObserver = new ResizeObserver(() => this.scheduleFit());
    this.renderPasswordPrompt();
  }

  get label() {
    return this.host.name;
  }

  get endpoint() {
    return `${this.host.username}@${this.host.address}${this.host.port === 22 ? '' : `:${this.host.port}`}`;
  }

  mount(stage) {
    stage.append(this.pane);
  }

  show() {
    this.pane.classList.add('active');
    if (!this.opened) {
      this.term.open(this.termHost);
      this.opened = true;
      this.resizeObserver.observe(this.pane);
    }
    this.fitNow();
    this.focus();
  }

  hide() {
    this.pane.classList.remove('active');
  }

  focus() {
    if (!this.pane.classList.contains('active')) return;
    const field = this.overlay.hidden ? null : this.overlay.querySelector('input, .btn-primary');
    if (field) field.focus();
    else if (this.state === 'ready') this.term.focus();
  }

  setTheme(theme) {
    this.term.options.theme = THEMES[theme] || THEMES.dark;
  }

  updateHost(host) {
    this.host = host;
    this.callbacks.onChange();
  }

  scheduleFit() {
    if (this.fitFrame) return;
    this.fitFrame = requestAnimationFrame(() => {
      this.fitFrame = null;
      this.fitNow();
    });
  }

  fitNow() {
    if (!this.opened || !this.pane.classList.contains('active')) return;
    try {
      this.fitAddon.fit();
    } catch {
      // Fit can throw while the pane has no layout yet; the next resize retries.
    }
  }

  setState(state) {
    this.state = state;
    this.callbacks.onChange();
  }

  send(message) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(message));
  }

  connect(password) {
    this.disconnect();
    this.finalMessage = false;
    this.setState('connecting');
    this.renderProgress(`Connecting to ${this.host.address}…`);

    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${protocol}//${location.host}/ws/terminal`);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    let secret = password;

    ws.onopen = () => {
      this.fitNow();
      ws.send(JSON.stringify({ t: 'connect', hostId: this.host.id, password: secret, cols: this.term.cols, rows: this.term.rows }));
      secret = null;
    };
    ws.onmessage = (event) => {
      if (this.ws !== ws) return;
      if (typeof event.data !== 'string') {
        this.term.write(new Uint8Array(event.data));
        return;
      }
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      this.handleControl(message);
    };
    ws.onclose = (event) => {
      secret = null;
      if (this.ws !== ws) return;
      this.ws = null;
      if (this.finalMessage) return;
      if (event.code === 4001) return; // logged out; the app resets the view
      if (this.state === 'ready') {
        this.renderEnded('Lost the connection to the RemoteHub server.');
      } else {
        this.renderPasswordPrompt("Couldn't open a terminal connection. Your RemoteHub login may have expired.");
        this.callbacks.onConnectionLost();
      }
    };
  }

  handleControl(message) {
    switch (message.t) {
      case 'status':
        if (message.s === 'connecting') this.renderProgress(`Connecting to ${this.host.address}…`);
        if (message.s === 'authenticating') {
          this.setState('authenticating');
          this.renderProgress(`Logging in as ${this.host.username}…`);
        }
        if (message.s === 'ready') this.onReady();
        break;
      case 'hostkey':
        if (message.status === 'new') this.renderHostKeyPrompt(message);
        if (message.status === 'mismatch') this.mismatch = message;
        break;
      case 'error':
        this.finalMessage = true;
        if (message.code === 'hostkey-mismatch' && this.mismatch) this.renderMismatch(this.mismatch);
        else if (this.state === 'ready') this.renderEnded(message.message);
        else this.renderPasswordPrompt(message.message);
        break;
      case 'closed':
        this.finalMessage = true;
        this.renderEnded(message.reason);
        break;
      default:
        break;
    }
  }

  onReady() {
    if (this.everReady) this.term.write('\r\n\x1b[2m── reconnected ──\x1b[0m\r\n');
    this.everReady = true;
    this.mismatch = null;
    this.overlay.hidden = true;
    this.overlay.classList.remove('overlay-dock');
    this.setState('ready');
    this.fitNow();
    this.send({ t: 'resize', cols: this.term.cols, rows: this.term.rows });
    this.focus();
  }

  disconnect() {
    const ws = this.ws;
    this.ws = null;
    if (ws && ws.readyState <= WebSocket.OPEN) ws.close(1000);
  }

  dispose() {
    this.disconnect();
    this.resizeObserver.disconnect();
    if (this.fitFrame) cancelAnimationFrame(this.fitFrame);
    this.term.dispose();
    this.pane.remove();
  }

  // ── Overlay views ──────────────────────────────────────────────

  showOverlay(card, { dock = false } = {}) {
    this.overlay.replaceChildren(card);
    this.overlay.classList.toggle('overlay-dock', dock);
    this.overlay.hidden = false;
    queueMicrotask(() => this.focus());
  }

  passwordForm(submitLabel, extraActions = []) {
    const input = el('input', {
      type: 'password',
      autocomplete: 'off',
      spellcheck: 'false',
      'aria-label': `SSH password for ${this.endpoint}`,
    });
    const form = el(
      'form',
      {
        onsubmit: (event) => {
          event.preventDefault();
          if (!input.value) return input.focus();
          const password = input.value;
          input.value = '';
          this.connect(password);
        },
      },
      el('label', { class: 'field' }, el('span', { class: 'label' }, 'SSH password'), input),
      el('div', { class: 'overlay-actions' }, el('button', { type: 'submit', class: 'btn btn-primary' }, submitLabel), extraActions),
    );
    return form;
  }

  closeButton(label = 'Close tab') {
    return el('button', { type: 'button', class: 'btn btn-ghost btn-small', onclick: () => this.callbacks.onClose(this.id) }, label);
  }

  renderPasswordPrompt(error) {
    this.setState('password');
    this.showOverlay(
      el(
        'div',
        { class: 'overlay-card bracketed' },
        el('span', { class: 'label' }, error ? "Couldn't connect" : 'New session'),
        el('h2', {}, this.host.name),
        el('p', {}, this.endpoint),
        error ? el('p', { class: 'form-error', role: 'alert' }, error) : null,
        this.passwordForm(error ? 'Try again' : 'Connect', this.everReady || error ? [this.closeButton()] : []),
      ),
    );
  }

  renderProgress(text) {
    this.showOverlay(
      el(
        'div',
        { class: 'overlay-card' },
        el('div', { class: 'overlay-progress', role: 'status' }, el('span', { class: 'dot', 'data-state': 'connecting' }), el('span', {}, text)),
        el('div', { class: 'overlay-actions' }, el('button', { type: 'button', class: 'btn btn-ghost btn-small', onclick: () => this.cancel() }, 'Cancel')),
      ),
    );
  }

  cancel() {
    this.finalMessage = true;
    this.disconnect();
    this.renderPasswordPrompt();
  }

  renderHostKeyPrompt({ keyType, fingerprint }) {
    this.setState('verify');
    const decide = (accept) => {
      this.send({ t: 'hostkey', accept });
      if (accept) this.renderProgress(`Logging in as ${this.host.username}…`);
    };
    this.showOverlay(
      el(
        'div',
        { class: 'overlay-card bracketed' },
        el('span', { class: 'label' }, 'First connection'),
        el('h2', {}, 'Check this computer’s ID'),
        el('p', {}, `RemoteHub hasn't connected to ${this.host.name} before. If this ID matches the one on that computer, trust it and RemoteHub will remember it.`),
        el('div', { class: 'kv' }, el('span', { class: 'label' }, 'Computer ID'), el('code', { class: 'fingerprint' }, fingerprint)),
        el('p', { class: 'hint' }, 'If you know the computer’s ID, check that it matches. If this is your own computer and you just set it up, it’s fine to continue.'),
        el(
          'div',
          { class: 'overlay-actions' },
          el('button', { type: 'button', class: 'btn btn-primary', onclick: () => decide(true) }, 'Trust and connect'),
          el('button', { type: 'button', class: 'btn btn-ghost btn-small', onclick: () => decide(false) }, 'Cancel'),
        ),
      ),
    );
  }

  renderMismatch({ keyType, fingerprint, expected }) {
    this.setState('ended');
    this.showOverlay(
      el(
        'div',
        { class: 'overlay-card bracketed' },
        el('span', { class: 'label' }, 'Connection blocked'),
        el('h2', {}, 'This computer’s ID changed'),
        el(
          'p',
          {},
          `${this.host.name} answered with a different computer ID than last time. That's expected after the computer was reinstalled, but it can also mean a different computer is pretending to be it. If you expected the change, open the computer’s settings, click “Forget this computer ID”, and connect again.`,
        ),
        el('div', { class: 'kv' }, el('span', { class: 'label' }, 'Saved ID'), el('code', { class: 'fingerprint expected' }, expected.fingerprint)),
        el('div', { class: 'kv' }, el('span', { class: 'label' }, 'ID it sent now'), el('code', { class: 'fingerprint' }, fingerprint)),
        el(
          'div',
          { class: 'overlay-actions' },
          el('button', { type: 'button', class: 'btn btn-primary', onclick: () => this.callbacks.onEditHost(this.host) }, 'Open computer settings'),
          this.closeButton(),
        ),
      ),
    );
  }

  renderEnded(reason) {
    this.setState('ended');
    this.showOverlay(
      el(
        'div',
        { class: 'overlay-card bracketed' },
        el('span', { class: 'label' }, 'Disconnected'),
        el('h2', {}, this.host.name),
        el('p', {}, reason),
        this.passwordForm('Reconnect', [this.closeButton()]),
      ),
      { dock: true },
    );
  }
}
