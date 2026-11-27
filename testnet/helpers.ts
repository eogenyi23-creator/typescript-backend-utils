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

/**
 * Returns true only for statuses that mean the transaction has reached a
 * permanent terminal state on the Stellar network.
 *
 * `NOT_FOUND` is intentionally excluded: immediately after submission the RPC
 * often returns NOT_FOUND simply because the node has not yet indexed the
 * transaction.  Treating it as terminal would cause false timeouts.
 * `PENDING` is also non-terminal.  Any unrecognised status is treated as
 * non-terminal so that new intermediate states do not silently stop polling.
 *
 * @param status - The `status` string from a `getTransaction` RPC response
 */
export function isTerminalStatus(status: string | undefined): boolean {
  return status === "SUCCESS" || status === "FAILED";
}

/**
 * Checks whether the deployed contract ID matches any entry in the
 * `FORBIDDEN_CONTRACT_IDS` environment variable (comma-separated list
 * supplied by the operator; never committed to the repo).
 *
 * Returns an object describing the outcome so callers can log and act:
 *   - `{ configured: false }` — variable not set; nothing to check
 *   - `{ configured: true, matched: false }` — no match; safe to continue
 *   - `{ configured: true, matched: true, id: contractId }` — match; caller must abort
 */
export function checkForbiddenContractId(
  contractId: string,
  env: Record<string, string | undefined>
): { configured: false } | { configured: true; matched: false } | { configured: true; matched: true; id: string } {
  const raw = env.FORBIDDEN_CONTRACT_IDS;
  if (!raw || raw.trim() === "") {
    return { configured: false };
  }
  const forbidden = raw.split(",").map((s) => s.trim()).filter(Boolean);
  for (const id of forbidden) {
    if (contractId === id) {
      return { configured: true, matched: true, id: contractId };
    }
  }
  return { configured: true, matched: false };
}
