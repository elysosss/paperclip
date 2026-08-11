import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  agentRuntimeState,
  agentWakeupRequests,
  companySkills,
  companies,
  createDb,
  documentRevisions,
  documents,
  environmentLeases,
  environments,
  executionWorkspaces,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issueDocuments,
  issueTreeHolds,
  issues,
  workspaceOperations,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { withCompanyWipSlot } from "../services/company-wip-limit.ts";
import { runningProcesses } from "../adapters/index.ts";

/**
 * The company WIP limit has to be a reservation, not a count.
 *
 * A test that calls the gate twice in sequence passes against the broken code and
 * proves nothing: the bug only exists while two claims overlap. Both tests here
 * force a genuine overlap — the first claim is pinned open on a deferred while the
 * second one runs — which is the only shape that can tell a reservation apart from
 * an observation.
 */

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "Company WIP limit race test run.",
    provider: "test",
    model: "test-model",
  })),
);

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({
      supportsLocalAgentJwt: false,
      execute: mockAdapterExecute,
    })),
  };
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres company WIP limit race tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Settles to "pending" unless `promise` wins within a few macrotask turns. */
async function settledWithin<T>(promise: Promise<T>, turns = 10): Promise<"pending" | { value: T }> {
  const pending = Symbol("pending");
  for (let turn = 0; turn < turns; turn += 1) {
    const winner = await Promise.race([
      promise.then((value) => ({ value })),
      new Promise<typeof pending>((resolve) => setTimeout(() => resolve(pending), 10)),
    ]);
    if (winner !== pending) return winner as { value: T };
  }
  return "pending";
}

async function waitForCondition(fn: () => Promise<boolean>, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return fn();
}

