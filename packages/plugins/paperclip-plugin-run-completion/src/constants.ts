export const PLUGIN_ID = "paperclip-plugin-run-completion";
export const PLUGIN_VERSION = "0.1.0";

/**
 * The event this watches. Note the name: the core publishes `agent.run.finished`
 * for a succeeded run — there is no `agent.run.succeeded`, and a plugin
 * subscribed to that name fails silently forever.
 * See server/src/services/heartbeat.ts, where the run status is mapped to an event.
 */
export const RUN_FINISHED_EVENT = "agent.run.finished";

/** Emitted for other plugins (the GitHub mirror) to surface the parked task. */
export const FLAGGED_EVENT = "run-ended-unfinished";

/** What the label is called on the board. The id goes in the instance config. */
export const DEFAULT_LABEL_NAME = "human-review";
