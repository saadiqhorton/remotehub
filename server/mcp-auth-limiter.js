const MAX_AUTH_FAILURES_PER_IP = 5;
const AUTH_FAILURE_WINDOW_MS = 15 * 60_000;
const AUTH_LOCK_MS = 10 * 60_000;
const MAX_AUTH_BUCKETS = 10_000;
const MAX_AGGREGATE_AUTH_FAILURES = 5;
const AUTH_COOLDOWN_MS = 60_000;

export function createOAuthAuthLimiter({ now = Date.now, maxBuckets = MAX_AUTH_BUCKETS } = {}) {
  const bucketCapacity = Number.isSafeInteger(maxBuckets) && maxBuckets > 0 ? maxBuckets : MAX_AUTH_BUCKETS;
  const buckets = new Map();
  let aggregateWindowStartedAt = now();
  let aggregateFailures = 0;
  let aggregateInFlight = 0;
  let aggregateLockedUntil = 0;

  const resetAggregate = (at) => {
    aggregateWindowStartedAt = at;
    aggregateFailures = 0;
    aggregateLockedUntil = 0;
  };

  function prune(at) {
    for (const [key, bucket] of buckets) {
      if (bucket.windowStartedAt + AUTH_FAILURE_WINDOW_MS <= at
        && bucket.lockedUntil <= at && bucket.inFlight === 0) {
        buckets.delete(key);
      }
    }
    if (aggregateInFlight === 0 && aggregateLockedUntil > 0 && aggregateLockedUntil <= at) {
      resetAggregate(at);
    } else if (aggregateInFlight === 0 && aggregateWindowStartedAt + AUTH_FAILURE_WINDOW_MS <= at) {
      resetAggregate(at);
    }
  }

  function retryAfterMs(ip, at) {
    prune(at);
    const bucket = buckets.get(ip);
    let waitMs = 0;
    if (bucket?.lockedUntil > at) {
      waitMs = bucket.lockedUntil - at;
    } else if (bucket && bucket.inFlight > 0
      && bucket.failures + bucket.inFlight >= MAX_AUTH_FAILURES_PER_IP) {
      waitMs = AUTH_LOCK_MS;
    }
    if (aggregateLockedUntil > at) {
      waitMs = Math.max(waitMs, aggregateLockedUntil - at);
    } else if (aggregateInFlight > 0
      && aggregateFailures + aggregateInFlight >= MAX_AGGREGATE_AUTH_FAILURES) {
      waitMs = Math.max(waitMs, AUTH_COOLDOWN_MS);
    }
    return Math.max(0, waitMs);
  }

  function getBucket(ip, at) {
    let bucket = buckets.get(ip);
    if (!bucket) {
      if (buckets.size >= bucketCapacity) {
        const oldestIp = buckets.keys().next().value;
        if (oldestIp !== undefined) buckets.delete(oldestIp);
      }
      bucket = { windowStartedAt: at, failures: 0, inFlight: 0, lockedUntil: 0 };
      buckets.set(ip, bucket);
    } else if (bucket.windowStartedAt + AUTH_FAILURE_WINDOW_MS <= at
      && bucket.lockedUntil <= at) {
      bucket.windowStartedAt = at;
      bucket.failures = 0;
      bucket.lockedUntil = 0;
    }
    return bucket;
  }

  function begin(ip) {
    const key = String(ip || 'unknown');
    const at = now();
    const waitMs = retryAfterMs(key, at);
    if (waitMs > 0) return { ok: false, retryAfterMs: waitMs };

    // Reserve before awaiting password verification so concurrent requests cannot race past the cap.
    const bucket = getBucket(key, at);
    bucket.inFlight += 1;
    aggregateInFlight += 1;
    let finished = false;
    return {
      ok: true,
      finish(success) {
        if (finished) return;
        finished = true;
        const completedAt = now();
        bucket.inFlight = Math.max(0, bucket.inFlight - 1);
        aggregateInFlight = Math.max(0, aggregateInFlight - 1);

        if (success) {
          bucket.windowStartedAt = completedAt;
          bucket.failures = 0;
          bucket.lockedUntil = 0;
          resetAggregate(completedAt);
        } else {
          if (bucket.windowStartedAt + AUTH_FAILURE_WINDOW_MS <= completedAt
            && bucket.lockedUntil <= completedAt) {
            bucket.windowStartedAt = completedAt;
            bucket.failures = 0;
            bucket.lockedUntil = 0;
          }
          bucket.failures += 1;
          if (bucket.failures >= MAX_AUTH_FAILURES_PER_IP) {
            bucket.lockedUntil = completedAt + AUTH_LOCK_MS;
          }

          if (aggregateInFlight === 0 && aggregateLockedUntil > 0 && aggregateLockedUntil <= completedAt) {
            resetAggregate(completedAt);
          } else if (aggregateInFlight === 0
            && aggregateWindowStartedAt + AUTH_FAILURE_WINDOW_MS <= completedAt) {
            resetAggregate(completedAt);
          }
          aggregateFailures += 1;
          if (aggregateFailures >= MAX_AGGREGATE_AUTH_FAILURES
            && aggregateLockedUntil <= completedAt) {
            aggregateLockedUntil = completedAt + AUTH_COOLDOWN_MS;
          }
        }
        prune(completedAt);
      },
    };
  }

  return { begin };
}
