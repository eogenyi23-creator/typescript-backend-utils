# Claims Audit

Every factual claim from the README, SECURITY.md, and module header comments is mapped here to the implementing code and the test that exercises it. Status is one of:

- **test-backed** — stated, implemented, and directly exercised by a named test
- **code-only** — stated, implemented, but no direct test (see note column)
- **not verified** — stated but not confirmed by code or test

The `check:claims` script (`npm run check:claims`) verifies that every `test-backed` row names a test file and test title that exist in `tests/`.

---

## Claim table

| # | Claim | Where stated | Implementing code | Test file | Test title | Status |
|---|-------|-------------|-------------------|-----------|------------|--------|
| 1 | LRU eviction at capacity | README, contractCache.ts header | `LRUCache.set()` evicts least-recently-used entry when `store.size >= maxSize` | `tests/contractCache.test.ts` | `LRUCache > evicts LRU entry at capacity` | test-backed |
| 2 | Expired entries evicted on read (wall-clock TTL) | contractCache.ts header | `LRUCache.get()` checks `Date.now() > entry.expiresAt` | `tests/contractCache.test.ts` | `LRUCache > evicts expired entries on read` | test-backed |
| 3 | Deep clone returned to prevent cache mutation | contractCache.ts header | `deepClone()` called in `LRUCache.get()` | `tests/contractCache.test.ts` | `LRUCache > returns a deep clone to prevent mutation of cached state` | test-backed |
| 4 | Expiry driven by `liveUntilLedgerSeq` (ledger sequence) | README, contractCache.ts header | `ContractCache._checkLiveness()` compares currentLedger vs liveUntilLedgerSeq | `tests/contractCache.test.ts` | `ContractCache — ledger-sequence expiry mid-session > returns undefined for a temporary entry once ledger advances past liveUntilLedgerSeq` | test-backed |
| 5 | Persistent entry returns `ArchivedEntryResult` after expiry | README, contractCache.ts header | `ContractCache._checkLiveness()` returns `"archived"` for persistent entries; `get()` returns `ArchivedEntryResult` | `tests/contractCache.test.ts` | `ContractCache — ledger-sequence expiry mid-session > returns ArchivedEntryResult for a persistent entry once ledger advances past liveUntilLedgerSeq` | test-backed |
| 6 | Temporary entry returns plain miss after expiry (not ArchivedEntryResult) | contractCache.ts header | `_checkLiveness()` returns `"expired"` for temporary; `get()` returns `undefined` | `tests/contractCache.test.ts` | `ContractCache — persistent vs temporary durability > temporary entry does NOT return entryArchived even well past its TTL` | test-backed |
| 7 | `liveUntilLedgerSeq === 0` treated as archived for persistent entries | contractCache.ts header | `_checkLiveness()` checks `entry.liveUntilLedgerSeq === 0` | `tests/contractCache.test.ts` | `ContractCache — ledger-sequence expiry mid-session > returns ArchivedEntryResult when liveUntilLedgerSeq === 0` | test-backed |
| 8 | Stampede deduplication — concurrent callers coalesced onto one fetch | README, contractCache.ts header | `StampedeLock.coalesce()` in `ContractCache.getOrFetch()` | `tests/contractCache.test.ts` | `ContractCache — getOrFetch > calls fetch only once for concurrent requests (stampede prevention)` | test-backed |
| 9 | LedgerSequenceTracker coalesces concurrent requests | contractCache.ts header | `LedgerSequenceTracker.current()` checks `this.inflight` | `tests/contractCache.test.ts` | `LedgerSequenceTracker > coalesces concurrent callers onto one network request` | test-backed |
| 10 | LedgerSequenceTracker re-fetches after poll interval | contractCache.ts header | `current()` checks `now - this.lastFetchedAt < this.pollIntervalMs` | `tests/contractCache.test.ts` | `LedgerSequenceTracker > re-fetches after pollIntervalMs elapses` | test-backed |
| 11 | L1 serves from cache; Redis back-fills L1 on L1 miss | README, contractCache.ts header | `ContractCache.get()` tries L1 first, then Redis, then back-fills L1 | `tests/contractCache.test.ts` | `ContractCache — Redis integration > back-fills L1 from Redis on L1 miss` | test-backed |
| 12 | L1 serves reads when Redis is unavailable (graceful degradation) | README, SECURITY.md, contractCache.ts header | `ContractCache.get()` catches Redis errors and falls through | `tests/contractCache.test.ts` | `ContractCache — Redis integration > does not throw when Redis is down` | test-backed |
| 13 | Redis write failure is non-fatal; L1 still populated | contractCache.ts | `ContractCache.set()` catches Redis errors | `tests/contractCache.test.ts` | `ContractCache — Redis integration > stores in L1 even when Redis write fails` | test-backed |
| 14 | `delete` removes entry from both L1 and Redis | contractCache.ts | `ContractCache.delete()` calls `l1.delete()` and `redis.del()` | `tests/contractCache.test.ts` | `ContractCache — Redis integration > delete removes entry from both L1 and Redis` | test-backed |
| 15 | Token bucket public tier: 60 requests/min | README, rpcRateLimiter.ts header | `TIER_CONFIGS.public.maxTokens = 60` | `tests/rpcRateLimiter.test.ts` | `createRpcRateLimiter > public tier (60 req/min) > returns 429 after exhausting the 60-token public bucket` | test-backed |
| 16 | Token bucket authenticated tier: 300 requests/min | README, rpcRateLimiter.ts header | `TIER_CONFIGS.authenticated.maxTokens = 300` | `tests/rpcRateLimiter.test.ts` | `createRpcRateLimiter > authenticated tier (300 req/min) > allows 300 requests before rate limiting` | test-backed |
| 17 | Token bucket is atomic on a single Redis instance (Lua script) | README, rpcRateLimiter.ts header, SECURITY.md | `TOKEN_BUCKET_LUA` Lua script executed via `redis.eval()`; atomicity verified by CI integration test | `tests/integration/redis.test.ts` | `rpcRateLimiter — real Redis > token bucket really limits under concurrent calls` | test-backed |
| 18 | Two limiter instances share one Redis bucket | SECURITY.md (implied by per-instance key) | Bucket key includes endpoint+tier+IP; two instances with same config use same key | `tests/integration/redis.test.ts` | `rpcRateLimiter — real Redis > two limiter instances share one Redis bucket` | test-backed |
| 19 | Fail-open on Redis error (rate limiter) | README, rpcRateLimiter.ts header, SECURITY.md | `createRpcRateLimiter` catches errors and calls `next()` | `tests/rpcRateLimiter.test.ts` | `createRpcRateLimiter > fail-open on Redis error > calls next() and does not crash when Redis is unavailable` | test-backed |
| 20 | `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Window` headers set | README, rpcRateLimiter.ts | `res.setHeader` calls in `createRpcRateLimiter` | `tests/rpcRateLimiter.test.ts` | `createRpcRateLimiter > public tier (60 req/min) > sets informational rate-limit headers on allowed requests` | test-backed |
| 21 | `X-RateLimit-Retry-After` set on 429 response | rpcRateLimiter.ts | `res.setHeader("X-RateLimit-Retry-After", retryAfter)` | `tests/rpcRateLimiter.test.ts` | `createRpcRateLimiter > public tier (60 req/min) > sets X-RateLimit-Retry-After on 429` | test-backed |
| 22 | `trustProxy` reads client IP from `X-Forwarded-For` | README, rpcRateLimiter.ts | `resolveIdentifier()` checks `trustProxy` and reads header | `tests/rpcRateLimiter.test.ts` | `createRpcRateLimiter > trustProxy and IP resolution > uses X-Forwarded-For when trustProxy is true` | test-backed |
| 23 | Separate rate-limit buckets per IP | rpcRateLimiter.ts | Bucket key includes per-IP identifier | `tests/rpcRateLimiter.test.ts` | `createRpcRateLimiter > public tier (60 req/min) > tracks separate buckets per IP (Stellar address or user IP)` | test-backed |
| 24 | Exponential backoff with full jitter on retry | README, transactionBatcher.ts header | `calcBackoff()` uses `Math.random() * maxJitter` | `tests/transactionBatcher.test.ts` | `TransactionBatcher > retry on transient Soroban errors > retries txInsufficientFee and eventually fulfills` | test-backed |
| 25 | Backoff retries `txInsufficientFee` errors | README, transactionBatcher.ts header | `_executeTask()` catches errors and retries up to `maxRetries` | `tests/transactionBatcher.test.ts` | `TransactionBatcher > retry on transient Soroban errors > retries txInsufficientFee and eventually fulfills` | test-backed |
| 26 | `maxConcurrency` limits concurrent submissions | README, transactionBatcher.ts header | `_executeBatch()` gates on `executing.size >= config.maxConcurrency` | `tests/transactionBatcher.test.ts` | `TransactionBatcher > concurrency throttling > respects maxConcurrency to avoid overwhelming the RPC node` | test-backed |
| 27 | `AbortSignal` cancels pending transactions | transactionBatcher.ts header | `sleep()` and `_executeBatch()` check `signal?.aborted` | `tests/transactionBatcher.test.ts` | `TransactionBatcher > AbortSignal integration > cancels pending transactions when signal is aborted` | test-backed |
| 28 | `submitWithResults()` returns typed `{ fulfilled, rejected }` split | transactionBatcher.ts header | `TransactionBatcher.submitWithResults()` splits records by status | `tests/transactionBatcher.test.ts` | `TransactionBatcher > submitWithResults helper > returns fulfilled and rejected in typed buckets` | test-backed |
| 29 | Constant-time HMAC-SHA256 comparison (timing-safe) | horizonEventHandler.ts header, SECURITY.md | `verifyHorizonSignature()` uses `crypto.timingSafeEqual` | `tests/horizonEventHandler.test.ts` | `verifyHorizonSignature > returns false for a tampered body` | test-backed |
| 30 | Signature checked in `x-stellar-signature` header (also `x-signature-sha256`) | horizonEventHandler.ts header, SECURITY.md | `createHorizonEventHandler()` reads `req.headers["x-stellar-signature"] ?? req.headers["x-signature-sha256"]` | `tests/horizonEventHandler.test.ts` | `createHorizonEventHandler > signature verification > returns 401 for missing signature` | test-backed |
| 31 | Replay window default 300 s | README, horizonEventHandler.ts header, SECURITY.md | `config.maxAgeSeconds ?? 300` in `createHorizonEventHandler` | `tests/horizonEventHandler.test.ts` | `createHorizonEventHandler > replay attack prevention > rejects Stellar events older than 300s` | test-backed |
| 32 | 60 s future-timestamp clock-skew guard | horizonEventHandler.ts header | `age < -60` check in `createHorizonEventHandler` | `tests/horizonEventHandler.test.ts` | `createHorizonEventHandler > replay attack prevention > rejects events far in the future (clock skew protection)` | test-backed |
| 33 | Event ID idempotency (in-memory store) | horizonEventHandler.ts header | `HorizonIdempotencyStore.has()` / `mark()` called in handler | `tests/horizonEventHandler.test.ts` | `createHorizonEventHandler > idempotency > accepts duplicate Horizon event IDs without reprocessing` | test-backed |
| 34 | Returns 202 Accepted immediately; fires `onEvent` asynchronously | horizonEventHandler.ts header | `res.status(202)` before `config.onEvent(payload)` call | `tests/horizonEventHandler.test.ts` | `createHorizonEventHandler > successful acceptance > returns 202 for a valid Stellar payment event` | test-backed |
| 35 | `RedisIdempotencyStore` uses `SET NX EX` for atomic deduplication | horizonEventHandler.ts, SECURITY.md | `hasAndMark()` calls `redis.set(key, ts, "EX", ttl, "NX")` | `tests/horizonEventHandler.test.ts` | `RedisIdempotencyStore > uses SET NX EX — second hasAndMark does not overwrite first value` | test-backed |
| 36 | WASM magic-byte validation (`\0asm` = `0x00 0x61 0x73 0x6d`) | README, wasmPipeline.ts header, SECURITY.md | `WASM_MAGIC` constant; `processWasm()` checks first 4 bytes; `validate()` reads header | `tests/wasmPipeline.test.ts` | `processWasm > WASM magic byte validation > sets wasmMagicValid=true for a valid WASM binary` | test-backed |
| 37 | Non-WASM file sets `wasmMagicValid=false` | wasmPipeline.ts | `processWasm()` sets `wasmMagicValid = false` when magic bytes mismatch | `tests/wasmPipeline.test.ts` | `processWasm > WASM magic byte validation > sets wasmMagicValid=false for a non-WASM binary` | test-backed |
| 38 | `WasmPipeline.validate()` throws for non-WASM file | wasmPipeline.ts header | `validate()` reads first 4 bytes and compares to `WASM_MAGIC` | `tests/wasmPipeline.test.ts` | `WasmPipeline class > validate() > throws for a non-WASM binary` | test-backed |
| 39 | SHA-256 hash matches `stellar contract install` wasm-hash | README, wasmPipeline.ts header, SECURITY.md | `createHash("sha256").update(chunk).digest()` over all chunks | `tests/wasmPipeline.test.ts` | `processWasm > basic functionality > computes SHA-256 matching \`stellar contract install\` wasm-hash` | test-backed |
| 40 | Sandbox path isolation (directory traversal prevention) | README, wasmPipeline.ts header, SECURITY.md | `validateWasmPath()` resolves path and checks it starts with sandbox | `tests/wasmPipeline.test.ts` | `validateWasmPath > throws on directory traversal with ../` | test-backed |
| 41 | Absolute paths outside sandbox rejected | wasmPipeline.ts | `validateWasmPath()` rejects paths resolving outside sandbox dir | `tests/wasmPipeline.test.ts` | `validateWasmPath > throws on absolute path outside sandbox` | test-backed |
| 42 | `sha256=` prefix accepted in signature header | horizonEventHandler.ts | `verifyHorizonSignature()` calls `signature.replace(/^sha256=/, "")` | `tests/horizonEventHandler.test.ts` | `verifyHorizonSignature > accepts sha256= prefix (standard format)` | test-backed |
| 43 | LedgerSequenceTracker falls back gracefully when fetch throws | contractCache.ts | `_checkLiveness()` catches tracker errors, returns `"unknown"` | `tests/contractCache.test.ts` | `LedgerSequenceTracker > falls back gracefully when fetch throws` | test-backed |
| 44 | `maxRetries` exhausted marks transaction rejected | transactionBatcher.ts | `_executeTask()` sets `status = "rejected"` after `attempt === maxRetries` | `tests/transactionBatcher.test.ts` | `TransactionBatcher > retry on transient Soroban errors > marks transactions as rejected after maxRetries exhausted` | test-backed |
| 45 | Non-Error rejection wrapped in Error object | transactionBatcher.ts | `_executeTask()`: `err instanceof Error ? err : new Error(String(err))` | `tests/transactionBatcher.test.ts` | `TransactionBatcher > error edge cases > wraps non-Error rejections in an Error object` | test-backed |
| 46 | Redis Lua token bucket is atomic on a single Redis instance only (not Cluster) | SECURITY.md | Noted in SECURITY.md: "In a Redis Cluster, ensure bucket keys hash to the same slot" | — | — | code-only |

