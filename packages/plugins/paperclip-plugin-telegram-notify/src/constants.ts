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
  /**
   * The hand-off we last said "waiting for you" about, or absent when the issue
   * is not currently waiting on anyone as far as we told the operator.
   *
   * Two different signals mean the same hand-off — the task parking as
   * `blocked`, and an agent opening an issue-thread interaction — and a task can
   * produce both. One key shared by both paths is what makes a hand-off buzz the
   * phone once. The value says which signal claimed it, so only that signal's
   * ending clears it: `status:blocked`, or `interaction:<id>`.
   */
  waitingNotified: "telegram:waiting-notified",
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

/**
 * Emitted when a message could not be delivered to a single allowlisted chat.
 * The GitHub mirror listens and writes it onto the mirrored issue instead, so a
 * notification that cannot reach a phone is not simply lost.
 *
 * Emitted rather than written to GitHub here on purpose: this plugin knows
 * nothing about GitHub, exactly as the escalation plugin knows nothing about
 * either of us. The bus is where the surfaces meet.
 */
export const UNDELIVERED_EVENT = "notification-undelivered";
