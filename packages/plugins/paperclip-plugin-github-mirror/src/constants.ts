export const PLUGIN_ID = "paperclip-plugin-github-mirror";
export const PLUGIN_VERSION = "0.1.0";

/** Plugin state keys, scoped per Paperclip issue. */
export const STATE_KEYS = {
  /** GitHub issue number this Paperclip issue is mirrored to. */
  mirroredNumber: "github-issue-number",
  /** Last mirrored status, so unchanged updates do not spam the GitHub issue. */
  lastStatus: "last-mirrored-status",
} as const;

/**
 * Emitted by the escalation plugin when a task is handed to a human. Subscribed to
 * rather than reimplemented, so escalation policy stays in one place.
 */
export const ESCALATION_EVENT = "plugin.paperclip-plugin-escalation.escalation-raised";

/** Marker appended to every mirrored body so a human can tell what created it. */
export const MIRROR_FOOTER =
  "_Mirrored from Paperclip. This issue is written by the mirror; edits here are not read back._";

/**
 * Emitted by the Telegram plugin when it could not deliver a message to any of
 * its allowlisted chats. The mirror writes it onto the mirrored issue, so a
 * notification that cannot reach a phone still reaches somewhere a human looks.
 *
 * The mirror knows nothing about Telegram beyond this event's shape, and the
 * Telegram plugin knows nothing about GitHub. Same seam as escalation.
 */
export const TELEGRAM_UNDELIVERED_EVENT =
  "plugin.paperclip-plugin-telegram-notify.notification-undelivered";
