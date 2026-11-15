export const SAA352_STABLE_READY_MS = 8000;
export const SAA352_INPUT_CLICK_TIMEOUT_MS = 4000;
export const SAA352_INPUT_SETUP_TIMEOUT_MS = 5000;
export const SAA352_INPUT_TIMEOUT_MS = 10000;
export const SAA352_INPUT_BASELINE_TIMEOUT_MS = 2000;
export const SAA352_INPUT_STATE_TIMEOUT_MS = 1000;
export const SAA352_RECOVERY_TIMEOUT_MS = 100000;
export const SAA352_MAX_FIXED_SOCKET_ATTEMPTS = 6;
export const SAA352_REQUIRED_WIDTH = 1032;
export const SAA352_REQUIRED_HEIGHT = 716;
export const SAA352_RETRY_BASE_DELAY_MS = 500;
export const SAA352_RETRY_MAX_DELAY_MS = 4000;

// Keep the entire readiness and input proof inside the recovery deadline.
const SAA352_INPUT_PROOF_RESERVE_MS = SAA352_INPUT_CLICK_TIMEOUT_MS
  + SAA352_INPUT_BASELINE_TIMEOUT_MS
  + (2 * SAA352_INPUT_STATE_TIMEOUT_MS)
  + SAA352_INPUT_SETUP_TIMEOUT_MS
  + SAA352_INPUT_TIMEOUT_MS;

export function getSAA352ReadinessDeadline(recoveryDeadline) {
  return Math.max(0, recoveryDeadline - SAA352_INPUT_PROOF_RESERVE_MS);
}

export function getLatestFixedSocket(sockets) {
  return [...sockets].reverse().find((socket) => socket.fixed) ?? null;
}

export function getLatestActiveFixedSocket(sockets) {
  const latest = getLatestFixedSocket(sockets);
  if (!latest || latest.closed || latest.errors?.length) return null;
  return latest;
}

export function isSAA352CurrentFixedSocket(candidate, sockets) {
  return Boolean(candidate?.fixed && getLatestActiveFixedSocket(sockets)?.id === candidate.id);
}

export function getSAA352RetryDelayMs(retryNumber) {
  const exponent = Math.max(0, Math.min(3, Math.floor(retryNumber) - 1));
  return Math.min(SAA352_RETRY_BASE_DELAY_MS * (2 ** exponent), SAA352_RETRY_MAX_DELAY_MS);
}

export function createSAA352RecoveryBudget(startedAt, options = {}) {
  const requestedTimeout = Number.isFinite(options.timeoutMs) ? options.timeoutMs : SAA352_RECOVERY_TIMEOUT_MS;
  const timeoutMs = Math.max(0, Math.min(requestedTimeout, SAA352_RECOVERY_TIMEOUT_MS));
  const requestedAttempts = Number.isFinite(options.maxAttempts) ? Math.floor(options.maxAttempts) : SAA352_MAX_FIXED_SOCKET_ATTEMPTS;
  const maxAttempts = Math.max(0, Math.min(requestedAttempts, SAA352_MAX_FIXED_SOCKET_ATTEMPTS));
  const deadline = startedAt + timeoutMs;
  const attempts = new Set();
  const failures = new Set();
  let retryAt = startedAt;

  return {
    deadline,
    get attemptCount() { return attempts.size; },
    registerAttempt(socket, now) {
      if (!socket?.fixed) return false;
      if (attempts.has(socket.id)) return true;
      if (now >= deadline || now < retryAt || attempts.size >= maxAttempts) return false;
      attempts.add(socket.id);
      return true;
    },
    hasAttempt(socket) {
      return Boolean(socket && attempts.has(socket.id));
    },
    noteFailure(socket, now) {
      if (!socket || !attempts.has(socket.id)) return Math.max(0, retryAt - now);
      if (!failures.has(socket.id)) {
        failures.add(socket.id);
        retryAt = Math.min(deadline, now + getSAA352RetryDelayMs(attempts.size));
      }
      return Math.max(0, retryAt - now);
    },
    retryDelayRemaining(now) {
      return Math.max(0, retryAt - now);
    },
    remainingMs(now) {
      return Math.max(0, deadline - now);
    },
  };
}

export function createFixedSocketReadinessTracker() {
  let readySocketId = null;
  let readySince = null;
  let readySizeRevision = null;
  let readySizeKey = null;

  return (sockets, state, now, stableForMs) => {
    const current = getLatestActiveFixedSocket(sockets);
    const currentSize = current?.currentSize ?? current?.receivedSizes?.at(-1) ?? null;
    const hasRequiredSize = currentSize?.w === SAA352_REQUIRED_WIDTH
      && currentSize?.h === SAA352_REQUIRED_HEIGHT;
    if (state !== 'ready' || !current || current.ready !== true || current.images < 2 || !hasRequiredSize) {
      readySocketId = null;
      readySince = null;
      readySizeRevision = null;
      readySizeKey = null;
      return null;
    }

    const sizeRevision = current.sizeRevision ?? 0;
    const sizeKey = currentSize.w + 'x' + currentSize.h;
    if (current.id !== readySocketId || sizeRevision !== readySizeRevision || sizeKey !== readySizeKey) {
      readySocketId = current.id;
      readySince = now;
      readySizeRevision = sizeRevision;
      readySizeKey = sizeKey;
    }
    return now - readySince >= stableForMs ? current : null;
  };
}

export function parseSAA352GuacErrors(payload) {
  const text = String(payload);
  const errors = [];
  let offset = 0;

  while (offset < text.length) {
    let nameEnd = offset;
    while (nameEnd < text.length && text[nameEnd] !== ',' && text[nameEnd] !== ';') nameEnd += 1;
    if (nameEnd >= text.length) break;

    const name = text.slice(offset, nameEnd);
    if (text[nameEnd] === ';') {
      offset = nameEnd + 1;
      continue;
    }

    const args = [];
    let cursor = nameEnd + 1;
    let complete = false;
    let malformed = false;
    while (cursor < text.length) {
      const dot = text.indexOf('.', cursor);
      if (dot < 0) {
        malformed = true;
        break;
      }
      const lengthText = text.slice(cursor, dot);
      if (!/^\d+$/.test(lengthText)) {
        malformed = true;
        break;
      }
      const valueStart = dot + 1;
      const valueEnd = valueStart + Number(lengthText);
      if (valueEnd > text.length) {
        malformed = true;
        break;
      }
      args.push(text.slice(valueStart, valueEnd));
      if (text[valueEnd] === ';') {
        offset = valueEnd + 1;
        complete = true;
        break;
      }
      if (text[valueEnd] !== ',') {
        malformed = true;
        break;
      }
      cursor = valueEnd + 1;
    }

    if (!complete) {
      if (!malformed) break;
      const nextEnd = text.indexOf(';', Math.max(nameEnd, cursor));
      if (nextEnd < 0) break;
      offset = nextEnd + 1;
      continue;
    }

    if (name === '5.error' && args.length >= 2) {
      const status = Number(args[1]);
      if (Number.isInteger(status)) errors.push({ message: args[0], status });
    }
  }

  return errors;
}

export function sanitizeSAA352LogMessage(message) {
  return String(message)
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/(token|password|passwd|secret)(\s*[:=]\s*)[^\s,;]+/gi, '$1$2[redacted]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 240);
}
