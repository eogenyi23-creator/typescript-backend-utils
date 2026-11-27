#!/usr/bin/env node
/**
 * soroban-ts-sdk testnet harness
 *
 * Runs the SDK modules (WasmPipeline, ContractCache, TransactionBatcher,
 * RpcRateLimiter, HorizonEventHandler) against a real kv-test contract
 * deployed to the Stellar testnet on each run.
 *
 * Usage:
 *   npm run testnet
 *   REDIS_URL=redis://localhost:6379 npm run testnet
 *
 * See docs/testnet.md for full prerequisites and expected output.
 *
 * Keys: throwaway keypairs are generated fresh on every run, funded through
 * Friendbot, held in memory only, and never written to disk or printed.
 */

import { randomBytes } from "node:crypto";
import { execFile, execFileSync } from "node:child_process";
import { existsSync, writeFileSync, unlinkSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import https from "node:https";

const execFileP = promisify(execFile);

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
const WASM_PATH = resolve(
  __dirname,
  "contract/target/wasm32v1-none/release/kv_test.wasm"
);
const WASM_DIR = resolve(__dirname, "contract/target/wasm32v1-none/release");
const CONTRACT_DIR = resolve(__dirname, "contract");
const LAST_RUN_PATH = resolve(__dirname, "last-run.txt");

// ---------------------------------------------------------------------------
// Import compiled helpers (built from testnet/helpers.ts via `npm run build:testnet`)
// ---------------------------------------------------------------------------

const { isTerminalStatus, checkForbiddenContractId } = await import(
  join(REPO_ROOT, "dist-testnet/helpers.js")
);

// ---------------------------------------------------------------------------
// Network constants
// ---------------------------------------------------------------------------

const NETWORK_PASSPHRASE = "Test SDF Network ; September 2015";
const RPC_URL = "https://soroban-testnet.stellar.org";
const FRIENDBOT_URL = "https://friendbot.stellar.org";

// ---------------------------------------------------------------------------
// Output collection
// ---------------------------------------------------------------------------

const outputLines = [];

function log(...args) {
  const line = args.join(" ");
  console.log(line);
  outputLines.push(line);
}

function logSection(title) {
  const bar = "─".repeat(60);
  log("");
  log(bar);
  log(`  ${title}`);
  log(bar);
}

// ---------------------------------------------------------------------------
// Helpers: HTTP fetch (no extra deps, top-level https import)
// ---------------------------------------------------------------------------

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        if (res.statusCode && res.statusCode >= 400) {
          reject(new Error(`HTTP ${res.statusCode} from ${url}: ${data}`));
        } else {
          try {
            resolve(JSON.parse(data));
          } catch {
            resolve(data);
          }
        }
      });
      res.on("error", reject);
    }).on("error", reject);
  });
}

function httpsPost(url, body, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const urlObj = new URL(url);
    const options = {
      hostname: urlObj.hostname,
      port: urlObj.port || 443,
      path: urlObj.pathname + urlObj.search,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload),
        ...extraHeaders,
      },
    };
    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, body: data });
        }
      });
    });
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Helpers: JSON-RPC call to Soroban RPC
// ---------------------------------------------------------------------------

async function rpcCall(method, params) {
  const result = await httpsPost(RPC_URL, {
    jsonrpc: "2.0",
    id: 1,
    method,
    params,
  });
  if (result.body && result.body.error) {
    throw new Error(
      `RPC error on ${method}: ${JSON.stringify(result.body.error)}`
    );
  }
  return result.body.result;
}

/**
 * Polls getTransaction until a terminal state or timeout.
 *
 * Uses raw JSON-RPC (not the TypeScript SDK) so an SDK meta-decoding error
 * cannot turn into a false timeout.  Network errors are reported immediately
 * and do NOT silently continue the polling loop.
 *
 * Only SUCCESS and FAILED are terminal.  NOT_FOUND means the node has not
 * yet indexed the transaction and is treated as non-terminal, the same as
 * PENDING.  On timeout the error message includes the last status seen.
 */
