import type { Issue, IssueStatus } from "@paperclipai/shared";

/**
 * Why a finished run was left alone. Every skip is named rather than being a
 * bare `return`, because the interesting question when this plugin does nothing
 * is always "which condition let it go".
 */
export type SkipReason =
  | "no-issue"
  | "no-run-window"
  | "terminal"
  | "already-blocked"
  | "already-flagged"
  | "board-was-touched";

export type Verdict = { flag: true } | { flag: false; reason: SkipReason };

const TERMINAL: readonly IssueStatus[] = ["done", "cancelled"];

export function isTerminal(status: IssueStatus): boolean {
  return TERMINAL.includes(status);
}

function toMillis(value: Date | string | null | undefined): number | null {
  if (!value) return null;
  const millis = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(millis) ? millis : null;
}

export function labelIdsOf(issue: Issue): string[] {
  if (issue.labelIds && issue.labelIds.length > 0) return issue.labelIds;
  return (issue.labels ?? []).map((label) => label.id);
}

/**
 * The whole rule, in one testable place.
 *
 * A run that finished successfully should have left the board saying something:
 * done, in review with a real reviewer, blocked with a named owner. When the
 * task has not been touched since before the run began, the agent worked and
 * recorded nothing — the board is now claiming a state nobody stands behind.
 *
 * Comments and documents deliberately do not count. That is not an oversight:
 * the core's own agent contract says they are "evidence, not valid liveness
 * paths by themselves", and a run that only commented is exactly the case this
 * is here to catch.
 */
export function decide(input: {
  issue: Issue | null;
  runStartedAt: string | null;
  labelId: string | null;
}): Verdict {
  const { issue, runStartedAt, labelId } = input;
  if (!issue) return { flag: false, reason: "no-issue" };

  const startedAt = toMillis(runStartedAt);
  // Without a start time there is no window to compare against, and guessing
  // one would mean parking tasks on no evidence.
  if (startedAt === null) return { flag: false, reason: "no-run-window" };

  if (isTerminal(issue.status)) return { flag: false, reason: "terminal" };
  if (issue.status === "blocked") return { flag: false, reason: "already-blocked" };
  if (labelId && labelIdsOf(issue).includes(labelId)) {
    return { flag: false, reason: "already-flagged" };
  }

  const updatedAt = toMillis(issue.updatedAt);
  if (updatedAt !== null && updatedAt >= startedAt) {
    return { flag: false, reason: "board-was-touched" };
  }

  return { flag: true };
}

function formatInstant(value: string | null): string {
  return value ?? "an unknown time";
}

export function formatUnblockAction(runId: string): string {
  return (
    `Run ${runId} ended without recording a result. Check whether the work actually landed — ` +
    "a merged pull request, a pushed branch, a written document — and then set the real status. " +
    "If nothing landed, put it back in the queue."
  );
}

export function formatComment(input: {
  runId: string;
  startedAt: string | null;
  finishedAt: string | null;
  issueUpdatedAt: Date | string;
}): string {
  const updated = input.issueUpdatedAt instanceof Date
    ? input.issueUpdatedAt.toISOString()
    : input.issueUpdatedAt;
  return [
    "**Parked for a human — the run ended without finishing this or saying so.**",
    "",
    `Run \`${input.runId}\` started at ${formatInstant(input.startedAt)} and finished at ` +
      `${formatInstant(input.finishedAt)}. This task has not changed since ${updated}, which is ` +
      "before the run began.",
    "",
    "So nothing here says the work is done, and nothing says it is stuck. That is the one state " +
      "the board must not sit in quietly: it reports queued or active work that may not exist.",
    "",
    "Comments and documents are not counted as an answer, on purpose — a run that only talked " +
      "about the work is the case this check exists for.",
  ].join("\n");
}
