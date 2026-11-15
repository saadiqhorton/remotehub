export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

let onUnauthorized = () => {};

export function setUnauthorizedHandler(handler) {
  onUnauthorized = handler;
}

export async function api(path, { method = 'GET', body } = {}) {
  let response;
  try {
    response = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, "Can't reach the RemoteHub server.");
  }

  let data = null;
  try {
    data = await response.json();
  } catch {
    // Non-JSON responses (e.g. proxy error pages) fall through to the status check.
  }

  if (!response.ok) {
    const error = new ApiError(response.status, data?.error || `Request failed (${response.status}).`);
    error.data = data;
    const retryAfter = Number(response.headers?.get?.('Retry-After'));
    if (Number.isFinite(retryAfter) && retryAfter > 0) error.retryAfterSeconds = retryAfter;
    if (response.status === 401 && !path.startsWith('/api/auth/')) onUnauthorized(error);
    throw error;
  }
  return data;
}
