/**
 * Pure helper functions for the testnet harness.
 *
 * These functions have no network, filesystem, or process dependencies.
 * They are exported so that:
 *   - `testnet/run.mjs` can import and use them
 *   - `tests/harnessHelpers.test.ts` can import and unit-test them
 *     without touching the network
 */

export interface CheckResult {
  id: string;
  pass?: boolean;
  skipped?: boolean;
  reason?: string;
}

export interface SummaryRow {
  id: string;
  verdict: string;
}

/**
 * Converts an array of check results into summary rows.
 * - A passing result → `{ verdict: "PASS" }`
 * - A failing result → `{ verdict: "FAIL" }`
 * - A skipped result → `{ verdict: "SKIPPED (reason)" }`
 */
export function buildSummaryTable(allResults: CheckResult[]): SummaryRow[] {
  return allResults.map((r) => ({
    id: r.id,
    verdict: r.skipped
      ? `SKIPPED (${r.reason})`
      : r.pass
        ? "PASS"
        : "FAIL",
  }));
}

/**
 * Formats a summary-row array into a Unicode box-drawing table string.
 */
export function formatSummaryTable(rows: SummaryRow[]): string {
  const lines = [
    "",
    "┌──────┬──────────────────────────────────────────────┐",
    "│ ID   │ Result                                       │",
    "├──────┼──────────────────────────────────────────────┤",
  ];
  for (const row of rows) {
    const id = row.id.padEnd(4);
    const verdict = row.verdict.padEnd(44);
    lines.push(`│ ${id} │ ${verdict} │`);
  }
  lines.push("└──────┴──────────────────────────────────────────────┘");
  return lines.join("\n");
}

/**
 * Returns whether a given check should be skipped based on the environment.
 *
 * @param checkId - The check identifier (e.g. "D", "A1")
 * @param env     - An environment variable map (pass `process.env` or a mock)
 */
export function shouldSkipCheck(
  checkId: string,
  env: Record<string, string | undefined>
): { skip: boolean; reason?: string } {
  if (checkId === "D" && !env.REDIS_URL) {
    return { skip: true, reason: "REDIS_URL not set" };
  }
  return { skip: false };
}
