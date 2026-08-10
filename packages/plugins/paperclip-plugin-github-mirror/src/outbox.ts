/**
 * The create outbox.
 *
 * ## Why an outbox at all
 *
 * Creating the mirrored GitHub issue is the one step that cannot be repeated
 * safely: a second POST makes a second issue. Everything else the mirror does
 * — patching, commenting — is keyed on a number we already hold.
 *
 * Event delivery gives no help here. The host pushes events as a fire-and-forget
 * JSON-RPC notification and drops it outright when the worker is down
 * (`plugin-worker-manager.ts`, `notify()` returns early unless the status is
 * `running`). There is no replay: an event that arrives while the worker is
 * restarting is simply gone. So the plugin cannot wait to be told again — it
 * has to write down what it is about to do, before it does it.
 *
 * ## Why entities and not state
 *
 * `ctx.state` is `get`/`set`/`delete` only, with a last-write-wins upsert on
 * the host side — no compare-and-set, no conditional write. Worse for an
 * outbox: the host's state store has a `list`, but it is not exposed over the
 * worker→host RPC, so a queue kept in state could never enumerate its own
 * pending work. `ctx.entities` has `upsert(externalId)` plus `list(query)` and
 * is enumerable, so the outbox lives there.
 *
 * ## What this buys, and what it does not
 *
 * Intent is recorded before the POST, so a create that dies mid-flight leaves a
 * `pending` record. What it cannot do is find out what actually happened: the
 * mirror is write-only and stays that way, so a `pending` record with no number
 * becomes `uncertain` — recorded, logged, visible, and never retried. That is a
 * downgrade from a silent duplicate to a known unknown, not a cure.
 */

import type { PluginContext, PluginEntityRecord, ScopeKey } from "@paperclipai/plugin-sdk";
import {
  OUTBOX_ENTITY_TYPE,
  OUTBOX_PENDING_GRACE_MS,
  OUTBOX_STATUS,
  STATE_KEYS,
} from "./constants.js";

/** Records examined per drain run, and the page size used to walk them. */
const PAGE_SIZE = 200;
const MAX_RECORDS_PER_RUN = 2_000;

export interface OutboxData {
  companyId: string;
  issueId: string;
  /** When the create was first attempted — the clock the grace window uses. */
  startedAt: string;
  /** Set once the POST has returned a number. */
  mirroredNumber?: number;
}

export function issueScope(issueId: string): { scopeKind: "issue"; scopeId: string } {
  return { scopeKind: "issue", scopeId: issueId };
}

export async function readMirroredNumber(
  ctx: PluginContext,
  issueId: string,
): Promise<number | null> {
  const key: ScopeKey = { ...issueScope(issueId), stateKey: STATE_KEYS.mirroredNumber };
  const stored = await ctx.state.get(key);
  return typeof stored === "number" ? stored : null;
}

/** One record per Paperclip issue, per company. */
function externalId(companyId: string, issueId: string): string {
  return `${companyId}:${issueId}`;
}

function readData(record: PluginEntityRecord): OutboxData | null {
  const data = record.data as Partial<OutboxData> | undefined;
  if (!data || typeof data.issueId !== "string" || typeof data.companyId !== "string") return null;
  return {
    companyId: data.companyId,
    issueId: data.issueId,
    startedAt: typeof data.startedAt === "string" ? data.startedAt : "",
    mirroredNumber: typeof data.mirroredNumber === "number" ? data.mirroredNumber : undefined,
  };
}

async function write(
  ctx: PluginContext,
  data: OutboxData,
  status: string,
  title: string | undefined,
): Promise<PluginEntityRecord> {
  return ctx.entities.upsert({
    entityType: OUTBOX_ENTITY_TYPE,
    scopeKind: "issue",
    scopeId: data.issueId,
    externalId: externalId(data.companyId, data.issueId),
    title,
    status,
    data: { ...data },
  });
}

