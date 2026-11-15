import express from 'express';
import { createHash, randomBytes } from 'node:crypto';
import { BASIC_SCOPES, createMcpOAuthRouter } from './mcp-oauth.js';

// A 1 MiB write can expand to 6 MiB when JSON escapes control characters; keep room for its envelope.
const MAX_BODY = 8 * 1024 * 1024;
const MAX_FILE_WRITE = 1024 * 1024;
const MAX_COMMAND_OUTPUT = 64 * 1024;
const MAX_COMMAND_TIMEOUT_MS = 300_000;
const MAX_COMMAND_INPUT = 64 * 1024;
const MAX_COMMAND_ARGUMENTS = 64;
const MAX_COMMAND_ARGUMENT_BYTES = 64 * 1024;
const PROTOCOL_VERSION = '2025-11-25';
const SUPPORTED_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26'];
const MAX_MCP_SESSIONS = 4096;
const MAX_MCP_SESSIONS_PER_CLIENT = 32;
const MCP_SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const TOOL_CALL_WINDOW_MS = 60_000;
const MAX_TOOL_CALLS_PER_TOKEN = 30;
const MAX_TOOL_CALLS_PER_CLIENT = 300;
const MAX_TOOL_CALL_BUCKETS = 2048;
const toolCallBuckets = new Map();
let lastToolBucketPruneAt = 0;

const schemas = {
  hostId: { type: 'string', minLength: 1, maxLength: 64 },
  path: { type: 'string', minLength: 1, maxLength: 2048 },
};
const tools = [
  { name: 'remotehub.hosts.list', description: 'List the hosts selected and currently connected for this OAuth grant.', inputSchema: { type: 'object', additionalProperties: false }, access: ['hosts:read'] },
  { name: 'remotehub.files.list', description: 'List a bounded page of entries under the selected host agent root. Use nextCursor as cursor to continue when hasMore is true.', inputSchema: { type: 'object', properties: { hostId: schemas.hostId, path: { type: 'string', maxLength: 2048 }, cursor: { type: 'string', maxLength: 1024 }, limit: { type: 'integer', minimum: 1, maximum: 256 } }, required: ['hostId'], additionalProperties: false }, access: ['files:read'] },
  { name: 'remotehub.files.read', description: 'Read a UTF-8 text file under the selected host agent root (maximum 64 KiB).', inputSchema: { type: 'object', properties: { hostId: schemas.hostId, path: schemas.path }, required: ['hostId', 'path'], additionalProperties: false }, access: ['files:read'] },
  { name: 'remotehub.files.write', description: 'Write a UTF-8 text file under the selected host agent root (maximum 1 MiB of UTF-8 bytes).', inputSchema: { type: 'object', properties: { hostId: schemas.hostId, path: schemas.path, content: { type: 'string', maxLength: MAX_FILE_WRITE } }, required: ['hostId', 'path', 'content'], additionalProperties: false }, access: ['files:write'], destructive: true },
  { name: 'remotehub.commands.run', description: 'Execute one program with argv on the selected connected host. It runs as the agent service account; the agent root is only its working directory, not a sandbox. Explicit shell executables remain powerful.', inputSchema: { type: 'object', properties: { hostId: schemas.hostId, executable: { type: 'string', minLength: 1, maxLength: 256 }, args: { type: 'array', maxItems: MAX_COMMAND_ARGUMENTS, items: { type: 'string', maxLength: 4096 } }, stdin: { type: 'string', maxLength: MAX_COMMAND_INPUT }, timeoutMs: { type: 'integer', minimum: 1000, maximum: MAX_COMMAND_TIMEOUT_MS } }, required: ['hostId', 'executable'], additionalProperties: false }, access: ['commands:exec'], destructive: true },
];

const response = (id, result) => ({ jsonrpc: '2.0', id, result });
const error = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });
const toolError = (message, challenge = null) => ({ content: [{ type: 'text', text: message }], ...(challenge ? { _meta: { 'mcp/www_authenticate': [challenge] } } : {}), isError: true });
const toolResult = (value) => ({ content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value, isError: false });
const hasScopes = (grant, required) => required.every((scope) => grant.scopes.includes(scope));
const validId = (value) => typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value));
const requestKey = (value) => `${typeof value}:${String(value)}`;

