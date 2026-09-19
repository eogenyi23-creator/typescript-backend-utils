# Phase 1 Audit Verification Report

**Repository:** `typescript-backend-utils`  
**Audit Date:** 2026-09-19  
**Auditor Role:** `verify_repo1` — independent read-only verification  
**HEAD commit:** `08b6e7a`  
**Branch verified against:** `main`

All verdicts are based on reading actual source files at HEAD. Runtime tests were written to `/tmp/test_*.mjs` and executed with `node`. Reasoning-only verdicts are noted. No source files were modified.

---

## Summary Table

| ID  | Verdict            | File                    |
|-----|--------------------|-------------------------|
| A1  | CONFIRMED          | tsconfig.json, package.json |
| A2  | PARTIAL            | contractCache.ts:398–413 |
| A3  | PARTIAL            | contractCache.ts:615–622 |
| A4  | CONFIRMED          | rpcRateLimiter.ts:178–213 |
| A5  | DISPUTED           | rpcRateLimiter.ts:145–152 |
| A6  | PARTIAL            | contractCache.ts:220–227 |
| A7  | CONFIRMED          | horizonEventHandler.ts:342–348 |
| A8  | CONFIRMED          | horizonEventHandler.ts:336 |
| A9  | CONFIRMED          | horizonEventHandler.ts:117–121 |
| A10 | CONFIRMED          | rpcRateLimiter.ts:87–88 |
| A11 | PARTIAL            | wasmPipeline.ts:95–100 |
| A12 | CONFIRMED          | transactionBatcher.ts:258–283 |
| A13 | CONFIRMED          | contractCache.ts:571–595 |
| A14 | CONFIRMED          | contractCache.ts:506–546 |
| A15 | CONFIRMED          | contractCache.ts:398–413 |
| A16 | CONFIRMED          | contractCache.ts:537, 252 |
| A17 | CONFIRMED          | transactionBatcher.ts:159–172 |
| A18 | CONFIRMED          | transactionBatcher.ts:78–87 |
| A19 | CONFIRMED          | transactionBatcher.ts:248–285 |
| A20 | PARTIAL            | transactionBatcher.ts:89–101 |
| A21 | CONFIRMED          | wasmPipeline.ts:157–199 |
| A22 | CONFIRMED          | wasmPipeline.ts:108–122 |
| A23 | CONFIRMED (multi)  | rpcRateLimiter.ts, horizonEventHandler.ts |
| C1  | PARTIAL            | .github/workflows/ci.yml |
| C2  | CONFIRMED          | package.json:8 |
| C3  | PARTIAL            | (SECURITY.md exists) |
| C4  | CONFIRMED          | tests/ directory |

---

## Detailed Verdicts

---

### A1 — tsconfig.json lacks `declaration: true`; exports condition ordering

**Verdict: CONFIRMED**

**Evidence (reasoning):**

