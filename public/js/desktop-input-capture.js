// Keyboard Lock is best effort: the host OS decides which shortcuts it exposes.
// Chrome requires JavaScript-initiated fullscreen before Keyboard Lock is available.
// https://developer.chrome.com/docs/capabilities/web-apis/keyboard-lock
// Keep one owner per document: keyboard.unlock() affects the whole document.
const owners = new WeakMap();

export class DesktopInputCapture {
  constructor({ element, onChange = () => {}, onRelease = () => {}, canEnter = () => true, onFocus = () => {} }) {
    Object.assign(this, { element, onChange, onRelease, canEnter, onFocus });
    this.document = globalThis.document;
    this.keyboard = globalThis.navigator?.keyboard;
    this.state = 'idle';
    this.detail = '';
    this.generation = 0;
    this.pending = false;
    this.keyboardRequested = false;
    this.fullscreen = false;
  }

  get active() { return this.state === 'locked' || this.state === 'partial'; }
  get requested() { return this.state !== 'idle'; }

  update(state, detail = '') {
    this.state = state;
    this.detail = detail;
    this.onChange(this);
  }

  // Called only by the visible Capture input button: requestFullscreen must run
  // directly in that user gesture. Reconnect/focus never re-enters capture.
  async enter({ fullscreen = false } = {}) {
    if (this.pending || this.requested || !this.canEnter()) return;
    const owner = owners.get(this.document);
    if (owner && owner !== this) {
      this.update('idle', 'Release input in the other desktop before capturing this one.');
      return;
    }
    if (fullscreen && this.document.fullscreenElement && this.document.fullscreenElement !== this.element) {
      this.update('idle', 'Exit the other fullscreen view before capturing this desktop.');
      return;
    }
    owners.set(this.document, this);
    const generation = ++this.generation;
    this.pending = true;
    this.onRelease();
    this.update('entering');
    try {
      if (fullscreen) {
        if (typeof this.element.requestFullscreen !== 'function') {
          this.update('idle', 'Full-screen capture is unavailable here.');
          this.onFocus();
          return;
        }
        // The Fullscreen API's browser keyboardLock reserves browser shortcuts where supported.
        try {
          await this.element.requestFullscreen({ keyboardLock: 'browser' });
        } catch (error) {
          // Older engines can reject the newer options dictionary. Fullscreen itself
          // may still be supported, so retry without keyboardLock.
          if (error?.name !== 'NotSupportedError') throw error;
          await this.element.requestFullscreen();
        }
        if (generation !== this.generation || !this.canEnter()) { this.exit(); return; }
        if (this.document.fullscreenElement !== this.element) { this.exit(); return; }
      }
      // Bind capture loss to fullscreen only when fullscreen was explicitly
      // requested. A windowed capture may sit inside a pane that is already fullscreen.
      this.fullscreen = fullscreen && this.document.fullscreenElement === this.element;
      if (typeof this.keyboard?.lock !== 'function') {
        this.update('partial', 'System-key capture is not confirmed here. Full-screen capture may request more browser shortcuts where supported.');
      } else {
        this.keyboardRequested = true;
        await this.keyboard.lock(); // No allow-list: request every key available to the browser.
        this.keyboardRequested = true; // A late successful request must also be unlocked after cancellation.
        if (generation !== this.generation || !this.canEnter() || (fullscreen && this.document.fullscreenElement !== this.element)) {
          this.exit(); return;
        }
        this.update('locked');
      }
      this.onFocus();
    } catch {
      if (generation === this.generation && this.canEnter()) {
        if (this.keyboardRequested) {
          try { this.keyboard?.unlock?.(); } catch { /* Browser may already have released it. */ }
          this.keyboardRequested = false;
        }
        this.update('partial', fullscreen
          ? 'The browser did not allow full-screen capture or keyboard lock. Full-screen capture may request more browser shortcuts where supported.'
          : 'Keyboard lock was not allowed. Full-screen capture may request more browser shortcuts where supported.');
        this.onFocus();
      }
    } finally {
      this.pending = false;
      if (this.state === 'idle' && owners.get(this.document) === this) owners.delete(this.document);
      this.onChange(this);
    }
  }

  fullscreenChanged() {
    // Loss/replacement must end capture. Windowed capture can request fullscreen later.
    if (this.requested && this.fullscreen && this.document.fullscreenElement !== this.element) this.exit();
  }

  exit() {
    ++this.generation;
    this.onRelease();
    this.fullscreen = false;
    this.update('idle');
    if (owners.get(this.document) === this) {
      if (this.keyboardRequested) {
        try { this.keyboard?.unlock?.(); } catch { /* Already unlocked, or document is unloading. */ }
        this.keyboardRequested = false;
      }
      if (this.document.fullscreenElement === this.element) {
        try { Promise.resolve(this.document.exitFullscreen?.()).catch(() => {}); } catch { /* Already exiting. */ }
      }
      if (!this.pending) owners.delete(this.document);
    }
  }
}
