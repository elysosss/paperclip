import {
  definePlugin,
  runWorker,
  type PluginContext,
  type PluginEvent,
} from "@paperclipai/plugin-sdk";
import { parseConfig, type NotifyConfig } from "./config.js";
import { ESCALATION_EVENT, STATE_KEYS, WAITING_STATUS } from "./constants.js";
import {
  boardLink,
  formatBudget,
  formatEscalation,
  formatRunFailure,
  formatWaitingForHuman,
  type IssueRef,
} from "./format.js";
import { TelegramApiError, TelegramClient } from "./telegram.js";

async function readConfig(ctx: PluginContext, companyId: string): Promise<NotifyConfig | null> {
  return parseConfig(await ctx.config.get(companyId));
}

/**
 * Telegram being unreachable is an observability problem, not a reason to stop
 * the board processing events. Same discipline as the mirror: every handler
 * wrapped, failures logged with a `retryable` flag, nothing propagated.
 */
async function guard(ctx: PluginContext, what: string, run: () => Promise<void>): Promise<void> {
  try {
    await run();
  } catch (error) {
    const retryable = error instanceof TelegramApiError ? error.retryable : false;
    const retryAfterSec = error instanceof TelegramApiError ? error.retryAfterSec : null;
    ctx.logger.error(`Telegram notify: ${what} failed`, {
      message: error instanceof Error ? error.message : String(error),
      retryable,
      ...(retryAfterSec !== null ? { retryAfterSec } : {}),
    });
  }
}

/** Best-effort issue lookup — a message with a bare id beats no message. */
async function lookupIssue(
  ctx: PluginContext,
  issueId: string | null,
  companyId: string,
): Promise<IssueRef | null> {
  if (!issueId) return null;
  try {
    const issue = await ctx.issues.get(issueId, companyId);
    if (!issue) return null;
    // The board calls the human-facing key `identifier` ("KIT-9"); `id` is the
    // uuid. A message showing the uuid is a message nobody can act on.
    return {
      id: issue.id,
      key: typeof issue.identifier === "string" ? issue.identifier : null,
      title: typeof issue.title === "string" ? issue.title : null,
    };
  } catch {
    return null;
  }
}

function payloadOf(event: PluginEvent): Record<string, unknown> {
  return (event.payload ?? {}) as Record<string, unknown>;
}

