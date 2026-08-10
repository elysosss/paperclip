import { describe, expect, it, vi } from "vitest";
import { createTestHarness, type TestHarness } from "@paperclipai/plugin-sdk/testing";
import type { Issue } from "@paperclipai/shared";
import manifest from "../src/manifest.js";
import plugin from "../src/worker.js";
import { GithubApiError, GithubClient, parseRepository } from "../src/github.js";
import { formatBody, formatTitle, githubStateFor, statusLabel } from "../src/mirror.js";
import {
  OUTBOX_DRAIN_JOB,
  OUTBOX_ENTITY_TYPE,
  OUTBOX_STATUS,
  STATE_KEYS,
} from "../src/constants.js";

const COMPANY_ID = "c_1";

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "iss_1",
    companyId: COMPANY_ID,
    title: "Write the launch post",
    description: "Draft it end to end.",
    status: "todo",
    identifier: "CON-12",
    projectId: null,
    projectWorkspaceId: null,
    goalId: null,
    parentId: null,
    workMode: "standard",
    priority: "medium",
    assigneeAgentId: null,
    assigneeUserId: null,
    checkoutRunId: null,
    executionRunId: null,
    executionAgentNameKey: null,
    executionLockedAt: null,
    createdByAgentId: null,
    createdByUserId: null,
    responsibleUserId: null,
    issueNumber: 12,
    requestDepth: 0,
    billingCode: null,
    assigneeAdapterOverrides: null,
    ...overrides,
  } as Issue;
}

type HttpFetch = (url: string, init?: RequestInit) => Promise<Response>;