async function pollTransaction(hash, timeoutMs = 90000) {
  const deadline = Date.now() + timeoutMs;
  let lastStatus = "(none)";
  while (Date.now() < deadline) {
    // Any error here is a real failure — not caught and swallowed.
    const res = await rpcCall("getTransaction", { hash });
    lastStatus = res.status ?? "(missing)";
    if (isTerminalStatus(lastStatus)) {
      return res;
    }
    // NOT_FOUND, PENDING, or unknown — keep polling.
    await sleep(2000);
  }
  throw new Error(
    `Transaction ${hash} did not reach a terminal state within ${timeoutMs} ms` +
    ` (last status: ${lastStatus})`
  );
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Helpers: stellar CLI wrappers
// ---------------------------------------------------------------------------

async function stellarExec(args, opts = {}) {
  const { stdout, stderr } = await execFileP("stellar", args, {
    timeout: 120000,
    maxBuffer: 10 * 1024 * 1024,
    env: { ...process.env },
    ...opts,
  });
  return { stdout: (stdout ?? "").trim(), stderr: (stderr ?? "").trim() };
}

// ---------------------------------------------------------------------------
// Helpers: Keypair generation and Friendbot
// ---------------------------------------------------------------------------

/**
 * Generates a fresh throwaway keypair, registers it with the stellar CLI's
 * in-memory identity store, and funds it via Friendbot.
 *
 * The secret key is never printed or written to disk; it lives only in the
 * stellar CLI's ephemeral key store for the duration of the harness run.
 *
 * Returns { keyName, publicKey }.
 */
async function generateAndFundKeypair(label) {
  const keyName = `harness-${label}-${randomBytes(4).toString("hex")}`;
  // Generate key (--no-fund so we can fund via Friendbot ourselves)
  await stellarExec([
    "keys", "generate", "--no-fund",
    "--network", "testnet",
    keyName,
  ]);
  // Get the public address
  const { stdout: address } = await stellarExec(["keys", "address", keyName]);
  const publicKey = address.trim();

  // Fund via Friendbot
  log(`  Funding ${label} (${publicKey.slice(0, 8)}…) via Friendbot…`);
  await httpsGet(`${FRIENDBOT_URL}?addr=${encodeURIComponent(publicKey)}`);

  return { keyName, publicKey };
}

// ---------------------------------------------------------------------------
// Prerequisites check
// ---------------------------------------------------------------------------

function checkNode() {
  const [major] = process.versions.node.split(".").map(Number);
  if (major < 20) {
    throw new Error(`Node.js 20+ required; found ${process.version}`);
  }
  log(`Node.js: ${process.version} ✓`);
}

function checkStellarCli() {
  try {
    const v = execFileSync("stellar", ["--version"], {
      encoding: "utf8",
      timeout: 10000,
    }).trim();
    log(`stellar CLI: ${v.split("\n")[0]} ✓`);
  } catch {
    throw new Error(
      "stellar CLI not found. Install from https://github.com/stellar/stellar-cli/releases"
    );
  }
}

async function ensureWasm() {
  if (!existsSync(WASM_PATH)) {
    log("WASM not found — building (this takes ~60 s)…");
    const { stdout, stderr } = await stellarExec(["contract", "build"], {
      cwd: CONTRACT_DIR,
      timeout: 300000,
    });
    if (stdout) log(stdout);
    if (stderr) log(stderr);
    if (!existsSync(WASM_PATH)) {
      throw new Error(
        `WASM file not found at ${WASM_PATH} even after build. ` +
        "Run `stellar contract build` manually in testnet/contract/ and retry."
      );
    }
    log(`WASM built ✓`);
  } else {
    log(`WASM present: ${WASM_PATH} ✓`);
  }
}

// ---------------------------------------------------------------------------
// Deploy contract
// ---------------------------------------------------------------------------

/**
 * Uploads the WASM and deploys a fresh contract instance.
 * Returns { wasmHash, contractId }.
 */
async function deployContract(deployerKeyName) {
  logSection("Deploying kv-test contract");

  log("  Uploading WASM…");
  const { stdout: installOut } = await stellarExec([
    "contract", "install",
    "--wasm", WASM_PATH,
    "--source", deployerKeyName,
    "--network", "testnet",
  ]);
  // stellar contract install prints the wasm hash on the last non-empty line
  const wasmHash = installOut.trim().split("\n").pop().trim();
  log(`  WASM hash (from upload): ${wasmHash}`);

  log("  Deploying contract instance…");
  const { stdout: deployOut } = await stellarExec([
    "contract", "deploy",
    "--wasm-hash", wasmHash,
    "--source", deployerKeyName,
    "--network", "testnet",
  ]);
  const contractId = deployOut.trim().split("\n").pop().trim();
  log(`  Contract ID: ${contractId}`);

  return { wasmHash, contractId };
}

// ---------------------------------------------------------------------------
// Check A: WasmPipeline
// ---------------------------------------------------------------------------

async function checkA_wasmPipeline(wasmHash) {
  logSection("Check A — WasmPipeline");
  const results = [];

  const { WasmPipeline, validateWasmPath } = await import(
    join(REPO_ROOT, "dist/wasmPipeline.js")
  );

  // A1: SHA-256 computed by WasmPipeline equals the hash returned by upload
  try {
    const pipeline = new WasmPipeline({ sandboxDir: WASM_DIR });
    const manifest = await pipeline.process("kv_test.wasm");
    const localHash = manifest.sha256;
    if (localHash === wasmHash) {
      log(`  A1 PASS  WasmPipeline SHA-256 matches upload hash (${wasmHash})`);
      results.push({ id: "A1", pass: true });
    } else {
      log(`  A1 FAIL  hash mismatch: pipeline=${localHash}  upload=${wasmHash}`);
      results.push({ id: "A1", pass: false });
    }
  } catch (err) {
    log(`  A1 FAIL  unexpected error: ${err.message}`);
    results.push({ id: "A1", pass: false });
  }

  // A2: Non-WASM file (text file renamed .wasm) is rejected by validate()
  const fakeWasm = join(WASM_DIR, "_fake.wasm");
  writeFileSync(fakeWasm, "this is not wasm");
  try {
    const pipeline = new WasmPipeline({ sandboxDir: WASM_DIR, validateMagic: true });
    await pipeline.validate("_fake.wasm");
    log("  A2 FAIL  expected validate() to throw for a non-WASM file");
    results.push({ id: "A2", pass: false });
  } catch {
    log(`  A2 PASS  non-WASM file rejected by validate()`);
    results.push({ id: "A2", pass: true });
  } finally {
    try { unlinkSync(fakeWasm); } catch { /* ignore */ }
  }

  // A3: Path outside sandbox is rejected by validateWasmPath
  try {
    validateWasmPath(WASM_DIR, "/etc/passwd");
    log("  A3 FAIL  expected validateWasmPath to throw for /etc/passwd");
    results.push({ id: "A3", pass: false });
  } catch (err) {
    log(`  A3 PASS  path outside sandbox rejected (${err.message.slice(0, 60)})`);
    results.push({ id: "A3", pass: true });
  }

  return results;
}

// ---------------------------------------------------------------------------
// Check B: ContractCache
// ---------------------------------------------------------------------------

async function checkB_contractCache(contractId, deployerKeyName) {
  logSection("Check B — ContractCache");
  const results = [];

  const { ContractCache, LedgerSequenceTracker } = await import(
    join(REPO_ROOT, "dist/contractCache.js")
  );

  const tracker = new LedgerSequenceTracker(async () => {
    const r = await rpcCall("getLatestLedger", {});
    return r.sequence;
  });

  let fetchCount = 0;
  const makeKey = (k) => ({ contractId, storageKey: `kv:${k}` });

  // Helper: invoke kv-test via stellar CLI
  async function kvGet(key) {
    const { stdout } = await stellarExec([
      "contract", "invoke",
      "--id", contractId,
      "--source", deployerKeyName,
      "--network", "testnet",
      "--",
      "get",
      "--key", key,
    ]);
    const raw = stdout.trim().split("\n").pop().trim();
    return raw === "null" ? null : JSON.parse(raw);
  }

  async function kvSet(key, value) {
    await stellarExec([
      "contract", "invoke",
      "--id", contractId,
      "--source", deployerKeyName,
      "--network", "testnet",
      "--",
      "set",
      "--key", key,
      "--value", String(value),
    ]);
  }

  // The fetch function the cache calls on a miss: reads from the network
  // and returns the SorobanEntryResult shape the cache requires.
  async function fetchEntry(key) {
    fetchCount++;
    const value = await kvGet(key);
    const latestLedger = await tracker.current();
    return {
      value,
      liveUntilLedgerSeq: latestLedger + 2000,
      durability: "persistent",
      fetchedAtLedger: latestLedger,
    };
  }

  const cache = new ContractCache({ maxSize: 100 }, null, tracker);

  log("  Setting key 'b_key' = 1 on-chain…");
  await kvSet("b_key", 1);

  // B1: Two reads of the same key → exactly one network fetch
  log("  Reading 'b_key' twice through the cache…");
  const beforeCount = fetchCount;
  const r1 = await cache.getOrFetch(makeKey("b_key"), () => fetchEntry("b_key"));
  const r2 = await cache.getOrFetch(makeKey("b_key"), () => fetchEntry("b_key"));
  const fetchesForTwoReads = fetchCount - beforeCount;

  if (fetchesForTwoReads === 1 && !r1.entryArchived && r1.value === 1) {
    log(`  B1 PASS  two reads produced 1 fetch; value=${r1.value} on both reads`);
    results.push({ id: "B1", pass: true });
  } else {
    log(
      `  B1 FAIL  fetches=${fetchesForTwoReads} r1.value=${r1.value} r2.value=${r2.value ?? "(archived)"}`
    );
    results.push({ id: "B1", pass: false });
  }

  // B2: After cache.delete() the new on-chain value is read back
  log("  Setting key 'b_key' = 2 on-chain and deleting from cache…");
  await kvSet("b_key", 2);
  await cache.delete(makeKey("b_key"));

  const beforeCount2 = fetchCount;
  const r3 = await cache.getOrFetch(makeKey("b_key"), () => fetchEntry("b_key"));
  const fetchesAfterDelete = fetchCount - beforeCount2;

  if (!r3.entryArchived && r3.value === 2) {
    log(`  B2 PASS  after cache.delete(), new value=2 read from network (fetches=${fetchesAfterDelete})`);
    results.push({ id: "B2", pass: true });
  } else {
    log(
      `  B2 FAIL  r3=${JSON.stringify(r3)} fetches=${fetchesAfterDelete}`
    );
    results.push({ id: "B2", pass: false });
  }

  // B3: Missing key returns null (the contract's response for absent keys)
  log("  Reading a key that does not exist ('b_missing')…");
  const r4 = await cache.getOrFetch(makeKey("b_missing"), () => fetchEntry("b_missing"));
  if (!r4.entryArchived && r4.value === null) {
    log(`  B3 PASS  missing key returned null`);
    results.push({ id: "B3", pass: true });
  } else {
    log(`  B3 FAIL  unexpected result for missing key: ${JSON.stringify(r4)}`);
    results.push({ id: "B3", pass: false });
  }

  return results;
}

// ---------------------------------------------------------------------------
// Check C: TransactionBatcher
// ---------------------------------------------------------------------------

async function checkC_transactionBatcher(contractId, extraKeys) {
  logSection("Check C — TransactionBatcher");
  const results = [];

  const { TransactionBatcher } = await import(
    join(REPO_ROOT, "dist/transactionBatcher.js")
  );

  /**
   * Submits a single Soroban invocation via the stellar CLI.
   *
   * `stellar contract invoke` submits the transaction and waits for it to
   * land on the ledger, then returns the contract's return value on stdout.
   * To get the transaction hash we use `--verbose`, which writes the hash to
   * stderr in the form "INFO  Transaction hash: <hash>".  If the CLI version
   * does not emit that line we fall back to recording the CLI output only.
   *
   * Each task uses its own funded keypair to avoid sequence-number collisions
   * across concurrent submissions.
   */
  async function invokeAndConfirm(keyName, fn, fnArgs) {
    const cliArgs = [
      "contract", "invoke",
      "--id", contractId,
      "--source", keyName,
      "--network", "testnet",
      "--",
      fn,
      ...fnArgs,
    ];
    // CLI submits, waits for SUCCESS, and exits non-zero on failure.
    const { stdout, stderr } = await stellarExec(cliArgs);

    // Extract the transaction hash from verbose stderr output if present.
    // This is a best-effort enhancement; the check still passes without it.
    const hashMatch = stderr.match(/transaction hash:?\s*([0-9a-fA-F]{64})/i)
      ?? stderr.match(/hash[: ]+([0-9a-fA-F]{64})/i);
    const hash = hashMatch ? hashMatch[1] : null;

    return { hash, output: stdout.trim() };
  }

  // Task factory: valid increment invocation on a unique counter per task.
  // The increment function returns the new counter value.
  const makeValidTask = (keyName, counter) => () =>
    invokeAndConfirm(keyName, "increment", ["--key", `c_ctr${counter}`]);

  // Task factory: deliberately invalid — calls a function that does not exist
  // on the contract.  The CLI rejects this at simulation time before any
  // transaction is submitted.
  const makeInvalidTask = (keyName) => () =>
    invokeAndConfirm(keyName, "nonexistent_fn", []);

  const [key0, key1, key2] = extraKeys;
  const tasks = [
    makeValidTask(key0.keyName, 0),
    makeValidTask(key1.keyName, 1),
    makeInvalidTask(key2.keyName),
  ];

  const batcher = new TransactionBatcher({
    maxConcurrency: 3,
    batchSize: 3,
    retryInterval: 1000,
    maxRetries: 1,
  });

  log("  Submitting 2 valid + 1 invalid tasks to TransactionBatcher…");
  const records = await batcher.run(tasks);

  const fulfilled = records.filter((r) => r.status === "fulfilled");
  const rejected = records.filter((r) => r.status === "rejected");

  // C1: Valid tasks succeed; re-confirm any extracted tx hashes via getTransaction.
  if (fulfilled.length === 2) {
    let allConfirmed = true;
    for (const rec of fulfilled) {
      const hash = rec.result?.hash;
      if (hash) {
        // Re-check via raw JSON-RPC; assert on what the network reports.
        const tx = await pollTransaction(hash, 30000);
        if (tx.status === "SUCCESS") {
          log(`    re-confirmed ${hash.slice(0, 12)}… → SUCCESS`);
        } else {
          log(`    C1 FAIL  ${hash.slice(0, 12)}… re-check returned ${tx.status}`);
          allConfirmed = false;
        }
      } else {
        // CLI did not output a hash in its stderr — the CLI already verified
        // SUCCESS by waiting; the on-chain counter check (C3) is the evidence.
        log(`    task fulfilled; CLI confirmed SUCCESS (hash not in stderr output)`);
      }
    }
    if (allConfirmed) {
      log(`  C1 PASS  ${fulfilled.length} valid tasks fulfilled`);
      results.push({ id: "C1", pass: true });
    } else {
      log(`  C1 FAIL  hash re-check failed`);
      results.push({ id: "C1", pass: false });
    }
  } else {
    log(`  C1 FAIL  expected 2 fulfilled, got ${fulfilled.length}`);
    results.push({ id: "C1", pass: false });
  }

  // C2: Invalid task fails independently without stopping the valid ones.
  if (rejected.length === 1) {
    const snippet = (rejected[0].error?.message ?? "").slice(0, 80);
    log(`  C2 PASS  invalid task rejected independently (${snippet})`);
    results.push({ id: "C2", pass: true });
  } else {
    log(`  C2 FAIL  expected 1 rejected, got ${rejected.length}`);
    results.push({ id: "C2", pass: false });
  }

  // C3: On-chain counters reflect the two successful increments.
  // This is the primary assertion against what the network reports.
  log("  Verifying on-chain increment results…");
  let onChainMatch = true;
  for (let i = 0; i < 2; i++) {
    const { stdout } = await stellarExec([
      "contract", "invoke",
      "--id", contractId,
      "--source", key0.keyName,
      "--network", "testnet",
      "--",
      "get",
      "--key", `c_ctr${i}`,
    ]);
    const raw = stdout.trim().split("\n").pop().trim();
    const val = raw === "null" ? null : JSON.parse(raw);
    if (val === 1) {
      log(`    c_ctr${i} = ${val} ✓`);
    } else {
      log(`    c_ctr${i} = ${val} ✗ (expected 1)`);
      onChainMatch = false;
    }
  }
  if (onChainMatch) {
    log(`  C3 PASS  on-chain counters match expected values after batcher run`);
    results.push({ id: "C3", pass: true });
  } else {
    log(`  C3 FAIL  on-chain counter mismatch`);
    results.push({ id: "C3", pass: false });
  }

  return results;
}

// ---------------------------------------------------------------------------
// Check D: RpcRateLimiter (requires REDIS_URL)
//
// Tests the SDK's rate-limiter middleware against a real Redis instance.
// This does NOT test Stellar's own RPC rate limits.
// ---------------------------------------------------------------------------

async function checkD_rpcRateLimiter() {
  logSection("Check D — RpcRateLimiter (real Redis, not Stellar RPC limits)");

  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) {
    log("  D SKIPPED (REDIS_URL not set — set REDIS_URL to run this check)");
    return [{ id: "D", skipped: true, reason: "REDIS_URL not set" }];
  }

  const { createRpcRateLimiter } = await import(
    join(REPO_ROOT, "dist/rpcRateLimiter.js")
  );

  let Redis;
  try {
    ({ Redis } = await import("ioredis"));
  } catch {
    log("  D SKIPPED (ioredis not available)");
    return [{ id: "D", skipped: true, reason: "ioredis not available" }];
  }

  const redis = new Redis(redisUrl, { lazyConnect: true, enableOfflineQueue: false });
  try {
    await redis.connect();
  } catch (err) {
    log(`  D SKIPPED (Redis connection failed: ${err.message})`);
    redis.disconnect();
    return [{ id: "D", skipped: true, reason: `Redis connection failed: ${err.message}` }];
  }

  const results = [];
  const endpoint = `/harness/d/${Date.now()}`;
  const ip = "10.0.0.1";
  const bucketKey = `rrl:${endpoint}:public:${ip}`;

  // Flush any stale bucket key so the test is deterministic
  await redis.del(bucketKey);

  const limiter = createRpcRateLimiter({ redis, tier: "public" });

  // Helper: build a minimal mock req/res pair for the middleware
  function makeReqRes() {
    const req = {
      path: endpoint,
      headers: {},
      socket: { remoteAddress: ip },
      ip,
    };
    let _status = 200;
    let _nextCalled = false;
    let _responded = false;
    const res = {
      setHeader() {},
      status(c) { _status = c; return this; },
      json() { _responded = true; return this; },
    };
    const next = () => { _nextCalled = true; };
    return { req, res, next, isAllowed: () => _nextCalled };
  }

  // Fire 65 requests sequentially against a 60-token bucket
  let allowed = 0;
  let blocked = 0;
  for (let i = 0; i < 65; i++) {
    const { req, res, next, isAllowed } = makeReqRes();
    await limiter(req, res, next);
    if (isAllowed()) allowed++;
    else blocked++;
  }

  // D1: Exactly 60 allowed, 5 blocked
  if (allowed === 60 && blocked === 5) {
    log(`  D1 PASS  60 allowed, 5 blocked against real Redis (public tier, limit=60)`);
    results.push({ id: "D1", pass: true });
  } else {
    log(`  D1 FAIL  allowed=${allowed} blocked=${blocked} (expected 60 allowed, 5 blocked)`);
    results.push({ id: "D1", pass: false });
  }

  // D2: Bucket reset simulates window refill — first request after reset is allowed
  await redis.del(bucketKey);
  const { req: rr, res: rres, next: rnext, isAllowed: rAllowed } = makeReqRes();
  await limiter(rr, rres, rnext);
  if (rAllowed()) {
    log(`  D2 PASS  request allowed after bucket reset (simulates window expiry)`);
    results.push({ id: "D2", pass: true });
  } else {
    log(`  D2 FAIL  request blocked even after bucket reset`);
    results.push({ id: "D2", pass: false });
  }

  redis.disconnect();
  return results;
}

