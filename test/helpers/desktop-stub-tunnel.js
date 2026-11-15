import { ensureWindow } from './fake-dom.js';

// Deterministic transport for DesktopSession tests. Protocol parsing, streams, display,
// input and synchronization still run through the bundled Apache Guacamole.Client.
export function stubTunnelFactory() {
  ensureWindow();
  const made = [];
  const factory = (options) => {
    const Guac = globalThis.Guacamole;
    const tunnel = {};
    Guac.Tunnel.call(tunnel);
    Object.assign(tunnel, {
      options,
      sent: [],
      connected: false,
      closed: false,
      parser: new Guac.Parser(),
      connect() {
        this.connected = true;
        this.setState(Guac.Tunnel.State.CONNECTING);
        this.setState(Guac.Tunnel.State.OPEN);
      },
      sendMessage(...elements) { this.sent.push(elements.map(String)); },
      send(opcode, ...args) { this.sendMessage(opcode, ...args); },
      disconnect() { this.close(); },
      close() { this.closed = true; },
      receive(opcode, ...args) { this.parser.receive(Guac.Parser.toInstruction([opcode, ...args])); },
      end(code, reason = '', opened = true) {
        this.closed = true;
        this.setState(Guac.Tunnel.State.CLOSED);
        this.onclose?.({ code, reason, opened });
      },
      fail(message = 'socket error') {
        this.onerror?.(new Guac.Status(Guac.Status.Code.UPSTREAM_NOT_FOUND, message));
        this.end(1006, '', false);
      },
      ops(name) { return this.sent.filter(([op]) => op === name); },
    });
    tunnel.parser.oninstruction = (opcode, args) => {
      const accepted = tunnel.onrawinstruction?.(opcode, args);
      if (accepted !== false) tunnel.oninstruction?.(opcode, args);
    };
    made.push(tunnel);
    return tunnel;
  };
  factory.made = made;
  factory.last = () => made.at(-1);
  return factory;
}