`tsconfig.json` (entire file, 14 lines):
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "rootDir": "./src",
    "outDir": "./dist",
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "strict": true,
    "skipLibCheck": true
  },
  "include": ["src/**/*"]
}
```

`declaration: true` is absent. Running `tsc` will produce `.js` files in `dist/` but no `.d.ts` declaration files.

`package.json:10` sets `"types": "dist/index.d.ts"` — a file that will never be generated.

`package.json:13–16` exports condition ordering:
```json
"exports": {
  ".": {
    "import": "./dist/index.js",
    "types": "./dist/index.d.ts"
  }
}
```
`"import"` precedes `"types"`. The [Node.js package resolution spec](https://nodejs.org/api/packages.html#community-conditions-definitions) and TypeScript docs both recommend `"types"` first so that TypeScript picks it up in bundler/node16 resolution modes. The ordering here means bundlers that do not specifically prioritise `"types"` will see `"import"` first.

Both sub-issues confirmed.

---

### A2 — `_toWallClockTtl` uses archival deadline, not freshness; needs maxTtlSeconds clamp

**Verdict: PARTIAL**

`contractCache.ts:398–413`:
```typescript
private _toWallClockTtl(
  liveUntilLedgerSeq: number,
  fetchedAtLedger: number
): number {
  if (liveUntilLedgerSeq === 0) return 0;

  const currentLedger =
    this.ledgerTracker?.lastKnown ?? fetchedAtLedger;

  const ledgersRemaining = Math.max(0, liveUntilLedgerSeq - currentLedger);
  if (ledgersRemaining === 0) return 0;

  const wallClockSecs = ledgersRemaining * this.avgLedgerCloseSecs;
  return Math.max(wallClockSecs, 1);
}
```

The finding is **real**: `liveUntilLedgerSeq` is Soroban's archival deadline (the last ledger at which the entry is live), not a freshness indicator. A persistent entry with `liveUntilLedgerSeq = currentLedger + 1_000_000` (≈ one year) would be cached for `1_000_000 × 5 = 5_000_000 seconds` — over 57 days. No `maxTtlSeconds` clamp exists.

**However, the claim that "stale values served for months" and "can be overwritten next ledger" is inaccurate as stated.** The on-chain value genuinely lives until `liveUntilLedgerSeq` and the TTL accurately reflects that. The real problem is a different one: the _value_ on-chain can change (via contract execution) before the archival deadline, but the cache will continue serving the old value until the wall-clock TTL derived from the archival deadline expires. A `maxTtlSeconds` clamp is therefore needed for correctness on mutable state, not just for the archival scenario the finding describes.

**Reasoning only** (no runtime test needed — arithmetic is straightforward).

---

### A3 — `_redisWithTimeout` never clears its `setTimeout`; unhandled rejection crash

**Verdict: PARTIAL**

`contractCache.ts:615–622`:
```typescript
private _redisWithTimeout<T>(fn: () => Promise<T>): Promise<T> {
  return Promise.race([
    fn(),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("Redis timeout")), this.redisTimeoutMs)
    ),
  ]);
}
```

**Part 1 — setTimeout leak: CONFIRMED.** The `setTimeout` handle is never captured and `clearTimeout` is never called. When `fn()` resolves before the timeout, the timeout timer remains alive. This prevents clean process exit in tests and wastes resources. Confirmed by code inspection.

**Part 2 — Unhandled rejection crash: NOT CONFIRMED by runtime test.** `Promise.race()` internally subscribes to **all** input promises before returning. When the timeout fires and rejects first, V8's internal handler attached by `Promise.race()` handles any subsequent rejection from `fn()`. Tested with Node.js v24.21.0: zero `unhandledRejection` events were fired even when the underlying ioredis promise rejected 100ms after the timeout winner. The claim of "potential unhandled rejection crash" is incorrect for standard `Promise.race()`.

**Runtime test:** `/tmp/test_a3.mjs` — unhandled rejection count: 0 (confirmed not triggered).

The real issue is the timer leak only.

---

### A4 — `await next()` inside try block; throwing `next()` caught as Redis error, double invocation

**Verdict: CONFIRMED**

`rpcRateLimiter.ts:178–213`:
```typescript
try {
  const nowMs = Date.now();
  const result = (await redis.eval(...)) as [number, number, number];
  // ...
  await next();          // line 208 — inside try
} catch (err) {
  console.error(`[RpcRateLimiter:${endpoint}] Redis error, failing open:`, err);
  await next();          // line 212 — catch block
}
```

`await next()` (line 208) sits inside the same try block as `redis.eval()`. If the downstream handler (`next()`) throws, the catch block at line 209 catches it, logs it as a "Redis error", and then calls `next()` a **second time**. This means every downstream exception results in the handler being invoked twice — a potentially catastrophic bug for state-mutating routes.

**Runtime test:** `/tmp/test_a4.mjs` — confirmed double invocation: `next()` called count 2 when it throws.

---

### A5 — `resolveIdentifier` uses leftmost X-Forwarded-For entry; bypassable

**Verdict: DISPUTED**

`rpcRateLimiter.ts:145–152`:
```typescript
function resolveIdentifier(req: RpcRequest, trustProxy: boolean): string {
  if (trustProxy) {
    const forwarded = req.headers["x-forwarded-for"];
    const first = Array.isArray(forwarded) ? forwarded[0] : forwarded;
    if (first) return first.split(",")[0].trim();
  }
  return req.ip ?? req.socket?.remoteAddress ?? "unknown";
}
```

The finding is **factually accurate**: when `trustProxy: true`, the leftmost entry of `X-Forwarded-For` is used, and a client can prepend a fake IP to that header.

**However, this is the industry-standard behaviour and the code correctly documents the risk.** The comment at `rpcRateLimiter.ts:128–135` explicitly states: _"Only enable this if your service sits behind a trusted reverse proxy (nginx, AWS ALB, Cloudflare, etc.) that sets this header — otherwise clients can spoof it to bypass per-IP limits."_

Correctly-configured reverse proxies (nginx `proxy_set_header X-Real-IP $remote_addr`, AWS ALB, Cloudflare) either overwrite the header entirely or append the trusted IP, making the leftmost entry the true client IP. Choosing leftmost vs rightmost depends on the proxy chain topology. The code matches the documented contract. The real problem would be silently applying `trustProxy: true` without documentation — this code documents it clearly.

**Verdict: DISPUTED.** The code is as described but the conclusion that "Per-IP limits are bypassable" is only true if the operator misconfigures `trustProxy: true` without a proper proxy, which the documentation warns against.

---

### A6 — `deepClone` throws on bigint/Buffer/Date; catch returns original reference

**Verdict: PARTIAL**

`contractCache.ts:220–227`:
```typescript
function deepClone<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  try {
    return JSON.parse(JSON.stringify(value)) as T;
  } catch {
    return value;  // returns original reference
  }
}
```

**bigint — CONFIRMED:** `JSON.stringify` throws `TypeError: Do not know how to serialize a BigInt`. The catch returns the original object reference. Mutations to the "clone" affect the original. **Runtime tested** in `/tmp/test_a6.mjs`: Test 1 passes — same reference returned, mutation propagates.

**Buffer — PARTIAL:** `JSON.stringify` does **not** throw on a Buffer; it serialises it as `{"type":"Buffer","data":[...]}`. The catch is NOT triggered. However, `JSON.parse` produces a plain object, not a Buffer instance — so the cloned object's `data` field is a plain object, not a Buffer. This is silently lossy but different from the described behaviour (no aliasing, no reference return).

**Date — NOT CONFIRMED as aliasing:** `JSON.stringify` converts Date to ISO string; `JSON.parse` back to a plain string. The catch is NOT triggered. No reference aliasing — but the Date prototype is silently lost.

**L2 write silently disabled:** `contractCache.ts:539–546`:
```typescript
if (this.redis) {
  try {
    const serialized = JSON.stringify({ ...stored, wallClockTtl });
    await this._redisSetWithTimeout(cacheKey, serialized, wallClockTtl);
  } catch {
    // Non-fatal; L1 is the local source of truth
  }
}
```
If `stored.value` contains a bigint, `JSON.stringify` throws, the catch silently swallows it, and Redis is never written. CONFIRMED by code inspection.

**Summary:** bigint causes silent reference aliasing and L2 write failure. Buffer and Date cause silent data loss but not aliasing. The finding overstates the Buffer case.

**Runtime test:** `/tmp/test_a6.mjs`.

---

### A7 — Non-Redis idempotency branch doesn't await `has()` or `mark()`

**Verdict: CONFIRMED**

`horizonEventHandler.ts:342–348`:
```typescript
} else {
  if (idempotency.has(payload.id)) {   // not awaited
    res.status(202).json({ ... });
    return { accepted: true, reason: "duplicate", payload };
  }
  idempotency.mark(payload.id, payload.timestamp);  // not awaited
}
```

The `IdempotencyStore` interface at `horizonEventHandler.ts:80–83`:
```typescript
export interface IdempotencyStore {
  has(eventId: string): boolean | Promise<boolean>;
  mark(eventId: string, ts: number): void | Promise<void>;
}
```

Both methods can return a Promise. The else branch (lines 342–348) does not `await` either call. If a custom async store is provided:
- `has()` returns a Promise, which is truthy (non-null object), so every event appears to be a duplicate → all events rejected
- `mark()` fires-and-forgets — no guarantee the mark completes before the next request

**Reasoning only** (no runtime test needed — the code path is unambiguous).

---

### A8 — `dispatch` uses `instanceof RedisIdempotencyStore`; breaks with duplicate modules

**Verdict: CONFIRMED**

`horizonEventHandler.ts:336`:
```typescript
if (idempotency instanceof RedisIdempotencyStore) {
```

`instanceof` checks the prototype chain against the exact class constructor reference. In Node.js ESM environments, duplicate module copies (e.g., two versions of the package installed in a monorepo, or the class imported through a re-export wrapper) produce different constructor references. A `RedisIdempotencyStore` from a different module copy will fail the `instanceof` check and fall through to the non-async else branch (A7), silently treating every event as a duplicate.

Feature-detection (`'hasAndMark' in idempotency`) would be more robust.

**Reasoning only.**

---

### A9 — `HorizonIdempotencyStore.purgeExpired` never called; unbounded memory growth

**Verdict: CONFIRMED**

`horizonEventHandler.ts:117–121`:
```typescript
/** Purges events older than maxAgeSeconds. Call periodically in production. */
purgeExpired(maxAgeSeconds: number): void {
  const cutoff = Math.floor(Date.now() / 1000) - maxAgeSeconds;
  for (const [id, ts] of this.seen) {
    if (ts < cutoff) this.seen.delete(id);
  }
}
```

`purgeExpired` is defined but never called anywhere in the codebase. Grepping confirms no call site exists. Under production load with `HorizonIdempotencyStore`, the `seen` Map grows without bound — each unique event ID permanently occupies memory.

**Reasoning only** (grep verified: zero call sites).

---

### A10 — Lua `now_ms` from calling process; clock skew causes negative `elapsed_sec`

**Verdict: CONFIRMED**

`rpcRateLimiter.ts:87–88` (Lua script):
```lua
local elapsed_sec = (now_ms - last_refill) / 1000
local new_tokens  = elapsed_sec * refill_rate
tokens = math.min(max_tokens, tokens + new_tokens)
```

`now_ms` is `Date.now()` from the Node.js process (passed as `ARGV[3]`, line 186). In a multi-instance deployment where one server's clock is behind Redis's clock, `now_ms` can be less than `last_refill`, making `elapsed_sec` negative. `new_tokens` becomes negative, reducing the bucket below what it should be. No `math.max(0, elapsed_sec)` clamp exists.

Using `redis.call('TIME')` inside the Lua script would guarantee a single authoritative clock and eliminate skew entirely.

**Reasoning only** (arithmetic is straightforward; no runtime Redis available).

---

### A11 — `validateWasmPath` hardcodes `'/'` separator; `outputDir` bypasses validation

**Verdict: PARTIAL**

`wasmPipeline.ts:95–100`:
```typescript
export function validateWasmPath(sandboxDir: string, filePath: string): string {
  const normalizedSandbox = resolve(normalize(sandboxDir));
  const resolved = resolve(normalizedSandbox, normalize(filePath));
  if (!resolved.startsWith(normalizedSandbox + "/") && resolved !== normalizedSandbox) {
    throw new Error(...);
  }
  return resolved;
}
```

**Hardcoded `/` separator — CONFIRMED:** Line 98 appends `"/"` literally. On Windows this would fail for paths like `C:\sandbox` because `startsWith("C:\\sandbox/")` uses a Unix separator. However this is a Node.js package targeting Stellar RPC backends — practically always Linux/macOS. The finding is technically correct but has minimal real-world impact for the target environment.

**Symlinks not resolved — CONFIRMED:** `resolve()` and `normalize()` do not resolve symlinks. A symlink inside the sandbox pointing outside would pass validation. `fs.realpathSync` would be needed for true containment.

**`outputDir` bypasses validation — CONFIRMED:** `wasmPipeline.ts:139–140`:
```typescript
const {
  sandboxDir,
  outputDir = sandboxDir,
  ...
} = config;
```
`outputDir` is accepted as-is without passing through `validateWasmPath`. The manifest JSON is written to `join(outputDir, manifestName)` (line 208) without any sandbox check on `outputDir`.

**Partial because:** the symlink and separator sub-findings are confirmed, but the hardcoded `/` only matters on Windows (not typical for this use case).

---

### A12 — `_executeTask` retries every error unconditionally

**Verdict: CONFIRMED**

`transactionBatcher.ts:258–283`:
```typescript
for (let attempt = 0; attempt <= maxRetries; attempt++) {
  try {
    record.attempts++;
    record.result = await task();
    record.status = "fulfilled";
    return;
  } catch (err) {
    if (attempt === maxRetries) {
      record.status = "rejected";
      record.error = err instanceof Error ? err : new Error(String(err));
      return;
    }
    const backoffMs = calcBackoff(...);
    await sleep(backoffMs, signal);
  }
}
```

Every error unconditionally triggers a retry. Soroban-specific errors like `txBadSeq` (wrong sequence number) and `txTooLate` (transaction already expired) are permanent for the given signed envelope. Resubmitting the same signed envelope cannot succeed for these errors — the retry loop wastes time and potentially submits duplicate transactions if the original eventually lands.

No `shouldRetry` predicate or error-type filtering exists.

**Reasoning only.**

---

### A13 — `getOrFetch` returns `{entryArchived: false}` on first call for already-archived persistent entry

**Verdict: CONFIRMED**

`contractCache.ts:571–595`:
```typescript
async getOrFetch<T>(
  key: ContractStateKey,
  fetch: () => Promise<SorobanEntryResult<T>>
): Promise<CacheResult<T>> {
  const cached = await this.get<T>(key);
  if (cached !== undefined) {
    if ("entryArchived" in cached) return cached as ArchivedEntryResult;
    return { entryArchived: false, value: (cached as StoredEntry<T>).value };
  }

  const cacheKey = encodeContractKey(key);
  return this.stampede.coalesce(cacheKey, async () => {
    const rechecked = await this.get<T>(key);
    if (rechecked !== undefined) {
      if ("entryArchived" in rechecked) return rechecked as ArchivedEntryResult;
      return { entryArchived: false, value: (rechecked as StoredEntry<T>).value };
    }

    const entry = await fetch();
    await this.set(key, entry);
    return { entryArchived: false, value: entry.value };  // line 594 — ALWAYS returns entryArchived:false
  }) as Promise<CacheResult<T>>;
}
```

**First call (cache miss):** `get()` returns `undefined` → stampede coalesce fires → `fetch()` returns `{liveUntilLedgerSeq: 0, durability: 'persistent'}` → `set()` stores it in L1 with `fallbackTtl` → line 594 unconditionally returns `{entryArchived: false, value: entry.value}`. The already-archived state is NOT checked here.

**Second call (L1 hit):** `get()` finds the L1 entry → `_checkLiveness` sees `liveUntilLedgerSeq === 0` → returns `"archived"` → returns `ArchivedEntryResult`.

The first call lies to the caller (says entry is live when it's archived). The second call tells the truth.

**Reasoning verified** in `/tmp/test_a13.mjs`.

---

### A14 — Archived entries get `fallbackTtl` in L1 but `Math.max(1, 0) = 1s` TTL in Redis

**Verdict: CONFIRMED**

`contractCache.ts:506–546`:
```typescript
async set<T>(key: ContractStateKey, entry: SorobanEntryResult<T>): Promise<void> {
  const cacheKey = encodeContractKey(key);
  const wallClockTtl = this._toWallClockTtl(   // returns 0 when liveUntilLedgerSeq===0
    entry.liveUntilLedgerSeq,
    entry.fetchedAtLedger
  );
  const alreadyArchived = entry.liveUntilLedgerSeq === 0 && entry.durability === "persistent";
  if (wallClockTtl === 0 && !alreadyArchived) return;
  
  // effectiveTtl = fallbackTtl (e.g. 30s) for archived entries
  const effectiveTtl = wallClockTtl === 0 ? this.fallbackTtl : wallClockTtl;
  const expiresAt = Date.now() + effectiveTtl * 1000;
  
  // ...
  this.l1.set(cacheKey, { ...stored, expiresAt });   // L1 uses expiresAt based on effectiveTtl (30s)

  if (this.redis) {
    try {
      const serialized = JSON.stringify({ ...stored, wallClockTtl });
      await this._redisSetWithTimeout(cacheKey, serialized, wallClockTtl); // passes wallClockTtl (0!)
```

`_redisSetWithTimeout` calls `redis.set(key, value, "EX", Math.max(1, Math.ceil(wallClockTtl)))` = `Math.max(1, 0)` = **1 second**.

L1 serves the entry for `fallbackTtl` (default 30s). Redis expires the key after 1 second. After a process restart or L1 eviction within 1–30s, a Redis lookup will miss and trigger a fresh fetch instead of returning `ArchivedEntryResult`. The inconsistency means multi-instance deployments behave differently from single-instance.

**Runtime verified** in `/tmp/test_a14.mjs`: L1 TTL = 30s, Redis TTL = 1s.

---

### A15 — `_toWallClockTtl` uses `lastKnown ?? fetchedAtLedger`; `lastKnown` may be stale

**Verdict: CONFIRMED**

`contractCache.ts:404–405`:
```typescript
const currentLedger =
  this.ledgerTracker?.lastKnown ?? fetchedAtLedger;
```

`lastKnown` is the sequence number from the most recent poll, which may be up to `ledgerPollIntervalMs` (default 4s) stale. Soroban ledgers close every ~5s, so `lastKnown` can be 0–1 ledgers behind. More importantly, `lastKnown` is updated by `seed()` (called from `set()` with `fetchedAtLedger`) and by `LedgerSequenceTracker.current()`. If a prior `set()` seeded an older ledger number (e.g., from a slow RPC response), then `lastKnown` would be lower than `fetchedAtLedger`, making `liveUntilLedgerSeq - lastKnown` larger than `liveUntilLedgerSeq - fetchedAtLedger`, thereby inflating the TTL. This is precisely the scenario described.

The correct base should always be `fetchedAtLedger` (the ledger at which the entry was actually fetched), not `lastKnown` which may come from an earlier request.

**Reasoning only.**

---

### A16 — `get()` returns deep clone; `set()` stores caller's object by reference

**Verdict: CONFIRMED**

`contractCache.ts:252`:
```typescript
// In LRUCache.get():
return deepClone(entry) as T;
```

`contractCache.ts:537`:
```typescript
// In ContractCache.set():
this.l1.set(cacheKey, { ...stored, expiresAt });
```

`stored.value = entry.value` — the spread creates a new `stored` object but `value` is copied by reference. If the caller mutates the object they passed to `set()`, the cached value mutates too. `get()` clones the outgoing value, but the inbound path in `set()` does not clone.

The asymmetry means: a caller who passes `{balance: 100n}` and then mutates `balance = 200n` will see the cached value updated, which defeats caching correctness.

**Reasoning only.**

---

### A17 — Batches execute sequentially; slow task in batch N stalls batch N+1

**Verdict: CONFIRMED**

`transactionBatcher.ts:159–172`:
```typescript
for (let batchStart = 0; batchStart < taskPairs.length; batchStart += this.config.batchSize) {
  // ...
  const batch = taskPairs.slice(batchStart, batchStart + this.config.batchSize);
  await this._executeBatch(batch, signal);   // fully awaited before next iteration
}
```

Each `_executeBatch` is fully `await`ed. Batch N+1 does not start until every task in batch N has completed (including retries with backoff). Even if all `maxConcurrency` slots are free, they remain idle while the slowest task in the previous batch finishes.

Within a batch, `_executeBatch` uses a `Set<Promise>` with `Promise.race` to honour `maxConcurrency`. But the inter-batch gate is strictly sequential. For workloads where `batchSize` is large or task latency is high, this introduces artificial serialisation.

**Confirmed by code inspection.**

---

### A18 — `calcBackoff` documented as "full jitter" but implements exponential + fixed jitter

**Verdict: CONFIRMED**

`transactionBatcher.ts:74–87`:
```typescript
/**
 * Calculates exponential backoff with full jitter.
 * Full jitter prevents thundering-herd re-submission after fee spikes.
 */
function calcBackoff(
  attempt: number,
  baseMs: number,
  multiplier: number,
  maxJitter: number,
  cap = 30_000
): number {
  const exponential = Math.min(cap, baseMs * Math.pow(multiplier, attempt));
  return exponential + Math.random() * maxJitter;
}
```

**Full jitter** (per the [AWS Architecture Blog](https://aws.amazon.com/blogs/architecture/exponential-backoff-and-jitter/)) is defined as:
```
sleep = random_between(0, min(cap, base * 2^attempt))
```
The minimum possible wait is **0**.

**The implementation** adds `Math.random() * maxJitter` on top of the deterministic exponential term. The minimum wait is always `exponential` (e.g. at attempt=0: `baseMs * 1 = baseMs`), never 0. This is closer to "equal jitter" or simply "exponential + noise".

**Runtime test:** `/tmp/test_a18.mjs` — samples at attempt=0 with `base=1000, mult=2, jitter=200` always exceed 1000ms. True full jitter can return values near 0ms.

---

### A19 — `signal` is never passed to `task()`; in-flight RPC calls can't be aborted

**Verdict: CONFIRMED**

`transactionBatcher.ts:265–269`:
```typescript
try {
  record.attempts++;
  record.result = await task();   // signal NOT passed to task
  record.status = "fulfilled";
  return;
}
```

The `TransactionTask<T>` type is `() => Promise<T>` — it accepts no arguments. When an `AbortSignal` fires mid-task, `_executeTask` will abort on the _next_ loop iteration check (line 259) or during `sleep()`, but the currently in-flight `task()` has no way to cancel its underlying RPC call.

The fix would require changing `TransactionTask<T>` to `(signal: AbortSignal) => Promise<T>` and passing `signal` at line 267.

**Reasoning only.**

---

### A20 — `sleep()` adds abort listener never removed on normal resolution path

**Verdict: PARTIAL**

`transactionBatcher.ts:89–101`:
```typescript
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    }, { once: true });   // <-- once: true
  });
}
```

The finding is **real but partially mitigated by `{ once: true }`**.

On normal resolution (timer fires, signal never aborts): the abort listener is NOT removed, because `{ once: true }` only auto-removes the listener **when it fires**. If the signal never fires, the listener remains attached to the `AbortSignal` object for as long as that signal lives. This is a minor memory leak per `sleep()` call with a signal.

The `{ once: true }` option correctly handles the abort-fires-during-sleep case. But there is no `removeEventListener` call on the happy path. A `finally` block calling `signal?.removeEventListener(...)` would fully close the leak.

For typical usage (one signal per `run()` call), this means `maxRetries` dangling listeners per transaction — negligible in practice but non-zero.

**Confirmed by code inspection.** The finding is correct but the impact is minor.

---

### A21 — `processWasm` gzips whole file before checking magic bytes; compressedSize meaningless; pause/resume serialises

**Verdict: CONFIRMED**

`wasmPipeline.ts:157–199`:

**Magic bytes checked after full stream:** The stream processes all chunks (line 160–195) and `firstChunkBytes` is captured during streaming, but the WASM magic validation only happens _after_ the full `await new Promise(...)` resolves (lines 199–205). The file is fully read, hashed, and gzipped before the magic check occurs. The `WasmPipeline.validate()` method exists as an explicit pre-check, but `processWasm()` itself does not abort early on invalid magic. For large files, this wastes substantial I/O.

**`compressedSize` is per-chunk gzip, not meaningful:** Each chunk is independently gzipped (`gzipAsync(chunk)`). The `compressedSize` stored per chunk is the gzip output for that isolated chunk — not representative of how the chunk would compress within the full WASM context. `totalCompressedBytes` is the sum of independent per-chunk gzip sizes, not the actual compressed file size. The manifest values are misleading.

**pause/resume serialises the stream:** Lines 171–178:
```typescript
stream.pause();
lastGzipPromise = lastGzipPromise
  .then(() => gzipAsync(chunk))
  .then((compressed) => {
    ...
    stream.resume();
  })
