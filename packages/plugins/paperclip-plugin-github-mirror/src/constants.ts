export const PLUGIN_ID = "paperclip-plugin-github-mirror";
export const PLUGIN_VERSION = "0.1.0";

/** Plugin state keys, scoped per Paperclip issue. */
export const STATE_KEYS = {
  /** GitHub issue number this Paperclip issue is mirrored to. */
  mirroredNumber: "github-issue-number",
  /** Last mirrored status, so unchanged updates do not spam the GitHub issue. */
  lastStatus: "last-mirrored-status",
} as const;

/** Marker appended to every mirrored body so a human can tell what created it. */
export const MIRROR_FOOTER =
  "_Mirrored from Paperclip. This issue is written by the mirror; edits here are not read back._";