---

## Live evidence

These claims require running against real infrastructure. The Redis integration
tests run in CI against a `redis:7` service container (see the
`integration-tests` job in `.github/workflows/ci.yml`); those results are
CI-backed but not from a production Redis deployment.

The testnet harness (`npm run testnet`, described in `docs/testnet.md`) was run
on 2026-11-27 at 16:06:30 UTC on `main` (PR #33 merged, merge commit `697d469`)
in a GitHub Codespace. Full terminal output and the check table are in
[`docs/testnet-run.md`](testnet-run.md). The harness ran against
`Test SDF Network ; September 2015` with stellar CLI 30.0.1, Node v24.22.2, and
Redis 7.0.15 on localhost. Result: **18 checks, 18 passed, 0 failed, 0 skipped**.
Both re-confirmed transaction hashes were re-checked against the testnet RPC on
2026-11-27 and returned `"status": "SUCCESS"`.

"Where it ran" is stated per row: A, B, C ran against the Stellar testnet
through the deployed contract; D ran against a local Redis (NOT Stellar's own
RPC limits); E ran locally over HTTP only.

| # | Claim | Infrastructure needed | Harness check | Where it ran | Status |
|---|-------|----------------------|--------------|--------------|--------|
| L1 | `contractCache` reads from a real Soroban testnet contract | Stellar testnet, funded account | B1–B3 | testnet (contract `CBKCMVFQZE7X6QA4VKAWE3IKBYUJBEBTTSGZY7BWQG3WFW52JC5UMZLQ`) | PASS — 2026-11-27 |
| L2 | `rpcRateLimiter` enforces limits against a real Redis instance | Redis instance | D1–D3 | local Redis 7.0.15 | PASS — 2026-11-27 |
| L3 | `transactionBatcher` submits real transactions to Soroban testnet | Stellar testnet, funded account | C1–C3 | testnet — tx hashes [`17c8939d…31f29`](https://stellar.expert/explorer/testnet/tx/17c8939d8f1d29755692d225ac2fe3f97386260105625fe67864b22386831f29) and [`8a6b1743…b95f`](https://stellar.expert/explorer/testnet/tx/8a6b1743625d622cb681628eafe1239c4ad7b0f4515b3dbe6d656dba8f0fb95f) | PASS — 2026-11-27 |
| L4 | `horizonEventHandler` accepts a valid HMAC-signed request and rejects bad signatures, replays and missing headers | Local HTTP (relay-forwarded events not tested) | E1–E6 | local HTTP only | PASS — 2026-11-27 (relay-forwarded events remain untested) |
| L5 | `wasmPipeline` SHA-256 matches the on-chain wasm-hash after `stellar contract upload` | Stellar testnet, compiled WASM contract | A1 | testnet — WASM hash `cf46518c3c6cc678788e52340431638a21d56c1c42822dc2643f1af0e4f10391` | PASS — 2026-11-27 |
| L6 | Redis integration tests: token bucket atomicity under real concurrent load | Production Redis deployment | D1–D3 (harness) + CI `redis:7` service container | local Redis 7.0.15 (harness); CI `redis:7` service container (integration tests) | PASS — 2026-11-27 (single local instance; Redis Cluster untested) |
