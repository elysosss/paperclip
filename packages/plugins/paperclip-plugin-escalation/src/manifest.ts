import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
import { DEFAULT_REVIEW_RETURN_THRESHOLD, PLUGIN_ID, PLUGIN_VERSION } from "./constants.js";

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "Escalation",
  description:
    "Stops implementer/reviewer ping-pong: after N reviewer returns a task is blocked and handed to a human instead of being retried.",
  author: "elysosss",
  categories: ["automation"],
  capabilities: [
    "events.subscribe",
    "events.emit",
    "issues.read",
    "issues.update",
    "issue.comments.create",
    "plugin.state.read",
    "plugin.state.write",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
  },
  instanceConfigSchema: {
    type: "object",
    properties: {
      reviewReturnThreshold: {
        type: "number",
        title: "Reviewer returns before escalating",
        description:
          "How many times the reviewer may send a task back before it is parked for a human. Gate failures are counted but never escalate on their own.",
        default: DEFAULT_REVIEW_RETURN_THRESHOLD,
        minimum: 1,
      },
      escalationEnabled: {
        type: "boolean",
        title: "Enable escalation",
        default: true,
      },
    },
  },
};

export default manifest;