function str(raw: Record<string, unknown>, key: string): string | null {
  const value = raw[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function num(raw: Record<string, unknown>, key: string): number {
  const value = raw[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

const plugin = definePlugin({
  async setup(ctx) {
    /**
     * Sends to every allowlisted chat. One failing recipient must not silence
     * the others, so each send is guarded on its own — the alternative loses
     * the message for everyone because one person blocked the bot.
     */
    const broadcast = async (config: NotifyConfig, companyId: string, text: string): Promise<void> => {
      const token = await ctx.secrets.resolve(config.token, { companyId, configPath: "token" });
      const client = new TelegramClient({
        token,
        fetchImpl: (url, init) => ctx.http.fetch(url, init),
      });
      for (const chatId of config.chatIds) {
        await guard(ctx, `send to chat ${chatId}`, () => client.sendMessage({ chatId, text }));
      }
    };

    ctx.events.on(ESCALATION_EVENT, (event) =>
      guard(ctx, ESCALATION_EVENT, async () => {
        const config = await readConfig(ctx, event.companyId);
        if (!config?.notify.escalation) return;
        const raw = payloadOf(event);
        const issueId = str(raw, "issueId");
        if (!issueId) return;
        const issue = await lookupIssue(ctx, issueId, event.companyId);
        await broadcast(
          config,
          event.companyId,
          formatEscalation({
            issue,
            issueId,
            reviewReturns: num(raw, "reviewReturns"),
            gateFailures: num(raw, "gateFailures"),
            threshold: num(raw, "threshold"),
            link: boardLink(config.boardBaseUrl, issue),
          }),
        );
      }),
    );

    ctx.events.on("agent.run.failed", (event) =>
      guard(ctx, "agent.run.failed", async () => {
        const config = await readConfig(ctx, event.companyId);
        if (!config?.notify.runFailed) return;
        const raw = payloadOf(event);
        // entityId is the run. The issue, when there is one, rides in the payload.
        const issueId = str(raw, "issueId");
        const issue = await lookupIssue(ctx, issueId, event.companyId);
        const agentId = str(raw, "agentId");
        let agentName: string | null = null;
        if (agentId) {
          try {
            agentName = (await ctx.agents.get(agentId, event.companyId))?.name ?? null;
          } catch {
            agentName = null;
          }
        }
        await broadcast(
          config,
          event.companyId,
          formatRunFailure({
            issue,
            issueId,
            agentName,
            runId: str(raw, "runId") ?? event.entityId ?? null,
            message: str(raw, "error") ?? str(raw, "message"),
            link: boardLink(config.boardBaseUrl, issue),
          }),
        );
      }),
    );

    ctx.events.on("budget.incident.opened", (event) =>
      guard(ctx, "budget.incident.opened", async () => {
        const config = await readConfig(ctx, event.companyId);
        if (!config?.notify.budget) return;
        await broadcast(
          config,
          event.companyId,
          formatBudget({ state: "opened", reason: str(payloadOf(event), "reason"), link: null }),
        );
      }),
    );

    ctx.events.on("budget.incident.resolved", (event) =>
      guard(ctx, "budget.incident.resolved", async () => {
        const config = await readConfig(ctx, event.companyId);
        if (!config?.notify.budget) return;
        await broadcast(
          config,
          event.companyId,
          formatBudget({ state: "resolved", reason: null, link: null }),
        );
      }),
    );

    /**
     * A task became somebody's to decide. Watched on the board state rather
     * than on the completion check's event, because a reviewer agent that
     * finishes its work and refuses to merge parks a task exactly the same way
     * and emits nothing — and that hand-off is most of them.
     */
    ctx.events.on("issue.updated", (event) =>
      guard(ctx, "issue.updated", async () => {
        const issueId = event.entityId;
        if (!issueId) return;
        const config = await readConfig(ctx, event.companyId);
        if (!config?.notify.waitingForHuman) return;

        const issue = await ctx.issues.get(issueId, event.companyId);
        if (!issue) return;

        // Only the transition into the status is worth a message. An update to
        // a task that was already parked is the board being edited, not news.
        const scope = { scopeKind: "issue" as const, scopeId: issueId };
        const seen = await ctx.state.get({ ...scope, stateKey: STATE_KEYS.lastStatus });
        const previous = typeof seen === "string" ? seen : null;
        await ctx.state.set({ ...scope, stateKey: STATE_KEYS.lastStatus }, issue.status);
        if (issue.status !== WAITING_STATUS || previous === WAITING_STATUS) return;

        const descriptor = issue.unblockDescriptor as
          | { owner?: unknown; action?: unknown }
          | null
          | undefined;
        const owner = descriptor?.owner;
        // `{ userId }` means a named person owns the unblock; `"board"` means
        // anyone. Both need a human, only one of them is addressed to you.
        const ownedByYou = typeof owner === "object" && owner !== null && "userId" in owner;

        await broadcast(
          config,
          event.companyId,
          formatWaitingForHuman({
            issue: {
              id: issue.id,
              key: typeof issue.identifier === "string" ? issue.identifier : null,
              title: typeof issue.title === "string" ? issue.title : null,
            },
            issueId,
            action: typeof descriptor?.action === "string" ? descriptor.action : null,
            ownedByYou,
            link: boardLink(config.boardBaseUrl, { id: issue.id, key: null, title: null }),
          }),
        );
      }),
    );

    ctx.logger.info("Telegram notify ready");
  },

  async onHealth() {
    return { status: "ok", message: "Telegram notify worker is running" };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
