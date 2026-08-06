/**
 * Message rendering. Pure functions, no I/O — every one of them is a string in,
 * a string out, so the whole "what does the phone actually say" surface is
 * testable without a network.
 *
 * Two rules from the spec hold everywhere in this file:
 *
 * 1. **Identifiers and links, not content.** This is the only part of the kit
 *    that leaves the machine. A task key and a URL are not the diff.
 * 2. **Readable on a lock screen.** One bold first line saying what happened,
 *    then the detail. No cards, no keyboards, no markdown that needs escaping
 *    rules a title can violate.
 */

import { MAX_ERROR_CHARS } from "./constants.js";
import { escapeHtml } from "./telegram.js";

export interface IssueRef {
  id: string;
  key: string | null;
  title: string | null;
}

/** Truncates on a character budget, marking that it happened. */
export function clip(text: string, max = MAX_ERROR_CHARS): string {
  const collapsed = text.replaceAll(/\s+/g, " ").trim();
  return collapsed.length <= max ? collapsed : `${collapsed.slice(0, max - 1)}…`;
}

/** `TEC-4 · Write the next technique`, or the bare id when the board gave us nothing. */
export function issueLabel(issue: IssueRef | null, fallbackId: string | null): string {
  if (!issue) return fallbackId ? escapeHtml(fallbackId) : "an unknown task";
  const key = issue.key ? escapeHtml(issue.key) : escapeHtml(issue.id);
  return issue.title ? `${key} · ${escapeHtml(clip(issue.title, 120))}` : key;
}

/**
 * The board link, when the operator configured a base URL. It is optional on
 * purpose: the board runs on a LAN address that is meaningless from a phone
 * outside the house, and a dead link is worse than none.
 */
export function boardLink(baseUrl: string | null, issue: IssueRef | null): string | null {
  if (!baseUrl || !issue) return null;
  const trimmed = baseUrl.replace(/\/+$/, "");
  return `${trimmed}/issues/${encodeURIComponent(issue.id)}`;
}

function withLink(lines: string[], link: string | null): string {
  if (link) lines.push(escapeHtml(link));
  return lines.join("\n");
}

export function formatEscalation(input: {
  issue: IssueRef | null;
  issueId: string | null;
  reviewReturns: number;
  gateFailures: number;
  threshold: number;
  link: string | null;
}): string {
  const reasons: string[] = [];
  if (input.reviewReturns > 0) reasons.push(`${input.reviewReturns} review returns`);
  if (input.gateFailures > 0) reasons.push(`${input.gateFailures} gate failures`);
  const why = reasons.length > 0 ? reasons.join(", ") : "escalation threshold reached";
  return withLink(
    [
      "<b>Needs a human</b>",
      issueLabel(input.issue, input.issueId),
      `${escapeHtml(why)} (threshold ${input.threshold}).`,
    ],
    input.link,
  );
}

export function formatRunFailure(input: {
  issue: IssueRef | null;
  issueId: string | null;
  agentName: string | null;
  runId: string | null;
  message: string | null;
  link: string | null;
}): string {
  const who = input.agentName ? escapeHtml(input.agentName) : "An agent";
  const lines = [
    "<b>Run failed</b>",
    `${who}${input.runId ? ` · run <code>${escapeHtml(clip(input.runId, 40))}</code>` : ""}`,
  ];
  if (input.issue || input.issueId) lines.push(issueLabel(input.issue, input.issueId));
  if (input.message) lines.push(`<code>${escapeHtml(clip(input.message))}</code>`);
  // The spec asked for "runs remaining today" here, and it is not in this
  // message: the daily cap lives in the agent's heartbeat config and the day's
  // run count is not on any read the plugin SDK exposes. Saying nothing is
  // better than guessing a number the operator would act on. See README.
  lines.push("A failed run still spends the day's cap — check the board before waking it again.");
  return withLink(lines, input.link);
}

export function formatBudget(input: {
  state: "opened" | "resolved";
  reason: string | null;
  link: string | null;
}): string {
  const lines =
    input.state === "opened"
      ? ["<b>Budget stopped work</b>", input.reason ? escapeHtml(clip(input.reason)) : "A spend limit was reached."]
      : ["<b>Budget incident resolved</b>", "Spending is allowed again."];
  return withLink(lines, input.link);
}

/**
 * The fourth notification, and the spec says a fourth needs an argument, so:
 * every loop in this kit that produces work for the owner ends here — the
 * completion check parks an abandoned task like this, and a reviewer agent that
 * will not merge parks a finished one the same way. Without this message the
 * output of an overnight run is invisible until someone opens the board, which
 * is the failure the notifier exists to prevent. It is a filter on an event
 * that already exists, not a new event, and it can be switched off alone.
 */
export function formatWaitingForHuman(input: {
  issue: IssueRef | null;
  issueId: string | null;
  reason: string | null;
  action: string | null;
  link: string | null;
}): string {
  const lines = ["<b>Waiting for you</b>", issueLabel(input.issue, input.issueId)];
  if (input.action) lines.push(escapeHtml(clip(input.action, 200)));
  else if (input.reason) lines.push(escapeHtml(clip(input.reason, 200)));
  return withLink(lines, input.link);
}
