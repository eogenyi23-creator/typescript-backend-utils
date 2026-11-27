# Testnet Harness

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
| D1 | `RpcRateLimiter` | Against a real Redis: 60 of 65 requests pass, 5 are blocked (public tier, limit=60) |
| D2 | `RpcRateLimiter` | Bucket reset allows the next request (simulates window expiry) |
| E1 | `HorizonEventHandler` | Valid HMAC-signed request accepted (202) |
| E2 | `HorizonEventHandler` | Wrong signature rejected (401) |
| E3 | `HorizonEventHandler` | Duplicate event ID not processed twice |
| E4 | `HorizonEventHandler` | Timestamp outside the 300 s replay window rejected |
| E5 | `HorizonEventHandler` | Far-future timestamp (> 60 s ahead) rejected |
| E6 | `HorizonEventHandler` | Missing signature header rejected (401) |

**Note on check D:** This tests the SDK's rate-limiter middleware against a real
Redis instance. It does **not** test Stellar's own RPC rate limits.

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
- **npm run build** (the harness imports from `dist/`)

### Optional

- **REDIS_URL** environment variable — if set, check D runs against that Redis
  instance. If not set, check D is skipped.
- **Network access** to `https://soroban-testnet.stellar.org` and
  `https://friendbot.stellar.org`

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

# 4. Run the harness
npm run testnet

# 4a. With Redis
REDIS_URL=redis://localhost:6379 npm run testnet
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
  Contract ID safety check passed ✓

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
| Friendbot returns 400 | Testnet is experiencing issues; retry later |
| `SAFETY STOP: deployed contract ID matches a known foreign contract` | The deployer account was reused across runs; this should not happen with fresh keys |
| A1 FAIL (hash mismatch) | The WASM binary changed between the build and upload steps |
| B1 FAIL (more than 1 fetch) | The cache's LRU or TTL logic is not storing entries correctly |
| C1 FAIL | A valid transaction failed; check the error in the rejected record |
| C2 FAIL (0 rejected) | An invalid function call unexpectedly succeeded — contract schema check not working |
| D1 FAIL (wrong counts) | Redis Lua script atomicity issue; check that two separate connections are not sharing state |

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
