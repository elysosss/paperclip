import { describe, expect, it } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import type { Agent, Issue } from "@paperclipai/shared";
import manifest from "../src/manifest.js";
import plugin from "../src/worker.js";
import { ESCALATION_EVENT } from "../src/constants.js";
import { parseConfig } from "../src/config.js";
import { boardLink, clip, formatRunFailure, issueLabel } from "../src/format.js";
import { escapeHtml, TelegramApiError } from "../src/telegram.js";

const COMPANY_ID = "c_1";
const ISSUE_ID = "iss_1";
const CHAT_ID = "123456789";
const OTHER_CHAT_ID = "-1001234567890";

type HttpFetch = (url: string, init?: RequestInit) => Promise<Response>;

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: ISSUE_ID,
    companyId: COMPANY_ID,
    title: "Ship the thing",
    description: "Body that must never leave the machine.",
    status: "in_progress",
    identifier: "KIT-9",
    projectId: null,
    projectWorkspaceId: null,
    goalId: null,
    parentId: null,
    workMode: "standard",
    priority: "medium",
    assigneeAgentId: "agent_1",
    assigneeUserId: null,
    checkoutRunId: null,
    executionRunId: null,
    executionAgentNameKey: null,
    executionLockedAt: null,
    createdByAgentId: null,
    createdByUserId: null,
    responsibleUserId: null,
    issueNumber: 9,
    requestDepth: 0,
    billingCode: null,
    assigneeAdapterOverrides: null,
    ...overrides,
  } as Issue;
}

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: "agent_1",
    companyId: COMPANY_ID,
    name: "maint-dev",
    role: "developer",
    status: "idle",
    ...overrides,
  } as Agent;
}

interface Sent {
  chatId: string;
  text: string;
  url: string;
}

/** Records every send and answers 200, unless a responder says otherwise. */
function stubTelegram(responder?: (call: number) => Response) {
  const sent: Sent[] = [];
  let calls = 0;
  const impl: HttpFetch = async (url, init) => {
    calls += 1;
    const body = init?.body ? (JSON.parse(String(init.body)) as { chat_id: string; text: string }) : null;
    if (body) sent.push({ chatId: body.chat_id, text: body.text, url });
    return responder ? responder(calls) : new Response(JSON.stringify({ ok: true }), { status: 200 });
  };
  return { sent, impl };
}

async function setup(
  input: {
    config?: Record<string, unknown>;
    responder?: (call: number) => Response;
    issue?: Issue | null;
  } = {},
) {
  const harness = createTestHarness({
    manifest,
    capabilities: [...manifest.capabilities],
    config: {
      token: { type: "secret_ref", secretId: "sec_1" },
      allowedChatIds: [CHAT_ID],
      boardBaseUrl: "https://board.example",
      ...input.config,
    },
  });

  const telegram = stubTelegram(input.responder);
  harness.ctx.http.fetch = telegram.impl as typeof harness.ctx.http.fetch;

  const undelivered: Array<Record<string, unknown>> = [];
  harness.ctx.events.on(`plugin.${manifest.id}.notification-undelivered`, async (event) => {
    undelivered.push((event.payload ?? {}) as Record<string, unknown>);
  });

  const issue = input.issue === undefined ? makeIssue() : input.issue;
  harness.seed({ issues: issue ? [issue] : [], agents: [makeAgent()] });
  await plugin.definition.setup(harness.ctx);

  const escalate = (payload: Record<string, unknown> = {}) =>
    harness.emit(
      ESCALATION_EVENT as `plugin.${string}`,
      { issueId: ISSUE_ID, reviewReturns: 3, gateFailures: 0, threshold: 3, ...payload },
      { companyId: COMPANY_ID },
    );

  const failRun = (payload: Record<string, unknown> = {}) =>
    harness.emit(
      "agent.run.failed",
      { runId: "run_9", agentId: "agent_1", issueId: ISSUE_ID, error: "boom", ...payload },
      { entityId: "run_9", companyId: COMPANY_ID },
    );

  /**
   * Moves the task on the board and lets the plugin observe it, which is what
   * a parking agent actually does — the plugin is not told, it notices.
   */
  const setStatus = async (status: string, overrides: Partial<Issue> = {}) => {
    // Re-seeded rather than written through the context: this plugin holds no
    // write capability at all, which is itself part of what is being asserted.
    harness.seed({ issues: [makeIssue({ status, ...overrides } as Partial<Issue>)] });
    await harness.emit("issue.updated", {}, { entityId: ISSUE_ID, companyId: COMPANY_ID });
  };

  const park = (overrides: Partial<Issue> = {}) =>
    setStatus("blocked", {
      unblockDescriptor: { owner: { userId: "user_owner" }, action: "Merge or close PR #14" },
      ...overrides,
    } as Partial<Issue>);

  return { harness, sent: telegram.sent, undelivered, escalate, failRun, park, setStatus };
}

