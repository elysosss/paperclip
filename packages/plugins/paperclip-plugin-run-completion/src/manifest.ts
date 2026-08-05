import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
import { DEFAULT_LABEL_NAME, PLUGIN_ID, PLUGIN_VERSION } from "./constants.js";

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "Run completion check",
  description:
    "Catches the run that ends without finishing its task or saying it could not: the task is parked as blocked, labelled for a human, and given an unblock action, instead of the board quietly claiming work nobody stands behind.",
  author: "elysosss",
  categories: ["automation"],
  capabilities: [
    "events.subscribe",
    "events.emit",
    "issues.read",
    "issues.update",
    "issue.comments.create",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
  },
  instanceConfigSchema: {
    type: "object",
    properties: {
      completionCheckEnabled: {
        type: "boolean",
        title: "Enable the completion check",
        default: true,
      },
      humanReviewLabelId: {
        type: "string",
        title: `Id of the "${DEFAULT_LABEL_NAME}" label`,
        description:
          `Create the label on the board first, then paste its id here — GET /api/companies/<id>/labels lists them. ` +
          "Left empty, the task is still parked as blocked with an unblock action; it just will not carry the label, " +
          "so it is harder to tell apart from a blocker the agent named itself.",
      },
      unblockOwnerUserId: {
        type: "string",
        title: "Who unblocks it",
        description:
          "User id recorded as the unblock owner. Left empty, the owner is the board, which means anyone.",
      },
    },
  },
};

export default manifest;
