import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeDocument, loadGuacamole } from './helpers/fake-dom.js';
import { DESKTOP_CLOSE as SERVER_CLOSE } from '../server/desktop-bridge.js';

// Load Apache's browser bundle before importing the adapter, matching index.html's
// classic-script-before-ES-module order.
globalThis.document ??= makeDocument();
globalThis.window ??= globalThis;
const nativeSetTimeout = globalThis.setTimeout.bind(globalThis);
const nativeClearTimeout = globalThis.clearTimeout.bind(globalThis);
globalThis.window.setTimeout = (...args) => {
  const timer = nativeSetTimeout(...args);
  timer.unref?.();
  return timer;
};
globalThis.window.clearTimeout = (timer) => nativeClearTimeout(timer);
const Guac = loadGuacamole();
const { DESKTOP_CLOSE, RemoteHubTunnel, desktopTunnelUrl } = await import('../public/js/desktop-tunnel.js');

function makeSocketClass() {
  const sockets = [];
  class FakeWebSocket {
    constructor(url) {
      this.url = url;
      this.readyState = 0;
      this.sent = [];
      this.closedWith = [];
      sockets.push(this);
    }
    send(data) { this.sent.push(data); }
    close(code, reason) { this.closedWith.push([code, reason]); }
    open() { this.readyState = 1; this.onopen?.(); }
    receive(...elements) { this.onmessage?.({ data: Guac.Parser.toInstruction(elements) }); }
  }
  return { FakeWebSocket, sockets };
}

test('official Guac Parser encodes and incrementally parses fragmented Unicode instructions', () => {
  assert.equal(Guac.Parser.toInstruction(['size', '0', '800', '600']), '4.size,1.0,3.800,3.600;');
  const received = [];
  const parser = new Guac.Parser();
  parser.oninstruction = (opcode, args) => received.push([opcode, ...args]);

  const wire = Guac.Parser.toInstruction(['sync', '1'])
    + Guac.Parser.toInstruction(['clipboard', 'text/plain', 'héllo😀']);
  const emoji = wire.indexOf('😀');
  parser.receive(wire.slice(0, emoji + 1));
  parser.receive(wire.slice(emoji + 1)); // split the surrogate pair across input chunks
  assert.deepEqual(received, [['sync', '1'], ['clipboard', 'text/plain', 'héllo😀']]);
  assert.throws(() => parser.receive('HTTP/1.1;'));
});

test('RemoteHubTunnel uses official encoding and sends credentials as its first WebSocket instruction', () => {
  const { FakeWebSocket, sockets } = makeSocketClass();
  const tunnel = new RemoteHubTunnel({ url: 'ws://x/ws/desktop', WebSocketImpl: FakeWebSocket, password: 'pw✓', Guac });

  tunnel.connect();
  const socket = sockets[0];
  assert.equal(socket.url, 'ws://x/ws/desktop');
  tunnel.sendMessage('mouse', 1, 2, 0); // not open: dropped
  assert.deepEqual(socket.sent, []);

  socket.open();
  tunnel.sendMessage('sync', '9');
  assert.deepEqual(socket.sent, [
    Guac.Parser.toInstruction(['credentials', 'password', 'pw✓']),
    Guac.Parser.toInstruction(['sync', '9']),
  ]);
  assert.equal(tunnel.password, '', 'password is discarded after credentials are sent');

  socket.readyState = 3;
  tunnel.sendMessage('nop');
  assert.equal(socket.sent.length, 2, 'instructions are gated after the socket stops being open');
});

test('RemoteHubTunnel parses fragmented server messages and reports authoritative close metadata', () => {
  const { FakeWebSocket, sockets } = makeSocketClass();
  const tunnel = new RemoteHubTunnel({ url: 'ws://x/ws/desktop', WebSocketImpl: FakeWebSocket, Guac });
  const received = [];
  const closes = [];
  tunnel.oninstruction = (opcode, args) => received.push([opcode, ...args]);
  tunnel.onclose = (event) => closes.push(event);
  tunnel.connect();

  const socket = sockets[0];
  socket.open();
  const wire = Guac.Parser.toInstruction(['ready', '$abcd'])
    + Guac.Parser.toInstruction(['sync', '7'])
    + Guac.Parser.toInstruction(['clipboard', 'text/plain', 'héllo😀']);
  const emoji = wire.indexOf('😀');
  socket.onmessage({ data: wire.slice(0, emoji + 1) });
  socket.onmessage({ data: wire.slice(emoji + 1) });
  socket.onclose({ code: DESKTOP_CLOSE.CERT_CHANGED, reason: 'Certificate changed' });

  assert.deepEqual(received, [['ready', '$abcd'], ['sync', '7'], ['clipboard', 'text/plain', 'héllo😀']]);
  assert.deepEqual(closes, [{ code: DESKTOP_CLOSE.CERT_CHANGED, reason: 'Certificate changed', opened: true }]);
  assert.equal(tunnel.socket, null);
  assert.deepEqual({ ...DESKTOP_CLOSE }, { ...SERVER_CLOSE });
});

