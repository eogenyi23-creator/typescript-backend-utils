# Changelog

All notable changes to `soroban-ts-sdk` are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
This project uses [Semantic Versioning](https://semver.org/).

---

## [Unreleased]

### 2026-11-27 — fix/verify-and-readme (Task 2: Make every README example compile against the real API)

#### Changes
- Created `examples/` with one file per module (`contract-cache.ts`, `rpc-rate-limiter.ts`,
  `transaction-batcher.ts`, `horizon-event-handler.ts`, `wasm-pipeline.ts`).
- Added `tsconfig.examples.json` with a `paths` alias so examples import from
  `soroban-ts-sdk` exactly as a consumer would, resolved to `./src/index.ts` during
  type-checking.
- Added npm scripts: `check:examples` (`tsc --project tsconfig.examples.json`),
  `check:readme-examples` (`node scripts/check-readme-examples.mjs`),
  `test:coverage`, `test:integration`.
- Added `scripts/check-readme-examples.mjs`: reads `<!-- example: <name> -->` markers in
  the README and asserts each following fenced TypeScript block appears verbatim in
  `examples/<name>.ts`. Fails if no markers are found, an example file is missing,
  or the snippet is not found.
- Updated `.github/workflows/ci.yml` to run `check:examples`, `check:readme-examples`,
  and `test:coverage` after the build step.
- Rewrote the five README Quick Start snippets to match the real exported API.

#### Why (errors in the original README)
1. `SorobanRpc.Server` / `SorobanRpc.Durability` — `SorobanRpc` is not exported by
   `@stellar/stellar-sdk` v13.x. The correct namespace is `rpc`.
2. `new Address(userAddress)` — `Address` was used without being imported.
3. `cache.getOrFetch(contractId, 'balance', [new Address(...)], (key) => ...)` — wrong
   call signature. The real signature is `getOrFetch(key: ContractStateKey, fetch: () =>
   Promise<SorobanEntryResult<T>>)`: two arguments, not four.
4. `RpcRateLimiter.create('soroban-rpc', redis, { maxTokens, refillRate, windowSeconds })` —
   the third argument is a tier string (`'public'` | `'authenticated'`), not a config
   object. Config overrides go in the fourth argument.
5. `batcher.submit(txEnvelopes, fn)` — `submit` does not exist. The method is
   `submitWithResults(tasks)` where `tasks` is an array of `() => Promise<T>` functions,
   not raw transaction envelopes.

#### Verification
```
npm run check:examples      → exit 0 (5 files type-checked with tsc --noEmit)
npm run check:readme-examples → all 5 snippet(s) matched. ✓
npm run lint                → exit 0
npm run build               → exit 0
npm test                    → 99 tests, 5 suites, all passing
```

#### Limits
Examples are type-checked only (`--noEmit`). They do not run against a real Stellar
network or Redis instance. `wasm-pipeline.ts` is not executed (no `.wasm` file present).

---

### 2026-11-27 — fix/verify-and-readme (Task 1: Baseline audit)

#### Changes
- No code changes. Recorded exact baseline state before any modifications.

#### Why
Step 0 audit to confirm whether anything fails before touching the repo.

#### Verification
```
Node v24.22.2, npm 11.19.1

npm run lint   → exit 0  (tsc --noEmit, no errors)
npm run build  → exit 0
npm test -- --coverage → 5 suites, 99 tests, 0 failures

Coverage:
  contractCache.ts       86.5% stmts  83.87% branch
  horizonEventHandler.ts 72.04% stmts 67.39% branch
  rpcRateLimiter.ts      78.78% stmts 41.66% branch
  transactionBatcher.ts  66.66% stmts 36.36% branch
  wasmPipeline.ts        74.03% stmts 53.84% branch
  All files              76.5%  stmts 65.47% branch
```

#### Limits
No failures at baseline. All 99 tests pass on Node v24.22.2.

---

### Changed
- Renamed package from `typescript-backend-utils` to `soroban-ts-sdk` to clearly
  reflect the package's Soroban/Stellar focus

---

## [0.1.0] — 2026-01-15

### Added

#### `contractCache` — Ledger-sequence-aware contract state cache
- Two-tier LRU + Redis cache keyed by `contractId` + `storageKey`
- Expiry driven by Soroban's on-chain `liveUntilLedgerSeq` rather than
  wall-clock guesses
- Distinguishes persistent (archived) vs temporary (deleted) entries on expiry
- Returns `ArchivedEntryResult` for persistent entries so callers know to
  submit `RestoreFootprintOperation` before retrying
- `LedgerSequenceTracker`: polls `getLatestLedger` at most once per 4 s,
  coalesces concurrent callers onto one request
- Cache stampede prevention via per-key in-flight deduplication
- Graceful Redis degradation: L1 serves reads when Redis is unavailable

#### `rpcRateLimiter` — Token-bucket rate limiter for Stellar RPC / Horizon
- Atomic token bucket via Redis Lua script (no race conditions)
- Two built-in tiers: `public` (60 req/min), `authenticated` (300 req/min)
- Custom tier config support
- Fails open on Redis outage — requests pass through rather than hard-failing
- Sets `X-RateLimit-*` headers on every response
- `trustProxy` option for `X-Forwarded-For` support behind reverse proxies
- Framework-agnostic middleware interface (Express / Hono / Fastify)

#### `transactionBatcher` — Concurrent Soroban transaction submission
- Configurable `maxConcurrency` and `batchSize`
- Exponential backoff with full jitter (thundering-herd prevention)
- `AbortSignal` support for cancellation
- `submitWithResults()` helper returning typed `{ fulfilled, rejected }` split
- Per-task attempt tracking; completed records flushed to free memory

#### `horizonEventHandler` — Secure Horizon streaming event handler
- Constant-time HMAC-SHA256 signature verification (timing-safe)
- Replay attack prevention via configurable timestamp window (default 300 s)
- In-memory idempotency store (`HorizonIdempotencyStore`) for single-instance use
- Redis-backed idempotency store (`RedisIdempotencyStore`) using atomic `SET NX EX`
- Immediate 202 Accepted + async event queue offload
- Typed Stellar event payload (`payment`, `account_credited`, `contract_event`, etc.)

#### `wasmPipeline` — WASM validation and hash pipeline
- Streaming SHA-256 (matching `stellar contract install` wasm-hash output)
- WebAssembly magic-byte validation (`\0asm` = `0x00 0x61 0x73 0x6d`)
- Directory traversal prevention via sandbox path isolation
- Manifest JSON output: hash, size, chunk info, `completedAt`
- `WasmPipeline.validate()` throws before processing invalid files — prevents
  wasting ledger fees on a guaranteed-to-fail contract upload

### Tests
- Full Jest test suite for all 5 modules
- Mock Redis, mock Soroban RPC responses, tmp-directory WASM fixtures
- LRU eviction, ledger expiry mid-session, stampede prevention,
  Redis degradation, HMAC timing safety, path traversal, abort signal handling

[Unreleased]: https://github.com/eogenyi23-creator/typescript-backend-utils/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/eogenyi23-creator/typescript-backend-utils/releases/tag/v0.1.0