describe("the allowlist is the whole authorisation model", () => {
  it("sends nothing when no chat id is configured", async () => {
    const { sent, escalate } = await setup({ config: { allowedChatIds: [] } });
    await escalate();
    expect(sent).toEqual([]);
  });

  it("sends nothing when the chat ids are all malformed", async () => {
    // Fails closed rather than falling back to "everyone" or to a default.
    const { sent, escalate } = await setup({ config: { allowedChatIds: ["", "not-a-number", "12x"] } });
    await escalate();
    expect(sent).toEqual([]);
  });

  it("sends to every allowlisted chat, including a negative group id", async () => {
    const { sent, escalate } = await setup({ config: { allowedChatIds: [CHAT_ID, OTHER_CHAT_ID] } });
    await escalate();
    expect(sent.map((s) => s.chatId)).toEqual([CHAT_ID, OTHER_CHAT_ID]);
  });

  it("keeps sending to the rest when one chat rejects the bot", async () => {
    // A user who blocked the bot must not silence the notifier for everyone.
    const { sent, escalate } = await setup({
      config: { allowedChatIds: [CHAT_ID, OTHER_CHAT_ID] },
      responder: (call) => (call === 1 ? new Response("blocked", { status: 403 }) : new Response("{}", { status: 200 })),
    });
    await escalate();
    expect(sent.map((s) => s.chatId)).toEqual([CHAT_ID, OTHER_CHAT_ID]);
  });

  it("sends nothing when notifications are switched off", async () => {
    const { sent, escalate } = await setup({ config: { notifyEnabled: false } });
    await escalate();
    expect(sent).toEqual([]);
  });

  it("sends nothing without a token", async () => {
    const { sent, escalate } = await setup({ config: { token: "" } });
    await escalate();
    expect(sent).toEqual([]);
  });
});

