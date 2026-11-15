import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as readiness from './scripts/saa352-probe-readiness.mjs';

const {
  createFixedSocketReadinessTracker,
  createSAA352RecoveryBudget,
  getSAA352RetryDelayMs,
  isSAA352CurrentFixedSocket,
  SAA352_STABLE_READY_MS,
} = readiness;

const socket = (id, extra = {}) => ({
  id,
  fixed: true,
  closed: false,
  ready: true,
  images: 2,
  errors: [],
  receivedSizes: [{ w: 1032, h: 716 }],
  ...extra,
});

test('SAA-352 recovery reserves stable readiness and the complete input proof window', () => {
  assert.equal(SAA352_STABLE_READY_MS, 8000);
  assert.equal(readiness.SAA352_RECOVERY_TIMEOUT_MS, 100000);
  assert.equal(readiness.SAA352_INPUT_CLICK_TIMEOUT_MS, 4000);
  assert.equal(readiness.SAA352_INPUT_SETUP_TIMEOUT_MS, 5000);
  assert.equal(readiness.SAA352_INPUT_TIMEOUT_MS, 10000);
  assert.equal(readiness.SAA352_MAX_FIXED_SOCKET_ATTEMPTS, 6);
  assert.equal(readiness.SAA352_INPUT_BASELINE_TIMEOUT_MS, 2000);
  assert.equal(readiness.SAA352_INPUT_STATE_TIMEOUT_MS, 1000);
  assert.equal(readiness.getSAA352ReadinessDeadline(100000), 77000);
});

test('SAA-352 readiness uses only the latest socket own ready, size, and image evidence', () => {
  const tracker = createFixedSocketReadinessTracker();
  const earlier = socket(1, { images: 20 });
  const current = socket(2, { ready: false, images: 1 });

  assert.equal(tracker([earlier, current], 'ready', 1000, 5000), null);
  current.images = 2;
  assert.equal(tracker([earlier, current], 'ready', 2000, 5000), null);
  current.ready = true;
  assert.equal(tracker([earlier, current], 'ready', 3000, 5000), null);
  assert.equal(tracker([earlier, current], 'ready', 7999, 5000), null);
  assert.equal(tracker([earlier, current], 'ready', 8000, 5000), current);
});

test('SAA-352 readiness rejects a null candidate and a replaced or failed socket', () => {
  const tracker = createFixedSocketReadinessTracker();
  const first = socket(1);
  const replacement = socket(2);

  assert.equal(isSAA352CurrentFixedSocket(null, [first]), false);
  assert.equal(tracker([first], 'ready', 1000, 5000), null);
  assert.equal(tracker([first], 'ready', 6000, 5000), first);
  assert.equal(isSAA352CurrentFixedSocket(first, [first, replacement]), false);
  assert.equal(tracker([first, replacement], 'ready', 7000, 5000), null);
  assert.equal(tracker([first, replacement], 'ready', 11999, 5000), null);
  assert.equal(tracker([first, replacement], 'ready', 12000, 5000), replacement);

  replacement.errors.push(520);
  assert.equal(isSAA352CurrentFixedSocket(replacement, [first, replacement]), false);
  assert.equal(tracker([first, replacement], 'ready', 13000, 5000), null);
  replacement.errors.length = 0;
  replacement.closed = true;
  assert.equal(isSAA352CurrentFixedSocket(replacement, [first, replacement]), false);
  assert.equal(tracker([first, replacement], 'ready', 14000, 5000), null);
});

