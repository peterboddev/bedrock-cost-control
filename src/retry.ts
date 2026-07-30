/**
 * Bounded exponential backoff retry wrapper.
 *
 * Used by Quota_Enforcer around `PutRolePolicy`/`DeleteRolePolicy` when
 * attaching/removing a Model_Deny_Policy (Requirement 5.5), and by
 * Daily_Reset around `DeleteRolePolicy` when removing a Model_Deny_Policy
 * on the scheduled reset (Requirement 6.2). See design.md's Quota_Enforcer
 * "Retry behavior" section and the Error Handling table.
 *
 * `retryWithBackoff` itself is bounded (a fixed number of attempts within a
 * single call). The "retry until success, never abandon" behavior required
 * of Daily_Reset (Requirement 6.2, Property 19) is achieved by the caller:
 * on exhaustion, the caller marks the operation `Pending_Reset` and calls
 * `retryWithBackoff` again on a later, separate invocation — the bound here
 * only limits how many attempts happen within one invocation, not across
 * invocations.
 */

/** A function that waits for `delayMs` milliseconds. Injectable for tests. */
export type SleepFn = (delayMs: number) => Promise<void>;

export interface RetryOptions {
  /** Total number of attempts (including the first), must be >= 1. Defaults to 3. */
  maxAttempts?: number;
  /** Delay before the first retry, in milliseconds. Defaults to 100. */
  initialDelayMs?: number;
  /** Upper bound on the delay between retries, in milliseconds. Defaults to 5000. */
  maxDelayMs?: number;
  /** Multiplier applied to the delay after each failed attempt. Defaults to 2. */
  backoffMultiplier?: number;
  /** Injectable sleep implementation, primarily for tests. Defaults to a real timer-based sleep. */
  sleep?: SleepFn;
  /** Optional callback invoked before each retry (not on the final failed attempt). */
  onRetry?: (attempt: number, error: unknown, delayMs: number) => void;
}

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_INITIAL_DELAY_MS = 100;
const DEFAULT_MAX_DELAY_MS = 5000;
const DEFAULT_BACKOFF_MULTIPLIER = 2;

function defaultSleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function computeDelayMs(
  attempt: number,
  initialDelayMs: number,
  maxDelayMs: number,
  backoffMultiplier: number
): number {
  const exponentialDelay = initialDelayMs * backoffMultiplier ** (attempt - 1);
  return Math.min(maxDelayMs, exponentialDelay);
}

/**
 * Invokes `operation`, retrying with exponential backoff on failure up to
 * `options.maxAttempts` total attempts. Resolves with the operation's
 * result as soon as any attempt succeeds. If every attempt fails, rejects
 * with the error from the last attempt (the retry budget is exhausted —
 * callers are responsible for recording a permanent-failure outcome, e.g.
 * an Audit_Log `FAILED` entry, per Requirement 5.5).
 *
 * Validates: Requirements 5.5, 6.2
 */
export async function retryWithBackoff<T>(
  operation: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const initialDelayMs = options.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS;
  const maxDelayMs = options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  const backoffMultiplier = options.backoffMultiplier ?? DEFAULT_BACKOFF_MULTIPLIER;
  const sleep = options.sleep ?? defaultSleep;

  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error(`maxAttempts must be a positive integer, got: ${maxAttempts}`);
  }

  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;

      if (attempt === maxAttempts) {
        break;
      }

      const delayMs = computeDelayMs(attempt, initialDelayMs, maxDelayMs, backoffMultiplier);
      options.onRetry?.(attempt, error, delayMs);
      await sleep(delayMs);
    }
  }

  throw lastError;
}

/**
 * A controllable fake operation for property tests: fails on every call
 * until `failuresBeforeSuccess` calls have failed, then succeeds with
 * `successValue` on every subsequent call.
 *
 * The call count is tracked across separate `retryWithBackoff` invocations
 * that share the same fake, which is what makes it suitable for testing
 * Daily_Reset's "retry until success across invocations" behavior
 * (Property 19) as well as Quota_Enforcer's "bounded retry, then permanent
 * failure" behavior (Property 17, by choosing `failuresBeforeSuccess` >=
 * `maxAttempts`).
 */
export interface FailThenSucceedOperation<T> {
  /** The fake operation to pass to `retryWithBackoff`. */
  operation: () => Promise<T>;
  /** The number of times `operation` has been called so far. */
  callCount: () => number;
}

export function createFailThenSucceedOperation<T>(
  failuresBeforeSuccess: number,
  successValue: T,
  makeError: (attemptNumber: number) => unknown = (attemptNumber) =>
    new Error(`Simulated failure #${attemptNumber}`)
): FailThenSucceedOperation<T> {
  if (!Number.isInteger(failuresBeforeSuccess) || failuresBeforeSuccess < 0) {
    throw new Error(
      `failuresBeforeSuccess must be a non-negative integer, got: ${failuresBeforeSuccess}`
    );
  }

  let calls = 0;

  const operation = async (): Promise<T> => {
    calls += 1;
    if (calls <= failuresBeforeSuccess) {
      throw makeError(calls);
    }
    return successValue;
  };

  return {
    operation,
    callCount: () => calls,
  };
}
