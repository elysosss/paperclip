import type { Issue, IssueStatus } from "@paperclipai/shared";
import { MIRROR_FOOTER } from "./constants.js";

/**
 * Formatting is kept pure and separate from the service so it can be tested
 * without a network or a host context.
 */

/** GitHub issues have no status field, so Paperclip status is carried as a label. */
export function statusLabel(status: IssueStatus): string {
  return `paperclip:${status.replace(/_/g, "-")}`;
}

/** Only terminal Paperclip states close the mirrored GitHub issue. */
export function githubStateFor(status: IssueStatus): "open" | "closed" {
  return status === "done" || status === "cancelled" ? "closed" : "open";
}

export function formatTitle(issue: Pick<Issue, "title" | "identifier">): string {
  return issue.identifier ? `[${issue.identifier}] ${issue.title}` : issue.title;
}

export function formatBody(issue: Pick<Issue, "description" | "status" | "id">): string {
  const description = issue.description?.trim();
  return [
    `**Status:** \`${issue.status}\``,
    "",
    description && description.length > 0 ? description : "_No description._",
    "",
    "---",
    `Paperclip issue \`${issue.id}\``,
    MIRROR_FOOTER,
  ].join("\n");
}

export function formatStatusComment(from: string | null, to: IssueStatus): string {
  return from ? `Status changed: \`${from}\` → \`${to}\`.` : `Status: \`${to}\`.`;
}

export function formatRunFailureComment(input: {
  runId?: string;
  message?: string;
}): string {
  const detail = input.message?.trim();
  return [
    "⚠️ **Agent run failed.**",
    input.runId ? `Run \`${input.runId}\`.` : null,
    detail ? `\n\`\`\`\n${detail.slice(0, 1500)}\n\`\`\`` : null,
    "\nThe task stays open in Paperclip; this is a status mirror, not a failure report.",
  ]
    .filter(Boolean)
    .join(" ");
}

/**
 * Budget stops are a valid observable state ("found it but did not ship it"),
 * not a failure — the wording deliberately reflects that.
 */
export function formatBudgetComment(kind: "opened" | "resolved", reason?: string): string {
  return kind === "opened"
    ? `⏸️ **Paused — budget limit reached.**${reason ? ` ${reason}` : ""} Work resumes when the limit resets.`
    : `▶️ **Budget incident resolved.** Work can continue.`;
}
