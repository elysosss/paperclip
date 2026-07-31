import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
import { PLUGIN_ID, PLUGIN_VERSION } from "./constants.js";

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "GitHub Mirror",
  description:
    "One-way mirror of Paperclip task state into GitHub issues. Paperclip stays the store of record; GitHub is a viewing surface.",
  author: "elysosss",
  categories: ["automation"],
  capabilities: [
    "events.subscribe",
    "issues.read",
    "plugin.state.read",
    "plugin.state.write",
    "http.outbound",
    "secrets.read-ref",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
  },
  instanceConfigSchema: {
    type: "object",
    properties: {
      repository: {
        type: "string",
        title: "Target repository",
        description: 'Where task state is mirrored, as "owner/repo".',
      },
      token: {
        type: "string",
        title: "GitHub token (secret reference)",
        description:
          "Secret reference to a token with issues:write on the target repository. Resolved per call, never stored by the plugin.",
      },
      mirrorEnabled: {
        type: "boolean",
        title: "Enable mirroring",
        description: "Turn the mirror off without uninstalling the plugin.",
        default: true,
      },
    },
  },
};

export default manifest;
