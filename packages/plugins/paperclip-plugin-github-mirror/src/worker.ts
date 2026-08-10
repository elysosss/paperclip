import {
  definePlugin,
  runWorker,
  type EnvSecretRefBinding,
  type PluginContext,
  type PluginEvent,
} from "@paperclipai/plugin-sdk";
import type { IssueStatus } from "@paperclipai/shared";
import { GithubApiError, GithubClient } from "./github.js";
import {
  ESCALATION_EVENT,
  OUTBOX_DRAIN_JOB,
  OUTBOX_STATUS,
  STATE_KEYS,
  TELEGRAM_UNDELIVERED_EVENT,
} from "./constants.js";
import {
  drainOutbox,
  findCreateRecord,
  issueScope,
  readMirroredNumber,
  recordIntent,
  recordFailed,
  recordMirrored,
  recordUncertain,
} from "./outbox.js";
import {
  formatBody,
  formatBudgetComment,
  formatEscalationNotice,
  formatRunFailureComment,
  formatStatusComment,
  formatTitle,
  formatUndeliveredNotice,
  githubStateFor,
  statusLabel,
} from "./mirror.js";

interface MirrorConfig {
  repository: string;
  token: string | EnvSecretRefBinding;
  mirrorEnabled: boolean;
}

/**
 * Reads operator config for a company. Returns null when the mirror is not
 * configured or is switched off, so every handler can bail out uniformly.
 */
async function readConfig(ctx: PluginContext, companyId: string): Promise<MirrorConfig | null> {
  const raw = await ctx.config.get(companyId);
  const repository = typeof raw.repository === "string" ? raw.repository.trim() : "";
  const token = raw.token as MirrorConfig["token"] | undefined;
  const mirrorEnabled = raw.mirrorEnabled !== false;
  if (!mirrorEnabled || !repository || !token) return null;
  return { repository, token, mirrorEnabled };
}

/**
 * Builds a client for one call. The token is resolved per invocation and never
 * cached or logged — the SDK requires secret values to stay call-scoped.
 */
async function clientFor(
  ctx: PluginContext,
  companyId: string,
  config: MirrorConfig,
): Promise<GithubClient> {
  const token = await ctx.secrets.resolve(config.token, { companyId, configPath: "token" });
  return new GithubClient({
    repository: config.repository,
    token,
    fetchImpl: (url, init) => ctx.http.fetch(url, init),
  });
}

/**
 * Handlers must never take the worker down: a GitHub outage or a revoked token
 * is an observability problem, not a reason to stop processing Paperclip events.
 */
async function guard(ctx: PluginContext, what: string, run: () => Promise<void>): Promise<void> {
  try {
    await run();
  } catch (error) {
    const retryable = error instanceof GithubApiError ? error.retryable : false;
    ctx.logger.error(`GitHub mirror: ${what} failed`, {
      message: error instanceof Error ? error.message : String(error),
      retryable,
    });
  }
}

