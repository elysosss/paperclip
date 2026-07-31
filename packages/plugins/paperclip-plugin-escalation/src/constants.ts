export const PLUGIN_ID = "paperclip-plugin-escalation";
export const PLUGIN_VERSION = "0.1.0";

/** Reviewer returns before a task is handed to a human. */
export const DEFAULT_REVIEW_RETURN_THRESHOLD = 3;

/** Plugin state keys, scoped per issue. */
export const STATE_KEYS = {
  /** Counter A — objective gate failures (a test or lint run failed). */
  gateFailures: "gate-failure-count",
  /** Counter B — reviewer returns (judgement calls, which may be a spec dispute). */
  reviewReturns: "review-return-count",
  /** Last status seen, used to detect the in_review -> in_progress transition. */
  lastStatus: "last-status",
  /** Set once the task has been escalated, so it only happens one time. */
  escalated: "escalated",
} as const;

/** Emitted for other plugins (e.g. the GitHub mirror) to surface the escalation. */
export const ESCALATION_EVENT = "escalation-raised";
