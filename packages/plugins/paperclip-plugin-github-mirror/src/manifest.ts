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
        // `format: secret-ref` is only a UI hint — the host registers it as a
        // no-op format — so the type must still admit the
        // { type: "secret_ref", secretId } object a secret picker submits,
        // not just a plain string.
        type: ["string", "object"],
        format: "secret-ref",
        title: "GitHub token",
        description:
          "Token with issues:write on the target repository. Resolved per call, never stored by the plugin.",
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
