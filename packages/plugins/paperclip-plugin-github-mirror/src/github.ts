/**
 * Minimal GitHub issues client — only the three calls the mirror needs.
 *
 * Deliberately write-only: the mirror never reads GitHub state back into
 * Paperclip, so there is no `get`/`list` here. Paperclip stays the store of
 * record; GitHub is a viewing surface.
 */

export interface GithubClientOptions {
  /** `owner/repo`. */
  repository: string;
  /** Resolved at call time by the caller — never cached or logged here. */
  token: string;
  fetchImpl: (url: string, init?: RequestInit) => Promise<Response>;
  apiBaseUrl?: string;
}

export interface GithubIssueRef {
  number: number;
  htmlUrl: string;
}

const DEFAULT_API_BASE = "https://api.github.com";

export class GithubApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** True when GitHub asked us to back off rather than rejecting the request outright. */
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "GithubApiError";
  }
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

  private async request<T>(path: string, init: RequestInit): Promise<T> {
    const response = await this.options.fetchImpl(`${this.apiBaseUrl}${path}`, {
      ...init,
      headers: {
        accept: "application/vnd.github+json",
        "content-type": "application/json",
        "x-github-api-version": "2022-11-28",
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
