import { reportFromHello } from './host-status.js';
import { AGENT_CLOSE, redactSecrets, verifyAgentToken } from './agent-auth.js';
import { PROTOCOL_VERSION } from './agent-protocol.js';

function sendJson(ws, value) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(value));
}

function close(ws, code, reason) {
  if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) ws.close(code, reason);
}

function parseHello(raw) {
  let message;
  try {
    message = JSON.parse(typeof raw === 'string' ? raw : raw.toString('utf8'));
  } catch {
    return { error: 'hello must be JSON' };
  }
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    return { error: 'hello must be an object' };
  }
  if (message.event !== 'hello') return { error: 'first message must be a hello event' };
  const protocol = message.protocol;
  if (protocol !== undefined && protocol !== PROTOCOL_VERSION) {
    return { error: 'protocol_mismatch', protocol };
  }
  const hostId = typeof message.hostId === 'string' ? message.hostId.trim() : '';
  const token = typeof message.token === 'string' ? message.token : '';
  if (!hostId) return { error: 'hello.hostId is required' };
  if (!token) return { error: 'hello.token is required' };
  return { hostId, token, hello: message };
}

let nextConnection = 1;

export function attachAgent(ws, { store, registry, log, limiter, clientIp, hostStatus = null, sound = null }) {
  let detachStatus = () => {};
  let boundHostId = null;
  const timeout = setTimeout(() => {
    if (!boundHostId) close(ws, AGENT_CLOSE.PROTOCOL, 'registration timeout');
  }, 10_000);

  const finish = (hostId) => {
    clearTimeout(timeout);
    if (hostId) registry.release(hostId, ws);
  };

  ws.once('message', (data) => {
    const parsed = parseHello(data);
    if (parsed.error === 'protocol_mismatch') {
      sendJson(ws, {
        ok: false,
        error: { code: 'protocol_mismatch', message: `peer speaks protocol ${parsed.protocol}, server speaks ${PROTOCOL_VERSION}` },
      });
      finish(null);
      return close(ws, AGENT_CLOSE.PROTOCOL, 'protocol mismatch');
    }
    if (parsed.error) {
      sendJson(ws, { ok: false, error: { code: 'bad_request', message: parsed.error } });
      finish(null);
      return close(ws, AGENT_CLOSE.PROTOCOL, 'bad hello');
    }

    const wait = limiter?.retryAfterMs(clientIp);
    if (wait) {
      finish(null);
      return close(ws, 4408, 'rate limited');
    }

    const host = store.getHost(parsed.hostId);
    const credential = host?.agentCredential;
    const ok = Boolean(credential && verifyAgentToken(parsed.token, credential.tokenHash));

    if (!host || !credential || !ok) {
      limiter?.fail(clientIp);
      log(`agent rejected host=${parsed.hostId} reason=unauthorized`);
      sendJson(ws, { ok: false, error: { code: 'unauthorized', message: 'agent credential was rejected' } });
      finish(null);
      return close(ws, AGENT_CLOSE.UNAUTHORIZED, 'unauthorized');
    }
    if (credential.revokedAt) {
      limiter?.fail(clientIp);
      log(`agent rejected host=${host.id} reason=revoked`);
      sendJson(ws, { ok: false, error: { code: 'revoked', message: 'agent credential has been revoked' } });
      finish(null);
      return close(ws, AGENT_CLOSE.REVOKED, 'revoked');
    }

    limiter?.succeed(clientIp);
    boundHostId = host.id;
    registry.connect(host.id, {
      ws,
      credentialId: credential.id,
      hello: {
        name: typeof parsed.hello.name === 'string' ? parsed.hello.name : null,
        version: typeof parsed.hello.version === 'string' ? parsed.hello.version : null,
        mode: parsed.hello.mode === 'persistent' || parsed.hello.mode === 'temporary' ? parsed.hello.mode : null,
        protocol: PROTOCOL_VERSION,
        operations: Array.isArray(parsed.hello.operations) ? parsed.hello.operations.filter((op) => ['fs.list', 'fs.list.page', 'fs.read', 'fs.write', 'exec.run', 'audio.capture'].includes(op)) : [],
      },
    });
    detachStatus = hostStatus?.attach(host.id, `registered:${nextConnection++}`, reportFromHello(parsed.hello, 'registered')) ?? detachStatus;
    ws.on('message', (raw) => {
      let message;
      try { message = JSON.parse(typeof raw === 'string' ? raw : raw.toString('utf8')); } catch { return; }
      const current = registry.get(host.id);
      if (current?.ws !== ws) return; // a replaced connection no longer speaks for this computer
      if (current.resolveRequest(message)) return;
      sound?.agentEvent(host.id, message); // desktop sound (server/desktop-sound.js)
    });
    log(`agent connected host=${host.id}`);
    sendJson(ws, {
      event: 'authenticated',
      protocol: PROTOCOL_VERSION,
      hostId: host.id,
      mode: parsed.hello.mode === 'temporary' ? 'temporary' : 'persistent',
    });
  });

  ws.on('error', (err) => {
    log(`agent socket error host=${boundHostId || 'unknown'}: ${redactSecrets(err.message)}`);
  });

  ws.on('close', () => {
    clearTimeout(timeout);
    if (boundHostId) {
      registry.release(boundHostId, ws);
      detachStatus();
      log(`agent disconnected host=${boundHostId}`);
    }
  });
}
