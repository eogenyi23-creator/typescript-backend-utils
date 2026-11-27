# Testnet Run — 2026-11-27

This is the record of a real, end-to-end run of the testnet harness
(`npm run testnet`) on `main` after the merge of PR #33
(merge commit `697d469`, "Merge pull request #33 from
eogenyi23-creator/fix/harness-check-d"). The run was executed by the repository
owner on 2026-11-27 at 16:06:30 UTC in a GitHub Codespace.

## Environment

| Item | Value |
|------|-------|
| Date and time | 2026-11-27T16:06:30.191Z |
| Environment | GitHub Codespace |
| Node.js | v24.22.2 |
| stellar CLI | 30.0.1 (f2a7b74175c34585f3b30a1abf42a2d41cbcc390) |
| Redis | 7.0.15 on localhost (Ubuntu package) |
| Network | Test SDF Network ; September 2015 |
| RPC | https://soroban-testnet.stellar.org |
| Accounts | throwaway keypairs funded through Friendbot, removed from the CLI key store after the run |
| `@stellar/stellar-sdk` | 13.1.0 (the only version tested) |

## Commands used

```sh
# 1. Offline preflight: verify every stellar CLI flag before touching the network
npm run testnet:preflight

# 2. Full harness, with Redis on localhost for check D
REDIS_URL=redis://localhost:6379 npm run testnet
```

The run was `npm run testnet` with `REDIS_URL` set; the commands above are the
exact sequence used (the harness also builds its helpers via
`npm run build:testnet` automatically).

## Result

**18 checks, 18 passed, 0 failed, 0 skipped.**

- Deployed contract (this repo's `testnet/contract/kv-test` fixture):
  `CBKCMVFQZE7X6QA4VKAWE3IKBYUJBEBTTSGZY7BWQG3WFW52JC5UMZLQ`
  ([contract explorer](https://stellar.expert/explorer/testnet/contract/CBKCMVFQZE7X6QA4VKAWE3IKBYUJBEBTTSGZY7BWQG3WFW52JC5UMZLQ))
- WASM hash (from the real upload):
  `cf46518c3c6cc678788e52340431638a21d56c1c42822dc2643f1af0e4f10391`
- Re-confirmed transactions (status SUCCESS via `getTransaction`):
  - [`17c8939d8f1d29755692d225ac2fe3f97386260105625fe67864b22386831f29`](https://stellar.expert/explorer/testnet/tx/17c8939d8f1d29755692d225ac2fe3f97386260105625fe67864b22386831f29)
  - [`8a6b1743625d622cb681628eafe1239c4ad7b0f4515b3dbe6d656dba8f0fb95f`](https://stellar.expert/explorer/testnet/tx/8a6b1743625d622cb681628eafe1239c4ad7b0f4515b3dbe6d656dba8f0fb95f)

Both transaction hashes were re-checked against
`https://soroban-testnet.stellar.org` with the RPC `getTransaction` method on
2026-11-27, after the recorded run: both returned `"status": "SUCCESS"`.

## Check table

"Where it ran" is stated per check: A, B and C ran against the Stellar testnet
through the deployed `kv-test` contract; D ran against a real local Redis
(NOT against Stellar's own RPC rate limits); E ran entirely locally over HTTP
(no testnet connection, no relay service).

| ID | Module | What it asserts | Result | Evidence | Where it ran |
|----|--------|-----------------|--------|----------|---------------|
| A1 | WasmPipeline | The SHA-256 computed locally equals the hash returned by the real WASM upload | PASS | local hash matched upload hash `cf46518c3c6cc678788e52340431638a21d56c1c42822dc2643f1af0e4f10391` | testnet (upload) |
| A2 | WasmPipeline | A non-WASM file is rejected by `validate()` | PASS | `validate()` threw for the non-WASM file | local file check |
| A3 | WasmPipeline | A path outside the sandbox is rejected | PASS | `Path traversal detected: "/etc/passwd" resolves outside sand` | local file check |
| B1 | ContractCache | Two reads of the same key produce exactly one network fetch | PASS | one fetch; value=1 on both reads | testnet |
| B2 | ContractCache | After `cache.delete()`, the new on-chain value is read from the network | PASS | new value=2 read from network (fetches=1) | testnet |
| B3 | ContractCache | A missing key returns null | PASS | `b_missing` returned null | testnet |
| C1 | TransactionBatcher | 2 valid tasks fulfilled; transaction hashes re-confirmed as SUCCESS | PASS | `17c8939d…31f29` and `8a6b1743…b95f` re-confirmed SUCCESS via `getTransaction` | testnet |
| C2 | TransactionBatcher | An invalid task is rejected independently | PASS | invalid task rejected on its own (`Command failed: stellar contract invoke …`), valid tasks unaffected | testnet |
| C3 | TransactionBatcher | On-chain counters match expected values after the batcher run | PASS | `c_ctr0 = 1`, `c_ctr1 = 1` | testnet |
| D1 | RpcRateLimiter | 60 allowed, 5 blocked (public tier, real `maxTokens=60`); all 5 blocks returned status 429 with a body; bucket `EXISTS=1`; `SCAN` found the derived key | PASS | bucket key `rl:harness-d-1795795620650-871816e8:public:10.1.23228.152` | local Redis |
| D2 | RpcRateLimiter | Real refill: 5 allowed, 6th blocked (429), request allowed again 1.2 s later (refillRate 5 tokens/s) | PASS | refill observed after 1.2 s | local Redis |
| D3 | RpcRateLimiter | Two instances share one bucket: 30 via instance A + 30 via instance B (`maxTokens=60`); next request blocked (429); bucket `EXISTS=1` | PASS | shared bucket verified | local Redis |
| E1 | HorizonEventHandler | Valid HMAC-signed request accepted (202) | PASS | 202 returned | local HTTP |
| E2 | HorizonEventHandler | Wrong signature rejected (401) | PASS | 401 returned | local HTTP |
| E3 | HorizonEventHandler | Duplicate event ID not processed twice | PASS | second delivery not processed | local HTTP |
| E4 | HorizonEventHandler | Timestamp outside replay window rejected | PASS | rejected with `replay_attack` | local HTTP |
| E5 | HorizonEventHandler | Far-future timestamp rejected | PASS | rejected with `future_timestamp` | local HTTP |
| E6 | HorizonEventHandler | Missing signature rejected (401) | PASS | 401 returned | local HTTP |

Small honest note: the mock client IP used in check D is a synthetic string —
it appears as `10.1.23228.152` in the bucket key and is not a real address.

## Full terminal output

```
══════════════════════════════════════════════════════════════
  soroban-ts-sdk testnet harness
══════════════════════════════════════════════════════════════
  Run at: 2026-11-27T16:06:30.191Z
  Network: Test SDF Network ; September 2015
  RPC:     https://soroban-testnet.stellar.org

────────────────────────────────────────────────────────────
  Prerequisites
────────────────────────────────────────────────────────────
Node.js: v24.22.2 ✓
stellar CLI: stellar 30.0.1 (f2a7b74175c34585f3b30a1abf42a2d41cbcc390) ✓
WASM present: /workspaces/typescript-backend-utils/testnet/contract/target/wasm32v1-none/release/kv_test.wasm ✓

────────────────────────────────────────────────────────────
  Generating and funding keypairs
────────────────────────────────────────────────────────────
  Generating deployer keypair…
  Funding deployer (GDL5NIKA…) via Friendbot…
  Generating 3 keypairs for batcher check…
  Funding batcher0 (GCQ3XI2Z…) via Friendbot…
  Funding batcher1 (GBIFR6DY…) via Friendbot…
  Funding batcher2 (GDO3Y32L…) via Friendbot…
  All keypairs funded ✓

────────────────────────────────────────────────────────────
  Deploying kv-test contract
────────────────────────────────────────────────────────────
  Uploading WASM…
  WASM hash (from upload): cf46518c3c6cc678788e52340431638a21d56c1c42822dc2643f1af0e4f10391
  Deploying contract instance…
  Contract ID: CBKCMVFQZE7X6QA4VKAWE3IKBYUJBEBTTSGZY7BWQG3WFW52JC5UMZLQ
  Explorer: https://stellar.expert/explorer/testnet/contract/CBKCMVFQZE7X6QA4VKAWE3IKBYUJBEBTTSGZY7BWQG3WFW52JC5UMZLQ
  Contract-ID safety check: no match found ✓
  Contract ID safety check passed ✓
  A1 PASS  WasmPipeline SHA-256 matches upload hash (cf46518c3c6cc678788e52340431638a21d56c1c42822dc2643f1af0e4f10391)
  A2 PASS  non-WASM file rejected by validate()
  A3 PASS  path outside sandbox rejected (Path traversal detected: "/etc/passwd" resolves outside sand)

────────────────────────────────────────────────────────────
  Check B — ContractCache
────────────────────────────────────────────────────────────
  Setting key 'b_key' = 1 on-chain…
  Reading 'b_key' twice through the cache…
  B1 PASS  two reads produced 1 fetch; value=1 on both reads
  Setting key 'b_key' = 2 on-chain and deleting from cache…
  B2 PASS  after cache.delete(), new value=2 read from network (fetches=1)
  Reading a key that does not exist ('b_missing')…
  B3 PASS  missing key returned null

────────────────────────────────────────────────────────────
  Check C — TransactionBatcher
────────────────────────────────────────────────────────────
  Submitting 2 valid + 1 invalid tasks to TransactionBatcher…
    re-confirmed 17c8939d8f1d29755692d225ac2fe3f97386260105625fe67864b22386831f29 → SUCCESS
    https://stellar.expert/explorer/testnet/tx/17c8939d8f1d29755692d225ac2fe3f97386260105625fe67864b22386831f29
    re-confirmed 8a6b1743625d622cb681628eafe1239c4ad7b0f4515b3dbe6d656dba8f0fb95f → SUCCESS
    https://stellar.expert/explorer/testnet/tx/8a6b1743625d622cb681628eafe1239c4ad7b0f4515b3dbe6d656dba8f0fb95f
  C1 PASS  2 valid tasks fulfilled; hashes re-confirmed
  C2 PASS  invalid task rejected independently (Command failed: stellar contract invoke --id CBKCMVFQZE7X6QA4VKAWE3IKBYUJBEBTTSG)
  Verifying on-chain increment results…
    c_ctr0 = 1 ✓
    c_ctr1 = 1 ✓
  C3 PASS  on-chain counters match expected values after batcher run

────────────────────────────────────────────────────────────
  Check D — RpcRateLimiter (real Redis, not Stellar RPC limits)
────────────────────────────────────────────────────────────
  D1 PASS  allowed=60 blocked=5 (public tier, real maxTokens=60); all 5 blocks returned status 429 with a body; bucket EXISTS=1 for rl:harness-d-1795795620650-871816e8:public:10.1.23228.152; SCAN found the derived key
  D2 PASS  real refill: 5 allowed, 6th blocked (429), request allowed again 1.2 s later (refillRate 5 tokens/s)
  D3 PASS  two instances share one bucket: 30 via instance A + 30 via instance B (maxTokens=60); next request blocked (429); bucket EXISTS=1

────────────────────────────────────────────────────────────
  Check E — HorizonEventHandler (local only, not testnet)
────────────────────────────────────────────────────────────
  E1 PASS  valid HMAC-signed request accepted (202)
  E2 PASS  wrong signature rejected (401)
  E3 PASS  duplicate event ID not processed twice
  E4 PASS  timestamp outside replay window rejected (replay_attack)
  E5 PASS  far-future timestamp rejected (future_timestamp)
  E6 PASS  missing signature rejected (401)

────────────────────────────────────────────────────────────
  Summary
────────────────────────────────────────────────────────────

┌──────┬──────────────────────────────────────────────┐
│ ID   │ Result                                       │
├──────┼──────────────────────────────────────────────┤
│ A1   │ PASS                                         │
│ A2   │ PASS                                         │
│ A3   │ PASS                                         │
│ B1   │ PASS                                         │
│ B2   │ PASS                                         │
│ B3   │ PASS                                         │
│ C1   │ PASS                                         │
│ C2   │ PASS                                         │
│ C3   │ PASS                                         │
│ D1   │ PASS                                         │
│ D2   │ PASS                                         │
│ D3   │ PASS                                         │
│ E1   │ PASS                                         │
│ E2   │ PASS                                         │
│ E3   │ PASS                                         │
│ E4   │ PASS                                         │
│ E5   │ PASS                                         │
│ E6   │ PASS                                         │
└──────┴──────────────────────────────────────────────┘
  18 passed   0 failed   0 skipped
  Deployed contract: CBKCMVFQZE7X6QA4VKAWE3IKBYUJBEBTTSGZY7BWQG3WFW52JC5UMZLQ
  Contract explorer: https://stellar.expert/explorer/testnet/contract/CBKCMVFQZE7X6QA4VKAWE3IKBYUJBEBTTSGZY7BWQG3WFW52JC5UMZLQ
  WASM hash: cf46518c3c6cc678788e52340431638a21d56c1c42822dc2643f1af0e4f10391

  Full output written to: /workspaces/typescript-backend-utils/testnet/last-run.txt

  ✓ All executed checks passed.

────────────────────────────────────────────────────────────
  Cleaning up harness keypairs
────────────────────────────────────────────────────────────
  Removed identity: harness-deployer-f24d00b5 ✓
  Removed identity: harness-batcher0-fdb2b9d2 ✓
  Removed identity: harness-batcher1-aa23e8d1 ✓
  Removed identity: harness-batcher2-877fd85a ✓
```

## Earlier runs that found real problems

All of the issues below were found, fixed and merged **before** the recorded
run above; the recorded run passed with every fix in place.

1. **First attempt — stopped at the very start.** The harness passed
   `stellar keys generate --no-fund`, a flag that does not exist in CLI 30.0.1.
   Nothing reached the network. Fix: an audit of every CLI call against the
   real `--help` output, `contract upload` instead of the deprecated
   `install`, and an offline `npm run testnet:preflight`.
2. **Run at 12:29 UTC the same day — 16 of 17 checks passed**
   (contract `CAMFS53OQWTJREP5FTJHI2C7QFP24CU57R3MGTIYTLVMVNIIIC66D3VH`), D1
   failed: the harness called the rate limiter with the wrong arguments, so the
   limiter had no Redis client and failed open, allowing 65 of 65 requests; the
   old D2 passed falsely for the same reason. Fix: the correct call, the
   library's real bucket key, a response mock that can observe blocks, a real
   refill test, a shared-bucket test, and a guard that fails the check if the
   limiter ever fails open.
3. **Found in review before any run:** the build output path was changed by
   mistake (the package entry point went missing after a build) and is now
   guarded in CI; polling treated `NOT_FOUND` as final and was corrected; a
   Redis integration test was flaky and leaked connections and was rewritten.

## What this proves / does not prove

This run is live evidence for the SDK modules against real infrastructure:
the WASM hash matched a real upload, the cache really read from a deployed
testnet contract, the batcher's transactions really landed on the testnet and
were re-confirmed as SUCCESS, and the rate limiter really enforced its bucket
against a real Redis. It does **not** prove any of the following, which
remain untested:

- **Mainnet** — the run was exclusively on `Test SDF Network ; September 2015`.
- **Load or long-running behaviour** — a one-shot run with a handful of
  transactions; no throughput, latency or soak testing.
- **Stellar's real RPC rate-limit enforcement** — check D tested the SDK
  middleware against a local Redis, not the testnet RPC's own limits.
- **Horizon streaming (SSE) and any real relay service** — check E used local
  HTTP requests only.
- **Contract TTL expiry** — not exercised.
- **Redis Cluster** — a single local Redis 7.0.15 instance only.
- **`@stellar/stellar-sdk` versions other than the tested 13.1.0**.
- **Transaction building** — transactions in the batcher check were sent
  through the `stellar` CLI. The batcher's concurrency, retry and
  failure-isolation logic ran, but transaction building is the CLI's.
- **Contract realism** — the test contract is a minimal fixture
  (`kv-test`), not a production contract.
- **Security audit** — none has been performed. See `SECURITY.md`.

See `docs/testnet.md` for how to run the harness yourself.