function toolCallRetryAfter(grant, token) {
  const now = Date.now();
  for (const [key, bucket] of toolCallBuckets) {
    if (bucket.startedAt + TOOL_CALL_WINDOW_MS <= now) toolCallBuckets.delete(key);
  }
  const tokenKey = `token:${createHash('sha256').update(token).digest('hex')}`;
  const clientKey = `client:${grant.clientId}`;
  const entries = [
    [tokenKey, MAX_TOOL_CALLS_PER_TOKEN],
    [clientKey, MAX_TOOL_CALLS_PER_CLIENT],
  ];
  const live = entries.map(([key, max]) => {
    let bucket = toolCallBuckets.get(key);
    if (!bucket || bucket.startedAt + TOOL_CALL_WINDOW_MS <= now) bucket = { startedAt: now, count: 0 };
    return { key, max, bucket, exists: toolCallBuckets.has(key) };
  });
  const denied = live.filter(({ bucket, max }) => bucket.count >= max);
  if (denied.length) return Math.max(...denied.map(({ bucket }) => bucket.startedAt + TOOL_CALL_WINDOW_MS - now));
  const missing = live.filter(({ exists }) => !exists).length;
  if (toolCallBuckets.size + missing > MAX_TOOL_CALL_BUCKETS) return TOOL_CALL_WINDOW_MS;
  for (const { key, bucket } of live) toolCallBuckets.set(key, { ...bucket, count: bucket.count + 1 });
  return 0;
}

function validArgs(name, args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return 'Tool arguments must be an object.';
  if (name === 'remotehub.hosts.list') return null;
  if (typeof args.hostId !== 'string' || args.hostId.length < 1 || args.hostId.length > 64) return 'hostId is required.';
  if (name === 'remotehub.commands.run') {
    if (typeof args.executable !== 'string' || !args.executable.length || Buffer.byteLength(args.executable, 'utf8') > 256 || args.executable.includes(String.fromCharCode(0))) return 'executable must be a non-empty path of at most 256 bytes without NUL.';
    if (args.args !== undefined && (!Array.isArray(args.args) || args.args.length > MAX_COMMAND_ARGUMENTS || args.args.some((arg) => typeof arg !== 'string' || Buffer.byteLength(arg, 'utf8') > 4096))) return 'args must contain at most 64 strings of at most 4096 bytes.';
    if ((args.args || []).reduce((sum, arg) => sum + Buffer.byteLength(arg, 'utf8'), 0) > MAX_COMMAND_ARGUMENT_BYTES) return 'combined args exceed 64 KiB.';
    if (args.stdin !== undefined && (typeof args.stdin !== 'string' || Buffer.byteLength(args.stdin, 'utf8') > MAX_COMMAND_INPUT)) return 'stdin must be UTF-8 text no larger than 64 KiB.';
    if (args.timeoutMs !== undefined && (!Number.isInteger(args.timeoutMs) || args.timeoutMs < 1000 || args.timeoutMs > MAX_COMMAND_TIMEOUT_MS)) return 'timeoutMs must be between 1000 and 300000.';
    return null;
  }
  if (name === 'remotehub.files.list') {
    if (args.path !== undefined && (typeof args.path !== 'string' || args.path.length > 2048)) return 'path is too long.';
    if (args.cursor !== undefined && (typeof args.cursor !== 'string' || Buffer.byteLength(args.cursor, 'utf8') > 4096)) return 'cursor must be UTF-8 text no larger than 4096 bytes.';
    if (args.limit !== undefined && (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > 256)) return 'limit must be an integer between 1 and 256.';
    return null;
  }
  if (typeof args.path !== 'string' || !args.path.trim() || args.path.length > 2048) return 'path is required and must be at most 2048 characters.';
  if (name === 'remotehub.files.read') return null;
  if (name === 'remotehub.files.write') {
    if (typeof args.content !== 'string' || Buffer.byteLength(args.content, 'utf8') > MAX_FILE_WRITE) return 'content must be UTF-8 text no larger than 1 MiB in UTF-8 bytes.';
    return null;
  }
  return 'Unknown tool.';
}

