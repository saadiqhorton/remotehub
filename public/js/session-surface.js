import { TerminalSession } from './terminal-session.js';

export { FileSession } from './file-session.js';

// The workspace contract is id, surfaceType, host, label, state, endpoint,
// mount/show/hide/dispose, focus, setTheme, updateHost, and scheduleFit.
// TerminalSession owns its SSH lifecycle; this adapter only exposes that contract.
export class TerminalSurface {
  constructor(options) {
    this.session = new TerminalSession(options);
    this.surfaceType = 'terminal';
  }

  get id() { return this.session.id; }
  get host() { return this.session.host; }
  get label() { return this.session.label; }
  get endpoint() { return this.session.endpoint; }
  get state() { return this.session.state; }

  mount(stage) { this.session.mount(stage); }
  show() { this.session.show(); }
  hide() { this.session.hide(); }
  dispose() { this.session.dispose(); }
  focus() { this.session.focus(); }
  setTheme(theme) { this.session.setTheme(theme); }
  updateHost(host) { this.session.updateHost(host); }
  scheduleFit() { this.session.scheduleFit(); }
}

export { DesktopSession } from './desktop-session.js';
