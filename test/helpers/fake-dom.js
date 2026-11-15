import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInThisContext } from 'node:vm';
import { PixelCanvas } from './pixel-canvas.js';

let guacLoaded = false;
export function loadGuacamole() {
  if (guacLoaded) return globalThis.Guacamole;
  const source = readFileSync(new URL('../../public/vendor/guacamole/all.min.js', import.meta.url), 'utf8');
  runInThisContext(source, { filename: 'apache-guacamole-common-js-1.6.0.js' });
  guacLoaded = true;
  return globalThis.Guacamole;
}

export function ensureWindow() {
  const window = globalThis.window ?? {};
  window.setTimeout ??= (...args) => globalThis.setTimeout(...args);
  window.clearTimeout ??= (id) => globalThis.clearTimeout(id);
  window.setInterval ??= (...args) => globalThis.setInterval(...args);
  window.clearInterval ??= (id) => globalThis.clearInterval(id);
  window.requestAnimationFrame ??= (callback) => window.setTimeout(() => callback(Date.now()), 0);
  window.cancelAnimationFrame ??= (id) => window.clearTimeout(id);
  window.btoa ??= (value) => Buffer.from(String(value), 'binary').toString('base64');
  window.atob ??= (value) => Buffer.from(String(value), 'base64').toString('binary');
  globalThis.window = window;
  globalThis.Image ??= class FakeImage {
    constructor() { this.width = 1; this.height = 1; this.onload = null; this.onerror = null; this.surface = new PixelCanvas(1, 1); this.surface.set(0, 0, [255, 0, 0, 255]); }
    set src(value) {
      try {
        const encoded = String(value).split(',').at(-1);
        const rows = JSON.parse(Buffer.from(encoded, 'base64').toString());
        if (Array.isArray(rows) && rows.length && Array.isArray(rows[0])) {
          this.surface = new PixelCanvas(rows[0].length, rows.length);
          rows.forEach((row, y) => row.forEach((pixel, x) => this.surface.set(x, y, pixel)));
          this.width = this.surface.width; this.height = this.surface.height;
        }
      } catch { /* arbitrary test payloads use the default red pixel */ }
      window.setTimeout(() => this.onload?.(), 0);
    }
    pixel(x, y) { return this.surface.pixel(x, y); }
  };
  return window;
}

// Minimal DOM for running production FileSession in node:vm (copied from the
// polling integration test so new tests can share it).
export function makeDocument() {
  loadGuacamole();
  ensureWindow();
  const listeners = new Map();
  const document = { hidden: false, activeElement: null };
  class Node {
    constructor(tag, text = '') {
      this.tagName = tag.toUpperCase();
      this.text = text;
      this.children = [];
      this.attributes = {};
      this.style = {};
      this._width = 0; this._height = 0;
      this.offsetLeft = 0; this.offsetTop = 0; this.offsetParent = null;
      this.pixelSurface = null;
      this.context2d = null;
      this.parentNode = null;
      this.listeners = new Map();
      this.classes = new Set();
      if (this.tagName === 'CANVAS') this.resetPixels();
      this.classList = {
        add: (value) => this.classes.add(value),
        remove: (value) => this.classes.delete(value),
        contains: (value) => this.classes.has(value),
        toggle: (value, force = !this.classes.has(value)) => force ? this.classes.add(value) : this.classes.delete(value),
      };
    }
    set className(value) { this.classes = new Set(value.split(/\s+/)); }
    get className() { return [...this.classes].join(' '); }
    get firstChild() { return this.children[0] || null; }
    get width() { return this._width; }
    set width(value) {
      this._width = Number(value) || 0;
      if (this.tagName === 'CANVAS') this.resetPixels();
    }
    get height() { return this._height; }
    set height(value) {
      this._height = Number(value) || 0;
      if (this.tagName === 'CANVAS') this.resetPixels();
    }
    get nextSibling() { return this.parentNode?.children[this.parentNode.children.indexOf(this) + 1] || null; }
    get textContent() { return this.text + this.children.map((child) => child.textContent).join(''); }
    set textContent(value) { this.replaceChildren(String(value)); }
    setAttribute(name, value) {
      this.attributes[name] = String(value);
      if (name === 'disabled') this.disabled = true;
      if (name === 'class') this.className = value;
    }
    getAttribute(name) { return this.attributes[name] ?? null; }
    removeAttribute(name) { delete this.attributes[name]; if (name === 'disabled') this.disabled = false; }
    append(...children) { for (const child of children.flat(Infinity)) this.insertBefore(typeof child === 'object' ? child : new Node('#text', String(child)), null); }
    appendChild(child) { return this.insertBefore(child, null); }
    insertBefore(child, reference) {
      child.parentNode?.removeChild(child);
      const index = reference ? this.children.indexOf(reference) : this.children.length;
      assert.ok(index >= 0, 'insertBefore reference belongs to the parent');
      this.children.splice(index, 0, child);
      child.parentNode = this;
      return child;
    }
    removeChild(child) { this.children.splice(this.children.indexOf(child), 1); child.parentNode = null; return child; }
    replaceChildren(...children) { for (const child of [...this.children]) this.removeChild(child); this.append(...children); }
    remove() { this.parentNode?.removeChild(this); }
    contains(node) { return node === this || this.children.some((child) => child.contains(node)); }
    focus() {
      if (document.activeElement === this) return;
      document.activeElement?.dispatchEvent?.({ type: 'blur' });
      document.activeElement = this;
      this.dispatchEvent({ type: 'focus' });
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
    querySelectorAll(selector) {
      const matches = [];
      const wanted = selector.toUpperCase();
      const visit = (node) => {
        for (const child of node.children) {
          if (child.tagName === wanted) matches.push(child);
          visit(child);
        }
      };
      visit(this);
      return matches;
    }
    getBoundingClientRect() { return { left: 0, top: 0, width: this.clientWidth || this.width || 1024, height: this.clientHeight || this.height || 768 }; }
    getContext(type) {
      if (this.tagName !== 'CANVAS' || type !== '2d') return null;
      if (!this.context2d) {
        this.context2d = this.pixelSurface.getContext('2d');
        this.context2d.canvas = this;
      }
      return this.context2d;
    }
    resetPixels() {
      this.pixelSurface = new PixelCanvas(this._width, this._height);
      this.context2d = null;
    }
    pixel(x, y) { return this.pixelSurface?.pixel(x, y) ?? [0, 0, 0, 0]; }
    set(x, y, rgba) { this.pixelSurface?.set(x, y, rgba); }
    addEventListener(type, listener) { (this.listeners.get(type) || this.listeners.set(type, new Set()).get(type)).add(listener); }
    removeEventListener(type, listener) { this.listeners.get(type)?.delete(listener); }
    dispatchEvent(event) {
      event.target ??= this;
      event.currentTarget = this;
      for (const listener of [...(this.listeners.get(event.type) || [])]) listener.call(this, event);
      return !event.defaultPrevented;
    }
  }
  Object.assign(document, {
    createElement: (tag) => new Node(tag),
    addEventListener(type, listener) { (listeners.get(type) || listeners.set(type, new Set()).get(type)).add(listener); },
    removeEventListener(type, listener) { listeners.get(type)?.delete(listener); },
    dispatch(type) { for (const listener of listeners.get(type) || []) listener(); },
  });
  return document;
}

