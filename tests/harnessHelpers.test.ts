/**
 * Unit tests for the pure helper functions in testnet/helpers.ts.
 *
 * These tests do not require a network connection, a stellar CLI, Redis, or a
 * deployed contract.  They cover the summary-table builder, the skip logic,
 * the output formatter, the terminal-status predicate, and the contract-ID
 * safety check so that regressions are caught without a live run.
 */

import {
  buildSummaryTable,
  formatSummaryTable,
  shouldSkipCheck,
  isTerminalStatus,
  checkForbiddenContractId,
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

// ---------------------------------------------------------------------------
// isTerminalStatus
// ---------------------------------------------------------------------------

describe("isTerminalStatus", () => {
  it("returns true for SUCCESS", () => {
    expect(isTerminalStatus("SUCCESS")).toBe(true);
  });

  it("returns true for FAILED", () => {
    expect(isTerminalStatus("FAILED")).toBe(true);
  });

  it("returns false for NOT_FOUND", () => {
    // NOT_FOUND after submission means the node has not yet indexed the tx;
    // it is not a permanent outcome and must not stop polling.
    expect(isTerminalStatus("NOT_FOUND")).toBe(false);
  });

  it("returns false for PENDING", () => {
    expect(isTerminalStatus("PENDING")).toBe(false);
  });

  it("returns false for undefined", () => {
    expect(isTerminalStatus(undefined)).toBe(false);
  });

  it("returns false for an unrecognised status string", () => {
    expect(isTerminalStatus("UNKNOWN_FUTURE_STATUS")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// checkForbiddenContractId
// ---------------------------------------------------------------------------

// Use fake 56-character Stellar contract IDs (start with C, upper-case base32).
// No real deployed-contract IDs appear in this file.
const FAKE_ID_A = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const FAKE_ID_B = "CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const FAKE_DEPLOYED = "CDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD";

describe("checkForbiddenContractId", () => {
  it("returns configured:false when FORBIDDEN_CONTRACT_IDS is not set", () => {
    const result = checkForbiddenContractId(FAKE_DEPLOYED, {});
    expect(result.configured).toBe(false);
  });

  it("returns configured:false when FORBIDDEN_CONTRACT_IDS is an empty string", () => {
    const result = checkForbiddenContractId(FAKE_DEPLOYED, {
      FORBIDDEN_CONTRACT_IDS: "",
    });
    expect(result.configured).toBe(false);
  });

  it("returns configured:false when FORBIDDEN_CONTRACT_IDS is only whitespace", () => {
    const result = checkForbiddenContractId(FAKE_DEPLOYED, {
      FORBIDDEN_CONTRACT_IDS: "   ",
    });
    expect(result.configured).toBe(false);
  });

  it("returns matched:false when configured and no entry matches", () => {
    const result = checkForbiddenContractId(FAKE_DEPLOYED, {
      FORBIDDEN_CONTRACT_IDS: `${FAKE_ID_A},${FAKE_ID_B}`,
    });
    expect(result.configured).toBe(true);
    if (result.configured) {
      expect(result.matched).toBe(false);
    }
  });

  it("returns matched:true with the matching id when configured and the deployed ID matches", () => {
    const result = checkForbiddenContractId(FAKE_ID_A, {
      FORBIDDEN_CONTRACT_IDS: `${FAKE_ID_A},${FAKE_ID_B}`,
    });
    expect(result.configured).toBe(true);
    if (result.configured) {
      expect(result.matched).toBe(true);
      if (result.matched) {
        expect(result.id).toBe(FAKE_ID_A);
      }
    }
  });

  it("matches even when the list has extra whitespace around entries", () => {
    const result = checkForbiddenContractId(FAKE_ID_B, {
      FORBIDDEN_CONTRACT_IDS: ` ${FAKE_ID_A} , ${FAKE_ID_B} `,
    });
    expect(result.configured).toBe(true);
    if (result.configured) {
      expect(result.matched).toBe(true);
    }
  });

  it("does not match a prefix of a forbidden ID", () => {
    const prefix = FAKE_ID_A.slice(0, 20);
    const result = checkForbiddenContractId(prefix, {
      FORBIDDEN_CONTRACT_IDS: FAKE_ID_A,
    });
    expect(result.configured).toBe(true);
    if (result.configured) {
      expect(result.matched).toBe(false);
    }
  });
});
