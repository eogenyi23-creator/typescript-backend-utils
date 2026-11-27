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

// ---------------------------------------------------------------------------
// CLI argument builders
//
// Each function returns the exact argv array that stellarExec receives.
// Having them here makes the preflight checker and unit tests easy to write.
// ---------------------------------------------------------------------------

/**
 * Arguments for `stellar keys generate <name>`.
 *
 * In stellar 30.0.1 the flag to auto-fund is `--fund` (opt-in).  There is no
 * `--no-fund` flag; keys are NOT funded unless `--fund` is passed.  The harness
 * funds accounts via Friendbot itself, so `--fund` is not used.
 */
export function argsKeysGenerate(keyName: string): string[] {
  return ["keys", "generate", keyName];
}

/**
 * Arguments for `stellar keys public-key <name>`.
 *
 * `keys address` is a documented alias for `keys public-key`; both work in
 * 30.0.1.  We use the canonical subcommand name in the preflight check.
 */
export function argsKeysAddress(keyName: string): string[] {
  return ["keys", "public-key", keyName];
}

/**
 * Arguments for `stellar keys rm --force <name>`.
 *
 * `--force` suppresses the interactive confirmation prompt.
 */
export function argsKeysRm(keyName: string): string[] {
  return ["keys", "rm", "--force", keyName];
}

/**
 * Arguments for `stellar contract build` (run inside the contract directory).
 */
export function argsContractBuild(): string[] {
  return ["contract", "build"];
}

/**
 * Arguments for `stellar contract upload`.
 *
 * `contract install` is deprecated in 30.0.1; `contract upload` is the
 * current name.  `--source` is the documented alias for `--source-account`.
 */
export function argsContractUpload(
  wasmPath: string,
  sourceKey: string,
  network: string
): string[] {
  return [
    "contract", "upload",
    "--wasm", wasmPath,
    "--source", sourceKey,
    "--network", network,
  ];
}

/**
 * Arguments for `stellar contract deploy --wasm-hash`.
 *
 * `--source` is the documented alias for `--source-account`.
 */
export function argsContractDeploy(
  wasmHash: string,
  sourceKey: string,
  network: string
): string[] {
  return [
    "contract", "deploy",
    "--wasm-hash", wasmHash,
    "--source", sourceKey,
    "--network", network,
  ];
}

/**
 * Arguments for `stellar contract invoke`.
 *
 * `--id` is the documented alias for `--contract-id`.
 * `--source` is the documented alias for `--source-account`.
 * Contract function name and arguments follow `--` as positional args.
 */
export function argsContractInvoke(
  contractId: string,
  sourceKey: string,
  network: string,
  fnName: string,
  fnArgs: string[]
): string[] {
  return [
    "contract", "invoke",
    "--id", contractId,
    "--source", sourceKey,
    "--network", network,
    "--",
    fnName,
    ...fnArgs,
  ];
}

// ---------------------------------------------------------------------------
// Transaction-hash extraction
//
// stellar contract invoke (30.0.1) does not expose the transaction hash
// through any documented flag.  The `-v` / `--verbose` flag logs DEBUG events;
// `--very-verbose` additionally logs TRACE events.  Neither flag is
// documented to emit a transaction hash.
//
// Therefore: the harness does NOT attempt to extract a hash from CLI output.
// C1's independent hash re-confirmation is SKIPPED with a clear reason.
// ---------------------------------------------------------------------------

/**
 * Attempts to parse a 64-character hex transaction hash from a string.
 *
 * Returns the first match, or `null` if none is found.
 *
 * This function exists for completeness and unit-testing; in practice the
 * CLI does not emit a transaction hash, so callers should treat `null` as
 * the expected result and skip any hash-based re-confirmation.
 */
export function parseTransactionHash(text: string): string | null {
  // A Stellar transaction hash is exactly 64 hex characters.
  const match = text.match(/\b([0-9a-fA-F]{64})\b/);
  if (!match) return null;
  // Verify exactly 64 hex chars (the regex already guarantees this, but
  // be explicit so the contract is testable).
  return match[1].length === 64 ? match[1] : null;
}

// ---------------------------------------------------------------------------
// Preflight checker
//
// Verifies that every flag the harness uses is present in the installed CLI's
// help output.  Runs fully offline (--help works without network).
// ---------------------------------------------------------------------------

export interface PreflightSpec {
  /** The subcommand string passed to `stellar --help`, e.g. ["keys","generate"] */
  subcommand: string[];
  /** Exact flag strings the harness passes, e.g. ["--source", "--network"] */
  requiredFlags: string[];
}

/**
 * Returns the list of PreflightSpec entries that the harness depends on.
 * Keeping them here (rather than inline in run.mjs) makes them unit-testable.
 */
export function getPreflightSpecs(): PreflightSpec[] {
  return [
    {
      subcommand: ["keys", "generate"],
      requiredFlags: [],   // no special flags used (just <name>)
    },
    {
      subcommand: ["keys", "public-key"],
      requiredFlags: [],   // just <name>
    },
    {
      subcommand: ["keys", "rm"],
      requiredFlags: ["--force"],
    },
    {
      subcommand: ["contract", "build"],
      requiredFlags: [],   // no extra flags in harness call
    },
    {
      subcommand: ["contract", "upload"],
      requiredFlags: ["--wasm", "--source", "--network"],
    },
    {
      subcommand: ["contract", "deploy"],
      requiredFlags: ["--wasm-hash", "--source", "--network"],
    },
    {
      subcommand: ["contract", "invoke"],
      requiredFlags: ["--id", "--source", "--network"],
    },
  ];
}

/**
 * Checks whether every required flag appears in a help text string.
 *
 * Returns an array of flags that are missing.  An empty array means all flags
 * are present and the check passes.
 */
export function checkPreflightFlags(
  helpText: string,
  requiredFlags: string[]
): string[] {
  return requiredFlags.filter((flag) => !helpText.includes(flag));
}
