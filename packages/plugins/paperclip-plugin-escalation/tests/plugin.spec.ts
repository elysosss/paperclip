import { describe, expect, it } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import type { Issue, IssueStatus } from "@paperclipai/shared";
import manifest from "../src/manifest.js";
import plugin from "../src/worker.js";
import { STATE_KEYS } from "../src/constants.js";
import { isReviewReturn, isTerminal, shouldEscalate } from "../src/escalation.js";

const COMPANY_ID = "c_1";
const ISSUE_ID = "iss_1";

function makeIssue(status: IssueStatus): Issue {
  return {
    id: ISSUE_ID,
    companyId: COMPANY_ID,
    title: "Ship the thing",
    description: null,
    status,
    identifier: "CON-7",
    projectId: null,
    projectWorkspaceId: null,
    goalId: null,
    parentId: null,
    workMode: "standard",
    priority: "medium",
    reviewPolicy: null,
    assigneeAgentId: null,
    assigneeUserId: null,
    checkoutRunId: null,
    executionRunId: null,
    executionAgentNameKey: null,
    executionLockedAt: null,
    createdByAgentId: null,
    createdByUserId: null,
    responsibleUserId: null,
    issueNumber: 7,
    requestDepth: 0,
    billingCode: null,
    assigneeAdapterOverrides: null,
    executionWorkspaceId: null,
    executionWorkspacePreference: null,
    executionWorkspaceSettings: null,
    startedAt: null,
    completedAt: null,
    cancelledAt: null,
    hiddenAt: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
}

async function setup(config: Record<string, unknown> = {}) {
  const harness = createTestHarness({
    manifest,
    capabilities: [...manifest.capabilities],
    config: { reviewReturnThreshold: 3, escalationEnabled: true, ...config },
  });

  // Spy on the comment call rather than reading it back, which would need a
  // read capability the plugin has no reason to hold.
  const comments: string[] = [];
  const createComment = harness.ctx.issues.createComment.bind(harness.ctx.issues);
  harness.ctx.issues.createComment = (async (issueId: string, body: string, companyId: string) => {
    comments.push(body);
    return createComment(issueId, body, companyId);
  }) as typeof harness.ctx.issues.createComment;

  const emitted: unknown[] = [];
  harness.ctx.events.on("plugin.paperclip-plugin-escalation.escalation-raised", async (event) => {
    emitted.push(event.payload);
  });

  harness.seed({ issues: [makeIssue("in_progress")] });
  await plugin.definition.setup(harness.ctx);

  /** Drives a status transition the way the host would. */
  const transitionTo = async (status: IssueStatus) => {
    harness.seed({ issues: [makeIssue(status)] });
    await harness.emit("issue.updated", {}, { entityId: ISSUE_ID, companyId: COMPANY_ID });
  };

  /** One full reviewer round-trip: sent for review, then sent back. */
  const reviewerReturn = async () => {
    await transitionTo("in_review");
    await transitionTo("in_progress");
  };

  const currentStatus = async () =>
    (await harness.ctx.issues.get(ISSUE_ID, COMPANY_ID))?.status;

  return { harness, comments, emitted, transitionTo, reviewerReturn, currentStatus };
}

describe("escalation rules", () => {
  it("treats only in_review -> in_progress as a reviewer return", () => {
    expect(isReviewReturn("in_review", "in_progress")).toBe(true);
    expect(isReviewReturn("in_progress", "in_review")).toBe(false);
    expect(isReviewReturn(null, "in_progress")).toBe(false);
    expect(isReviewReturn("todo", "in_progress")).toBe(false);
  });

  it("escalates on reviewer returns only, however many gates failed", () => {
    expect(shouldEscalate({ gateFailures: 9, reviewReturns: 2 }, 3)).toBe(false);
    expect(shouldEscalate({ gateFailures: 0, reviewReturns: 3 }, 3)).toBe(true);
  });

  it("counts done and cancelled as terminal", () => {
    expect(isTerminal("done")).toBe(true);
    expect(isTerminal("cancelled")).toBe(true);
    expect(isTerminal("blocked")).toBe(false);
  });
});

describe("escalation behaviour", () => {
  it("does not escalate before the threshold", async () => {
    const { harness, emitted, reviewerReturn, currentStatus } = await setup();

    await reviewerReturn();
    await reviewerReturn();

    expect(emitted).toHaveLength(0);
    expect(await currentStatus()).toBe("in_progress");
    expect(
      harness.getState({ scopeKind: "issue", scopeId: ISSUE_ID, stateKey: STATE_KEYS.reviewReturns }),
    ).toBe(2);
  });

  it("blocks the task and announces it on the third reviewer return", async () => {
    const { comments, emitted, reviewerReturn, currentStatus } = await setup();

    await reviewerReturn();
    await reviewerReturn();
    await reviewerReturn();

    expect(await currentStatus()).toBe("blocked");
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({ issueId: ISSUE_ID, reviewReturns: 3, threshold: 3 });
    expect(comments[0]).toContain("needs a human");
    expect(comments[0]).toContain("3 time(s)");
  });

  it("escalates once, not on every later return", async () => {
    const { emitted, reviewerReturn } = await setup();

    for (let i = 0; i < 5; i += 1) await reviewerReturn();

    expect(emitted).toHaveLength(1);
  });

  it("serializes concurrent reviewer returns at the escalation threshold", async () => {
    const { harness, comments, emitted } = await setup();
    await harness.ctx.state.set(
      { scopeKind: "issue", scopeId: ISSUE_ID, stateKey: STATE_KEYS.lastStatus },
      "in_review",
    );
    await harness.ctx.state.set(
      { scopeKind: "issue", scopeId: ISSUE_ID, stateKey: STATE_KEYS.reviewReturns },
      2,
    );

    const originalUpdate = harness.ctx.issues.update;
    let releaseUpdate: (() => void) | undefined;
    let markUpdateStarted: (() => void) | undefined;
    const updateStarted = new Promise<void>((resolve) => {
      markUpdateStarted = resolve;
    });
    const updateMayFinish = new Promise<void>((resolve) => {
      releaseUpdate = resolve;
    });
    harness.ctx.issues.update = (async (...args) => {
      markUpdateStarted?.();
      await updateMayFinish;
      return originalUpdate(...args);
    }) as typeof harness.ctx.issues.update;

    const first = harness.emit("issue.updated", {}, { entityId: ISSUE_ID, companyId: COMPANY_ID });
    await updateStarted;
    const second = harness.emit("issue.updated", {}, { entityId: ISSUE_ID, companyId: COMPANY_ID });
    releaseUpdate?.();
    await Promise.all([first, second]);

    expect(comments).toHaveLength(1);
    expect(emitted).toHaveLength(1);
  });

  it("respects a configured threshold", async () => {
    const { emitted, reviewerReturn } = await setup({ reviewReturnThreshold: 1 });

    await reviewerReturn();

    expect(emitted).toHaveLength(1);
  });

  it("does nothing when escalation is disabled", async () => {
    const { emitted, reviewerReturn, currentStatus } = await setup({ escalationEnabled: false });

    for (let i = 0; i < 4; i += 1) await reviewerReturn();

    expect(emitted).toHaveLength(0);
    expect(await currentStatus()).toBe("in_progress");
  });

  it("counts gate failures without ever escalating on them", async () => {
    const { harness, emitted } = await setup();

    for (let i = 0; i < 5; i += 1) {
      await harness.emit(
        "agent.run.failed",
        { runId: `run_${i}`, issueId: ISSUE_ID },
        { entityId: `run_${i}`, companyId: COMPANY_ID },
      );
    }

    expect(
      harness.getState({ scopeKind: "issue", scopeId: ISSUE_ID, stateKey: STATE_KEYS.gateFailures }),
    ).toBe(5);
    expect(emitted).toHaveLength(0);
  });

  it("clears counters when the task reaches a terminal state", async () => {
    const { harness, reviewerReturn, transitionTo } = await setup();

    await reviewerReturn();
    await transitionTo("done");

    expect(
      harness.getState({ scopeKind: "issue", scopeId: ISSUE_ID, stateKey: STATE_KEYS.reviewReturns }),
    ).toBe(0);
  });

  it("keeps processing events after a host error", async () => {
    const { harness, transitionTo } = await setup({ reviewReturnThreshold: 1 });
    harness.ctx.issues.update = (async () => {
      throw new Error("host unavailable");
    }) as typeof harness.ctx.issues.update;

    await transitionTo("in_review");

    await expect(transitionTo("in_progress")).resolves.not.toThrow();
    expect(harness.logs.some((l) => l.level === "error")).toBe(true);
  });
});