function toolList(grant, registry, config) {
  const connected = grant.hostIds.map((hostId) => registry.get(hostId)).filter((record) => record && registry.isConnected(record.hostId));
  return tools.filter((tool) => {
    if (tool.name === 'remotehub.commands.run') {
      return config.mcpCommandsEnabled && connected.some((record) =>
        record.hello?.operations?.includes('exec.run'));
    }
    if (tool.name === 'remotehub.hosts.list') return true;
    if (tool.name === 'remotehub.files.list') return connected.some((record) => record.hello?.operations?.includes('fs.list.page'));
    const operation = tool.name === 'remotehub.files.read' ? 'fs.read'
        : tool.name === 'remotehub.files.write' ? 'fs.write' : 'exec.run';
    return connected.some((record) => operation === 'fs.list' || record.hello?.operations?.includes(operation));
  }).map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    annotations: { readOnlyHint: !tool.destructive, destructiveHint: Boolean(tool.destructive), openWorldHint: tool.name === 'remotehub.commands.run' },
    _meta: { securitySchemes: [{ type: 'oauth2', scopes: tool.access }] },
  }));
}

export async function createMcpRouter({ config, store, sessions, registry, tokenOf, originAllowed, verifyPassword, requestHost, log = () => {} }) {
  const router = express.Router();
  const oauth = await createMcpOAuthRouter({ express, config, store, sessions, tokenOf, originAllowed, verifyPassword, requestHost, log });
  oauth.setRegistry(registry);
  router.use(oauth.router);

  const metadata = `${oauth.issuer}/.well-known/oauth-protected-resource/mcp`;
  const unauthorized = (res, scopes = BASIC_SCOPES) => {
    const scope = scopes.length ? `, scope="${scopes.join(' ')}"` : '';
    res.set('WWW-Authenticate', `Bearer resource_metadata="${metadata}"${scope}`);
    return res.status(401).json({ error: 'unauthorized' });
  };

  const sessionsById = new Map();
  const removeMcpSession = (sessionId) => {
    const session = sessionsById.get(sessionId);
    if (!session) return;
    sessionsById.delete(sessionId);
    for (const controller of session.inFlight.values()) controller.abort();
    session.inFlight.clear();
  };
  oauth.state.onGrantRevoked((grantId) => {
    for (const [sessionId, session] of sessionsById) {
      if (session.grantId === grantId) removeMcpSession(sessionId);
    }
  });
  const allowedOrigin = (req) => {
    const value = req.headers.origin;
    if (value === undefined) return true; // OAuth bearer clients may be server-to-server.
    if (!config.mcpAllowedOrigins?.length) return false;
    try {
      const parsed = new URL(value);
      if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== value || parsed.username || parsed.password) return false;
      return config.mcpAllowedOrigins.includes(parsed.origin);
    } catch { return false; }
  };
  const validateOrigin = (req, res) => {
    if (allowedOrigin(req)) return true;
    res.status(403).json({ error: 'Origin rejected.' });
    return false;
  };
  const mediaTypes = (header) => new Set(String(header || '').split(',').map((item) => item.split(';', 1)[0].trim().toLowerCase()));
  const supportsPostAccept = (req) => {
    const accepted = mediaTypes(req.headers.accept);
    return accepted.has('application/json') && accepted.has('text/event-stream');
  };
  const validProtocolHeader = (value) => typeof value === 'string' && SUPPORTED_PROTOCOL_VERSIONS.includes(value);

  // Runs for every method before route-level body parsers.
  router.use('/mcp', (req, res, next) => {
    if (!validateOrigin(req, res)) return;
    next();
  });

  router.post('/mcp', express.json({ limit: MAX_BODY, type: ['application/json', 'application/*+json'] }), async (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!validateOrigin(req, res)) return;
    if (!supportsPostAccept(req)) return res.status(406).json({ error: 'Accept must include application/json and text/event-stream.' });
    const auth = /^Bearer ([A-Za-z0-9_-]{32,128})$/.exec(String(req.headers.authorization || ''));
    if (!auth) return unauthorized(res);
    const grant = await oauth.state.getToken(auth[1], oauth.resource);
    if (!grant || grant.ownerId !== 'owner' || !oauth.state.isGrantActive(grant.grantId)) return unauthorized(res);
    const message = req.body;
    if (!message || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
      return res.status(400).json(error(message?.id ?? null, -32600, 'Invalid JSON-RPC request.'));
    }
    const hasId = Object.prototype.hasOwnProperty.call(message, 'id');
    if (hasId && !validId(message.id)) return res.status(400).json(error(null, -32600, 'Invalid JSON-RPC id.'));
    const sid = req.get('MCP-Session-Id');
    if (message.method === 'initialize') {
      if (!hasId || sid) return res.status(400).json(error(message.id ?? null, -32600, 'initialize must start a new session.'));
      const requested = message.params?.protocolVersion;
      if (typeof requested !== 'string') return res.status(400).json(error(message.id, -32602, 'initialize.params.protocolVersion is required.'));
      const selected = SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSION;
      if (req.get('MCP-Protocol-Version') && !validProtocolHeader(req.get('MCP-Protocol-Version'))) {
        return res.status(400).json(error(message.id, -32600, 'Unsupported MCP-Protocol-Version header.'));
      }
      const now = Date.now();
      for (const [id, entry] of sessionsById) if (entry.createdAt + MCP_SESSION_TTL_MS <= now) removeMcpSession(id);
      let clientSessionCount = 0;
      for (const entry of sessionsById.values()) if (entry.clientId === grant.clientId) clientSessionCount += 1;
      if (clientSessionCount >= MAX_MCP_SESSIONS_PER_CLIENT) {
        return res.status(429).json({ error: 'MCP client session capacity reached.' });
      }
      if (sessionsById.size >= MAX_MCP_SESSIONS) return res.status(503).json({ error: 'MCP session capacity reached.' });
      const sessionId = randomBytes(24).toString('base64url');
      sessionsById.set(sessionId, { protocolVersion: selected, initialized: false, createdAt: now, clientId: grant.clientId, grantId: grant.grantId, grantKey: JSON.stringify([grant.clientId, [...grant.hostIds].sort(), [...grant.scopes].sort()]), inFlight: new Map() });
      res.set('MCP-Session-Id', sessionId);
      return res.status(200).type('application/json').send(response(message.id, {
        protocolVersion: selected,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'RemoteHub MCP', version: '0.1.0' },
      }));
    }
    if (!sid) return res.status(400).json(error(message.id ?? null, -32600, 'MCP-Session-Id is required after initialization.'));
    const session = sessionsById.get(sid);
    if (!session) return res.status(404).json(error(message.id ?? null, -32600, 'MCP session not found.'));
    if (session.grantKey !== JSON.stringify([grant.clientId, [...grant.hostIds].sort(), [...grant.scopes].sort()])) return unauthorized(res);
    if (session.createdAt + MCP_SESSION_TTL_MS <= Date.now()) {
      removeMcpSession(sid);
      return res.status(404).json(error(message.id ?? null, -32600, 'MCP session expired.'));
    }
    const protocolHeader = req.get('MCP-Protocol-Version');
    if (!validProtocolHeader(protocolHeader) || protocolHeader !== session.protocolVersion) {
      return res.status(400).json(error(message.id ?? null, -32600, 'MCP-Protocol-Version is missing or does not match the negotiated version.'));
    }
    if (message.method === 'notifications/initialized' && !hasId) {
      session.initialized = true;
      return res.status(202).end();
    }
    if (message.method === 'notifications/cancelled' && !hasId) {
      const requestId = message.params?.requestId;
      if (validId(requestId)) session.inFlight.get(requestKey(requestId))?.abort();
      return res.status(202).end();
    }
    if (message.method.startsWith('notifications/')) {
      if (hasId) return res.status(400).json(error(message.id, -32600, 'Notifications must not include an id.'));
      return res.status(202).end();
    }
    if (!hasId) return res.status(400).json(error(null, -32600, 'Requests must include an id.'));
    if (message.method !== 'ping' && !session.initialized) return res.status(400).json(error(message.id, -32600, 'Send notifications/initialized before requests.'));
    if (message.method === 'tools/call') {
      const retryAfterMs = toolCallRetryAfter(grant, auth[1]);
      if (retryAfterMs > 0) {
        const seconds = Math.max(1, Math.ceil(retryAfterMs / 1000));
        res.set('Retry-After', String(seconds));
        return res.status(429).json(error(message.id, -32029, `Tool call rate limit reached. Retry after ${seconds} seconds.`));
      }
    }
    let result;
    if (message.method === 'ping') {
      result = {};
    } else if (message.method === 'tools/list') {
      result = { tools: toolList(grant, registry, config) };
    } else if (message.method === 'tools/call') {
      const key = requestKey(message.id);
      if (session.inFlight.has(key)) return res.status(400).json(error(message.id, -32600, 'Request id is already in progress.'));
      const controller = new AbortController();
      const abortIfDisconnected = () => controller.abort();
      const abortIfResponseClosed = () => { if (!res.writableEnded) controller.abort(); };
      session.inFlight.set(key, controller);
      req.once('aborted', abortIfDisconnected);
      res.once('close', abortIfResponseClosed);
      try {
        result = await callTool(message.params, grant, { store, registry, metadata, config, signal: controller.signal });
      } finally {
        req.removeListener('aborted', abortIfDisconnected);
        res.removeListener('close', abortIfResponseClosed);
        if (session.inFlight.get(key) === controller) session.inFlight.delete(key);
      }
      const scopeChallenge = result?._meta?.['mcp/www_authenticate']?.[0];
      if (result?.isError && typeof scopeChallenge === 'string' && scopeChallenge.includes('error="insufficient_scope"')) {
        return res.status(403).set('WWW-Authenticate', scopeChallenge).type('application/json').send(response(message.id, result));
      }
      if (controller.signal.aborted) {
        if (!res.destroyed && !res.writableEnded) return res.status(202).end();
        return;
      }
    } else {
      return res.status(200).type('application/json').send(error(message.id, -32601, 'Method not found.'));
    }
    return res.status(200).type('application/json').send(response(message.id, result));
  });

  router.get('/mcp', async (req, res) => {
    if (!validateOrigin(req, res)) return;
    const auth = /^Bearer ([A-Za-z0-9_-]{32,128})$/.exec(String(req.headers.authorization || ''));
    if (!auth) return unauthorized(res);
    const grant = await oauth.state.getToken(auth[1], oauth.resource);
    if (!grant || grant.ownerId !== 'owner' || !oauth.state.isGrantActive(grant.grantId)) return unauthorized(res);
    const sid = req.get('MCP-Session-Id');
    if (sid) {
      const session = sessionsById.get(sid);
      if (!session) return res.status(404).end();
      if (session.grantKey !== JSON.stringify([grant.clientId, [...grant.hostIds].sort(), [...grant.scopes].sort()])) return unauthorized(res);
      if (!validProtocolHeader(req.get('MCP-Protocol-Version')) || req.get('MCP-Protocol-Version') !== session.protocolVersion) {
        return res.status(400).json({ error: 'MCP-Protocol-Version is missing or does not match the negotiated version.' });
      }
    }
    return res.status(405).set('Allow', 'POST, DELETE').end();
  });
  router.delete('/mcp', async (req, res) => {
    if (!validateOrigin(req, res)) return;
    const auth = /^Bearer ([A-Za-z0-9_-]{32,128})$/.exec(String(req.headers.authorization || ''));
    if (!auth) return unauthorized(res);
    const grant = await oauth.state.getToken(auth[1], oauth.resource);
    if (!grant || grant.ownerId !== 'owner' || !oauth.state.isGrantActive(grant.grantId)) return unauthorized(res);
    const sid = req.get('MCP-Session-Id');
    if (!sid) return res.status(400).json({ error: 'MCP-Session-Id is required.' });
    const session = sessionsById.get(sid);
    if (!session) return res.status(404).end();
    if (session.grantKey !== JSON.stringify([grant.clientId, [...grant.hostIds].sort(), [...grant.scopes].sort()])) return unauthorized(res);
    if (!validProtocolHeader(req.get('MCP-Protocol-Version')) || req.get('MCP-Protocol-Version') !== session.protocolVersion) {
      return res.status(400).json({ error: 'MCP-Protocol-Version is missing or does not match the negotiated version.' });
    }
    removeMcpSession(sid);
    return res.status(200).end();
  });
  router.all('/mcp', (req, res) => res.status(405).set('Allow', 'POST, GET, DELETE').end());
  return router;
}