```
The stream is paused on every chunk and only resumed after `gzipAsync` completes. Since gzip operations are chained via `lastGzipPromise`, chunks are processed one at a time (serial). The stream never reads ahead. This eliminates the streaming advantage.

**All three sub-issues confirmed by code inspection.**

---

### A22 — `verifyWasmChunkIntegrity` checks offsets produced by the same loop; cannot fail

**Verdict: CONFIRMED**

`wasmPipeline.ts:108–122`:
```typescript
export function verifyWasmChunkIntegrity(chunks: WasmChunkRecord[], totalBytes: number): boolean {
  if (chunks.length === 0) return totalBytes === 0;
  let expectedOffset = 0;
  for (const chunk of chunks) {
    if (chunk.byteOffset !== expectedOffset) return false;
    if (chunk.byteLength <= 0) return false;
    expectedOffset += chunk.byteLength;
  }
  return expectedOffset === totalBytes;
}
```

The chunks are constructed in `processWasm()` lines 166–169:
```typescript
const index = chunks.length;
const chunkByteOffset = byteOffset;
chunks.push({ index, byteOffset: chunkByteOffset, byteLength: chunk.length, compressedSize: 0 });
byteOffset += chunk.length;
```

`byteOffset` is incremented by `chunk.length` for each chunk, and `byteOffset` is used directly as `chunkByteOffset`. This guarantees:
- `chunks[n].byteOffset` always equals the sum of all prior `byteLength` values
- `totalBytes` (from `stat.size`) equals what the stream will sum to for a well-formed file

The verification function checks the exact invariants that the construction loop maintains. Under normal (non-corrupted) operation, `verifyWasmChunkIntegrity` is mathematically guaranteed to return `true` — it is not an independent verification at all. Only external corruption of the `chunks` array (after construction) could trigger a `false`.

**Confirmed by code inspection.**

---

### A23 — Miscellaneous issues in `rpcRateLimiter.ts` and `horizonEventHandler.ts`

**Verdict: CONFIRMED (all sub-items)**

Verified individually:

**Missing `Retry-After` header on 429:** `rpcRateLimiter.ts:197–204`:
```typescript
res.setHeader("X-RateLimit-Retry-After", retryAfter);   // custom header only
res.status(429).end(JSON.stringify({...}));
```
The standard `Retry-After` header ([RFC 7231](https://datatracker.ietf.org/doc/html/rfc7231#section-7.1.3)) is absent. Only `X-RateLimit-Retry-After` is set. **CONFIRMED.**

**No `Content-Type` on 429 body:** `res.status(429).end(JSON.stringify({...}))` — `setHeader("Content-Type", "application/json")` is never called for the 429 response. **CONFIRMED.**

**No IPv6 prefix normalisation:** `resolveIdentifier` (lines 145–152) returns raw IPv6 addresses (e.g. `::ffff:1.2.3.4`, `2001:db8::1`) without normalisation. Different representations of the same address create separate buckets. **CONFIRMED** by code inspection.

**HMAC secret not checked non-empty:** `horizonEventHandler.ts:58` (`secret: string`) — `createHorizonEventHandler` does not validate that `config.secret.length > 0`. An empty secret HMAC is computable by any client. **CONFIRMED.**

**Hardcoded -60s clock skew:** `horizonEventHandler.ts:329`: `if (age < -60)` — 60 seconds is hardcoded and not configurable. **CONFIRMED.**

**Deprecated `HMSET` in Lua:** `rpcRateLimiter.ts:102`: `redis.call('HMSET', ...)`. `HMSET` was deprecated in Redis 4.0.0 in favour of `HSET`. **CONFIRMED.**

**Script re-sent on every request instead of `EVALSHA`:** `rpcRateLimiter.ts:180–188`: `redis.eval(TOKEN_BUCKET_LUA, ...)` is called on every request, sending the full Lua script text over the wire each time. Using `redis.evalsha()` with script caching would reduce bandwidth. **CONFIRMED.**

**`windowSeconds` doesn't govern the limit:** The token bucket replenishes at `refillRate` tokens/second regardless of `windowSeconds`. `windowSeconds` is only used as the key TTL multiplier (`ttl_sec * 2`) on line 103 of the Lua. It does not set a window boundary for the rate. The public tier is documented as "60 req/min" but the actual limit is governed by `maxTokens=60` and `refillRate=1.0`, which happens to align — but `windowSeconds=60` has no direct effect on when the bucket refills. **CONFIRMED.**

---

## C-Series (Code Quality / Process)

---

### C1 — No CI running typecheck, tests, cargo test, cargo clippy

**Verdict: PARTIAL**

`.github/workflows/ci.yml`:
```yaml
jobs:
  build-and-test:
    steps:
      - name: Type check
        run: npm run lint        # tsc --noEmit
      - name: Build
        run: npm run build       # tsc
      - name: Run tests
        run: npm test            # jest
