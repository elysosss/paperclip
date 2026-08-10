/**
 * Retry for the mirror's GitHub writes.
 *
 * A plugin cannot bound its own HTTP call: `ctx.http.fetch` serializes only
 * method, headers and body, so an `AbortSignal` never reaches the host. The
 * bound comes from the runtime instead, and it is the reason this file has a
 * budget at all — see the note above `RETRY_BUDGET_MS`.
 *
 * Only two failures are worth trying again: GitHub asked us to back off (or
 * fell over), and the worker→host call timed out without an answer. Everything
 * else — a 401, a 404, a 422 — will fail identically on the second attempt, so
 * it is raised immediately.
 */

import { GithubApiError } from "./github.js";

/** Total attempts for one write, the first try included. */
export const RETRY_ATTEMPTS = 3;

/** Backoff before attempts 2 and 3, before jitter. */
export const RETRY_BACKOFF_MS = [1_000, 4_000] as const;

/**
 * Wall clock the whole retry sequence may consume.
 *
 * Each attempt is already bounded twice at 30s: the SDK's `callHost` timer
 * (`worker-rpc-host.ts`, `DEFAULT_RPC_TIMEOUT_MS`, which `runWorker` never
 * overrides) and the host's own `AbortController`
 * (`plugin-host-services.ts`, `PLUGIN_FETCH_TIMEOUT_MS`). Retrying multiplies
 * that: three attempts could otherwise occupy a handler for a minute and a
 * half. This budget caps the sequence at one call's worth of time, so a
 * first attempt that burns the full 30s leaves nothing to retry with — which
 * is the right answer, not a bug.
 */
export const RETRY_BUDGET_MS = 30_000;

/** Jitter spread, as a fraction of the base delay. */
const JITTER_RATIO = 0.25;

/** JSON-RPC code the SDK raises when a worker→host call times out. */
const RPC_TIMEOUT_CODE = -32003;

export interface RetryDeps {
  now(): number;
  sleep(ms: number): Promise<void>;
  /** `[0, 1)`. Injected so tests get a deterministic delay. */
  random(): number;
}

const DEFAULT_DEPS: RetryDeps = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  random: () => Math.random(),
};

/**
 * A timed-out worker→host call. The plugin never learns whether the request
 * reached GitHub, which is exactly why the create path records its intent
 * before posting.
 */
function isRpcTimeout(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  if ((error as { code?: unknown }).code === RPC_TIMEOUT_CODE) return true;
  const message = (error as { message?: unknown }).message;
  return typeof message === "string" && /timed out after \d+ *ms/i.test(message);
}

export function isRetryable(error: unknown): boolean {
  if (error instanceof GithubApiError) return error.retryable;
  return isRpcTimeout(error);
}

/** `retry-after` / `x-ratelimit-reset` if GitHub named a time, else jittered backoff. */
function delayFor(error: unknown, attempt: number, deps: RetryDeps): number {
  if (error instanceof GithubApiError && error.retryAfterMs !== null) {
    return error.retryAfterMs;
  }
  const base = RETRY_BACKOFF_MS[Math.min(attempt - 1, RETRY_BACKOFF_MS.length - 1)];
  // Spread retries of simultaneous events so they do not re-collide on the
  // same rate limit.
  return Math.round(base * (1 + (deps.random() * 2 - 1) * JITTER_RATIO));
}

export async function withRetry<T>(
  run: () => Promise<T>,
  overrides: Partial<RetryDeps> = {},
): Promise<T> {
  const deps: RetryDeps = { ...DEFAULT_DEPS, ...overrides };
  const startedAt = deps.now();

  for (let attempt = 1; ; attempt += 1) {
    try {
      return await run();
    } catch (error) {
      if (attempt >= RETRY_ATTEMPTS || !isRetryable(error)) throw error;

      const delay = delayFor(error, attempt, deps);
      // Waiting past the budget would leave no room for the attempt the wait
      // is for, so stop and let the caller record the failure now.
      if (deps.now() - startedAt + delay >= RETRY_BUDGET_MS) throw error;
      await deps.sleep(delay);
    }
  }
}