describe("what reaches the phone", () => {
  it("names the task and links the board on an escalation", async () => {
    const { sent, escalate } = await setup();
    await escalate();
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toContain("Needs a human");
    expect(sent[0].text).toContain("KIT-9");
    expect(sent[0].text).toContain("3 review returns");
    expect(sent[0].text).toContain(`https://board.example/issues/${ISSUE_ID}`);
  });

  it("never carries task content, only identifiers and links", async () => {
    const { sent, escalate } = await setup();
    await escalate();
    // The description is the thing that must not leave the machine.
    expect(sent[0].text).not.toContain("must never leave the machine");
  });

  it("names the agent and says the day's cap was spent on a failed run", async () => {
    const { sent, failRun } = await setup();
    await failRun();
    expect(sent[0].text).toContain("Run failed");
    expect(sent[0].text).toContain("maint-dev");
    expect(sent[0].text).toContain("spends the day's cap");
  });

  it("still reports a failure with no issue attached", async () => {
    const { sent, failRun } = await setup();
    await failRun({ issueId: null });
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toContain("Run failed");
  });

  it("reports a parked task as waiting for you, with the unblock action", async () => {
    const { sent, park } = await setup();
    await park();
    expect(sent[0].text).toContain("Waiting for you");
    expect(sent[0].text).toContain("KIT-9");
    expect(sent[0].text).toContain("Merge or close PR #14");
  });

  it("says parked rather than waiting for you when the board owns the unblock", async () => {
    const { sent, park } = await setup();
    await park({ unblockDescriptor: { owner: "board", action: "Decide the split" } } as never);
    expect(sent[0].text).toContain("Task parked");
    expect(sent[0].text).not.toContain("Waiting for you");
  });

  it("escapes a title that would otherwise break the HTML parse", async () => {
    const { sent, escalate } = await setup({ issue: makeIssue({ title: "Fix <script> & co" }) });
    await escalate();
    expect(sent[0].text).toContain("Fix &lt;script&gt; &amp; co");
  });

  it("omits the link when no board URL is configured", async () => {
    const { sent, escalate } = await setup({ config: { boardBaseUrl: "" } });
    await escalate();
    expect(sent[0].text).not.toContain("http");
  });

  it("drops a board URL that is not absolute http(s)", async () => {
    // A relative or javascript: URL renders as broken text on a phone.
    expect(parseConfig({ token: "t", allowedChatIds: [CHAT_ID], boardBaseUrl: "javascript:alert(1)" })?.boardBaseUrl)
      .toBeNull();
  });
});

describe("each notification can be switched off alone", () => {
  it("respects notifyEscalation", async () => {
    const { sent, escalate } = await setup({ config: { notifyEscalation: false } });
    await escalate();
    expect(sent).toEqual([]);
  });

  it("respects notifyRunFailed", async () => {
    const { sent, failRun } = await setup({ config: { notifyRunFailed: false } });
    await failRun();
    expect(sent).toEqual([]);
  });

  it("respects notifyWaitingForHuman", async () => {
    const { sent, park } = await setup({ config: { notifyWaitingForHuman: false } });
    await park();
    expect(sent).toEqual([]);
  });
});

describe("failure does not propagate", () => {
  it("logs a 429 as retryable and does not throw", async () => {
    const { harness, escalate } = await setup({
      responder: () =>
        new Response(JSON.stringify({ parameters: { retry_after: 12 } }), {
          status: 429,
          headers: { "content-type": "application/json" },
        }),
    });
    await expect(escalate()).resolves.toBeUndefined();
    const logged = harness.logs.find((entry) => entry.level === "error");
    expect(logged?.meta?.retryable).toBe(true);
    expect(logged?.meta?.retryAfterSec).toBe(12);
  });

  it("logs a 400 as not retryable", async () => {
    const { harness, escalate } = await setup({
      responder: () => new Response("bad chat id", { status: 400 }),
    });
    await escalate();
    expect(harness.logs.find((entry) => entry.level === "error")?.meta?.retryable).toBe(false);
  });

  it("treats a transport failure as retryable", async () => {
    const { harness, escalate } = await setup();
    harness.ctx.http.fetch = (async () => {
      throw new Error("socket hang up");
    }) as typeof harness.ctx.http.fetch;
    await expect(escalate()).resolves.toBeUndefined();
    expect(harness.logs.find((entry) => entry.level === "error")?.meta?.retryable).toBe(true);
  });

  it("still sends when the issue cannot be read", async () => {
    // A message naming the bare id beats no message at all.
    const { sent, escalate } = await setup({ issue: null });
    await escalate();
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toContain(ISSUE_ID);
  });
});

describe("only the transition is news", () => {
  it("does not buzz twice for a task that was already parked", async () => {
    const { sent, park } = await setup();
    await park();
    await park();
    expect(sent).toHaveLength(1);
  });

  it("sends again after the task was unparked and parked once more", async () => {
    const { sent, park, setStatus } = await setup();
    await park();
    await setStatus("in_progress");
    await park();
    expect(sent).toHaveLength(2);
  });

  it("says nothing about a status that is not parked", async () => {
    const { sent, setStatus } = await setup();
    await setStatus("in_review");
    await setStatus("done");
    expect(sent).toEqual([]);
  });
});

