/**
 * Minimal GitHub issues client — only the three calls the mirror needs.
 *
 * Deliberately write-only: the mirror never reads GitHub state back into
 * Paperclip, so there is no `get`/`list` here. Paperclip stays the store of
 * record; GitHub is a viewing surface. Retry does not change that: a failed
 * write is tried again, never read back to find out what happened.
 *
 * ## The 30s budget
 *
 * A plugin cannot cancel its own request. `ctx.http.fetch` is a JSON-RPC call
 * whose `init` is serialized down to method, headers and body, so an
 * `AbortSignal` passed here would be silently dropped and a `Promise.race`
 * around the await would only shorten the plugin's wait while the host socket
 * kept running.
 *
 * It does not need one. Every call is already bounded twice at 30 seconds:
 *
 * - worker side, the SDK's `callHost` timer (`DEFAULT_RPC_TIMEOUT_MS` in
 *   `worker-rpc-host.ts`; `runWorker` never passes `rpcTimeoutMs`), which
 *   rejects with a JSON-RPC timeout;
 * - host side, an `AbortController` armed with `PLUGIN_FETCH_TIMEOUT_MS`
 *   (`plugin-host-services.ts`), which aborts the socket itself.
 *
 * So the ceiling is the runtime's, not ours, and the only thing this file owes
 * it is that retrying stays inside it — see `RETRY_BUDGET_MS` in `retry.ts`.
 */

import { withRetry, type RetryDeps } from "./retry.js";

export interface GithubClientOptions {
  /** `owner/repo`. */
  repository: string;
  /** Resolved at call time by the caller — never cached or logged here. */
  token: string;
  fetchImpl: (url: string, init?: RequestInit) => Promise<Response>;
  apiBaseUrl?: string;
  /** Retry timing seams. Tests inject them; production uses the defaults. */
  retryDeps?: Partial<RetryDeps>;
}

export interface GithubIssueRef {
  number: number;
  htmlUrl: string;
}

const DEFAULT_API_BASE = "https://api.github.com";
const USER_AGENT = "paperclip-plugin-github-mirror";

export class GithubApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** True when GitHub asked us to back off rather than rejecting the request outright. */
    readonly retryable: boolean,
    /**
     * How long GitHub asked us to wait, in ms, when it said so via
     * `retry-after` or `x-ratelimit-reset`. `null` when it did not.
     */
    readonly retryAfterMs: number | null = null,
  ) {
    super(message);
    this.name = "GithubApiError";
  }
}

/**
 * GitHub names a wait in one of two ways: `retry-after` (seconds, on secondary
 * rate limits and abuse detection) or `x-ratelimit-reset` (epoch seconds, on
 * primary rate limits). Anything absent, unparseable, or in the past yields
 * `null`, and the caller falls back to its own backoff.
 */
function parseRetryAfterMs(headers: Headers, nowMs: number): number | null {
  const retryAfter = headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  }

  const reset = headers.get("x-ratelimit-reset");
  if (reset) {
    const resetSeconds = Number(reset);
    if (Number.isFinite(resetSeconds)) {
      const waitMs = resetSeconds * 1000 - nowMs;
      if (waitMs > 0) return Math.round(waitMs);
    }
  }

  return null;
}

/** `owner/repo` → validated parts. Throws on anything else so a typo fails loudly at setup. */
export function parseRepository(repository: string): { owner: string; repo: string } {
  const match = /^([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)$/.exec(repository.trim());
  if (!match) {
    throw new Error(`Invalid repository "${repository}" — expected "owner/repo".`);
  }
  return { owner: match[1], repo: match[2] };
}

export class GithubClient {
  private readonly owner: string;
  private readonly repo: string;
  private readonly apiBaseUrl: string;

  constructor(private readonly options: GithubClientOptions) {
    const { owner, repo } = parseRepository(options.repository);
    this.owner = owner;
    this.repo = repo;
    this.apiBaseUrl = options.apiBaseUrl ?? DEFAULT_API_BASE;
  }

  /**
   * One write, retried on the failures that can succeed on a second try. The
   * retry lives here rather than in the handlers so every call gets it, and so
   * a handler that ends up in `guard` has genuinely exhausted its options
   * rather than given up on the first 502.
   */
  private async request<T>(path: string, init: RequestInit): Promise<T> {
    return withRetry(() => this.attempt<T>(path, init), this.options.retryDeps);
  }

  private async attempt<T>(path: string, init: RequestInit): Promise<T> {
    const response = await this.options.fetchImpl(`${this.apiBaseUrl}${path}`, {
      ...init,
      headers: {
        accept: "application/vnd.github+json",
        "content-type": "application/json",
        "x-github-api-version": "2022-11-28",
        // GitHub rejects requests without a User-Agent with a 403 that reads
        // like a permissions failure, so this is required, not cosmetic.
        "user-agent": USER_AGENT,
        authorization: `Bearer ${this.options.token}`,
        ...(init.headers ?? {}),
      },
    });

    if (!response.ok) {
      // 403 with a rate-limit header and 429 are back-off signals, not bad requests.
      const rateLimited =
        response.status === 429 ||
        (response.status === 403 && response.headers.get("x-ratelimit-remaining") === "0");
      // Body may carry a useful message, but it can also echo request content —
      // truncate it and never include the token (it lives only in the header).
      const detail = await response.text().catch(() => "");
      throw new GithubApiError(
        `GitHub ${init.method ?? "GET"} ${path} failed: ${response.status} ${detail.slice(0, 300)}`,
        response.status,
        rateLimited || response.status >= 500,
        parseRetryAfterMs(response.headers, Date.now()),
      );
    }

    return (await response.json()) as T;
  }

  async createIssue(input: { title: string; body: string; labels?: string[] }): Promise<GithubIssueRef> {
    const created = await this.request<{ number: number; html_url: string }>(
      `/repos/${this.owner}/${this.repo}/issues`,
      { method: "POST", body: JSON.stringify(input) },
    );
    return { number: created.number, htmlUrl: created.html_url };
  }

  async updateIssue(
    issueNumber: number,
    input: { title?: string; body?: string; state?: "open" | "closed"; labels?: string[] },
  ): Promise<void> {
    await this.request(`/repos/${this.owner}/${this.repo}/issues/${issueNumber}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    });
  }

  async addComment(issueNumber: number, body: string): Promise<void> {
    await this.request(`/repos/${this.owner}/${this.repo}/issues/${issueNumber}/comments`, {
      method: "POST",
      body: JSON.stringify({ body }),
    });
  }
}
