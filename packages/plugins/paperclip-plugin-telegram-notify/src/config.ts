/**
 * Config parsing, kept pure so the security-relevant part — who is allowed to
 * receive a message — is decided by a function a test can call directly.
 *
 * The rule that matters: **an empty or unparseable allowlist means notify
 * nobody.** Not "notify everyone", not "fall back to the last known list". A
 * misconfigured notifier that stays silent is a nuisance; one that fails open
 * sends private task keys to whoever is in the config by accident.
 */

import type { EnvSecretRefBinding } from "@paperclipai/plugin-sdk";

export interface NotifyConfig {
  token: string | EnvSecretRefBinding;
  /** Numeric chat ids, as strings. Never empty — a config with none parses to null. */
  chatIds: string[];
  boardBaseUrl: string | null;
  notify: {
    escalation: boolean;
    runFailed: boolean;
    budget: boolean;
    waitingForHuman: boolean;
  };
}

/**
 * Telegram chat ids are 64-bit signed integers; group and channel ids are
 * negative and can exceed what a JS number holds exactly, which is why they are
 * carried as strings from here on rather than parsed into numbers.
 */
const CHAT_ID = /^-?\d{1,20}$/;

function readChatIds(raw: unknown): string[] {
  const values = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(",") : [];
  const seen = new Set<string>();
  for (const value of values) {
    const text = typeof value === "number" ? String(value) : typeof value === "string" ? value.trim() : "";
    if (CHAT_ID.test(text)) seen.add(text);
  }
  return [...seen];
}

function readFlag(raw: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const value = raw[key];
  return typeof value === "boolean" ? value : fallback;
}

function readBoardBaseUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  // Anything that is not an absolute http(s) URL would render as broken text on
  // a phone, so it is dropped rather than sent.
  return /^https?:\/\/\S+$/.test(trimmed) ? trimmed : null;
}

/**
 * Returns null when the plugin must stay silent: switched off, no token, or —
 * the case worth being explicit about — no valid chat id to send to.
 */
export function parseConfig(raw: Record<string, unknown>): NotifyConfig | null {
  if (raw.notifyEnabled === false) return null;

  const token = raw.token as NotifyConfig["token"] | undefined;
  if (!token || (typeof token === "string" && !token.trim())) return null;

  const chatIds = readChatIds(raw.allowedChatIds);
  if (chatIds.length === 0) return null;

  return {
    token,
    chatIds,
    boardBaseUrl: readBoardBaseUrl(raw.boardBaseUrl),
    notify: {
      escalation: readFlag(raw, "notifyEscalation", true),
      runFailed: readFlag(raw, "notifyRunFailed", true),
      budget: readFlag(raw, "notifyBudget", true),
      waitingForHuman: readFlag(raw, "notifyWaitingForHuman", true),
    },
  };
}
