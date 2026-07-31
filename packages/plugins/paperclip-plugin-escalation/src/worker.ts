import {
  definePlugin,
  runWorker,
  type PluginContext,
  type PluginEvent,
} from "@paperclipai/plugin-sdk";
import type { IssueStatus } from "@paperclipai/shared";
import { DEFAULT_REVIEW_RETURN_THRESHOLD, ESCALATION_EVENT, STATE_KEYS } from "./constants.js";
import {
  formatEscalationComment,
  isReviewReturn,
  isTerminal,
  shouldEscalate,
  type Counters,
} from "./escalation.js";

interface EscalationConfig {
  reviewReturnThreshold: number;
}

async function readConfig(ctx: PluginContext, companyId: string): Promise<EscalationConfig | null> {
  const raw = await ctx.config.get(companyId);
  if (raw.escalationEnabled === false) return null;
  const configured = Number(raw.reviewReturnThreshold);
  const reviewReturnThreshold =
    Number.isFinite(configured) && configured >= 1
      ? Math.floor(configured)
      : DEFAULT_REVIEW_RETURN_THRESHOLD;
  return { reviewReturnThreshold };
}

function scope(issueId: string) {
  return { scopeKind: "issue" as const, scopeId: issueId };
}

async function readNumber(ctx: PluginContext, issueId: string, stateKey: string): Promise<number> {
  const value = await ctx.state.get({ ...scope(issueId), stateKey });
  return typeof value === "number" ? value : 0;
}

async function clearCounters(ctx: PluginContext, issueId: string): Promise<void> {
  await ctx.state.set({ ...scope(issueId), stateKey: STATE_KEYS.gateFailures }, 0);
  await ctx.state.set({ ...scope(issueId), stateKey: STATE_KEYS.reviewReturns }, 0);
  await ctx.state.set({ ...scope(issueId), stateKey: STATE_KEYS.escalated }, false);
}

/** A failure here must not stop event processing — keeping the queue moving matters more. */
async function guard(ctx: PluginContext, what: string, run: () => Promise<void>): Promise<void> {
  try {
    await run();
  } catch (error) {
    ctx.logger.error(`Escalation: ${what} failed`, {
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

const plugin = definePlugin({
  async setup(ctx) {
    /** Parks the task for a human and tells other plugins about it. */
    const escalate = async (
      event: PluginEvent,
      counters: Counters,
      threshold: number,
    ): Promise<void> => {
      const issueId = event.entityId;
      if (!issueId) return;

      await ctx.issues.update(issueId, { status: "blocked" }, event.companyId);
      await ctx.issues.createComment(
        issueId,
        formatEscalationComment(counters, threshold),
        event.companyId,
      );
      await ctx.state.set({ ...scope(issueId), stateKey: STATE_KEYS.escalated }, true);

      // The mirror listens for this and surfaces it in GitHub. Emitting instead of
      // calling GitHub here keeps the escalation rules and the viewing surface apart.
      await ctx.events.emit(ESCALATION_EVENT, event.companyId, {
        issueId,
        reviewReturns: counters.reviewReturns,
        gateFailures: counters.gateFailures,
        threshold,
      });

      ctx.logger.warn("Task escalated to a human", {
        issueId,
        reviewReturns: counters.reviewReturns,
        threshold,
      });
    };

    ctx.events.on("issue.updated", (event) =>
      guard(ctx, "issue.updated", async () => {
        const issueId = event.entityId;
        if (!issueId) return;
        const config = await readConfig(ctx, event.companyId);
        if (!config) return;

        const issue = await ctx.issues.get(issueId, event.companyId);
        if (!issue) return;

        const stored = await ctx.state.get({ ...scope(issueId), stateKey: STATE_KEYS.lastStatus });
        const previous = typeof stored === "string" ? (stored as IssueStatus) : null;
        if (previous === issue.status) return;

        await ctx.state.set({ ...scope(issueId), stateKey: STATE_KEYS.lastStatus }, issue.status);

        if (isTerminal(issue.status)) {
          await clearCounters(ctx, issueId);
          return;
        }

        if (!isReviewReturn(previous, issue.status)) return;

        const alreadyEscalated = await ctx.state.get({
          ...scope(issueId),
          stateKey: STATE_KEYS.escalated,
        });
        if (alreadyEscalated === true) return;

        const reviewReturns = (await readNumber(ctx, issueId, STATE_KEYS.reviewReturns)) + 1;
        await ctx.state.set({ ...scope(issueId), stateKey: STATE_KEYS.reviewReturns }, reviewReturns);

        const counters: Counters = {
          gateFailures: await readNumber(ctx, issueId, STATE_KEYS.gateFailures),
          reviewReturns,
        };
        if (shouldEscalate(counters, config.reviewReturnThreshold)) {
          await escalate(event, counters, config.reviewReturnThreshold);
        }
      }),
    );

    // Counter A is recorded for context but never escalates on its own: a failing
    // test is objective and worth retrying, unlike a repeated reviewer disagreement.
    ctx.events.on("agent.run.failed", (event) =>
      guard(ctx, "agent.run.failed", async () => {
        const issueId = event.entityId;
        if (!issueId) return;
        if (!(await readConfig(ctx, event.companyId))) return;
        const next = (await readNumber(ctx, issueId, STATE_KEYS.gateFailures)) + 1;
        await ctx.state.set({ ...scope(issueId), stateKey: STATE_KEYS.gateFailures }, next);
      }),
    );

    ctx.logger.info("Escalation watcher ready");
  },

  async onHealth() {
    return { status: "ok", message: "Escalation worker is running" };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
