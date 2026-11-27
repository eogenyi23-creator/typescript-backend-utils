/**
 * Unit tests for the pure helper functions in testnet/helpers.ts.
 *
 * These tests do not require a network connection, a stellar CLI, Redis, or a
 * deployed contract.  They cover the summary-table builder, the skip logic, and
 * the output formatter so that regressions are caught without a live run.
 */

import {
  buildSummaryTable,
  formatSummaryTable,
  shouldSkipCheck,
  type CheckResult,
  type SummaryRow,
} from "../testnet/helpers.js";

// ---------------------------------------------------------------------------
// buildSummaryTable
// ---------------------------------------------------------------------------

describe("buildSummaryTable", () => {
  it("maps a passing result to verdict PASS", () => {
    const rows = buildSummaryTable([{ id: "A1", pass: true }]);
    expect(rows).toEqual([{ id: "A1", verdict: "PASS" }]);
  });

  it("maps a failing result to verdict FAIL", () => {
    const rows = buildSummaryTable([{ id: "A2", pass: false }]);
    expect(rows).toEqual([{ id: "A2", verdict: "FAIL" }]);
  });

  it("maps a skipped result to verdict SKIPPED (reason)", () => {
    const rows = buildSummaryTable([
      { id: "D", skipped: true, reason: "REDIS_URL not set" },
    ]);
    expect(rows[0].verdict).toBe("SKIPPED (REDIS_URL not set)");
  });

  it("handles a mixed array in order", () => {
    const rows = buildSummaryTable([
      { id: "A1", pass: true },
      { id: "A2", pass: false },
      { id: "D", skipped: true, reason: "REDIS_URL not set" },
      { id: "E1", pass: true },
    ]);
    expect(rows.map((r: SummaryRow) => r.verdict)).toEqual([
      "PASS",
      "FAIL",
      "SKIPPED (REDIS_URL not set)",
      "PASS",
    ]);
  });

  it("returns an empty array for empty input", () => {
    expect(buildSummaryTable([])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// formatSummaryTable
// ---------------------------------------------------------------------------

describe("formatSummaryTable", () => {
  it("produces a table that starts with a top border", () => {
    const rows = buildSummaryTable([{ id: "A1", pass: true }]);
    const table = formatSummaryTable(rows);
    expect(table).toContain("┌");
    expect(table).toContain("┘");
  });

  it("includes each check ID in the output", () => {
    const rows = buildSummaryTable([
      { id: "A1", pass: true },
      { id: "B2", pass: false },
      { id: "D", skipped: true, reason: "REDIS_URL not set" },
    ]);
    const table = formatSummaryTable(rows);
    expect(table).toContain("A1");
    expect(table).toContain("B2");
    expect(table).toContain("D");
  });

  it("includes PASS, FAIL, and SKIPPED strings", () => {
    const rows = buildSummaryTable([
      { id: "X1", pass: true },
      { id: "X2", pass: false },
      { id: "X3", skipped: true, reason: "no redis" },
    ]);
    const table = formatSummaryTable(rows);
    expect(table).toContain("PASS");
    expect(table).toContain("FAIL");
    expect(table).toContain("SKIPPED");
  });

  it("produces a non-empty string for an empty row array", () => {
    const table = formatSummaryTable([]);
    expect(typeof table).toBe("string");
    expect(table.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// shouldSkipCheck
// ---------------------------------------------------------------------------

describe("shouldSkipCheck", () => {
  it("skips check D when REDIS_URL is not set", () => {
    const result = shouldSkipCheck("D", {});
    expect(result.skip).toBe(true);
    expect(result.reason).toBe("REDIS_URL not set");
  });

  it("does not skip check D when REDIS_URL is set", () => {
    const result = shouldSkipCheck("D", { REDIS_URL: "redis://localhost:6379" });
    expect(result.skip).toBe(false);
  });

  it("does not skip check A regardless of REDIS_URL", () => {
    expect(shouldSkipCheck("A1", {}).skip).toBe(false);
    expect(shouldSkipCheck("A1", { REDIS_URL: "redis://localhost:6379" }).skip).toBe(false);
  });

  it("does not skip check E regardless of environment", () => {
    expect(shouldSkipCheck("E1", {}).skip).toBe(false);
    expect(shouldSkipCheck("E1", { REDIS_URL: "set" }).skip).toBe(false);
  });

  it("does not skip check B or C", () => {
    expect(shouldSkipCheck("B1", {}).skip).toBe(false);
    expect(shouldSkipCheck("C1", {}).skip).toBe(false);
  });
});
