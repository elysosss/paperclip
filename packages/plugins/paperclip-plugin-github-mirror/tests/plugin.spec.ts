import { describe, expect, it } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import type { Issue } from "@paperclipai/shared";
import manifest from "../src/manifest.js";
import plugin from "../src/worker.js";
import { GithubApiError, GithubClient, parseRepository } from "../src/github.js";
import { formatBody, formatTitle, githubStateFor, statusLabel } from "../src/mirror.js";
import { STATE_KEYS } from "../src/constants.js";

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
    workMode: "single_run",
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

/** Records every outbound call and answers with a canned GitHub response. */
function stubFetch() {
  const calls: Array<{ url: string; method: string; body: unknown; headers: Record<string, string> }> = [];
  const impl = async (url: string, init?: RequestInit): Promise<Response> => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({
      url,
      method: init?.method ?? "GET",
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      headers,
    });
    return new Response(JSON.stringify({ number: 77, html_url: "https://github.com/o/r/issues/77" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  return { calls, impl };
}

async function setupHarness(config: Record<string, unknown> = {}) {
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
  const fetcher = stubFetch();
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

  it("flags rate limiting as retryable and a bad request as not", async () => {
    const make = (status: number, headers: Record<string, string> = {}) =>
      new GithubClient({
        repository: "acme/content",
        token: "t",
        fetchImpl: async () => new Response("nope", { status, headers }),
      });

    await expect(make(429).addComment(1, "x")).rejects.toMatchObject({ retryable: true });
    await expect(
      make(403, { "x-ratelimit-remaining": "0" }).addComment(1, "x"),
    ).rejects.toMatchObject({ retryable: true });
    await expect(make(422).addComment(1, "x")).rejects.toBeInstanceOf(GithubApiError);
    await expect(make(422).addComment(1, "x")).rejects.toMatchObject({ retryable: false });
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
      harness.emit("issue.created", {}, { entityId: "iss_1", companyId: COMPANY_ID }),
    ).resolves.not.toThrow();

    expect(harness.logs.some((l) => l.level === "error")).toBe(true);
  });

  it("comments on a run failure only for already-mirrored tasks", async () => {
    const { harness, fetcher } = await setupHarness();

    // Nothing mirrored yet -> no comment attempt.
    await harness.emit("agent.run.failed", { runId: "r1" }, { entityId: "iss_1", companyId: COMPANY_ID });
    expect(fetcher.calls).toHaveLength(0);

    await harness.emit("issue.created", {}, { entityId: "iss_1", companyId: COMPANY_ID });
    await harness.emit(
      "agent.run.failed",
      { runId: "r1", error: "boom" },
      { entityId: "iss_1", companyId: COMPANY_ID },
    );

    const comment = fetcher.calls.find((c) => c.url.endsWith("/comments"));
    expect((comment?.body as { body: string }).body).toContain("Agent run failed");
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
