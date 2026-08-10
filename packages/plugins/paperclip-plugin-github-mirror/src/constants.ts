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
 * Entity type for the create outbox — one record per Paperclip issue we have
 * tried to mirror, written before the POST so an interrupted create leaves a
 * trace instead of nothing.
 *
 * It lives in `ctx.entities` rather than `ctx.state` for one reason: entities
 * can be enumerated (`ctx.entities.list`), and plugin state cannot. The state
 * store does have a `list`, but it is not exposed over the worker→host RPC, so
 * an outbox kept there could never find its own pending work.
 */
export const OUTBOX_ENTITY_TYPE = "mirror-create";

/** Job key for the outbox drain, declared in the manifest. */
export const OUTBOX_DRAIN_JOB = "drain-mirror-outbox";

/**
 * Statuses a create record moves through.
 *
 * `uncertain` is terminal and deliberately final: it means a create may or may
 * not have reached GitHub and we have no way to find out — the mirror is
 * write-only, so it will not go and look. Refusing forever turns what used to
 * be a silent duplicate issue into one recorded fact a human can act on.
 */
export const OUTBOX_STATUS = {
  pending: "pending",
  done: "done",
  uncertain: "uncertain",
} as const;

/**
 * How long a `pending` record is left alone before the drain will call it
 * `uncertain`. Comfortably past the 30s a single call can take, so the drain
 * never condemns a create that is still in flight.
 */
export const OUTBOX_PENDING_GRACE_MS = 120_000;

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