test('RemoteHubTunnel preserves close codes for auth and backend-loss closes', () => {
  for (const code of [DESKTOP_CLOSE.AUTH, DESKTOP_CLOSE.BACKEND_LOST]) {
    const { FakeWebSocket, sockets } = makeSocketClass();
    const tunnel = new RemoteHubTunnel({ url: 'ws://x/ws/desktop', WebSocketImpl: FakeWebSocket, Guac });
    const closes = [];
    tunnel.onclose = (event) => closes.push(event);
    tunnel.connect();
    const socket = sockets[0];
    socket.open();
    socket.onclose({ code, reason: 'bridge closed' });
    assert.deepEqual(closes, [{ code, reason: 'bridge closed', opened: true }]);
    assert.equal(tunnel.socket, null);
  }

  const { FakeWebSocket, sockets } = makeSocketClass();
  const refused = new RemoteHubTunnel({ url: 'ws://x/ws/desktop', WebSocketImpl: FakeWebSocket, Guac });
  const refusedCloses = [];
  refused.onclose = (event) => refusedCloses.push(event);
  refused.connect();
  sockets[0].onclose({ code: DESKTOP_CLOSE.AUTH, reason: 'login required' });
  assert.deepEqual(refusedCloses, [{ code: DESKTOP_CLOSE.AUTH, reason: 'login required', opened: false }]);
});

test('malformed and binary frames close with valid wire code but report one 1007 tunnel failure', () => {
  for (const data of ['HTTP/1.1 400;', new Uint8Array([0, 1, 2])]) {
    const { FakeWebSocket, sockets } = makeSocketClass();
    const tunnel = new RemoteHubTunnel({ url: 'ws://x/ws/desktop', WebSocketImpl: FakeWebSocket, Guac });
    const closes = [];
    tunnel.onclose = (event) => closes.push(event);
    tunnel.connect();
    const socket = sockets[0];
    socket.open();

    socket.onmessage({ data });
    assert.deepEqual(socket.closedWith, [[3000, 'malformed instruction']], '1007 is reserved and must not be passed to WebSocket.close');
    socket.onclose({ code: 3000, reason: 'malformed instruction' });
    socket.onclose({ code: 3000, reason: 'duplicate close event' });
    assert.deepEqual(closes, [{ code: 1007, reason: 'Malformed Guacamole instruction', opened: true }]);
  }
});

test('Guac Client protocol error does not preempt the authoritative bridge close', () => {
  const { FakeWebSocket, sockets } = makeSocketClass();
  const tunnel = new RemoteHubTunnel({ url: 'ws://x/ws/desktop', WebSocketImpl: FakeWebSocket, Guac });
  const client = new Guac.Client(tunnel);
  const clientErrors = [];
  const closes = [];
  client.onerror = (status) => clientErrors.push(status);
  tunnel.onclose = (event) => closes.push(event);
  client.connect();
  const socket = sockets[0];
  socket.open();

  socket.receive('error', 'Remote desktop failed', String(Guac.Status.Code.SERVER_ERROR));
  assert.equal(clientErrors.length, 1, 'Apache Client receives and handles the protocol error');
  assert.deepEqual(socket.closedWith, [], 'client disconnect does not close the transport ahead of the bridge');
  assert.equal(tunnel.socket, socket, 'socket identity remains available for the authoritative close event');

  socket.onclose({ code: DESKTOP_CLOSE.REMOTE_ERROR, reason: 'bridge reported remote failure' });
  assert.deepEqual(closes, [{ code: DESKTOP_CLOSE.REMOTE_ERROR, reason: 'bridge reported remote failure', opened: true }]);
});

test('Guac Client disconnect instruction still allows authoritative backend close metadata', () => {
  const { FakeWebSocket, sockets } = makeSocketClass();
  const tunnel = new RemoteHubTunnel({ url: 'ws://x/ws/desktop', WebSocketImpl: FakeWebSocket, Guac });
  const client = new Guac.Client(tunnel);
  const closes = [];
  tunnel.onclose = (event) => closes.push(event);
  client.connect();
  const socket = sockets[0];
  socket.open();

  socket.receive('disconnect');
  assert.deepEqual(socket.closedWith, [], 'RemoteHub holds the transport open for the bridge close frame');
  assert.equal(tunnel.socket, socket, 'adapter retains the socket until the browser reports its close event');
  socket.onclose({ code: DESKTOP_CLOSE.BACKEND_LOST, reason: 'Desktop service stopped unexpectedly.' });
  assert.deepEqual(closes, [{ code: DESKTOP_CLOSE.BACKEND_LOST, reason: 'Desktop service stopped unexpectedly.', opened: true }]);
});

test('tunnel URL carries only host id and size, and chooses ws/wss from page protocol', () => {
  const url = desktopTunnelUrl({ host: { id: 'h1', address: 'secret.example' }, width: 800.4, height: 600, location: { protocol: 'https:', host: 'rh.lan' } });
  assert.equal(url, 'wss://rh.lan/ws/desktop?hostId=h1&width=800&height=600&dpi=96');
  assert.equal(desktopTunnelUrl({ host: { id: 'h' }, width: 1, height: 1, location: { protocol: 'http:', host: 'a:1' } }), 'ws://a:1/ws/desktop?hostId=h&width=1&height=1&dpi=96');
  assert.throws(() => desktopTunnelUrl({ host: { id: 'h' }, width: 1, height: 1, location: {} }), /location/);
});