describe("the pieces on their own", () => {
  it("escapes exactly the three characters that break Telegram's HTML", () => {
    expect(escapeHtml(`a & b < c > d "e" 'f'`)).toBe(`a &amp; b &lt; c &gt; d "e" 'f'`);
  });

  it("clips long text and collapses whitespace", () => {
    expect(clip("a\n\n  b", 10)).toBe("a b");
    expect(clip("x".repeat(50), 10)).toHaveLength(10);
    expect(clip("x".repeat(50), 10).endsWith("…")).toBe(true);
  });

  it("falls back to the bare id when the board gave us nothing", () => {
    expect(issueLabel(null, "iss_42")).toBe("iss_42");
  });

  it("builds no link without a base URL", () => {
    expect(boardLink(null, { id: "iss_1", key: null, title: null })).toBeNull();
    expect(boardLink("https://b/", { id: "iss 1", key: null, title: null })).toBe("https://b/issues/iss%201");
  });

  it("says nothing about runs remaining, which the SDK cannot tell us", () => {
    // Deliberate: the daily cap is in the agent's heartbeat config and the
    // day's count is on no plugin read. A guessed number would be acted on.
    const text = formatRunFailure({
      issue: null,
      issueId: null,
      agentName: "a",
      runId: "r",
      message: "m",
      link: null,
    });
    expect(text).not.toMatch(/\d+ runs? (left|remaining)/);
  });

  it("classifies a 500 as retryable and a 403 as not", () => {
    expect(new TelegramApiError("x", 500, true).retryable).toBe(true);
    expect(new TelegramApiError("x", 403, false).retryable).toBe(false);
  });

  it("parses a comma-separated chat id list and de-duplicates it", () => {
    expect(parseConfig({ token: "t", allowedChatIds: `${CHAT_ID}, ${CHAT_ID}, ${OTHER_CHAT_ID}` })?.chatIds).toEqual([
      CHAT_ID,
      OTHER_CHAT_ID,
    ]);
  });
});

describe("when nobody can be reached, the message is not lost", () => {
  const dead = () => new Response("gateway timed out", { status: 504 });

  it("hands an undeliverable notification to the bus, text and all", async () => {
    const { undelivered, park } = await setup({ responder: dead });
    await park();
    expect(undelivered).toHaveLength(1);
    expect(undelivered[0].kind).toBe("waiting-for-human");
    expect(undelivered[0].issueId).toBe(ISSUE_ID);
    // The message itself travels, so the surface that picks it up does not have
    // to render a second copy of every format.
    expect(String(undelivered[0].text)).toContain("Merge or close PR #14");
    expect(String(undelivered[0].reason)).toContain("504");
  });

  it("stays quiet when at least one chat got it", async () => {
    // A partial delivery is a delivery. A second copy elsewhere is noise.
    const { undelivered, sent, escalate } = await setup({
      config: { allowedChatIds: [CHAT_ID, OTHER_CHAT_ID] },
      responder: (call) => (call === 1 ? new Response("{}", { status: 200 }) : dead()),
    });
    await escalate();
    expect(sent).toHaveLength(2);
    expect(undelivered).toEqual([]);
  });

  it("emits nothing when the plugin was never going to send", async () => {
    // Silenced by config is not the same as undeliverable.
    const { undelivered, escalate } = await setup({ config: { allowedChatIds: [] } });
    await escalate();
    expect(undelivered).toEqual([]);
  });

  it("still emits for a run failure that names no task", async () => {
    const { undelivered, failRun } = await setup({ responder: dead });
    await failRun({ issueId: null });
    expect(undelivered).toHaveLength(1);
    expect(undelivered[0].issueId).toBeNull();
  });
});
