/**
 * Pure helper functions for the testnet harness.
 *
 * These functions have no network, filesystem, or process dependencies.
 * They are exported so that:
 *   - `testnet/run.mjs` can import and use them
 *   - `tests/harnessHelpers.test.ts` can import and unit-test them
 *     without touching the network
 */

// ---------------------------------------------------------------------------
// Mock request / response builder (used by check D)
// ---------------------------------------------------------------------------

/**
 * A minimal mock HTTP response that records the status code set by
 * `res.status(code)`, the body passed to `res.end(body)`, and all headers.
 * Supports the fluent `res.status(code).end(body)` chaining used by the
 * rate-limiter middleware.
 */
export interface MockResponse {
  statusCode: number;
  endBody: string | undefined;
  headers: Record<string, string | number>;
  status(code: number): MockResponse;
  setHeader(name: string, value: string | number): void;
  end(body?: string): void;
  json(body: unknown): MockResponse;
}

export interface MockRequest {
  headers: Record<string, string | undefined>;
  ip?: string;
  socket?: { remoteAddress?: string };
}

export interface MockReqRes {
  req: MockRequest;
  res: MockResponse;
  next: () => void;
  /** True only if `next()` was called (i.e. the request was allowed through). */
  isAllowed: () => boolean;
}

/**
 * Builds a minimal mock request/response pair for use with the rate-limiter
 * middleware in check D.
 *
 * The response captures:
 * - `statusCode` — set by `res.status(code)`; defaults to 200
 * - `endBody`    — the string passed to `res.end(body)`, or `undefined` if not called
 * - `headers`    — all names/values passed to `res.setHeader()`
 *
 * `isAllowed()` returns `true` if and only if `next()` was called, which is
 * what the rate-limiter does when it allows the request through.
 */
export function makeMockReqRes(ip: string): MockReqRes {
  const req: MockRequest = {
    headers: {},
    ip,
    socket: { remoteAddress: ip },
  };

  let _nextCalled = false;
  const _headers: Record<string, string | number> = {};

  const res: MockResponse = {
    statusCode: 200,
    endBody: undefined,
    headers: _headers,
    status(code: number): MockResponse {
      this.statusCode = code;
      return this;
    },
    setHeader(name: string, value: string | number): void {
      _headers[name] = value;
    },
    end(body?: string): void {
      this.endBody = body;
    },
    json(body: unknown): MockResponse {
      this.endBody = JSON.stringify(body);
      return this;
    },
  };

  const next = (): void => {
    _nextCalled = true;
  };

  return { req, res, next, isAllowed: () => _nextCalled };
}

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

// ---------------------------------------------------------------------------
// Fail-open detector (check D)
//
// The rate limiter fails open on Redis errors: it logs to console.error and
// calls next(), letting the request through.  A harness that only counts
// allowed/blocked requests therefore cannot tell a healthy limiter from a
// broken one — every request is allowed either way.  Check D installs a
// console.error recorder around the limiter and fails the whole check if any
// "failing open" message is emitted.
// ---------------------------------------------------------------------------

/** Marker string the rate limiter includes in every fail-open log line. */
export const FAIL_OPEN_MARKER = "failing open";

/**
 * Result of a fail-open scan.
 *
 * - `failedOpen === false` — no fail-open message was recorded
 * - `failedOpen === true`  — `firstMessage` holds the first recorded
 *   console.error line that contains the fail-open marker
 */
export interface FailOpenScan {
  failedOpen: boolean;
  firstMessage: string | null;
  /** All recorded console.error lines (for diagnostics). */
  messages: string[];
}

/**
 * Scans recorded console.error lines for the fail-open marker.
 *
 * @param messages - every console.error line captured during the check
 */
export function scanForFailOpen(messages: string[]): FailOpenScan {
  const hits = messages.filter((m) => m.includes(FAIL_OPEN_MARKER));
  return {
    failedOpen: hits.length > 0,
    firstMessage: hits.length > 0 ? hits[0] : null,
    messages,
  };
}

/**
 * Creates a recorder that wraps `console.error` (or a provided target function)
 * and collects every call as a single string.  Returns an object with the
 * collected messages and a `restore()` that reinstates the original.
 *
 * `restore()` must be called in a finally block so the real console.error is
 * never left wrapped.
 */
export function wrapConsoleError(): {
  messages: string[];
  restore: () => void;
} {
  const original = console.error;
  const messages: string[] = [];
  console.error = (...args: unknown[]) => {
    messages.push(args.map((a) => String(a)).join(" "));
  };
  return {
    messages,
    restore: () => {
      console.error = original;
    },
  };
}

// ---------------------------------------------------------------------------
// RpcRateLimiter tier config accessor (check D)
//
// The harness must use the real public-tier maxTokens value, not a copy of it.
// Importing TIER_CONFIGS from src would drag the compiled library into the
// helpers' unit-test path, so check D reads the value at run time from the
// built module (see run.mjs).  The pure pieces below — bucket-key derivation
// and tier-config extraction — are unit-testable without Redis.
// ---------------------------------------------------------------------------

/**
 * Derives the Redis bucket key exactly as the library does.
 *
 * Key layout in src/rpcRateLimiter.ts:
 *   `rl:${endpoint}:${tier}:${identifier}`
 *
 * and the identifier is chosen by resolveIdentifier():
 *   trustProxy ? leftmost X-Forwarded-For entry
 *              : req.ip ?? req.socket.remoteAddress ?? "unknown"
 *
 * This function mirrors that logic for a request that is not behind a proxy.
 */
export function deriveBucketKey(
  endpoint: string,
  tier: string,
  identifier: string
): string {
  return `rl:${endpoint}:${tier}:${identifier}`;
}

/**
 * Extracts the resolved maxTokens for a tier from a `TIER_CONFIGS`-shaped
 * object merged with an optional partial override.
 *
 * The library resolves `{ ...TIER_CONFIGS[tier], ...config }`; this mirrors it.
 */
export function resolveMaxTokens(
  tierConfigs: Record<string, { maxTokens: number }>,
  tier: string,
  config?: { maxTokens?: number }
): number {
  const base = tierConfigs[tier]?.maxTokens;
  if (config && typeof config.maxTokens === "number") {
    return config.maxTokens;
  }
  if (typeof base === "number") {
    return base;
  }
  throw new Error(`Unknown tier "${tier}" and no maxTokens override provided`);
}