test('SAA-352 readiness requires 1032x716 evidence from the current socket and resets on size changes', () => {
  const tracker = createFixedSocketReadinessTracker();
  const earlier = socket(1);
  const current = socket(2, { receivedSizes: [] });

  assert.equal(tracker([earlier, current], 'ready', 1000, 8000), null);
  current.receivedSizes.push({ w: 1032, h: 716 });
  assert.equal(tracker([earlier, current], 'ready', 2000, 8000), null);
  assert.equal(tracker([earlier, current], 'ready', 9999, 8000), null);
  assert.equal(tracker([earlier, current], 'ready', 10000, 8000), current);

  current.receivedSizes.push({ w: 1024, h: 768 });
  assert.equal(tracker([earlier, current], 'ready', 11000, 8000), null);
  current.receivedSizes.push({ w: 1032, h: 716 });
  assert.equal(tracker([earlier, current], 'ready', 12000, 8000), null);
  assert.equal(tracker([earlier, current], 'ready', 19999, 8000), null);
  assert.equal(tracker([earlier, current], 'ready', 20000, 8000), current);
});

test('SAA-352 recovery caps elapsed time, fixed attempts, and retry backoff', () => {
  assert.equal(getSAA352RetryDelayMs(1), 500);
  assert.equal(getSAA352RetryDelayMs(2), 1000);
  assert.equal(getSAA352RetryDelayMs(3), 2000);
  assert.equal(getSAA352RetryDelayMs(4), 4000);
  assert.equal(getSAA352RetryDelayMs(20), 4000);

  const budget = createSAA352RecoveryBudget(1000, { timeoutMs: 120000, maxAttempts: 20 });
  assert.equal(budget.deadline, 101000);
  let now = 1000;
  for (let id = 1; id <= 6; id += 1) {
    const attempt = socket(id);
    assert.equal(budget.registerAttempt(attempt, now), true);
    assert.equal(budget.attemptCount, id);
    const delay = budget.noteFailure(attempt, now);
    assert.equal(delay, getSAA352RetryDelayMs(id));
    now += delay;
  }
  assert.equal(budget.registerAttempt(socket(7), now), false);
  assert.equal(budget.remainingMs(101000), 0);
  assert.equal(budget.registerAttempt(socket(8), 101000), false);
});

test('SAA-352 recovery waits for retry backoff and permits the same observed attempt', () => {
  const budget = createSAA352RecoveryBudget(5000);
  const first = socket(1);
  const replacement = socket(2);

  assert.equal(budget.registerAttempt(first, 5000), true);
  assert.equal(budget.registerAttempt(first, 5001), true);
  assert.equal(budget.noteFailure(first, 6000), 500);
  assert.equal(budget.registerAttempt(replacement, 6499), false);
  assert.equal(budget.retryDelayRemaining(6499), 1);
  assert.equal(budget.registerAttempt(replacement, 6500), true);
  assert.equal(budget.attemptCount, 2);
});


test('SAA-352 parses and sanitizes Guacamole error messages for logs', () => {
  const parsed = readiness.parseSAA352GuacErrors('5.error,18.RDP failure; retry,3.520;');
  assert.deepEqual(parsed, [{ message: 'RDP failure; retry', status: 520 }]);
  assert.equal(
    readiness.sanitizeSAA352LogMessage('Connection refused\npassword=hidden token:private'),
    'Connection refused password=[redacted] token:[redacted]',
  );
});

test('SAA-352 stable readiness restarts when the same socket changes size and returns', () => {
  const tracker = createFixedSocketReadinessTracker();
  const current = socket(1, {
    receivedSizes: [],
    currentSize: { w: 1032, h: 716 },
    sizeRevision: 1,
  });

  assert.equal(tracker([current], 'ready', 1000, 8000), null);
  assert.equal(tracker([current], 'ready', 9000, 8000), current);
  current.currentSize = { w: 1024, h: 768 };
  current.sizeRevision = 2;
  assert.equal(tracker([current], 'ready', 10000, 8000), null);
  current.currentSize = { w: 1032, h: 716 };
  current.sizeRevision = 3;
  assert.equal(tracker([current], 'ready', 11000, 8000), null);
  assert.equal(tracker([current], 'ready', 18999, 8000), null);
  assert.equal(tracker([current], 'ready', 19000, 8000), current);
});
