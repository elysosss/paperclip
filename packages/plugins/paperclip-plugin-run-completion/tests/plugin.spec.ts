import { describe, expect, it } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import type { Issue, IssueStatus } from "@paperclipai/shared";
import manifest from "../src/manifest.js";
import plugin from "../src/worker.js";
import { RUN_FINISHED_EVENT } from "../src/constants.js";
import { decide, isTerminal, labelIdsOf } from "../src/detect.js";

const COMPANY_ID = "c_1";
const ISSUE_ID = "iss_1";
const RUN_ID = "run_1";
const LABEL_ID = "lbl_human_review";

/** The run window every test works against, unless it says otherwise. */
const RUN_STARTED_AT = "2026-08-05T10:00:00.000Z";
const RUN_FINISHED_AT = "2026-08-05T10:07:00.000Z";
const BEFORE_THE_RUN = new Date("2026-08-05T09:30:00.000Z");
const DURING_THE_RUN = new Date("2026-08-05T10:03:00.000Z");

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: ISSUE_ID,
    companyId: COMPANY_ID,
    title: "Ship the thing",
    description: null,
    status: "in_progress",
    identifier: "CON-7",
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
    updatedAt: BEFORE_THE_RUN,
    ...overrides,
  };
}

async function setup(input: { issue?: Issue; config?: Record<string, unknown> } = {}) {
  const harness = createTestHarness({
    manifest,
    capabilities: [...manifest.capabilities],
    config: {
      completionCheckEnabled: true,
      humanReviewLabelId: LABEL_ID,
      unblockOwnerUserId: "user_owner",
      ...input.config,
    },
  });

  // Spied rather than read back: reading comments would need a capability the
  // plugin has no reason to hold.
  const comments: string[] = [];
  const createComment = harness.ctx.issues.createComment.bind(harness.ctx.issues);
  harness.ctx.issues.createComment = (async (issueId: string, body: string, companyId: string) => {
    comments.push(body);
    return createComment(issueId, body, companyId);
  }) as typeof harness.ctx.issues.createComment;

  const emitted: unknown[] = [];
  harness.ctx.events.on(`plugin.${manifest.id}.run-ended-unfinished`, async (event) => {
    emitted.push(event.payload);
  });

  harness.seed({ issues: [input.issue ?? makeIssue()] });
  await plugin.definition.setup(harness.ctx);

  const finishRun = async (payload: Record<string, unknown> = {}) => {
    await harness.emit(
      RUN_FINISHED_EVENT,
      {
        runId: RUN_ID,
        agentId: "agent_1",
        status: "succeeded",
        issueId: ISSUE_ID,
        startedAt: RUN_STARTED_AT,
        finishedAt: RUN_FINISHED_AT,
        ...payload,
      },
      // The run is the entity; the issue rides in the payload.
      { entityId: RUN_ID, companyId: COMPANY_ID },
    );
  };

  const issue = async () => await harness.ctx.issues.get(ISSUE_ID, COMPANY_ID);

  return { harness, comments, emitted, finishRun, issue };
}

