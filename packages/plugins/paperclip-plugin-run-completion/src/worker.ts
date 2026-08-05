import {
  definePlugin,
  runWorker,
  type PluginContext,
  type PluginEvent,
} from "@paperclipai/plugin-sdk";
import type { IssueUnblockDescriptor } from "@paperclipai/shared";
import { FLAGGED_EVENT, RUN_FINISHED_EVENT } from "./constants.js";
import { decide, formatComment, formatUnblockAction, labelIdsOf } from "./detect.js";

interface CompletionConfig {
  labelId: string | null;
  ownerUserId: string | null;
}

/** The half of the run event this plugin reads. */
interface RunPayload {
  runId: string;
  issueId: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  agentId: string | null;
}

function readPayload(event: PluginEvent): RunPayload {
  const raw = (event.payload ?? {}) as Record<string, unknown>;
  const str = (key: string) => (typeof raw[key] === "string" ? (raw[key] as string) : null);
  return {
    // entityId is the run, not the issue — the issue rides in the payload, and
    // getting that backwards is how the mirror was broken for a week.
    runId: str("runId") ?? event.entityId ?? "unknown",
    issueId: str("issueId"),
    startedAt: str("startedAt"),
    finishedAt: str("finishedAt"),
    agentId: str("agentId"),
  };
}

async function readConfig(ctx: PluginContext, companyId: string): Promise<CompletionConfig | null> {
  const raw = await ctx.config.get(companyId);
  if (raw.completionCheckEnabled === false) return null;
  const trimmed = (key: string) => {
    const value = raw[key];
    return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
  };
  return { labelId: trimmed("humanReviewLabelId"), ownerUserId: trimmed("unblockOwnerUserId") };
}

/** A failure here must not stop event processing — keeping the queue moving matters more. */
async function guard(ctx: PluginContext, what: string, run: () => Promise<void>): Promise<void> {
  try {
    await run();
  } catch (error) {
    ctx.logger.error(`Run completion: ${what} failed`, {
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

const plugin = definePlugin({
  async setup(ctx) {
    ctx.events.on(RUN_FINISHED_EVENT, (event) =>
      guard(ctx, RUN_FINISHED_EVENT, async () => {
        const run = readPayload(event);
        if (!run.issueId) return;

        const config = await readConfig(ctx, event.companyId);
        if (!config) return;

        const issue = await ctx.issues.get(run.issueId, event.companyId);
        const verdict = decide({
          issue,
          runStartedAt: run.startedAt,
          labelId: config.labelId,
        });
        if (!verdict.flag) {
          ctx.logger.debug("Run finished, leaving the task alone", {
            issueId: run.issueId,
            runId: run.runId,
            reason: verdict.reason,
          });
          return;
        }
        // Narrowed by decide(), which returns no-issue for a missing one.
        if (!issue) return;

        const unblockDescriptor: IssueUnblockDescriptor = {
          owner: config.ownerUserId ? { userId: config.ownerUserId } : "board",
          action: formatUnblockAction(run.runId),
        };

        // One write, not three. Two runs can finish at the same moment, and the
        // status is what the second one's decide() reads to stand down — so the
        // label and the descriptor must not land in a separate, later call.
        await ctx.issues.update(
          run.issueId,
          {
            status: "blocked",
            unblockDescriptor,
            ...(config.labelId
              ? { labelIds: [...new Set([...labelIdsOf(issue), config.labelId])] }
              : {}),
          },
          event.companyId,
        );

        await ctx.issues.createComment(
          run.issueId,
          formatComment({
            runId: run.runId,
            startedAt: run.startedAt,
            finishedAt: run.finishedAt,
            issueUpdatedAt: issue.updatedAt,
          }),
          event.companyId,
        );

        // The mirror listens and surfaces this in GitHub. Emitting rather than
        // calling GitHub here keeps the rule and the viewing surface apart.
        await ctx.events.emit(FLAGGED_EVENT, event.companyId, {
          issueId: run.issueId,
          runId: run.runId,
          agentId: run.agentId,
          startedAt: run.startedAt,
          finishedAt: run.finishedAt,
        });

        ctx.logger.warn("Run ended without finishing its task; parked for a human", {
          issueId: run.issueId,
          runId: run.runId,
          agentId: run.agentId,
        });
      }),
    );

    ctx.logger.info("Run completion check ready");
  },

  async onHealth() {
    return { status: "ok", message: "Run completion worker is running" };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