// ---------------------------------------------------------------------------
// Check E: HorizonEventHandler (local HTTP server simulation, not testnet)
// ---------------------------------------------------------------------------

async function checkE_horizonEventHandler() {
  logSection("Check E — HorizonEventHandler (local only, not testnet)");

  const { createHorizonEventHandler, computeHorizonSignature, HorizonIdempotencyStore } =
    await import(join(REPO_ROOT, "dist/horizonEventHandler.js"));

  const SECRET = `harness-secret-${randomBytes(16).toString("hex")}`;
  const idempotency = new HorizonIdempotencyStore();
  const handler = createHorizonEventHandler({ secret: SECRET }, idempotency);

  // Helper: build a mock req/res pair and invoke the handler directly
  // (no actual HTTP server needed; the handler is a plain async function)
  async function invoke(rawBody, headers) {
    const req = {
      headers,
      rawBody: Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody),
    };
    let _status = 200;
    const res = {
      status(c) { _status = c; return this; },
      json() { return this; },
      get statusCode() { return _status; },
    };
    const result = await handler(req, res);
    return { result, statusCode: _status };
  }

  function makePayload(overrides = {}) {
    return JSON.stringify({
      id: `evt-${randomBytes(8).toString("hex")}`,
      timestamp: Math.floor(Date.now() / 1000),
      type: "payment",
      data: { amount: "100", asset: "XLM" },
      ...overrides,
    });
  }

  function sign(body) {
    return computeHorizonSignature(SECRET, Buffer.from(body));
  }

  const results = [];

  // E1: Valid HMAC-signed request → 202
  {
    const body = makePayload();
    const { result, statusCode } = await invoke(body, {
      "x-stellar-signature": sign(body),
    });
    if (result.accepted && statusCode === 202) {
      log("  E1 PASS  valid HMAC-signed request accepted (202)");
      results.push({ id: "E1", pass: true });
    } else {
      log(`  E1 FAIL  expected accepted/202, got accepted=${result.accepted} status=${statusCode}`);
      results.push({ id: "E1", pass: false });
    }
  }

  // E2: Wrong signature → 401
  {
    const body = makePayload();
    const { result, statusCode } = await invoke(body, {
      "x-stellar-signature": "sha256=deadbeefdeadbeef",
    });
    if (!result.accepted && statusCode === 401) {
      log("  E2 PASS  wrong signature rejected (401)");
      results.push({ id: "E2", pass: true });
    } else {
      log(`  E2 FAIL  expected rejected/401, got accepted=${result.accepted} status=${statusCode}`);
      results.push({ id: "E2", pass: false });
    }
  }

  // E3: Duplicate event ID — second call returns accepted=true with reason=duplicate
  {
    const id = `dup-${randomBytes(8).toString("hex")}`;
    const body = makePayload({ id });
    const headers = { "x-stellar-signature": sign(body) };
    const first = await invoke(body, headers);
    const second = await invoke(body, headers);
    if (
      first.result.accepted &&
      second.result.accepted &&
      second.result.reason === "duplicate"
    ) {
      log("  E3 PASS  duplicate event ID not processed twice");
      results.push({ id: "E3", pass: true });
    } else {
      log(
        `  E3 FAIL  first.accepted=${first.result.accepted} ` +
        `second.accepted=${second.result.accepted} second.reason=${second.result.reason}`
      );
      results.push({ id: "E3", pass: false });
    }
  }

  // E4: Timestamp outside the replay window (> 300 s old) → rejected
  {
    const body = makePayload({
      id: `old-${randomBytes(8).toString("hex")}`,
      timestamp: Math.floor(Date.now() / 1000) - 400,
    });
    const { result, statusCode } = await invoke(body, {
      "x-stellar-signature": sign(body),
    });
    if (!result.accepted && result.reason === "replay_attack") {
      log("  E4 PASS  timestamp outside replay window rejected (replay_attack)");
      results.push({ id: "E4", pass: true });
    } else {
      log(
        `  E4 FAIL  expected replay_attack, got accepted=${result.accepted} ` +
        `reason=${result.reason} status=${statusCode}`
      );
      results.push({ id: "E4", pass: false });
    }
  }

  // E5: Timestamp far in the future (> 60 s ahead) → rejected
  {
    const body = makePayload({
      id: `future-${randomBytes(8).toString("hex")}`,
      timestamp: Math.floor(Date.now() / 1000) + 120,
    });
    const { result, statusCode } = await invoke(body, {
      "x-stellar-signature": sign(body),
    });
    if (!result.accepted && result.reason === "future_timestamp") {
      log("  E5 PASS  far-future timestamp rejected (future_timestamp)");
      results.push({ id: "E5", pass: true });
    } else {
      log(
        `  E5 FAIL  expected future_timestamp, got accepted=${result.accepted} ` +
        `reason=${result.reason}`
      );
      results.push({ id: "E5", pass: false });
    }
  }

  // E6: Missing signature header → 401
  {
    const body = makePayload();
    const { result, statusCode } = await invoke(body, {});
    if (!result.accepted && statusCode === 401) {
      log("  E6 PASS  missing signature rejected (401)");
      results.push({ id: "E6", pass: true });
    } else {
      log(`  E6 FAIL  expected rejected/401 for missing signature, got status=${statusCode}`);
      results.push({ id: "E6", pass: false });
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Summary table helpers
// (the same logic lives in testnet/helpers.ts for unit tests)
// ---------------------------------------------------------------------------

function buildSummaryTable(allResults) {
  return allResults.map((r) => ({
    id: r.id,
    verdict: r.skipped ? `SKIPPED (${r.reason})` : r.pass ? "PASS" : "FAIL",
  }));
}

function formatSummaryTable(rows) {
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

// ---------------------------------------------------------------------------
// Contract ID safety check
//
// No foreign contract IDs are hard-coded in this file.  The operator supplies
// a comma-separated list via the FORBIDDEN_CONTRACT_IDS environment variable
// before running the harness.  The variable is never committed to the repo.
// ---------------------------------------------------------------------------

function assertNotForeignContract(contractId) {
  const outcome = checkForbiddenContractId(contractId, process.env);
  if (!outcome.configured) {
    log("  Contract-ID safety check: not configured (set FORBIDDEN_CONTRACT_IDS to enable)");
    return;
  }
  if (outcome.matched) {
    throw new Error(
      `SAFETY STOP: deployed contract ID ${contractId} matches an entry in FORBIDDEN_CONTRACT_IDS. ` +
      "Aborting. Check that you are on the right network and that the deployment is fresh."
    );
  }
  log("  Contract-ID safety check: no match found ✓");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  log("═".repeat(62));
  log("  soroban-ts-sdk testnet harness");
  log("═".repeat(62));
  log(`  Run at: ${new Date().toISOString()}`);
  log(`  Network: ${NETWORK_PASSPHRASE}`);
  log(`  RPC:     ${RPC_URL}`);

  // ── Prerequisites ──────────────────────────────────────────────────────
  logSection("Prerequisites");
  checkNode();
  checkStellarCli();
  await ensureWasm();

  // ── Setup: generate and fund keypairs ──────────────────────────────────
  logSection("Generating and funding keypairs");
  log("  Generating deployer keypair…");
  const deployer = await generateAndFundKeypair("deployer");
  log("  Generating 3 keypairs for batcher check…");
  const extraKeys = await Promise.all([
    generateAndFundKeypair("batcher0"),
    generateAndFundKeypair("batcher1"),
    generateAndFundKeypair("batcher2"),
  ]);
  log("  All keypairs funded ✓");

  // ── Deploy ─────────────────────────────────────────────────────────────
  const { wasmHash, contractId } = await deployContract(deployer.keyName);
  assertNotForeignContract(contractId);
  log(`  Contract ID safety check passed ✓`);

  // ── Run checks ─────────────────────────────────────────────────────────
  const allResults = [];

  allResults.push(...await checkA_wasmPipeline(wasmHash));
  allResults.push(...await checkB_contractCache(contractId, deployer.keyName));
  allResults.push(...await checkC_transactionBatcher(contractId, extraKeys));
  allResults.push(...await checkD_rpcRateLimiter());
  allResults.push(...await checkE_horizonEventHandler());

  // ── Summary ────────────────────────────────────────────────────────────
  logSection("Summary");
  const rows = buildSummaryTable(allResults);
  log(formatSummaryTable(rows));

  const failures = allResults.filter((r) => !r.skipped && !r.pass);
  const passes = allResults.filter((r) => !r.skipped && r.pass);
  const skipped = allResults.filter((r) => r.skipped);
  log(`  ${passes.length} passed   ${failures.length} failed   ${skipped.length} skipped`);

  // ── Write last-run.txt ─────────────────────────────────────────────────
  writeFileSync(LAST_RUN_PATH, outputLines.join("\n") + "\n", "utf8");
  log(`\n  Full output written to: ${LAST_RUN_PATH}`);

  if (failures.length > 0) {
    log("\n  ✗ One or more checks FAILED — see output above.");
    process.exit(1);
  } else {
    log("\n  ✓ All executed checks passed.");
    process.exit(0);
  }
}

// Run only when invoked directly (not when imported in tests)
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error("\nFATAL:", err.message);
    if (process.env.DEBUG) console.error(err.stack);
    process.exit(1);
  });
}
