# Changelog

All notable changes to `soroban-ts-sdk` are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
This project uses [Semantic Versioning](https://semver.org/).

---

## [Unreleased]

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
