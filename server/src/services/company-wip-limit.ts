import { and, eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { heartbeatRuns } from "@paperclipai/db";

/**
 * Company-wide work-in-progress limit.
 *
 * Paperclip already caps concurrency per agent (`maxConcurrentRuns`), which is
 * enough when a company is one agent. It is not enough for a team: an
 * implementer and a reviewer each get their own slot, so two tasks can be in
 * flight at once. This adds a cap across the whole company, so work can be run
 * strictly serially — one task carried end to end before the next is started.
 *
 * Lives in its own module on purpose: `heartbeat.ts` is the most frequently
 * changed file upstream, so the integration there is kept to a single call.
 *
 * Disabled by default (limit <= 0), which preserves upstream behaviour.
 */

/** A limit of 0 or less means "no company-wide cap". */
export function isCompanyWipLimitEnabled(limit: number): boolean {
  return Number.isFinite(limit) && limit > 0;
}

export function normalizeCompanyWipLimit(value: unknown): number {
  const parsed = Math.floor(Number(value));
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return parsed;
}

export function hasCompanySlot(limit: number, runningCount: number): boolean {
  if (!isCompanyWipLimitEnabled(limit)) return true;
  return runningCount < limit;
}

/**
 * Counts runs currently occupying a slot.
 *
 * Only `running` counts. A task parked for a human (escalated to `blocked`) has
 * no running run, so it stops consuming a slot the moment it is parked — which
 * is what keeps one stuck task from blocking the whole serial queue.
 */
export async function countRunningRunsForCompany(db: Db, companyId: string): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)` })
    .from(heartbeatRuns)
    .where(and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.status, "running")));
  return Number(row?.count ?? 0);
}

/**
 * Fast path used by the scheduler before it does any work: is it worth looking
 * for a queued run at all? Advisory only — it is not the gate. See
 * `withCompanyWipSlot`.
 */
export async function companyHasFreeWipSlot(input: {
  db: Db;
  companyId: string;
  limit: number;
}): Promise<boolean> {
  if (!isCompanyWipLimitEnabled(input.limit)) return true;
  const running = await countRunningRunsForCompany(input.db, input.companyId);
  return hasCompanySlot(input.limit, running);
}

/** Advisory-lock key. One lock per company, so companies never contend. */
function companyWipLockKey(companyId: string): string {
  return `paperclip:company-wip:${companyId}`;
}

/**
 * Reserves a company slot for the duration of `claim`.
 *
 * A bare count is not a gate. The scheduler counts running runs, then does about
 * eleven more database round trips (invokability, budgets, daily caps, tree
 * holds, dependency readiness, staleness) before the conditional UPDATE that
 * flips a run to `running`. The only mutex in that window is `withAgentStartLock`,
 * which is in-process and keyed by agent id — two agents of one company take two
 * different locks and both sail through. Both read zero running runs, both claim,
 * and the company spends two runs where the operator configured one. It fails on
 * money, so the check has to be a reservation, not an observation.
 *
 * Pushing `(select count(*) …) < limit` into the UPDATE's WHERE does not fix it:
 * under READ COMMITTED the two implicit transactions each take their snapshot
 * before the other commits, so both subqueries still see zero. The serialization
 * point has to be a lock. `pg_advisory_xact_lock` is the right one — it lives in
 * the database, so it holds across server processes, and Postgres drops it when
 * the transaction ends, including when a process dies, which a counter table
 * would not do.
 *
 * The transaction body is deliberately only three statements: take the lock,
 * re-count under it, run the caller's UPDATE. No budget checks, no adapter calls.
 * A company-wide lock held across slow work would serialize the whole company and
 * could deadlock against the longer-lived `paperclip:folders:*` locks.
 *
 * Returns null when the company has no free slot; the caller's run stays queued.
 * When the limit is disabled this touches neither a transaction nor the database
 * and hands the caller the plain connection, so upstream behaviour is unchanged.
 */
export async function withCompanyWipSlot<T>(
  input: { db: Db; companyId: string; limit: number },
  claim: (tx: Db) => Promise<T | null>,
): Promise<T | null> {
  if (!isCompanyWipLimitEnabled(input.limit)) return claim(input.db);
  return input.db.transaction(async (tx) => {
    const txDb = tx as unknown as Db;
    await txDb.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${companyWipLockKey(input.companyId)}, 0))`,
    );
    const running = await countRunningRunsForCompany(txDb, input.companyId);
    if (!hasCompanySlot(input.limit, running)) return null;
    return claim(txDb);
  });
}
