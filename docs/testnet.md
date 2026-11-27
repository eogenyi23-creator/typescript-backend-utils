# Testnet Harness

## Contract ID safety check

The harness deploys a fresh contract on every run so IDs should never match a
foreign project, but you can verify automatically.  Set the
`FORBIDDEN_CONTRACT_IDS` environment variable to a comma-separated list of
contract IDs from your other projects before running:

```sh
FORBIDDEN_CONTRACT_IDS=C...,C... npm run testnet
```

If the freshly-deployed contract ID matches any entry the harness stops with a
`SAFETY STOP` error.  If the variable is not set, the harness prints:

```
  Contract-ID safety check: not configured (set FORBIDDEN_CONTRACT_IDS to enable)
```

No real contract IDs from any other project are stored in this repo.

---

## What it checks

The harness deploys a fresh instance of the `kv-test` contract to the Stellar
testnet on every run, then exercises each SDK module against that live contract.

| Check | Module | What it asserts |
|-------|--------|-----------------|
| A1 | `WasmPipeline` | SHA-256 computed locally matches the hash returned by `stellar contract install` |
| A2 | `WasmPipeline` | `validate()` throws for a non-WASM file (text file renamed `.wasm`) |
| A3 | `WasmPipeline` | `validateWasmPath()` throws for a path outside the sandbox |
| B1 | `ContractCache` | Two reads of the same key produce exactly one network fetch |
| B2 | `ContractCache` | After `cache.delete()`, the new on-chain value is returned on the next read |
| B3 | `ContractCache` | A missing key returns `null` (the contract's documented result for absent keys) |
| C1 | `TransactionBatcher` | Valid increment tasks are fulfilled; fulfilled task hashes (when emitted by the CLI) are re-confirmed as SUCCESS via `getTransaction` |
| C2 | `TransactionBatcher` | An invalid task (calling a non-existent function) fails independently without stopping the valid tasks |
| C3 | `TransactionBatcher` | On-chain counters reflect the values written by the successful tasks |
| D1 | `RpcRateLimiter` | Against a real Redis: `maxTokens` of `maxTokens + 5` requests pass, 5 are blocked with HTTP status 429 (public tier); bucket EXISTS in Redis for the derived key `rl:<endpoint>:public:<ip>` — proves the limiter really used Redis |
| D2 | `RpcRateLimiter` | Real refill: custom small config (maxTokens=5, refillRate=5/s); 5 allowed, 6th blocked (429), after 1.2 s a request is allowed again |
| D3 | `RpcRateLimiter` | Two separately created limiter instances for the same endpoint share one Redis bucket: half the allowance through each, then the next request through either is blocked |
| E1 | `HorizonEventHandler` | Valid HMAC-signed request accepted (202) |
| E2 | `HorizonEventHandler` | Wrong signature rejected (401) |
| E3 | `HorizonEventHandler` | Duplicate event ID not processed twice |
| E4 | `HorizonEventHandler` | Timestamp outside the 300 s replay window rejected |
| E5 | `HorizonEventHandler` | Far-future timestamp (> 60 s ahead) rejected |
| E6 | `HorizonEventHandler` | Missing signature header rejected (401) |

**Note on check D:** This tests the SDK's rate-limiter middleware against a real
Redis instance. It does **not** test Stellar's own RPC rate limits. The check
asserts that the bucket key exists in Redis (`EXISTS` returns 1), which proves
the limiter really executed the Lua script — not the fail-open path. The
fail-open guard wraps `console.error` for the duration of check D and fails
every D sub-check if any log line containing `"failing open"` is emitted. A
limiter that fails open can make a completely broken setup look healthy (every
request is allowed either way), so the guard is essential. Full details:

- **D1** — creates a limiter with the real `public` tier config, sends
  `maxTokens + 5` sequential requests from a unique mock IP, asserts exactly
  `maxTokens` allowed and 5 blocked (each with status 429 and a body), then
  confirms the bucket exists in Redis via `EXISTS` and `SCAN`.
- **D2** — real token refill: creates a limiter with a small custom config
  (maxTokens=5, refillRate=5 tokens/s), sends 5 allowed and 1 blocked (429),
  waits 1.2 s, then asserts the next request is allowed again.
- **D3** — two separately created limiter instances for the same endpoint share
  one Redis bucket: half the allowance through instance A, the other half
  through instance B, then the next request through either is blocked.

**Note on check E:** This runs entirely locally using a mock HTTP request/response
pair. No testnet connection is made for check E.

---

## Prerequisites

### Required

- **stellar CLI ≥ 30.0.0** — install from
  <https://github.com/stellar/stellar-cli/releases>
- **Rust stable toolchain** with the `wasm32v1-none` target:

  ```sh
  rustup target add wasm32v1-none
  ```

- **Node.js 20 or 22**
- **npm ci** (or dependencies already installed)
- **npm run build** (the harness imports the SDK modules from `dist/`; `npm run testnet` builds the harness helpers into `dist-testnet/` automatically)

### Optional

- **REDIS_URL** environment variable — if set, check D runs against that Redis
  instance. If not set, check D is skipped.
- **FORBIDDEN_CONTRACT_IDS** environment variable — comma-separated list of
  contract IDs that belong to other projects of the operator.  If set and the
  freshly-deployed contract ID matches any entry, the harness stops immediately
  with a `SAFETY STOP` error.  If not set, the check is skipped with a notice.
  Example: `FORBIDDEN_CONTRACT_IDS=C...,C... npm run testnet`.
  Never commit real contract IDs from other projects to this repo.
- **Network access** to `https://soroban-testnet.stellar.org` and
  `https://friendbot.stellar.org`

---

## Preflight check

Before running the harness against the network, verify that every CLI flag the
harness uses is supported by the installed `stellar` CLI version:

```sh
npm run testnet:preflight
```

This command is offline: it runs `stellar <subcommand> --help` for each
subcommand and checks that the flags the harness passes appear in the help text.
It exits non-zero and prints a list of unsupported flags if any are missing.
Run this first after updating the stellar CLI.

---

## Key store hygiene

The harness generates throwaway keypairs on every run using
`stellar keys generate`.  The stellar CLI stores these identities on disk under
its configuration directory (usually `~/.config/stellar/identity/`).  All
harness identity names start with `harness-`.

The harness removes every identity it created in a `finally` block after all
checks complete, even if the run fails.  If a run is killed before cleanup:

```sh
# List any leftover harness identities
stellar keys ls | grep harness-

# Remove each one
stellar keys rm --force harness-<name>
```

---

## Commands (in order)

```sh
# 1. Install stellar CLI if missing (Linux x86-64 example)
curl -fsSL https://github.com/stellar/stellar-cli/releases/download/v30.0.1/stellar-cli-30.0.1-x86_64-unknown-linux-gnu.tar.gz \
  -o /tmp/stellar-cli.tar.gz
tar xzf /tmp/stellar-cli.tar.gz -C /tmp
sudo mv /tmp/stellar /usr/local/bin/stellar

# 2. Add the WASM build target
rustup target add wasm32v1-none

# 3. Install npm dependencies and build the TypeScript package
npm ci
npm run build

# 4. Run the preflight check (offline — verifies every CLI flag before touching the network)
npm run testnet:preflight

# 5. Run the harness (builds harness helpers automatically, then runs)
npm run testnet

# 5a. With Redis
REDIS_URL=redis://localhost:6379 npm run testnet

# 5b. With Redis and foreign-contract-ID safety check
REDIS_URL=redis://localhost:6379 FORBIDDEN_CONTRACT_IDS=C...,C... npm run testnet
```

---

## Expected output format

```
══════════════════════════════════════════════════════════════
  soroban-ts-sdk testnet harness
══════════════════════════════════════════════════════════════
  Run at: <ISO timestamp>
  Network: Test SDF Network ; September 2015
  RPC:     https://soroban-testnet.stellar.org

────────────────────────────────────────────────────────────
  Prerequisites
────────────────────────────────────────────────────────────
Node.js: v22.x.x ✓
stellar CLI: stellar 30.0.1 ... ✓
WASM present: .../kv_test.wasm ✓

────────────────────────────────────────────────────────────
  Generating and funding keypairs
────────────────────────────────────────────────────────────
  Funding deployer (GABC1234…) via Friendbot…
  ...
  All keypairs funded ✓

────────────────────────────────────────────────────────────
  Deploying kv-test contract
────────────────────────────────────────────────────────────
  Uploading WASM…
  WASM hash (from upload): <64-char hex hash>
  Deploying contract instance…
  Contract ID: <C...>
  Contract ID safety check: not configured (set FORBIDDEN_CONTRACT_IDS to enable)

────────────────────────────────────────────────────────────
  Check A — WasmPipeline
────────────────────────────────────────────────────────────
  A1 PASS  WasmPipeline SHA-256 matches upload hash (...)
  A2 PASS  non-WASM file rejected by validate()
  A3 PASS  path outside sandbox rejected (...)

...

────────────────────────────────────────────────────────────
  Summary
────────────────────────────────────────────────────────────
┌──────┬──────────────────────────────────────────────┐
│ ID   │ Result                                       │
├──────┼──────────────────────────────────────────────┤
│ A1   │ PASS                                         │
│ ...  │ ...                                          │
│ D    │ SKIPPED (REDIS_URL not set)                  │
└──────┴──────────────────────────────────────────────┘
  N passed   0 failed   1 skipped

  Full output written to: testnet/last-run.txt

  ✓ All executed checks passed.
```

---

## What a failure means

| Failure | Likely cause |
|---------|-------------|
| `stellar CLI not found` | Install the stellar CLI first |
| `Preflight FAILED — unsupported flags` | The installed stellar CLI version does not support a flag the harness uses; update the CLI or the harness |
| Friendbot returns 400 | Testnet is experiencing issues; retry later |
| `SAFETY STOP: deployed contract ID matches an entry in FORBIDDEN_CONTRACT_IDS` | The deployed ID matched one of your known foreign IDs; check network and account |
| A1 FAIL (hash mismatch) | The WASM binary changed between the build and upload steps |
| B1 FAIL (more than 1 fetch) | The cache's LRU or TTL logic is not storing entries correctly |
| C1 FAIL | A valid transaction failed; check the error in the rejected record |
| C2 FAIL (0 rejected) | An invalid function call unexpectedly succeeded — contract schema check not working |
| D1 FAIL (wrong counts) | Limiter not behaving as expected; inspect the `console.error` output (fail-open) or check Redis Lua execution. The fail-open guard reports any `failing open` message as the root cause |
| D1 FAIL (`limiter failed open: ...`) | The rate limiter hit an error and allowed every request through (fail-open). See the reported error — usually a Redis connection or argument mismatch. The harness cannot trust any D result in this state |

---

## Findings

### First real run (2026-11-27, CLI 30.0.1)

The first run against a real Redis instance found a harness mistake that caused
D1 to fail and D2 to show a false PASS. The root cause was three bugs:

1. **Wrong factory signature** — `createRpcRateLimiter` was called with an
   object `{ redis, tier }` instead of positional arguments
   `(endpoint, tier, redis)`. The endpoint resolved to `[object Object]` and
   the `redis` argument was `undefined`, so every call threw before reaching
   Redis and the limiter failed open.
2. **Wrong bucket key** — the harness used `rrl:<endpoint>:public:<ip>` but the
   library produces `rl:<endpoint>:<tier>:<identifier>`.
3. **Mock response lacked `end()`** — `res.status(429).end(...)` threw inside
   the middleware try/catch, which also triggered fail-open.

The result was that every request hit the fail-open path (`console.error` logged
the error and `next()` was called), so all 65 requests were counted as "allowed"
and D2's bucket-reset test passed trivially because nothing was ever blocked.

**A limiter that fails open makes a broken setup look healthy** — every request
is allowed either way, so the harness cannot distinguish correct behaviour from a
crash. The fix adds an explicit fail-open guard: `console.error` is wrapped
around the whole check D block, and if any line containing `"failing open"` is
emitted, the entire check is marked FAIL with the error message. It also adds an
`EXISTS` assertion on the derived bucket key so the harness can prove the Lua
script ran — not just that requests were not blocked.

---

## What the harness does NOT cover

- **Mainnet** — the harness runs exclusively against `Test SDF Network ; September 2015`.
- **Load testing** — a small number of transactions; no throughput or latency characterisation.
- **Real Stellar RPC rate-limit enforcement** — check D tests the SDK middleware against a local Redis, not the testnet RPC's own rate-limiting policy.
- **Horizon streaming** — check E sends mock HTTP requests directly to the handler; it does not start a real Horizon event relay.
- **Long-running behaviour** — the harness is a one-shot run, typically completing in 2–5 minutes.
- **Any security audit** — this codebase has not been audited. See `SECURITY.md`.
- **Multi-instance Redis Cluster** — check D uses a single Redis instance; cluster key-slot behaviour is not tested.

---

## Full output

After each run, the complete console output is saved to `testnet/last-run.txt`
(git-ignored). Paste its contents when reporting results.
