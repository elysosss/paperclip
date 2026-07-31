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
 * Single entry point used by the scheduler: may this company start another run?
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