const plugin = definePlugin({
  async setup(ctx) {
    const pendingMirrors = new Map<string, Promise<void>>();

    /**
     * Events can be delivered concurrently. Serialize creation per company/issue
     * so both handlers cannot observe an empty mirror state and create duplicates.
     */
    const serializeMirror = async (key: string, run: () => Promise<void>): Promise<void> => {
      const previous = pendingMirrors.get(key) ?? Promise.resolve();
      const next = previous.catch(() => undefined).then(run);
      pendingMirrors.set(key, next);
      try {
        await next;
      } finally {
        if (pendingMirrors.get(key) === next) pendingMirrors.delete(key);
      }
    };

    /**
     * Creates the GitHub issue once and remembers its number. Idempotent, and
     * where it cannot be idempotent it refuses rather than guesses — see
     * `outbox.ts` for why a create is the one step that must be written down
     * before it is attempted.
     */
    const ensureMirrored = async (event: PluginEvent): Promise<void> => {
      const issueId = event.entityId;
      if (!issueId) return;
      await serializeMirror(`${event.companyId}\u0000${issueId}`, async () => {
        const config = await readConfig(ctx, event.companyId);
        if (!config) return;
        if (await readMirroredNumber(ctx, issueId)) return;

        // No number in state, but a record of an earlier attempt: that attempt
        // may already have created the issue. Posting again would duplicate it,
        // and the mirror will not read GitHub back to find out which it is.
        const attempted = await findCreateRecord(ctx, event.companyId, issueId);
        if (attempted && attempted.status !== OUTBOX_STATUS.failed) {
          if (attempted.status === OUTBOX_STATUS.pending) {
            await recordUncertain(ctx, attempted);
            ctx.logger.error(
              "GitHub mirror: an earlier create was never confirmed — refusing to create a second issue",
              { issueId, companyId: event.companyId },
            );
          }
          return;
        }
        // A `failed` record falls through on purpose: GitHub answered, so the
        // issue does not exist and creating it now cannot duplicate anything.

        const issue = await ctx.issues.get(issueId, event.companyId);
        if (!issue) return;

        const intent = await recordIntent(ctx, event.companyId, issueId, formatTitle(issue));

        const github = await clientFor(ctx, event.companyId, config);
        let created;
        try {
          created = await github.createIssue({
            title: formatTitle(issue),
            body: formatBody(issue),
            labels: [statusLabel(issue.status)],
          });
        } catch (error) {
          // Only a reply from GitHub proves nothing was created. Anything else —
          // a timeout, a dead socket — leaves the outcome unknown, so the record
          // stays `pending` for the drain to condemn.
          if (error instanceof GithubApiError) await recordFailed(ctx, intent);
          throw error;
        }

        // State first: it is what every later handler reads. The outbox record
        // is closed after, and the drain repairs the gap if we die in between.
        await ctx.state.set(
          { ...issueScope(issueId), stateKey: STATE_KEYS.mirroredNumber },
          created.number,
        );
        await ctx.state.set(
          { ...issueScope(issueId), stateKey: STATE_KEYS.lastStatus },
          issue.status,
        );
        await recordMirrored(ctx, intent, created.number);

        ctx.logger.info("Mirrored Paperclip issue to GitHub", {
          issueId,
          githubIssue: created.number,
        });
      });
    };

    /** Posts a comment on the mirrored issue, if there is one. */
    const commentOnIssue = async (
      issueId: string,
      companyId: string,
      body: string,
    ): Promise<void> => {
      const config = await readConfig(ctx, companyId);
      if (!config) return;
      const number = await readMirroredNumber(ctx, issueId);
      if (!number) return;
      const github = await clientFor(ctx, companyId, config);
      await github.addComment(number, body);
    };

    const comment = async (event: PluginEvent, body: string): Promise<void> => {
      if (!event.entityId) return;
      await commentOnIssue(event.entityId, event.companyId, body);
    };

    ctx.events.on("issue.created", (event) =>
      guard(ctx, "issue.created", () => ensureMirrored(event)),
    );

    ctx.events.on("issue.updated", (event) =>
      guard(ctx, "issue.updated", async () => {
        const issueId = event.entityId;
        if (!issueId) return;
        const config = await readConfig(ctx, event.companyId);
        if (!config) return;

        // An issue created before the mirror was configured still gets picked up here.
        const number = await readMirroredNumber(ctx, issueId);
        if (!number) {
          await ensureMirrored(event);
          return;
        }

        const issue = await ctx.issues.get(issueId, event.companyId);
        if (!issue) return;

        const previous = await ctx.state.get({
          ...issueScope(issueId),
          stateKey: STATE_KEYS.lastStatus,
        });
        const previousStatus = typeof previous === "string" ? previous : null;
        if (previousStatus === issue.status) return; // nothing worth mirroring

        const github = await clientFor(ctx, event.companyId, config);
        await github.updateIssue(number, {
          title: formatTitle(issue),
          body: formatBody(issue),
          state: githubStateFor(issue.status),
          labels: [statusLabel(issue.status)],
        });
        await github.addComment(
          number,
          formatStatusComment(previousStatus, issue.status as IssueStatus),
        );
        await ctx.state.set(
          { ...issueScope(issueId), stateKey: STATE_KEYS.lastStatus },
          issue.status,
        );
      }),
    );

    ctx.events.on("agent.run.failed", (event) =>
      guard(ctx, "agent.run.failed", async () => {
        const payload = (event.payload ?? {}) as {
          runId?: string;
          issueId?: unknown;
          error?: string;
          message?: string;
        };
        const issueId = typeof payload.issueId === "string" ? payload.issueId : null;
        if (!issueId) return;
        await commentOnIssue(
          issueId,
          event.companyId,
          formatRunFailureComment({
            runId: payload.runId,
            message: payload.error ?? payload.message,
          }),
        );
      }),
    );

    ctx.events.on("budget.incident.opened", (event) =>
      guard(ctx, "budget.incident.opened", async () => {
        const payload = (event.payload ?? {}) as { reason?: string };
        await comment(event, formatBudgetComment("opened", payload.reason));
      }),
    );

    ctx.events.on("budget.incident.resolved", (event) =>
      guard(ctx, "budget.incident.resolved", () => comment(event, formatBudgetComment("resolved"))),
    );

    // Plugin-to-plugin: the escalation plugin decides, the mirror only shows it.
    // The issue id travels in the payload, since a plugin-emitted event has no entity.
    ctx.events.on(ESCALATION_EVENT, (event) =>
      guard(ctx, ESCALATION_EVENT, async () => {
        const payload = (event.payload ?? {}) as {
          issueId?: string;
          reviewReturns?: number;
          gateFailures?: number;
          threshold?: number;
        };
        if (!payload.issueId) return;
        await commentOnIssue(
          payload.issueId,
          event.companyId,
          formatEscalationNotice({
            reviewReturns: payload.reviewReturns ?? 0,
            gateFailures: payload.gateFailures ?? 0,
            threshold: payload.threshold ?? 0,
          }),
        );
      }),
    );

    // Plugin-to-plugin: the Telegram notifier could not reach a phone, so the
    // message lands here instead. GitHub is already the surface a human can
    // glance at; this stops an undeliverable notification being merely a log
    // line on a machine nobody is looking at.
    ctx.events.on(TELEGRAM_UNDELIVERED_EVENT, (event) =>
      guard(ctx, TELEGRAM_UNDELIVERED_EVENT, async () => {
        const payload = (event.payload ?? {}) as {
          issueId?: unknown;
          kind?: unknown;
          text?: unknown;
          reason?: unknown;
        };
        const issueId = typeof payload.issueId === "string" ? payload.issueId : null;
        const text = typeof payload.text === "string" ? payload.text : null;
        // Without a task there is no issue to comment on. A budget incident is
        // the case: company-level, no task. It stays in the log.
        if (!issueId || !text) return;
        await commentOnIssue(
          issueId,
          event.companyId,
          formatUndeliveredNotice({
            kind: typeof payload.kind === "string" ? payload.kind : "notification",
            text,
            reason: typeof payload.reason === "string" ? payload.reason : null,
          }),
        );
      }),
    );

    // Resolves creates that were interrupted between the POST and the state
    // write. Plugin-local only: it reads state and entities, never GitHub.
    ctx.jobs.register(OUTBOX_DRAIN_JOB, () =>
      guard(ctx, OUTBOX_DRAIN_JOB, () => drainOutbox(ctx)),
    );

    ctx.logger.info("GitHub mirror ready");
  },

  async onHealth() {
    return { status: "ok", message: "GitHub mirror worker is running" };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