describe("the rule", () => {
  const flagged = (overrides: Partial<Issue> = {}) =>
    decide({ issue: makeIssue(overrides), runStartedAt: RUN_STARTED_AT, labelId: LABEL_ID });

  it("flags a task untouched since before the run started", () => {
    expect(flagged({})).toEqual({ flag: true });
  });

  it("leaves a task that changed while the run was going", () => {
    expect(flagged({ updatedAt: DURING_THE_RUN })).toEqual({
      flag: false,
      reason: "board-was-touched",
    });
  });

  it("leaves finished work alone", () => {
    for (const status of ["done", "cancelled"] as IssueStatus[]) {
      expect(flagged({ status })).toEqual({ flag: false, reason: "terminal" });
    }
    expect(isTerminal("blocked")).toBe(false);
  });

  it("leaves a task somebody already parked", () => {
    expect(flagged({ status: "blocked" })).toEqual({ flag: false, reason: "already-blocked" });
  });

  it("leaves a task that already carries the label", () => {
    expect(flagged({ labelIds: [LABEL_ID] })).toEqual({ flag: false, reason: "already-flagged" });
  });

  it("refuses to judge a run with no start time", () => {
    expect(decide({ issue: makeIssue(), runStartedAt: null, labelId: LABEL_ID })).toEqual({
      flag: false,
      reason: "no-run-window",
    });
  });

  it("says so when the issue is gone", () => {
    expect(decide({ issue: null, runStartedAt: RUN_STARTED_AT, labelId: LABEL_ID })).toEqual({
      flag: false,
      reason: "no-issue",
    });
  });

  it("reads labels from either shape the host may send", () => {
    expect(labelIdsOf(makeIssue({ labelIds: ["a"] }))).toEqual(["a"]);
    expect(
      labelIdsOf(
        makeIssue({
          labels: [
            { id: "b", companyId: COMPANY_ID, name: "human-review", color: "#fff", createdAt: new Date(0), updatedAt: new Date(0) },
          ],
        }),
      ),
    ).toEqual(["b"]);
  });
});

describe("what it does to the board", () => {
  it("parks the task, labels it, and names who unblocks it", async () => {
    const { comments, emitted, finishRun, issue } = await setup();

    await finishRun();

    const parked = await issue();
    expect(parked?.status).toBe("blocked");
    expect(parked?.labelIds).toContain(LABEL_ID);
    expect(parked?.unblockDescriptor).toEqual({
      owner: { userId: "user_owner" },
      action: expect.stringContaining(RUN_ID),
    });
    expect(comments[0]).toContain("without finishing");
    expect(comments[0]).toContain(RUN_ID);
    expect(emitted).toEqual([
      {
        issueId: ISSUE_ID,
        runId: RUN_ID,
        agentId: "agent_1",
        startedAt: RUN_STARTED_AT,
        finishedAt: RUN_FINISHED_AT,
      },
    ]);
  });

  it("keeps the labels the task already had", async () => {
    const { finishRun, issue } = await setup({ issue: makeIssue({ labelIds: ["lbl_other"] }) });

    await finishRun();

    expect((await issue())?.labelIds).toEqual(["lbl_other", LABEL_ID]);
  });

  it("parks without a label when none is configured", async () => {
    const { finishRun, issue } = await setup({ config: { humanReviewLabelId: "" } });

    await finishRun();

    const parked = await issue();
    expect(parked?.status).toBe("blocked");
    expect(parked?.labelIds ?? []).toEqual([]);
  });

  it("hands the task to the board when no owner is configured", async () => {
    const { finishRun, issue } = await setup({ config: { unblockOwnerUserId: "" } });

    await finishRun();

    expect((await issue())?.unblockDescriptor?.owner).toBe("board");
  });

  it("does nothing when the task was updated during the run", async () => {
    const { comments, emitted, finishRun, issue } = await setup({
      issue: makeIssue({ updatedAt: DURING_THE_RUN }),
    });

    await finishRun();

    expect((await issue())?.status).toBe("in_progress");
    expect(comments).toEqual([]);
    expect(emitted).toEqual([]);
  });

  it("does nothing for a run that carried no issue", async () => {
    const { comments, finishRun, issue } = await setup();

    await finishRun({ issueId: null });

    expect((await issue())?.status).toBe("in_progress");
    expect(comments).toEqual([]);
  });

  it("does nothing when the check is switched off", async () => {
    const { comments, finishRun, issue } = await setup({
      config: { completionCheckEnabled: false },
    });

    await finishRun();

    expect((await issue())?.status).toBe("in_progress");
    expect(comments).toEqual([]);
  });

  // Two runs can finish in the same moment. The second must find the task
  // already parked and stand down, rather than commenting twice or overwriting
  // the descriptor the first one wrote.
  it("is idempotent when the same run event arrives twice", async () => {
    const { comments, emitted, finishRun } = await setup();

    await finishRun();
    await finishRun();

    expect(comments).toHaveLength(1);
    expect(emitted).toHaveLength(1);
  });
});
