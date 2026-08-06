import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
import { PLUGIN_ID, PLUGIN_VERSION } from "./constants.js";

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "Telegram Notify",
  description:
    "Pushes the few board events that need a human to Telegram. Outbound only — no webhook, no inbound endpoint, no commands.",
  author: "elysosss",
  categories: ["automation"],
  capabilities: [
    "events.subscribe",
    // Emits `notification-undelivered` so the GitHub mirror can carry a message
    // this plugin could not deliver.
    "events.emit",
    "issues.read",
    "agents.read",
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
      token: {
        // `format: secret-ref` is a UI hint only, so the type has to admit both
        // a plain string and the { type: "secret_ref", secretId } object the
        // secret picker submits — same as the GitHub mirror's token field.
        type: ["string", "object"],
        format: "secret-ref",
        title: "Bot token",
        description:
          "From @BotFather. Resolved per call, never stored by the plugin. Anyone holding it reads every notification ever sent.",
      },
      allowedChatIds: {
        type: "array",
        items: { type: "string" },
        title: "Allowed chat ids",
        description:
          "Numeric chat ids that may receive messages. Empty means notify nobody — this list is the entire authorisation model, so it fails closed.",
        default: [],
      },
      boardBaseUrl: {
        type: "string",
        title: "Board base URL",
        description:
          "Optional. Prefixes task links in messages. Leave empty if the board is only reachable on the LAN — a dead link is worse than none.",
      },
      notifyEnabled: {
        type: "boolean",
        title: "Enable notifications",
        description: "Turn every message off without uninstalling the plugin.",
        default: true,
      },
      notifyEscalation: {
        type: "boolean",
        title: "Notify on escalation",
        description: "A task the escalation plugin says needs a human.",
        default: true,
      },
      notifyRunFailed: {
        type: "boolean",
        title: "Notify on run failure",
        description: "A failed run still spends the day's cap, so this means today is over, not that it will retry.",
        default: true,
      },
      notifyBudget: {
        type: "boolean",
        title: "Notify on budget incidents",
        description: "Money stopped, or restarted.",
        default: true,
      },
      notifyWaitingForHuman: {
        type: "boolean",
        title: "Notify when a task is parked for you",
        description:
          "The completion check parking an abandoned task, or a reviewer that will not merge. This is where every loop that produces work for you ends.",
        default: true,
      },
    },
  },
};

export default manifest;
