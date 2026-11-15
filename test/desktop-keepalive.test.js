// Keep-alives are owned by the bundled Guacamole.Client. Use its real window timers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeDocument } from './helpers/fake-dom.js';
import { stubTunnelFactory } from './helpers/desktop-stub-tunnel.js';

globalThis.document ??= makeDocument();
const { DesktopSession } = await import('../public/js/desktop-session.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function view() {
  const factory = stubTunnelFactory();
  const s = new DesktopSession({ host: { id: 'h', name: 'Mac', address: 'mac.lan', username: 'me', port: 22, desktop: { protocol: 'vnc', port: 5900 } }, createTunnel: factory });
  s.mount(document.createElement('div'));
  return { s, factory };
}

test('the official client sends periodic nops on an idle session, and stops after disconnect', async () => {
  const { s, factory } = view();
  s.connect();
  const t = factory.last();
  t.receive('ready', '$id');
  await sleep(5200);
  const nops = t.ops('nop').length;
  assert.ok(nops >= 2, `expected an initial and periodic keep-alive; got ${nops}`);
  assert.deepEqual(t.sent.filter(([op]) => op !== 'nop'), [], 'idle traffic contains no other client messages');
  s.disconnect();
  await sleep(5200);
  assert.equal(t.ops('nop').length, nops, 'the official keep-alive timer stops with the connection');
  s.dispose();
});

test('a reconnect binds keep-alive traffic to the new tunnel only', async () => {
  const { s, factory } = view();
  s.connect();
  const first = factory.last();
  first.end(1011, 'gone');
  const oldNops = first.ops('nop').length;
  s.connect();
  const second = factory.last();
  second.receive('ready', '$id');
  await sleep(5200);
  assert.ok(second.ops('nop').length >= 2, 'new client schedules its own keep-alive');
  assert.equal(first.ops('nop').length, oldNops, 'the old tunnel receives no post-reconnect messages');
  s.dispose();
});

test('a guacd nop is handled quietly without changing the session state', () => {
  const { s, factory } = view();
  s.connect();
  const t = factory.last();
  t.receive('ready', '$id');
  const state = s.state;
  const before = t.sent.length;
  t.receive('nop');
  assert.equal(s.state, state);
  assert.equal(t.sent.length, before, 'incoming keep-alive does not itself produce an immediate reply');
  s.dispose();
});

test('incoming guacd traffic immediately catches up an overdue keep-alive without duplicating it', (t) => {
  t.mock.timers.enable({ apis: ['Date'] });
  try {
    const { s, factory } = view();
    s.connect();
    const tunnel = factory.last();
    tunnel.receive('ready', '$id');
    const before = tunnel.ops('nop').length;
    t.mock.timers.tick(6000); // model a throttled background timer; leave real Client timers pending
    tunnel.receive('nop');
    const caughtUp = tunnel.ops('nop').length;
    assert.equal(caughtUp, before + 1, 'the inbound instruction triggers one overdue nop immediately');
    tunnel.receive('nop');
    assert.equal(tunnel.ops('nop').length, caughtUp, 'subsequent traffic does not duplicate an on-time keep-alive');
    s.dispose();
  } finally { t.mock.timers.reset(); }
});

test('remote close and dispose cancel the official client keep-alive timer', (t) => {
  for (const end of ['remote-close', 'dispose']) {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'] });
    try {
      const { s, factory } = view();
      s.connect();
      const tunnel = factory.last();
      tunnel.receive('ready', '$id');
      t.mock.timers.tick(5001);
      const before = tunnel.ops('nop').length;
      if (end === 'remote-close') tunnel.end(1011, 'gone');
      else s.dispose();
      t.mock.timers.tick(5001);
      assert.equal(tunnel.ops('nop').length, before, `${end} cancels pending keep-alive work`);
      s.dispose();
    } finally { t.mock.timers.reset(); }
  }
});

test('editing an endpoint during an automatic retry stops the old official client keep-alive', (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'] });
  try {
    const { s, factory } = view();
    s.connect();
    const first = factory.last();
    first.receive('ready', '$id');
    // Model a previously live session, then let the actual retry countdown open a new client.
    s.wasLive = true;
    first.end(4502, 'gone');
    t.mock.timers.tick(2000);
    const retry = factory.last();
    const client = s.client;
    const states = [];
    const onstatechange = client.onstatechange;
    client.onstatechange = (state) => { onstatechange?.(state); states.push(state); };
    retry.receive('ready', '$retry');
    assert.equal(s.autoReconnecting, true);
    const before = retry.ops('nop').length;
    t.mock.timers.tick(5000);
    assert.ok(retry.ops('nop').length > before, 'the bundled client keep-alive runs on the retry tunnel');
    retry.receive('nop'); // Inbound activity schedules the official client's next keep-alive.

    s.updateHost({ ...s.host, address: 'new-host.lan' });
    assert.equal(retry.closed, true, 'the old retry tunnel is closed');
    assert.equal(s.client, null, 'the old client reference is cleared');
    assert.equal(s.display, null, 'the old display reference is cleared');
    assert.ok(states.includes(globalThis.Guacamole.Client.State.DISCONNECTED), 'the actual bundled client is disconnected');
    const stopped = retry.ops('nop').length;
    t.mock.timers.tick(5000);
    assert.equal(retry.ops('nop').length, stopped, 'the old client timer is cancelled with the endpoint change');
    s.dispose();
  } finally { t.mock.timers.reset(); }
});