function okResponse() {
  return new Response(JSON.stringify({ number: 77, html_url: "https://github.com/o/r/issues/77" }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/** A canned failure, as GitHub would send it. */
function errorResponse(status: number, headers: Record<string, string> = {}) {
  return () => new Response("nope", { status, headers });
}

/**
 * Records every outbound call. Answers from `queue` while it lasts, then with a
 * successful create — so a test only has to spell out the failures it cares about.
 */
function stubFetch(queue: Array<() => Response> = []) {
  const calls: Array<{ url: string; method: string; body: unknown; headers: Record<string, string> }> = [];
  const impl = async (url: string, init?: RequestInit): Promise<Response> => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({
      url,
      method: init?.method ?? "GET",
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      headers,
    });
    const next = queue.shift();
    return next ? next() : okResponse();
  };
  return { calls, impl };
}

/**
 * Drives a promise that sleeps between retries without spending the backoff in
 * real time. Only `setTimeout` is faked: the retry budget reads `Date.now()`,
 * and faking that too would make every attempt look instantaneous.
 */
async function withoutBackoffDelays<T>(start: () => Promise<T>): Promise<T> {
  vi.useFakeTimers({ toFake: ["setTimeout"] });
  try {
    const promise = start();
    let settled = false;
    // Marks completion without producing a second promise: a rejecting one
    // would be reported as unhandled before the loop below reaches its `await`.
    void promise.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    // Each pass flushes microtasks and fires any backoff timer that is now due.
    for (let i = 0; i < 20 && !settled; i += 1) {
      await vi.advanceTimersByTimeAsync(10_000);
    }
    return await promise;
  } finally {
    vi.useRealTimers();
  }
}

/** The create record the outbox keeps for a Paperclip issue, if any. */
async function outboxRecord(harness: TestHarness, issueId = "iss_1") {
  const [record] = await harness.ctx.entities.list({
    entityType: OUTBOX_ENTITY_TYPE,
    externalId: `${COMPANY_ID}:${issueId}`,
    limit: 1,
  });
  return record ?? null;
}

async function setupHarness(
  config: Record<string, unknown> = {},
  responses: Array<() => Response> = [],
) {
  const harness = createTestHarness({
    manifest,
    capabilities: [...manifest.capabilities, "events.emit"],
    config: {
      repository: "acme/content",
      token: { type: "secret_ref", secretId: "sec_1" },
      mirrorEnabled: true,
      ...config,
    },
  });
  const fetcher = stubFetch(responses);
  // The harness performs a real network fetch by default — replace it so the
  // suite stays offline and can assert on the exact requests.
  harness.ctx.http.fetch = fetcher.impl as HttpFetch;
  harness.seed({ issues: [makeIssue()] });
  await plugin.definition.setup(harness.ctx);
  return { harness, fetcher };
}

describe("formatting", () => {
  it("prefixes the title with the Paperclip identifier when present", () => {
    expect(formatTitle({ title: "Ship it", identifier: "CON-3" })).toBe("[CON-3] Ship it");
    expect(formatTitle({ title: "Ship it", identifier: null })).toBe("Ship it");
  });

  it("carries status as a label and closes only on terminal states", () => {
    expect(statusLabel("in_progress")).toBe("paperclip:in-progress");
    expect(githubStateFor("in_progress")).toBe("open");
    expect(githubStateFor("done")).toBe("closed");
    expect(githubStateFor("cancelled")).toBe("closed");
    expect(githubStateFor("blocked")).toBe("open");
  });

  it("marks the body as mirror-owned so humans do not reply into a void", () => {
    const body = formatBody({ id: "iss_1", description: null, status: "todo" });
    expect(body).toContain("_No description._");
    expect(body).toContain("not read back");
  });
});

describe("github client", () => {
  it("rejects a malformed repository instead of building a bad URL", () => {
    expect(() => parseRepository("not-a-repo")).toThrow(/owner\/repo/);
    expect(parseRepository("acme/content")).toEqual({ owner: "acme", repo: "content" });
  });

  it("sends the token as a bearer header and never in the body", async () => {
    const fetcher = stubFetch();
    const client = new GithubClient({
      repository: "acme/content",
      token: "t0ken",
      fetchImpl: fetcher.impl,
    });
    await client.createIssue({ title: "T", body: "B" });

    const [call] = fetcher.calls;
    expect(call.method).toBe("POST");
    expect(call.url).toBe("https://api.github.com/repos/acme/content/issues");
    expect(call.headers.authorization).toBe("Bearer t0ken");
    expect(JSON.stringify(call.body)).not.toContain("t0ken");
  });

  it("sends a User-Agent, which GitHub rejects the request without", async () => {
    // Omitting it produces a 403 whose body talks about "administrative rules",
    // which reads like a token permission problem and is not one.
    const fetcher = stubFetch();
    const client = new GithubClient({
      repository: "acme/content",
      token: "t0ken",
      fetchImpl: fetcher.impl,
    });
    await client.createIssue({ title: "T", body: "B" });

    expect(fetcher.calls[0]?.headers["user-agent"]).toBeTruthy();
  });

  it("flags rate limiting as retryable and a bad request as not", async () => {
    const make = (status: number, headers: Record<string, string> = {}) =>
      new GithubClient({
        repository: "acme/content",
        token: "t",
        fetchImpl: async () => new Response("nope", { status, headers }),
      });

    await expect(
      withoutBackoffDelays(() => make(429).addComment(1, "x")),
    ).rejects.toMatchObject({ retryable: true });
    await expect(
      withoutBackoffDelays(() => make(403, { "x-ratelimit-remaining": "0" }).addComment(1, "x")),
    ).rejects.toMatchObject({ retryable: true });
    await expect(make(422).addComment(1, "x")).rejects.toBeInstanceOf(GithubApiError);
    await expect(make(422).addComment(1, "x")).rejects.toMatchObject({ retryable: false });
  });

  it("reads the wait GitHub asks for, and ignores one it cannot use", async () => {
    const make = (status: number, headers: Record<string, string>) =>
      new GithubClient({
        repository: "acme/content",
        token: "t",
        fetchImpl: async () => new Response("nope", { status, headers }),
      });

    // `retry-after` is in seconds.
    await expect(
      withoutBackoffDelays(() => make(429, { "retry-after": "2" }).addComment(1, "x")),
    ).rejects.toMatchObject({ retryAfterMs: 2000 });
    // `x-ratelimit-reset` is an epoch timestamp; one in the past says nothing.
    await expect(
      withoutBackoffDelays(() => make(429, { "x-ratelimit-reset": "1" }).addComment(1, "x")),
    ).rejects.toMatchObject({ retryAfterMs: null });
  });

  it("retries a worker→host call that timed out without an answer", async () => {
    // The SDK drops `signal` when it serializes `init`, so the plugin cannot
    // bound the call itself; a timeout arrives as a rejection like this one.
    let attempts = 0;
    const client = new GithubClient({
      repository: "acme/content",
      token: "t",
      fetchImpl: async () => {
        attempts += 1;
        if (attempts === 1) {
          throw new Error('Worker→host call "http.fetch" timed out after 30000ms');
        }
        return okResponse();
      },
    });

    await withoutBackoffDelays(() => client.addComment(1, "x"));

    expect(attempts).toBe(2);
  });
});

describe("mirror behaviour", () => {
  it("creates a GitHub issue on issue.created and remembers its number", async () => {
    const { harness, fetcher } = await setupHarness();

    await harness.emit("issue.created", {}, { entityId: "iss_1", companyId: COMPANY_ID });

    expect(fetcher.calls).toHaveLength(1);
    expect(fetcher.calls[0].method).toBe("POST");
    expect((fetcher.calls[0].body as { title: string }).title).toBe("[CON-12] Write the launch post");
    expect(
      harness.getState({ scopeKind: "issue", scopeId: "iss_1", stateKey: STATE_KEYS.mirroredNumber }),
    ).toBe(77);
  });

  it("does not create a second GitHub issue for the same task", async () => {
    const { harness, fetcher } = await setupHarness();

    await harness.emit("issue.created", {}, { entityId: "iss_1", companyId: COMPANY_ID });
    await harness.emit("issue.created", {}, { entityId: "iss_1", companyId: COMPANY_ID });

    expect(fetcher.calls.filter((c) => c.method === "POST")).toHaveLength(1);
  });

  it("serializes concurrent create events for the same task", async () => {
    const { harness, fetcher } = await setupHarness();
    const originalFetch = harness.ctx.http.fetch;
    let releaseCreate: (() => void) | undefined;
    let markCreateStarted: (() => void) | undefined;
    const createStarted = new Promise<void>((resolve) => {
      markCreateStarted = resolve;
    });
    const createMayFinish = new Promise<void>((resolve) => {
      releaseCreate = resolve;
    });
    harness.ctx.http.fetch = (async (url, init) => {
      markCreateStarted?.();
      await createMayFinish;
      return originalFetch(url, init);
    }) as HttpFetch;

    const first = harness.emit("issue.created", {}, { entityId: "iss_1", companyId: COMPANY_ID });
    await createStarted;
    const second = harness.emit("issue.created", {}, { entityId: "iss_1", companyId: COMPANY_ID });
    releaseCreate?.();
    await Promise.all([first, second]);

    expect(fetcher.calls.filter((c) => c.method === "POST")).toHaveLength(1);
  });

  it("stays silent when the status has not changed", async () => {
    const { harness, fetcher } = await setupHarness();
    await harness.emit("issue.created", {}, { entityId: "iss_1", companyId: COMPANY_ID });
    const afterCreate = fetcher.calls.length;

    await harness.emit("issue.updated", {}, { entityId: "iss_1", companyId: COMPANY_ID });

    expect(fetcher.calls).toHaveLength(afterCreate);
  });

  it("mirrors a status change as a patch plus a comment", async () => {
    const { harness, fetcher } = await setupHarness();
    await harness.emit("issue.created", {}, { entityId: "iss_1", companyId: COMPANY_ID });
    harness.seed({ issues: [makeIssue({ status: "done" })] });

    await harness.emit("issue.updated", {}, { entityId: "iss_1", companyId: COMPANY_ID });

    const patch = fetcher.calls.find((c) => c.method === "PATCH");
    expect(patch?.body).toMatchObject({ state: "closed", labels: ["paperclip:done"] });
    const comment = fetcher.calls.find((c) => c.url.endsWith("/comments"));
    expect((comment?.body as { body: string }).body).toContain("`todo` → `done`");
  });

  it("does nothing when mirroring is switched off", async () => {
    const { harness, fetcher } = await setupHarness({ mirrorEnabled: false });

    await harness.emit("issue.created", {}, { entityId: "iss_1", companyId: COMPANY_ID });

    expect(fetcher.calls).toHaveLength(0);
  });

  it("survives a GitHub outage without taking the worker down", async () => {
    const harness = createTestHarness({
      manifest,
      capabilities: [...manifest.capabilities, "events.emit"],
      config: { repository: "acme/content", token: { type: "secret_ref", secretId: "s" }, mirrorEnabled: true },
    });
    harness.ctx.http.fetch = (async () => new Response("boom", { status: 500 })) as HttpFetch;
    harness.seed({ issues: [makeIssue()] });
    await plugin.definition.setup(harness.ctx);

    await expect(
      withoutBackoffDelays(() =>
        harness.emit("issue.created", {}, { entityId: "iss_1", companyId: COMPANY_ID }),
      ),
    ).resolves.not.toThrow();

    expect(harness.logs.some((l) => l.level === "error")).toBe(true);
  });

  it("comments on a run failure only for already-mirrored tasks", async () => {
    const { harness, fetcher } = await setupHarness();

    // Nothing mirrored yet -> no comment attempt.
    await harness.emit(
      "agent.run.failed",
      { runId: "run_1", issueId: "iss_1" },
      { entityId: "run_1", companyId: COMPANY_ID },
    );
    expect(fetcher.calls).toHaveLength(0);

    await harness.emit("issue.created", {}, { entityId: "iss_1", companyId: COMPANY_ID });
    await harness.emit(
      "agent.run.failed",
      { runId: "run_1", issueId: "iss_1", error: "boom" },
      { entityId: "run_1", companyId: COMPANY_ID },
    );

    const comment = fetcher.calls.find((c) => c.url.endsWith("/comments"));
    expect((comment?.body as { body: string }).body).toContain("Agent run failed");
  });

  it("renders an escalation raised by the escalation plugin", async () => {
    const { harness, fetcher } = await setupHarness();
    await harness.emit("issue.created", {}, { entityId: "iss_1", companyId: COMPANY_ID });

    // Emitted by the escalation plugin; the issue id travels in the payload.
    await harness.emit(
      "plugin.paperclip-plugin-escalation.escalation-raised",
      { issueId: "iss_1", reviewReturns: 3, gateFailures: 1, threshold: 3 },
      { companyId: COMPANY_ID },
    );

    const comment = fetcher.calls.find((c) => c.url.endsWith("/comments"));
    expect((comment?.body as { body: string }).body).toContain("Escalated after 3 review round(s)");
    expect((comment?.body as { body: string }).body).toContain("needs a human");
  });

  it("carries a notification Telegram could not deliver", async () => {
    const { harness, fetcher } = await setupHarness();
    await harness.emit("issue.created", {}, { entityId: "iss_1", companyId: COMPANY_ID });

    await harness.emit(
      "plugin.paperclip-plugin-telegram-notify.notification-undelivered",
      {
        issueId: "iss_1",
        kind: "waiting-for-human",
        text: "<b>Waiting for you</b>\nCON-12 · Merge or close PR #14",
        reason: "sendMessage failed: timed out",
      },
      { companyId: COMPANY_ID },
    );

    const comment = fetcher.calls.filter((c) => c.url.endsWith("/comments")).at(-1);
    const body = (comment?.body as { body: string }).body;
    // The point of the fallback: the message itself survives, not just a notice
    // that something was lost.
    expect(body).toContain("Merge or close PR #14");
    expect(body).toContain("could not be delivered");
    expect(body).toContain("waiting-for-human");
    expect(body).toContain("timed out");
  });

  it("says nothing when an undelivered notification names no task", async () => {
    const { harness, fetcher } = await setupHarness();
    await harness.emit("issue.created", {}, { entityId: "iss_1", companyId: COMPANY_ID });
    const before = fetcher.calls.length;

    // A budget incident is company-level: there is no issue to comment on.
    await harness.emit(
      "plugin.paperclip-plugin-telegram-notify.notification-undelivered",
      { issueId: null, kind: "budget-opened", text: "<b>Budget stopped work</b>" },
      { companyId: COMPANY_ID },
    );

    expect(fetcher.calls.length).toBe(before);
  });

  it("retries a 502 and still ends up with exactly one GitHub issue", async () => {
    const { harness, fetcher } = await setupHarness({}, [errorResponse(502)]);

    await withoutBackoffDelays(() =>
      harness.emit("issue.created", {}, { entityId: "iss_1", companyId: COMPANY_ID }),
    );

    expect(fetcher.calls.filter((c) => c.method === "POST")).toHaveLength(2);
    expect(
      harness.getState({ scopeKind: "issue", scopeId: "iss_1", stateKey: STATE_KEYS.mirroredNumber }),
    ).toBe(77);
    expect((await outboxRecord(harness))?.status).toBe(OUTBOX_STATUS.done);
  });

  it("does not retry a request GitHub rejected outright", async () => {
    // A 422 fails identically on the second attempt; retrying only wastes the
    // handler's budget.
    const { harness, fetcher } = await setupHarness({}, [
      errorResponse(422),
      errorResponse(422),
      errorResponse(422),
    ]);

    await withoutBackoffDelays(() =>
      harness.emit("issue.created", {}, { entityId: "iss_1", companyId: COMPANY_ID }),
    );

    expect(fetcher.calls.filter((c) => c.method === "POST")).toHaveLength(1);
  });

  it("gives up after three attempts and leaves the create recorded", async () => {
    const { harness, fetcher } = await setupHarness({}, [
      errorResponse(429),
      errorResponse(429),
      errorResponse(429),
      errorResponse(429),
    ]);

    await withoutBackoffDelays(() =>
      harness.emit("issue.created", {}, { entityId: "iss_1", companyId: COMPANY_ID }),
    );

    expect(fetcher.calls.filter((c) => c.method === "POST")).toHaveLength(3);
    // Nothing was created, but the attempt is on the record rather than lost.
    expect((await outboxRecord(harness))?.status).toBe(OUTBOX_STATUS.pending);
    expect(
      harness.getState({ scopeKind: "issue", scopeId: "iss_1", stateKey: STATE_KEYS.mirroredNumber }),
    ).toBeFalsy();
  });

  it("refuses a second create when the first one's outcome was lost", async () => {
    // The crash window: GitHub accepted the issue, then the state write died.
    // Nothing on this side knows the number, and the mirror will not go and ask.
    const { harness, fetcher } = await setupHarness();
    const realSet = harness.ctx.state.set.bind(harness.ctx.state);
    let failed = false;
    harness.ctx.state.set = async (input, value) => {
      if (!failed) {
        failed = true;
        throw new Error("state write lost");
      }
      return realSet(input, value);
    };

    await harness.emit("issue.created", {}, { entityId: "iss_1", companyId: COMPANY_ID });
    await harness.emit("issue.created", {}, { entityId: "iss_1", companyId: COMPANY_ID });

    expect(fetcher.calls.filter((c) => c.method === "POST")).toHaveLength(1);
    expect((await outboxRecord(harness))?.status).toBe(OUTBOX_STATUS.uncertain);
    expect(
      harness.logs.some((l) => l.level === "error" && l.message.includes("refusing to create")),
    ).toBe(true);

    // The drain does not try to resolve it either: the mirror is write-only, so
    // asking GitHub what happened is not an option it has.
    const callsBeforeDrain = fetcher.calls.length;
    await harness.runJob(OUTBOX_DRAIN_JOB);

    expect(fetcher.calls).toHaveLength(callsBeforeDrain);
    expect((await outboxRecord(harness))?.status).toBe(OUTBOX_STATUS.uncertain);
  });

  it("closes a create whose record was never closed, without calling GitHub", async () => {
    // The other half of the same window: the number reached state, the record
    // did not. That one is knowable from plugin-local state alone.
    const { harness, fetcher } = await setupHarness();
    const realUpsert = harness.ctx.entities.upsert.bind(harness.ctx.entities);
    let upserts = 0;
    harness.ctx.entities.upsert = async (input) => {
      upserts += 1;
      if (upserts === 2) throw new Error("entity write lost");
      return realUpsert(input);
    };

    await harness.emit("issue.created", {}, { entityId: "iss_1", companyId: COMPANY_ID });

    expect(
      harness.getState({ scopeKind: "issue", scopeId: "iss_1", stateKey: STATE_KEYS.mirroredNumber }),
    ).toBe(77);
    expect((await outboxRecord(harness))?.status).toBe(OUTBOX_STATUS.pending);

    const callsBeforeDrain = fetcher.calls.length;
    await harness.runJob(OUTBOX_DRAIN_JOB);

    expect(fetcher.calls).toHaveLength(callsBeforeDrain);
    const record = await outboxRecord(harness);
    expect(record?.status).toBe(OUTBOX_STATUS.done);
    expect(record?.data).toMatchObject({ mirroredNumber: 77 });
  });

  it("records a stale unfinished create as uncertain rather than retrying it", async () => {
    const { harness, fetcher } = await setupHarness();
    const stale = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    await harness.ctx.entities.upsert({
      entityType: OUTBOX_ENTITY_TYPE,
      scopeKind: "issue",
      scopeId: "iss_9",
      externalId: `${COMPANY_ID}:iss_9`,
      status: OUTBOX_STATUS.pending,
      data: { companyId: COMPANY_ID, issueId: "iss_9", startedAt: stale },
    });

    await harness.runJob(OUTBOX_DRAIN_JOB);

    expect((await outboxRecord(harness, "iss_9"))?.status).toBe(OUTBOX_STATUS.uncertain);
    expect(fetcher.calls).toHaveLength(0);
    expect(
      harness.logs.some((l) => l.level === "error" && l.message.includes("cannot be confirmed")),
    ).toBe(true);
  });

  it("leaves a create that is still in flight alone", async () => {
    // The drain runs on a schedule and must not condemn a create that simply
    // has not come back yet.
    const { harness } = await setupHarness();
    await harness.ctx.entities.upsert({
      entityType: OUTBOX_ENTITY_TYPE,
      scopeKind: "issue",
      scopeId: "iss_9",
      externalId: `${COMPANY_ID}:iss_9`,
      status: OUTBOX_STATUS.pending,
      data: { companyId: COMPANY_ID, issueId: "iss_9", startedAt: new Date().toISOString() },
    });

    await harness.runJob(OUTBOX_DRAIN_JOB);

    expect((await outboxRecord(harness, "iss_9"))?.status).toBe(OUTBOX_STATUS.pending);
  });

  it("reports a budget stop as a pause, not a failure", async () => {
    const { harness, fetcher } = await setupHarness();
    await harness.emit("issue.created", {}, { entityId: "iss_1", companyId: COMPANY_ID });

    await harness.emit(
      "budget.incident.opened",
      { reason: "Weekly cap reached." },
      { entityId: "iss_1", companyId: COMPANY_ID },
    );

    const comment = fetcher.calls.find((c) => c.url.endsWith("/comments"));
    expect((comment?.body as { body: string }).body).toContain("Paused");
    expect((comment?.body as { body: string }).body).not.toContain("failed");
  });
});
