// SAA-349: user-visible Desktop messages stay in plain words. Technical detail
// (certificates, TLS, guacd, handshakes, status codes) belongs in deploy/ docs only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CLOSE_STATES } from '../public/js/desktop-session.js';
import { hostActions } from '../public/js/host-actions.js';
import { explainVncFailure } from '../server/vnc.js';
import { selectDesktopProtocol } from '../server/desktop-protocols.js';

const JARGON = /certificate|\bcert\b|\bTLS\b|\bSSL\b|\bpin(ned|ning)?\b|fingerprint|guacd|guacamole|handshake|plugin|backend|tunnel|protocol|negotiat|\bRFB\b|\bNLA\b|status \d|\(\d{3,}\)|Remote Hub/i;
const ERRNO = /\bE[A-Z]{4,}\b/; // ECONNREFUSED, ETIMEDOUT, ...
const plain = (where, text) => {
  assert.doesNotMatch(String(text), JARGON, `${where}: "${text}"`);
  assert.doesNotMatch(String(text), ERRNO, `${where}: "${text}"`);
};

test('Desktop close-code messages are plain words', () => {
  for (const [code, [, , message]] of Object.entries(CLOSE_STATES)) plain(`close ${code}`, message);
});

test('VNC failure explanations are plain words', () => {
  const at = { address: 'mac.lan', port: 5900 };
  const checks = [
    { status: 'unreachable', code: 'ECONNREFUSED' }, { status: 'timeout' }, { status: 'not-vnc', silent: true },
    { status: 'closed' }, { status: 'refused', reason: 'RFB security handshake failed' },
    { status: 'ok', securityTypes: [{ id: 18, name: 'TLS' }, { id: 19, name: 'VeNCrypt' }], supported: false },
  ];
  for (const c of checks) plain(c.status, explainVncFailure(c, at).message);
  const pw = { status: 'ok', securityTypes: [{ id: 2, name: 'VNC password' }], supported: true, needsPassword: true };
  plain('pw given', explainVncFailure(pw, { ...at, passwordGiven: true }).message);
  plain('pw missing', explainVncFailure(pw, { ...at, passwordGiven: false }).message);
});

test('desktop choice and host-card reasons are plain words', () => {
  const host = (desktop) => ({ capabilities: { desktop } });
  plain('no capability', selectDesktopProtocol(host({ vnc: false }), { vnc: true }, 'vnc').reason);
  plain('no plugin', selectDesktopProtocol(host({ vnc: true }), { vnc: false }, 'vnc').reason);
  plain('nothing', selectDesktopProtocol(host({}), { vnc: true }).reason);
  const base = { id: 'h', capabilities: { desktop: { vnc: true } }, desktop: { protocol: 'vnc' }, desktopServerEnabled: true };
  for (const h of [base, { ...base, capabilities: { desktop: { vnc: false } } }, { ...base, desktopProtocols: { vnc: false } }, { ...base, desktop: null }, { id: 'h', capabilities: {} }]) {
    for (const a of hostActions(h)) if (a.reason) plain(`host action ${a.id ?? a.label}`, a.reason);
  }
});

test('RDP and desktop server messages sent to the browser are plain words', () => {
  const sources = { 'server/rdp.js': readFileSync(new URL('../server/rdp.js', import.meta.url), 'utf8'),
    'server/app.js': readFileSync(new URL('../server/app.js', import.meta.url), 'utf8') };
  const found = [];
  for (const [file, src] of Object.entries(sources)) {
    for (const m of src.matchAll(/(?:fail\(|reason: |refuse\([^,]+, |error: )(['`])((?:(?!\1).)*)\1/g)) found.push([file, m[2]]);
  }
  const desktop = found.filter(([file, s]) => file === 'server/rdp.js' || /desktop|RDP|VNC|computer/i.test(s));
  assert.ok(desktop.length >= 10, `expected to scan the desktop messages, found ${desktop.length}`);
  for (const [file, s] of desktop) plain(file, s.replace(/\$\{[^}]*\}/g, "X"));
});

test('the Trust button is plain words', () => {
  const src = readFileSync(new URL('../public/js/desktop-session.js', import.meta.url), 'utf8');
  assert.match(src, /'Trust this computer again'/);
  assert.doesNotMatch(src, /'Trust new certificate'/);
});

test('the old #20/#21 jargon sentences are gone from desktop sources', () => {
  for (const f of ['public/js/desktop-session.js', 'public/js/host-actions.js', 'server/app.js', 'server/desktop-protocols.js', 'server/rdp.js', 'server/vnc.js']) {
    const src = readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
    assert.doesNotMatch(src, /does not offer TLS|cannot serve \$\{|its plugin is not installed/, f);
  }
});
