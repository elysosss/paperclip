import { describe, expect, it } from "vitest";
import {
  companyHasFreeWipSlot,
  countRunningRunsForCompany,
  hasCompanySlot,
  isCompanyWipLimitEnabled,
  normalizeCompanyWipLimit,
} from "./company-wip-limit.js";
import type { Db } from "@paperclipai/db";

/** Minimal stand-in for the drizzle chain the counter uses. */
function fakeDb(count: number, onQuery?: () => void): Db {
  return {
    select: () => ({
      from: () => ({
        where: async () => {
          onQuery?.();
          return [{ count }];
        },
      }),
    }),
  } as unknown as Db;
}

describe("company wip limit config", () => {
  it("treats anything non-positive as disabled, so upstream behaviour is unchanged", () => {
    expect(normalizeCompanyWipLimit(undefined)).toBe(0);
    expect(normalizeCompanyWipLimit("")).toBe(0);
    expect(normalizeCompanyWipLimit("not a number")).toBe(0);
    expect(normalizeCompanyWipLimit(0)).toBe(0);
    expect(normalizeCompanyWipLimit(-3)).toBe(0);
    expect(isCompanyWipLimitEnabled(0)).toBe(false);
  });

  it("accepts a positive limit, from a string too (env vars are strings)", () => {
    expect(normalizeCompanyWipLimit("1")).toBe(1);
    expect(normalizeCompanyWipLimit(2.9)).toBe(2);
    expect(isCompanyWipLimitEnabled(1)).toBe(true);
  });
});

describe("slot arithmetic", () => {
  it("allows everything when disabled", () => {
    expect(hasCompanySlot(0, 99)).toBe(true);
  });

  it("permits work strictly below the limit", () => {
    expect(hasCompanySlot(1, 0)).toBe(true);
    expect(hasCompanySlot(1, 1)).toBe(false);
    expect(hasCompanySlot(2, 1)).toBe(true);
    expect(hasCompanySlot(2, 2)).toBe(false);
  });
});

describe("companyHasFreeWipSlot", () => {
  it("does not touch the database when the limit is disabled", async () => {
    let queried = false;
    const db = fakeDb(5, () => {
      queried = true;
    });

    await expect(companyHasFreeWipSlot({ db, companyId: "c1", limit: 0 })).resolves.toBe(true);
    expect(queried).toBe(false);
  });

  it("blocks a second run when one is already running under WIP=1", async () => {
    await expect(
      companyHasFreeWipSlot({ db: fakeDb(1), companyId: "c1", limit: 1 }),
    ).resolves.toBe(false);
  });

  it("allows the next run once nothing is running", async () => {
    await expect(
      companyHasFreeWipSlot({ db: fakeDb(0), companyId: "c1", limit: 1 }),
    ).resolves.toBe(true);
  });

  it("counts rows returned by the query", async () => {
    await expect(countRunningRunsForCompany(fakeDb(3), "c1")).resolves.toBe(3);
    await expect(countRunningRunsForCompany(fakeDb(0), "c1")).resolves.toBe(0);
  });
});
