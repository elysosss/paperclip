import {
  definePlugin,
  runWorker,
  type EnvSecretRefBinding,
  type PluginContext,
  type PluginEvent,
} from "@paperclipai/plugin-sdk";
import type { IssueStatus } from "@paperclipai/shared";
import { GithubApiError, GithubClient } from "./github.js";
import { STATE_KEYS } from "./constants.js";
import {
  formatBody,
  formatBudgetComment,
  formatRunFailureComment,
  formatStatusComment,
  formatTitle,
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

function issueScope(issueId: string) {
  return { scopeKind: "issue" as const, scopeId: issueId };
}

async function readMirroredNumber(ctx: PluginContext, issueId: string): Promise<number | null> {
  const stored = await ctx.state.get({ ...issueScope(issueId), stateKey: STATE_KEYS.mirroredNumber });
  return typeof stored === "number" ? stored : null;
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
    /** Creates the GitHub issue once and remembers its number. Idempotent. */
    const ensureMirrored = async (event: PluginEvent): Promise<void> => {
      const issueId = event.entityId;
      if (!issueId) return;
      const config = await readConfig(ctx, event.companyId);
      if (!config) return;
      if (await readMirroredNumber(ctx, issueId)) return;

      const issue = await ctx.issues.get(issueId, event.companyId);
      if (!issue) return;

      const github = await clientFor(ctx, event.companyId, config);
      const created = await github.createIssue({
        title: formatTitle(issue),
        body: formatBody(issue),
        labels: [statusLabel(issue.status)],
      });

      await ctx.state.set(
        { ...issueScope(issueId), stateKey: STATE_KEYS.mirroredNumber },
        created.number,
      );
      await ctx.state.set(
        { ...issueScope(issueId), stateKey: STATE_KEYS.lastStatus },
        issue.status,
      );
      ctx.logger.info("Mirrored Paperclip issue to GitHub", {
        issueId,
        githubIssue: created.number,
      });
    };

    /** Posts a comment on the mirrored issue, if there is one. */
    const comment = async (event: PluginEvent, body: string): Promise<void> => {
      const issueId = event.entityId;
      if (!issueId) return;
      const config = await readConfig(ctx, event.companyId);
      if (!config) return;
      const number = await readMirroredNumber(ctx, issueId);
      if (!number) return;
      const github = await clientFor(ctx, event.companyId, config);
      await github.addComment(number, body);
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
        const payload = (event.payload ?? {}) as { runId?: string; error?: string; message?: string };
        await comment(
          event,
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

    ctx.logger.info("GitHub mirror ready");
  },

  async onHealth() {
    return { status: "ok", message: "GitHub mirror worker is running" };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
