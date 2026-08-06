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
 * Where the notified state is remembered, so a re-delivered event does not send
 * twice. Same shape as the mirror's issue-number map: scoped to the issue.
 */
export const STATE_KEYS = {
  /** The status this issue was in when we last looked. */
  lastStatus: "telegram:last-status",
} as const;

/**
 * The status that means work stopped and somebody has to decide something.
 *
 * Notifying on the board state rather than on who produced it is deliberate.
 * Two different things park a task here — the completion check catching a run
 * that abandoned one, and a reviewer agent that finished its work and will not
 * merge — and only one of them emits an event. Watching the state catches both;
 * watching the completion check's event would have missed every deliberate
 * hand-off, which is most of them.
 */
export const WAITING_STATUS = "blocked";

/** Telegram truncates nothing for us; a lock screen shows about this much. */
export const MAX_ERROR_CHARS = 280;

export const TELEGRAM_API_BASE = "https://api.telegram.org";