async function callTool(params, grant, { store, registry, metadata, config, signal }) {
  const name = params?.name;
  const args = params?.arguments ?? {};
  const tool = tools.find((item) => item.name === name);
  if (!tool) return toolError('Unknown RemoteHub tool.');
  if (name === 'remotehub.commands.run' && !config.mcpCommandsEnabled) return toolError('Command execution is disabled. Set MCP_COMMANDS_ENABLED=true to opt in.');
  if (!hasScopes(grant, tool.access)) {
    const challenge = `Bearer resource_metadata=\"${metadata}\", error=\"insufficient_scope\", scope=\"${[...new Set([...grant.scopes, ...tool.access])].join(' ')}\", error_description=\"Additional RemoteHub permission required.\"`;
    return toolError('This OAuth grant does not include the required scope. Reconnect RemoteHub with the requested permission.', challenge);
  }
  const validation = validArgs(name, args);
  if (validation) return toolError(validation);
  if (name === 'remotehub.hosts.list') {
    const hosts = store.listHosts().filter((host) => grant.hostIds.includes(host.id) && registry.isConnected(host.id))
      .map((host) => ({ hostId: host.id, name: host.name, address: host.address, agent: host.agent, capabilities: host.capabilities }));
    return toolResult({ hosts });
  }
  if (!grant.hostIds.includes(args.hostId)) return toolError('The selected host is outside this OAuth grant.');
  if (!registry.isConnected(args.hostId)) return toolError('The selected host is not currently connected.');
  const connection = registry.get(args.hostId);
  if (!connection?.request) return toolError('The connected host does not support request dispatch.');
  const op = name === 'remotehub.files.list' ? 'fs.list'
    : name === 'remotehub.files.read' ? 'fs.read'
      : name === 'remotehub.files.write' ? 'fs.write' : 'exec.run';
  if (name === 'remotehub.files.list' && !connection.hello?.operations?.includes('fs.list.page')) {
    return toolError('This host agent does not support bounded directory pages. Upgrade and reconnect it to enable safe listing.');
  }
  if (op !== 'fs.list' && !connection.hello?.operations?.includes(op)) return toolError('This host agent is outdated. Upgrade and reconnect it to enable this operation.');
  const paramsForAgent = op === 'fs.list' ? { path: args.path || '.', cursor: args.cursor ?? null, limit: args.limit ?? 100 }
    : op === 'fs.read' ? { path: args.path }
      : op === 'fs.write' ? { path: args.path, content: args.content }
        : { executable: args.executable, args: args.args || [], ...(args.stdin !== undefined ? { stdin: args.stdin } : {}), timeoutMs: args.timeoutMs || 10_000 };
  try {
    const frame = await connection.request(op, paramsForAgent, op === 'exec.run' ? (args.timeoutMs || 10_000) + 10_000 : 15_000, { signal });
    if (!frame?.ok) return toolError(frame?.error?.message || 'The host agent refused the operation.');
    const encoded = JSON.stringify(frame.result ?? {});
    if (Buffer.byteLength(encoded) > MAX_COMMAND_OUTPUT + MAX_FILE_WRITE + 1024) return toolError('Host result exceeded the response size limit.');
    return toolResult(frame.result ?? {});
  } catch (err) {
    return toolError(err?.message || 'The host did not complete the operation.');
  }
}