describeEmbeddedPostgres("company WIP limit is a reservation, not a count", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-company-wip-race-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db, { companyMaxConcurrentRuns: 1 });
  }, 20_000);

  afterEach(async () => {
    let idlePolls = 0;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const runs = await db.select({ status: heartbeatRuns.status }).from(heartbeatRuns);
      const hasActiveRun = runs.some((run) => run.status === "queued" || run.status === "running");
      if (!hasActiveRun) {
        idlePolls += 1;
        if (idlePolls >= 3) break;
      } else {
        idlePolls = 0;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const runIds = await db
      .select({ id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .then((rows) => rows.map((row) => row.id));
    await Promise.all(runIds.map((runId) => heartbeat.waitForRunExecutionDrain(runId)));
    mockAdapterExecute.mockReset();
    mockAdapterExecute.mockImplementation(async () => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      errorMessage: null,
      summary: "Company WIP limit race test run.",
      provider: "test",
      model: "test-model",
    }));
    runningProcesses.clear();
    await db.delete(environmentLeases);
    await db.delete(activityLog);
    await db.delete(companySkills);
    await db.delete(issueComments);
    await db.delete(issueDocuments);
    await db.delete(documentRevisions);
    await db.delete(documents);
    await db.delete(issueTreeHolds);
    await db.delete(issues);
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agentRuntimeState);
    await db.delete(agents);
    await db.delete(environments);
    await db.delete(workspaceOperations);
    await db.delete(executionWorkspaces);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        await db.transaction(async (tx) => {
          await tx.delete(companySkills);
          await tx.delete(companies);
        });
        break;
      } catch (error) {
        if (attempt === 4) throw error;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany(companyId: string, prefixSeed: string) {
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `${prefixSeed}${companyId.replace(/-/g, "").slice(0, 5).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
  }

  async function seedAgent(companyId: string, agentId: string, name: string, role: string) {
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name,
      role,
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
    });
  }

  it("holds the second claimant outside the company slot until the first claim commits", async () => {
    const companyId = randomUUID();
    const firstAgentId = randomUUID();
    const secondAgentId = randomUUID();
    const firstRunId = randomUUID();
    const secondRunId = randomUUID();

    await seedCompany(companyId, "R");
    await seedAgent(companyId, firstAgentId, "Implementer", "engineer");
    await seedAgent(companyId, secondAgentId, "Reviewer", "qa");
    await db.insert(heartbeatRuns).values([
      { id: firstRunId, companyId, agentId: firstAgentId, status: "queued", invocationSource: "on_demand" },
      { id: secondRunId, companyId, agentId: secondAgentId, status: "queued", invocationSource: "on_demand" },
    ]);

    const holdFirstClaim = deferred();
    let secondClaimRan = false;

    // Claimant 1 parks *before* writing its running row. That is the shape of the
    // real bug: in claimQueuedRun about eleven database round trips sit between the
    // slot decision and the UPDATE, so a second claimant gets to look at the world
    // while the first has decided but not yet written. A count-based gate lets the
    // second one through here; a reservation must not.
    const firstClaim = withCompanyWipSlot({ db, companyId, limit: 1 }, async (tx) => {
      await holdFirstClaim.promise;
      return tx
        .update(heartbeatRuns)
        .set({ status: "running", startedAt: new Date(), updatedAt: new Date() })
        .where(eq(heartbeatRuns.id, firstRunId))
        .returning()
        .then((rows) => rows[0] ?? null);
    });

    // Wait until claimant 1 really holds the advisory lock, so the overlap is real
    // and not a scheduling accident.
    await waitForCondition(async () => {
      const locks = await db.execute(
        sql`select count(*)::int as count from pg_locks where locktype = 'advisory' and granted`,
      );
      return Number((locks as unknown as Array<{ count: number }>)[0]?.count ?? 0) > 0;
    });

    const secondClaim = withCompanyWipSlot({ db, companyId, limit: 1 }, async (tx) => {
      secondClaimRan = true;
      return tx
        .update(heartbeatRuns)
        .set({ status: "running", startedAt: new Date(), updatedAt: new Date() })
        .where(eq(heartbeatRuns.id, secondRunId))
        .returning()
        .then((rows) => rows[0] ?? null);
    });

    // The gate is a reservation: claimant 2 cannot even decide yet, because
    // claimant 1 holds the lock and has not committed its running row.
    expect(await settledWithin(secondClaim)).toBe("pending");
    expect(secondClaimRan).toBe(false);

    holdFirstClaim.resolve();
    await expect(firstClaim).resolves.toMatchObject({ id: firstRunId, status: "running" });

    // Now it can decide, and the answer is "no slot" — without ever running its claim.
    await expect(secondClaim).resolves.toBeNull();
    expect(secondClaimRan).toBe(false);

    const statuses = await db
      .select({ id: heartbeatRuns.id, status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .then((rows) => Object.fromEntries(rows.map((row) => [row.id, row.status])));
    expect(statuses[firstRunId]).toBe("running");
    expect(statuses[secondRunId]).toBe("queued");
  }, 30_000);

  it("starts exactly one run when two agents of one company wake at the same instant", async () => {
    const companyId = randomUUID();
    const implementerId = randomUUID();
    const reviewerId = randomUUID();
    const implementerIssueId = randomUUID();
    const reviewerIssueId = randomUUID();

    await seedCompany(companyId, "E");
    await seedAgent(companyId, implementerId, "Implementer", "engineer");
    await seedAgent(companyId, reviewerId, "Reviewer", "qa");
    await db.insert(issues).values([
      {
        id: implementerIssueId,
        companyId,
        title: "Implement the thing",
        status: "todo",
        priority: "high",
        assigneeAgentId: implementerId,
        responsibleUserId: "responsible-user",
      },
      {
        id: reviewerIssueId,
        companyId,
        title: "Review the thing",
        status: "todo",
        priority: "high",
        assigneeAgentId: reviewerId,
        responsibleUserId: "responsible-user",
      },
    ]);

    // Whoever wins parks in the adapter, so the winner stays `running` for the
    // whole assertion window and the company slot is genuinely occupied.
    const releaseAdapter = deferred();
    mockAdapterExecute.mockImplementation(async () => {
      await releaseAdapter.promise;
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        errorMessage: null,
        summary: "Company WIP limit race test run.",
        provider: "test",
        model: "test-model",
      };
    });

    try {
      const [implementerRun, reviewerRun] = await Promise.all([
        heartbeat.wakeup(implementerId, {
          source: "assignment",
          triggerDetail: "system",
          reason: "issue_assigned",
          payload: { issueId: implementerIssueId },
          contextSnapshot: { issueId: implementerIssueId, wakeReason: "issue_assigned" },
        }),
        heartbeat.wakeup(reviewerId, {
          source: "assignment",
          triggerDetail: "system",
          reason: "issue_assigned",
          payload: { issueId: reviewerIssueId },
          contextSnapshot: { issueId: reviewerIssueId, wakeReason: "issue_assigned" },
        }),
      ]);
      expect(implementerRun).not.toBeNull();
      expect(reviewerRun).not.toBeNull();

      const oneRunning = await waitForCondition(async () => {
        const rows = await db.select({ status: heartbeatRuns.status }).from(heartbeatRuns);
        return rows.filter((row) => row.status === "running").length === 1;
      });
      expect(oneRunning).toBe(true);

      // Let the winner reach the adapter, then let any second claim that was going
      // to happen, happen.
      const winnerReachedAdapter = await waitForCondition(
        async () => mockAdapterExecute.mock.calls.length >= 1,
        30_000,
      );
      expect(winnerReachedAdapter).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 500));

      const rows = await db
        .select({ id: heartbeatRuns.id, agentId: heartbeatRuns.agentId, status: heartbeatRuns.status })
        .from(heartbeatRuns);
      expect(rows).toHaveLength(2);
      const running = rows.filter((row) => row.status === "running");
      const queued = rows.filter((row) => row.status === "queued");
      expect(running).toHaveLength(1);
      expect(queued).toHaveLength(1);
      expect(running[0]!.agentId).not.toBe(queued[0]!.agentId);
      expect(mockAdapterExecute).toHaveBeenCalledTimes(1);
    } finally {
      releaseAdapter.resolve();
    }
  }, 40_000);

  it("re-dispatches the losing agent company-wide when the winning run finishes", async () => {
    const companyId = randomUUID();
    const implementerId = randomUUID();
    const reviewerId = randomUUID();
    const implementerIssueId = randomUUID();
    const reviewerIssueId = randomUUID();

    await seedCompany(companyId, "S");
    await seedAgent(companyId, implementerId, "Implementer", "engineer");
    await seedAgent(companyId, reviewerId, "Reviewer", "qa");
    await db.insert(issues).values([
      {
        id: implementerIssueId,
        companyId,
        title: "Implement the thing",
        status: "todo",
        priority: "high",
        assigneeAgentId: implementerId,
        responsibleUserId: "responsible-user",
      },
      {
        id: reviewerIssueId,
        companyId,
        title: "Review the thing",
        status: "todo",
        priority: "high",
        assigneeAgentId: reviewerId,
        responsibleUserId: "responsible-user",
      },
    ]);

    const releaseWinner = deferred();
    mockAdapterExecute.mockImplementationOnce(async () => {
      await releaseWinner.promise;
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        errorMessage: null,
        summary: "Winning run complete.",
        provider: "test",
        model: "test-model",
      };
    });

    try {
      await Promise.all([
        heartbeat.wakeup(implementerId, {
          source: "assignment",
          triggerDetail: "system",
          reason: "issue_assigned",
          payload: { issueId: implementerIssueId },
          contextSnapshot: { issueId: implementerIssueId, wakeReason: "issue_assigned" },
        }),
        heartbeat.wakeup(reviewerId, {
          source: "assignment",
          triggerDetail: "system",
          reason: "issue_assigned",
          payload: { issueId: reviewerIssueId },
          contextSnapshot: { issueId: reviewerIssueId, wakeReason: "issue_assigned" },
        }),
      ]);

      await waitForCondition(async () => {
        const rows = await db.select({ status: heartbeatRuns.status }).from(heartbeatRuns);
        return rows.filter((row) => row.status === "running").length === 1;
      });

      const loserAgentId = await db
        .select({ agentId: heartbeatRuns.agentId })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.status, "queued"))
        .then((rows) => rows[0]?.agentId ?? null);
      expect(loserAgentId).not.toBeNull();

      releaseWinner.resolve();

      // No timer is running in this test, so the only thing that can move the loser
      // off `queued` is the company-wide sweep on run completion.
      const loserDispatched = await waitForCondition(async () => {
        const row = await db
          .select({ status: heartbeatRuns.status })
          .from(heartbeatRuns)
          .where(eq(heartbeatRuns.agentId, loserAgentId!))
          .then((rows) => rows[0] ?? null);
        return row?.status !== "queued";
      }, 15_000);
      expect(loserDispatched).toBe(true);
      expect(mockAdapterExecute.mock.calls.length).toBeGreaterThanOrEqual(2);
    } finally {
      releaseWinner.resolve();
    }
  }, 60_000);
});