```

TypeCheck (`tsc --noEmit`) and Jest tests **do** run on every PR and push to main. The finding is incorrect on these points.

**However:** There is no Cargo (Rust) in this repository — it is a pure TypeScript project. There are no `cargo test` or `cargo clippy` steps and no Rust code present. The finding's mention of `cargo test` / `cargo clippy` is not applicable to this repo.

**The CI does NOT run:**
- ESLint (no ESLint installed — see C2)
- Dependency vulnerability scanning
- `declaration: true` check (A1 would be caught if `--noEmit` fails with missing types, but it won't — tsc with no declaration flag simply omits `.d.ts`)

**PARTIAL: TypeScript typecheck and tests run; Rust tooling is inapplicable; no linting or security scanning.**

---

### C2 — No ESLint; lint script is just `tsc --noEmit`

**Verdict: CONFIRMED**

`package.json:8`:
```json
"lint": "tsc --noEmit",
```

There is no `eslint`, `@eslint/*`, `eslint-plugin-*`, or `.eslintrc*`/`eslint.config.*` anywhere in the repository. The lint script is type-checking only, not linting.

No `any` cast count was performed (out of scope for this finding), but the absence of ESLint means `any` casts, `@ts-ignore`, and other suppressions go undetected.

**Confirmed by package.json inspection and glob search.**

---

### C3 — No dependency automation; no SECURITY.md

**Verdict: PARTIAL**

**SECURITY.md:** The file exists at `/tmp/repo1/SECURITY.md` and is substantive — it contains a vulnerability reporting policy, module-by-module security considerations, and an audit status disclosure. The finding that "no SECURITY.md" exists is **incorrect**.

**Dependency automation:** No Dependabot (`/.github/dependabot.yml`) or Renovate (`renovate.json`) configuration exists. Dependencies are static. **CONFIRMED** — no dependency automation.

**PARTIAL: SECURITY.md exists and is non-trivial; dependency automation is absent.**

---

### C4 — Test gaps: Redis failure paths, clock skew, mid-flight abort

**Verdict: CONFIRMED**

Inspecting `tests/`:

- `contractCache.test.ts`: Redis failure paths partially covered (mock errors on get/set) but `_redisWithTimeout` timer leak is not tested; no clock-skew scenario.
- `rpcRateLimiter.test.ts`: No clock skew tests (negative `elapsed_sec`). Redis failure path covered (fails-open test exists). No IPv6 normalisation tests.
- `transactionBatcher.test.ts`: No mid-flight abort test — signal passed to `run()` is tested for pre-abort but not for signal-while-task-in-flight. No test verifying `task()` receives signal (it doesn't — A19).
- `horizonEventHandler.test.ts`: No Redis idempotency failure tests. `purgeExpired` never tested in lifecycle.
- `wasmPipeline.test.ts`: No tests for symlink traversal, non-`/`-separator paths, or the `outputDir` sandbox bypass.

**Confirmed by directory inspection.**

---

## Additional Issues Not in the Original Finding List

### X1 — `LRUCache.set()` stores objects by reference (no clone on write path)

`contractCache.ts:255–261`:
```typescript
set(key: string, value: T & { expiresAt: number }): void {
  if (this.store.has(key)) this.store.delete(key);
  if (this.store.size >= this.maxSize) { ... }
  this.store.set(key, value);  // stores reference directly
}
```
`deepClone` is only called on `get()` (line 252), not on `set()`. This is the root mechanism behind A16.

### X2 — `LRUCache.get()` clones the entire `StoredEntry` wrapper including `expiresAt`

`contractCache.ts:252`: `return deepClone(entry) as T`. The caller receives a deep clone of the entire `StoredEntry<T>` shape (including `expiresAt`, `durability`, `liveUntilLedgerSeq`), not just `value`. For nested cache implementations, this may expose internal cache metadata to callers.

### X3 — `StampedeLock.coalesce` does not isolate per-key errors

`contractCache.ts:281–291`: If `compute()` rejects, the same rejected promise is returned to all concurrent waiters (correct stampede behaviour). However, the lock key is deleted in `.finally()`, so the next call will retry. This is correct but undocumented — a temporary network error causes all concurrent stampede waiters to receive the same rejection simultaneously, potentially triggering a thundering herd on the next request.

### X4 — `processWasm` writes manifest to `outputDir` without ensuring it's under `sandboxDir`

Extends A11: if `outputDir` is a user-controlled path (e.g. `/etc/cron.d`), arbitrary file writes are possible. The manifest is JSON-safe but the filename is `${fileName}.${Date.now()}.manifest.json` where `fileName = basename(safePath)` — safe. However, the directory is unvalidated. This is a path injection for writes.

### X5 — `horizonEventHandler.ts`: `createHorizonEventHandler` parameter type restricts to known concrete classes

```typescript
export function createHorizonEventHandler(
  config: HorizonEventHandlerConfig,
  idempotency: HorizonIdempotencyStore | RedisIdempotencyStore = new HorizonIdempotencyStore(),
  ...
```

The type `HorizonIdempotencyStore | RedisIdempotencyStore` is a union of concrete classes, not the `IdempotencyStore` interface. This prevents injecting a custom `IdempotencyStore` implementation without a type error, contradicting the interface's stated purpose. The parameter type should be `IdempotencyStore`.

### X6 — `_redisSetWithTimeout` passes `wallClockTtl` but `_toWallClockTtl` may return sub-second values

`contractCache.ts:609–613`: `Math.max(1, Math.ceil(ttlSeconds))` ensures Redis always gets at least 1 second. But very short-lived entries (e.g. 2 ledgers remaining × 5s = 10s → fine) are fine. The `Math.max(1, ...)` floor means entries that should expire in < 1s get a 1s Redis key — not harmful but slightly inconsistent with L1 wall-clock TTL.

---

## Test Execution Log

| Test File          | Purpose                                | Result         |
|--------------------|----------------------------------------|----------------|
| `/tmp/test_a6.mjs` | deepClone bigint/Buffer aliasing       | A6 PARTIAL confirmed |
| `/tmp/test_a3.mjs` | setTimeout leak + unhandled rejection  | A3 PARTIAL: leak confirmed, no unhandled rejection |
| `/tmp/test_a18.mjs`| calcBackoff jitter formula             | A18 CONFIRMED  |
| `/tmp/test_a13.mjs`| getOrFetch first-call inconsistency    | A13 CONFIRMED (reasoning trace) |
| `/tmp/test_a14.mjs`| L1 vs L2 TTL mismatch for archived    | A14 CONFIRMED  |
| A4 (inline node)   | Double next() invocation              | A4 CONFIRMED   |
| A17 (inline node)  | Sequential batch execution            | A17 CONFIRMED  |

---

## Risk Prioritisation

| Priority | ID  | Issue                                              | Impact           |
|----------|-----|----------------------------------------------------|------------------|
| CRITICAL | A4  | next() double invocation on downstream exception   | State corruption |
| CRITICAL | A1  | No .d.ts generated; broken types package           | All consumers    |
| HIGH     | A13 | getOrFetch lies about archived state (first call)  | Data integrity   |
| HIGH     | A7  | Custom async IdempotencyStore treats all as dupes  | Event loss       |
| HIGH     | A10 | Clock skew drains rate limit tokens                | DoS self-inflict |
| HIGH     | A12 | Retries un-retryable Soroban errors                | Wasted fees/time |
| MEDIUM   | A3  | setTimeout leak in _redisWithTimeout               | Resource leak    |
| MEDIUM   | A6  | bigint/Buffer silently aliases + disables L2       | Data corruption  |
| MEDIUM   | A14 | Archived entry TTL mismatch L1 vs Redis            | Inconsistency    |
| MEDIUM   | A9  | purgeExpired never called; OOM risk                | Memory growth    |
| MEDIUM   | A15 | Inflated TTL from stale lastKnown                  | Stale cache      |
| MEDIUM   | A16 | set() stores by reference; mutable cache          | Data corruption  |
| LOW      | A8  | instanceof check fragile across module copies      | Dedup bypass     |
| LOW      | A11 | Symlink traversal; outputDir unvalidated           | Path injection   |
| LOW      | A17 | Sequential batch scheduling wastes concurrency     | Performance      |
| LOW      | A18 | "Full jitter" misnaming; thundering herd risk      | Thundering herd  |
| LOW      | A19 | signal not passed to task(); no mid-flight abort   | Abort incomplete |
| LOW      | A20 | Abort listener not removed on normal resolution    | Minor leak       |
| LOW      | A21 | Magic check after full stream; serialised gzip     | Performance      |
| LOW      | A22 | verifyWasmChunkIntegrity cannot detect corruption  | False assurance  |
| INFO     | A2  | No maxTtlSeconds cap on TTL                        | Stale on write   |
| INFO     | A5  | trustProxy leftmost XFF (by design, documented)    | N/A (disputed)   |
| INFO     | A23 | Missing headers, HMSET deprecated, EVALSHA         | Various minor    |

---

*Report generated 2026-09-19. No source files were modified during this audit.*
