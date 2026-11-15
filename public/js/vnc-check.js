// SAA-305: asks RemoteHub's read-only VNC pre-check (GET /api/hosts/:id/desktop/vnc-check)
// why a VNC session failed. Returns { reason, message } or null. Sends no password.
// SAA-346: the pre-check allows one call per host every few seconds. A quick retry used to
// get 429 and fall back to guacd's vague "Aborted. See logs.", so a 429 now waits for
// Retry-After (capped) and asks once more.
export const VNC_CHECK_MAX_WAIT_MS = 10000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function fetchVncExplanation(host, { passwordGiven = false, fetchImpl = globalThis.fetch, wait = sleep } = {}) {
  const url = `/api/hosts/${encodeURIComponent(host.id)}/desktop/vnc-check${passwordGiven ? '?password=1' : ''}`;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await fetchImpl(url, { credentials: 'same-origin' });
    if (response.status === 429 && attempt === 0) {
      const seconds = Number(response.headers?.get?.('Retry-After'));
      await wait(Math.min(Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 5000, VNC_CHECK_MAX_WAIT_MS));
      continue;
    }
    if (!response.ok) return null;
    const { explanation } = await response.json();
    return explanation && typeof explanation.reason === 'string' && typeof explanation.message === 'string' ? explanation : null;
  }
  return null;
}