export async function findCreateRecord(
  ctx: PluginContext,
  companyId: string,
  issueId: string,
): Promise<PluginEntityRecord | null> {
  const [found] = await ctx.entities.list({
    entityType: OUTBOX_ENTITY_TYPE,
    externalId: externalId(companyId, issueId),
    limit: 1,
  });
  return found ?? null;
}

/**
 * Written before the POST, so an interrupted create is not invisible. Returns
 * the record so the closing write can keep its original `startedAt`.
 */
export async function recordIntent(
  ctx: PluginContext,
  companyId: string,
  issueId: string,
  title: string,
): Promise<PluginEntityRecord> {
  return write(
    ctx,
    { companyId, issueId, startedAt: new Date().toISOString() },
    OUTBOX_STATUS.pending,
    title,
  );
}

/** Written after the number has been persisted to state, closing the record. */
export async function recordMirrored(
  ctx: PluginContext,
  record: PluginEntityRecord,
  mirroredNumber: number,
): Promise<void> {
  const data = readData(record);
  if (!data) return;
  await write(ctx, { ...data, mirroredNumber }, OUTBOX_STATUS.done, record.title ?? undefined);
}

/**
 * GitHub answered with a status code, so the create definitively did not
 * happen. Terminal for this attempt but not for the task: a later event is
 * free to create the issue, because there is no duplicate to fear.
 */
export async function recordFailed(
  ctx: PluginContext,
  record: PluginEntityRecord,
): Promise<void> {
  const data = readData(record);
  if (!data) return;
  await write(ctx, data, OUTBOX_STATUS.failed, record.title ?? undefined);
}

/**
 * Terminal. The create may or may not exist on GitHub; finding out would mean
 * reading GitHub back, which this plugin does not do.
 */
export async function recordUncertain(
  ctx: PluginContext,
  record: PluginEntityRecord,
): Promise<void> {
  const data = readData(record);
  if (!data) return;
  await write(ctx, data, OUTBOX_STATUS.uncertain, record.title ?? undefined);
}

function isPastGrace(startedAt: string, now: number): boolean {
  const started = Date.parse(startedAt);
  // An unreadable timestamp is treated as old: leaving it pending forever would
  // hide it, and hiding it is the failure mode this whole file exists to fix.
  if (Number.isNaN(started)) return true;
  return now - started >= OUTBOX_PENDING_GRACE_MS;
}

/**
 * Resolves every `pending` record left behind by an interrupted create.
 *
 * Reads plugin state and plugin entities. Never GitHub — no lookup, no search,
 * no verification call. A record either has a number we already stored, or it
 * does not and becomes `uncertain`.
 */
export async function drainOutbox(ctx: PluginContext): Promise<void> {
  const now = Date.now();

  for (let offset = 0; offset < MAX_RECORDS_PER_RUN; offset += PAGE_SIZE) {
    const page = await ctx.entities.list({
      entityType: OUTBOX_ENTITY_TYPE,
      limit: PAGE_SIZE,
      offset,
    });

    for (const record of page) {
      if (record.status !== OUTBOX_STATUS.pending) continue;
      const data = readData(record);
      if (!data) continue;

      // The number may have been persisted to state even though the record was
      // never closed — the two writes are not atomic and cannot be.
      const mirroredNumber = data.mirroredNumber ?? (await readMirroredNumber(ctx, data.issueId));
      if (mirroredNumber !== null && mirroredNumber !== undefined) {
        await recordMirrored(ctx, record, mirroredNumber);
        continue;
      }

      // Still inside the window where a create could legitimately be in flight.
      if (!isPastGrace(data.startedAt, now)) continue;

      await recordUncertain(ctx, record);
      // Logged exactly once: the record leaves `pending` on this pass and the
      // drain never looks at it again.
      ctx.logger.error(
        "GitHub mirror: a create was interrupted and cannot be confirmed — no further attempts will be made",
        { issueId: data.issueId, companyId: data.companyId, startedAt: data.startedAt },
      );
    }

    if (page.length < PAGE_SIZE) break;
  }
}
