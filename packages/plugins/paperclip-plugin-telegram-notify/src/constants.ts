export const PLUGIN_ID = "paperclip-plugin-telegram-notify";
export const PLUGIN_VERSION = "0.1.0";

/**
 * Plugin-to-plugin. The escalation plugin decides that a task needs a human and
 * emits this; we only render it. Not a member of PLUGIN_EVENT_TYPES — it never
 * passes through the activity log — so the issue id travels in the payload.
 *
 * Note the prefix. The bus namespaces a plugin-emitted event as
 * `plugin.<emitting-plugin-id>.<name>`; the emitter passes the bare name and
 * every subscriber must use the namespaced one. Subscribing to the bare name
 * compiles, runs, and silently receives nothing for ever.
 */
export const ESCALATION_EVENT = "plugin.paperclip-plugin-escalation.escalation-raised";

/**
 * Emitted by paperclip-plugin-run-completion when it parks a task a run left
 * untouched. Subscribed to directly rather than inferred from `issue.updated`,
 * because the run-completion plugin already made the judgement and repeating it
 * here would mean two implementations of the same rule drifting apart.
 */
export const RUN_ENDED_UNFINISHED_EVENT =
  "plugin.paperclip-plugin-run-completion.run-ended-unfinished";

/**
 * Where the notified state is remembered, so a re-delivered event does not send
 * twice. Same shape as the mirror's issue-number map: scoped to the issue.
 */
export const STATE_KEYS = {
  /** Last status we sent a "waiting for you" message about. */
  lastHumanWaitStatus: "telegram:last-human-wait-status",
} as const;

/** Telegram truncates nothing for us; a lock screen shows about this much. */
export const MAX_ERROR_CHARS = 280;

export const TELEGRAM_API_BASE = "https://api.telegram.org";
