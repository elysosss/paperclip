import type { IssueStatus } from "@paperclipai/shared";

/**
 * Escalation rules, kept pure so the thresholds can be tested without a host.
 *
 * Two counters are tracked separately on purpose:
 *  - A (gate failures) is objective — a test failed, go fix it. Retrying is fine.
 *  - B (reviewer returns) is a judgement call, and repeated returns usually mean
 *    a disagreement about the spec that another round of automation won't settle.
 *
 * Only B escalates. That is what stops the implementer/reviewer ping-pong from
 * burning quota indefinitely.
 */

export interface Counters {
  gateFailures: number;
  reviewReturns: number;
}

/** A reviewer sending work back shows up as in_review -> in_progress. */
export function isReviewReturn(previous: IssueStatus | null, next: IssueStatus): boolean {
  return previous === "in_review" && next === "in_progress";
}

/** Terminal states end the task's life; counters are cleared so a reopen starts fresh. */
export function isTerminal(status: IssueStatus): boolean {
  return status === "done" || status === "cancelled";
}

export function shouldEscalate(counters: Counters, threshold: number): boolean {
  return counters.reviewReturns >= threshold;
}

export function formatEscalationComment(counters: Counters, threshold: number): string {
  return [
    `🚨 **Escalated — needs a human.**`,
    "",
    `The reviewer sent this back ${counters.reviewReturns} time(s), reaching the threshold of ${threshold}.`,
    `Automated gate failures so far: ${counters.gateFailures}.`,
    "",
    "Repeated reviewer returns usually mean a disagreement about the spec rather than a",
    "fixable defect, so the task is parked instead of being retried again.",
    "",
    "The task is now `blocked` and released from the work-in-progress limit, so the queue",
    "keeps moving. Unblock it by fixing it directly, replying with direction, or cancelling it.",
  ].join("\n");
}
