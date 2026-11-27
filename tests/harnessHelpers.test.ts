/**
 * Unit tests for the pure helper functions in testnet/helpers.ts.
 *
 * These tests do not require a network connection, a stellar CLI, Redis, or a
 * deployed contract.  They cover the summary-table builder, the skip logic,
 * the output formatter, the terminal-status predicate, the contract-ID
 * safety check, the CLI argument builders, the transaction-hash parser, and
 * the preflight flag checker so that regressions are caught without a live run.
 */

import {
  buildSummaryTable,
  formatSummaryTable,
  shouldSkipCheck,
  isTerminalStatus,
  checkForbiddenContractId,
  argsKeysGenerate,
  argsKeysAddress,
  argsKeysRm,
  argsContractBuild,
  argsContractUpload,
  argsContractDeploy,
  argsContractInvoke,
  parseTransactionHash,
  getPreflightSpecs,
  checkPreflightFlags,
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

// ---------------------------------------------------------------------------
// CLI argument builders
// ---------------------------------------------------------------------------

describe("argsKeysGenerate", () => {
  it("produces [keys, generate, <name>] with no extra flags", () => {
    const args = argsKeysGenerate("harness-test-abcd");
    expect(args).toEqual(["keys", "generate", "harness-test-abcd"]);
    // Confirm --no-fund is absent (it does not exist in stellar 30.0.1)
    expect(args).not.toContain("--no-fund");
    expect(args).not.toContain("--fund");
  });
});

describe("argsKeysAddress", () => {
  it("uses the canonical public-key subcommand (not the address alias)", () => {
    const args = argsKeysAddress("my-key");
    expect(args).toEqual(["keys", "public-key", "my-key"]);
  });
});

describe("argsKeysRm", () => {
  it("includes --force to suppress the interactive prompt", () => {
    const args = argsKeysRm("harness-deployer-1234");
    expect(args).toEqual(["keys", "rm", "--force", "harness-deployer-1234"]);
  });
});

describe("argsContractBuild", () => {
  it("produces [contract, build] with no extra flags", () => {
    expect(argsContractBuild()).toEqual(["contract", "build"]);
  });
});

describe("argsContractUpload", () => {
  it("uses contract upload (not the deprecated contract install)", () => {
    const args = argsContractUpload("/path/to/kv_test.wasm", "my-key", "testnet");
    expect(args[0]).toBe("contract");
    expect(args[1]).toBe("upload");
    // Must not use the deprecated 'install' subcommand
    expect(args).not.toContain("install");
    expect(args).toContain("--wasm");
    expect(args).toContain("--source");
    expect(args).toContain("--network");
    expect(args).toContain("/path/to/kv_test.wasm");
    expect(args).toContain("my-key");
    expect(args).toContain("testnet");
  });
});

describe("argsContractDeploy", () => {
  it("includes --wasm-hash, --source, and --network", () => {
    const args = argsContractDeploy("deadbeef1234", "my-key", "testnet");
    expect(args[0]).toBe("contract");
    expect(args[1]).toBe("deploy");
    expect(args).toContain("--wasm-hash");
    expect(args).toContain("deadbeef1234");
    expect(args).toContain("--source");
    expect(args).toContain("my-key");
    expect(args).toContain("--network");
    expect(args).toContain("testnet");
  });
});

describe("argsContractInvoke", () => {
  it("uses --id alias for --contract-id and --source alias for --source-account", () => {
    const CONTRACT = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    const args = argsContractInvoke(CONTRACT, "my-key", "testnet", "get", ["--key", "foo"]);
    expect(args).toContain("--id");
    expect(args).toContain(CONTRACT);
    expect(args).toContain("--source");
    expect(args).toContain("my-key");
    expect(args).toContain("--network");
    expect(args).toContain("testnet");
    // Function name and args follow --
    const ddIdx = args.indexOf("--");
    expect(ddIdx).toBeGreaterThan(0);
    expect(args[ddIdx + 1]).toBe("get");
    expect(args[ddIdx + 2]).toBe("--key");
    expect(args[ddIdx + 3]).toBe("foo");
  });

  it("passes an empty fnArgs array without extra elements after --", () => {
    const CONTRACT = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    const args = argsContractInvoke(CONTRACT, "my-key", "testnet", "increment", []);
    const ddIdx = args.indexOf("--");
    expect(ddIdx).toBeGreaterThan(0);
    expect(args[ddIdx + 1]).toBe("increment");
    expect(args.length).toBe(ddIdx + 2);
  });
});

// ---------------------------------------------------------------------------
// parseTransactionHash
// ---------------------------------------------------------------------------

// A valid 64-character hex transaction hash
const VALID_HASH = "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2";

describe("parseTransactionHash", () => {
  it("extracts a valid 64-char hex hash from a plain string", () => {
    expect(parseTransactionHash(VALID_HASH)).toBe(VALID_HASH);
  });

  it("extracts a hash embedded in surrounding text", () => {
    const text = `Transaction submitted: ${VALID_HASH} confirmed.`;
    expect(parseTransactionHash(text)).toBe(VALID_HASH);
  });

  it("returns null when the string is empty", () => {
    expect(parseTransactionHash("")).toBeNull();
  });

  it("returns null when no 64-char hex sequence is present", () => {
    expect(parseTransactionHash("Contract invoked successfully")).toBeNull();
  });

  it("returns null for a 63-char hex string (one short)", () => {
    const short = VALID_HASH.slice(0, 63);
    // 63 hex chars surrounded by word-break chars — should not match
    expect(parseTransactionHash(` ${short} `)).toBeNull();
  });

  it("returns null for a 65-char hex string (one long)", () => {
    const long = VALID_HASH + "f";
    // 65-char sequence — the \b word boundary breaks differently;
    // it should not be returned as a valid hash
    expect(parseTransactionHash(long)).toBeNull();
  });

  it("returns the first hash when two are present", () => {
    const hash2 = VALID_HASH.replace(/a/g, "b");
    const text = `first: ${VALID_HASH} second: ${hash2}`;
    expect(parseTransactionHash(text)).toBe(VALID_HASH);
  });

  it("is case-insensitive (returns as-found)", () => {
    const upper = VALID_HASH.toUpperCase();
    expect(parseTransactionHash(upper)).toBe(upper);
  });
});

// ---------------------------------------------------------------------------
// checkPreflightFlags
// ---------------------------------------------------------------------------

const FAKE_HELP = `
Usage: stellar contract invoke [OPTIONS] ...

Options:
      --contract-id <CONTRACT_ID>  [aliases: --id]
  -s, --source-account <SOURCE_ACCOUNT>  [aliases: --source]
  -n, --network <NETWORK>
      --wasm <WASM>
      --wasm-hash <WASM_HASH>
      --force
      --verbose
  -h, --help  Print help
`;

describe("checkPreflightFlags", () => {
  it("returns empty array when all required flags are present", () => {
    const missing = checkPreflightFlags(FAKE_HELP, ["--id", "--source", "--network"]);
    expect(missing).toEqual([]);
  });

  it("returns missing flags when a flag is absent from the help text", () => {
    const missing = checkPreflightFlags(FAKE_HELP, ["--id", "--no-fund"]);
    expect(missing).toContain("--no-fund");
    expect(missing).not.toContain("--id");
  });

  it("returns all missing flags when none are present", () => {
    const missing = checkPreflightFlags("Usage: stellar keys generate\n  -h, --help", [
      "--no-fund",
      "--auto-submit",
    ]);
    expect(missing).toEqual(["--no-fund", "--auto-submit"]);
  });

  it("returns empty array for an empty required list", () => {
    expect(checkPreflightFlags(FAKE_HELP, [])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// getPreflightSpecs
// ---------------------------------------------------------------------------

describe("getPreflightSpecs", () => {
  it("covers all subcommands the harness uses", () => {
    const specs = getPreflightSpecs();
    const subCmds = specs.map((s) => s.subcommand.join(" "));
    expect(subCmds).toContain("keys generate");
    expect(subCmds).toContain("keys public-key");
    expect(subCmds).toContain("keys rm");
    expect(subCmds).toContain("contract build");
    expect(subCmds).toContain("contract upload");
    expect(subCmds).toContain("contract deploy");
    expect(subCmds).toContain("contract invoke");
  });

  it("requires --force for keys rm", () => {
    const specs = getPreflightSpecs();
    const rm = specs.find((s) => s.subcommand.join(" ") === "keys rm");
    expect(rm?.requiredFlags).toContain("--force");
  });

  it("does not require --no-fund for keys generate (flag does not exist in 30.0.1)", () => {
    const specs = getPreflightSpecs();
    const gen = specs.find((s) => s.subcommand.join(" ") === "keys generate");
    expect(gen?.requiredFlags).not.toContain("--no-fund");
  });

  it("requires --wasm for contract upload", () => {
    const specs = getPreflightSpecs();
    const upload = specs.find((s) => s.subcommand.join(" ") === "contract upload");
    expect(upload?.requiredFlags).toContain("--wasm");
  });

  it("requires --wasm-hash for contract deploy", () => {
    const specs = getPreflightSpecs();
    const deploy = specs.find((s) => s.subcommand.join(" ") === "contract deploy");
    expect(deploy?.requiredFlags).toContain("--wasm-hash");
  });
});
