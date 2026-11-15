import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TerminalSurface, FileSession, DesktopSession } from '../public/js/session-surface.js';

function node() {
  const classes = new Set();
  return {
    children: [],
    attributes: {},
    classList: {
      add(value) { classes.add(value); },
      remove(value) { classes.delete(value); },
      toggle(value, force) { if (force) classes.add(value); else classes.delete(value); },
      contains(value) { return classes.has(value); },
    },
    setAttribute(key, value) { this.attributes[key] = value; },
    addEventListener() {},
    replaceChildren(...children) { this.children = children; },
    append(...children) { this.children.push(...children); },
    remove() { this.removed = true; },
    focus() { this.focused = true; },
    querySelector() { return null; },
  };
}

test('file and desktop stubs mount, switch visibility, update host and dispose independently', () => {
  const previousDocument = globalThis.document;
  globalThis.document = { createElement: node };
  try {
    const host = { id: 'one', name: 'NAS', username: 'sam', address: 'nas.lan', port: 22 };
    const stage = node();
    const files = new FileSession({ host });
    const desktop = new DesktopSession({ host });
    assert.equal(files.surfaceType, 'files');
    assert.equal(desktop.surfaceType, 'desktop');
    assert.notEqual(files.id, desktop.id);
    for (const surface of [files, desktop]) {
      surface.mount(stage);
      assert.equal(surface.pane.attributes.role, 'tabpanel');
      assert.equal(surface.pane.attributes.id, `pane-${surface.id}`);
      surface.show();
      assert.equal(surface.pane.classList.contains('active'), true);
      assert.equal(surface.pane.focused, true);
      surface.hide();
      assert.equal(surface.pane.classList.contains('active'), false);
      surface.setTheme('light');
      surface.scheduleFit();
      surface.updateHost({ ...host, name: 'New NAS' });
      assert.equal(surface.heading.textContent, 'New NAS');
      surface.dispose();
      assert.equal(surface.pane.removed, true);
    }
    assert.equal(stage.children.length, 2);
  } finally {
    globalThis.document = previousDocument;
  }
});

test('terminal surface delegates unchanged terminal lifecycle and metadata', () => {
  const previousDocument = globalThis.document;
  const previousWindow = globalThis.window;
  const previousObserver = globalThis.ResizeObserver;
  const previousMicrotask = globalThis.queueMicrotask;
  const previousFrame = globalThis.requestAnimationFrame;
  const previousCancel = globalThis.cancelAnimationFrame;
  const events = [];
  globalThis.document = { createElement: node };
  globalThis.window = {
    Terminal: class {
      constructor() { this.options = {}; }
      loadAddon() {}
      onData() {}
      onResize() {}
      attachCustomKeyEventHandler(callback) { this.keyHandler = callback; }
      open() { events.push('open'); }
      focus() { events.push('focus'); }
      dispose() { events.push('terminal dispose'); }
    },
    FitAddon: { FitAddon: class { fit() { events.push('fit'); } } },
  };
  globalThis.ResizeObserver = class {
    observe() { events.push('observe'); }
    disconnect() { events.push('disconnect'); }
  };
  globalThis.queueMicrotask = () => {};
  globalThis.requestAnimationFrame = () => 1;
  globalThis.cancelAnimationFrame = () => {};
  try {
    const host = { id: 'one', name: 'NAS', username: 'sam', address: 'nas.lan', port: 22 };
    const surface = new TerminalSurface({ host, theme: 'dark', onChange() {} });
    const stage = node();
    assert.equal(surface.surfaceType, 'terminal');
    assert.equal(surface.label, 'NAS');
    assert.equal(surface.endpoint, 'sam@nas.lan');
    assert.equal(surface.state, 'password');
    surface.mount(stage);
    assert.equal(stage.children[0], surface.session.pane);
    surface.show();
    surface.hide();
    surface.setTheme('light');
    assert.equal(surface.session.term.options.theme.background, '#EDE6D6');
    assert.equal(surface.session.term.keyHandler({ type: 'keydown', ctrlKey: true, shiftKey: true, key: 'k' }), false);
    surface.updateHost({ ...host, name: 'New NAS' });
    assert.equal(surface.label, 'New NAS');
    surface.dispose();
    assert.deepEqual(events.filter((event) => event === 'open'), ['open']);
    assert.deepEqual(events.slice(-2), ['disconnect', 'terminal dispose']);
    assert.equal(surface.session.pane.removed, true);
  } finally {
    globalThis.document = previousDocument;
    globalThis.window = previousWindow;
    globalThis.ResizeObserver = previousObserver;
    globalThis.queueMicrotask = previousMicrotask;
    globalThis.requestAnimationFrame = previousFrame;
    globalThis.cancelAnimationFrame = previousCancel;
  }
});
