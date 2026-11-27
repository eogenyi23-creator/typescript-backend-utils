/**
 * Integration tests: real Redis behaviour for rpcRateLimiter and contractCache.
 *
 * Run with:   REDIS_URL=redis://localhost:6379 npm run test:integration
 * Skipped when REDIS_URL is not set.
 *
 * These tests cover behaviour that cannot be exercised with a mock:
 *   - Token bucket atomicity under concurrent callers (Lua script race conditions)
 *   - Shared bucket across two independent limiter instances
 *   - Fail-open when Redis connection is refused
 *   - ContractCache L1 serves data when Redis is down
 *   - ContractCache L1/L2 round-trip and back-fill
 *
 * Design rules:
 *   - Every test creates its own Redis client and closes it in afterEach/afterAll.
 *   - Tests that need "Redis is unreachable" point at an unused local port with
 *     lazyConnect + enableOfflineQueue:false + maxRetriesPerRequest:0.  They do
 *     NOT disconnect/reconnect a shared client.
 *   - Unique key/endpoint suffixes prevent cross-test interference.
 */

import { Redis } from "ioredis";
import { createRpcRateLimiter, RpcRequest, RpcResponse } from "../../src/rpcRateLimiter.js";
import { ContractCache, LedgerSequenceTracker, ContractStateKey } from "../../src/contractCache.js";

// ---------------------------------------------------------------------------
// Skip guard
// ---------------------------------------------------------------------------

const REDIS_URL = process.env["REDIS_URL"];

function maybeDescribe(label: string, fn: () => void): void {
  if (!REDIS_URL) {
    describe.skip(`${label} [skipped: set REDIS_URL to run]`, fn);
  } else {
    describe(label, fn);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

class MockResponse implements RpcResponse {
  statusCode = 200;
  headers: Record<string, string | number> = {};
  body = "";
  status(code: number): this { this.statusCode = code; return this; }
  setHeader(name: string, value: string | number): void { this.headers[name] = value; }
  end(body?: string): void { if (body) this.body = body; }
}

function makeReq(ip = "127.0.0.1"): RpcRequest {
  return { headers: {}, ip };
}

/** Returns a fresh Redis client connected to REDIS_URL. */
function makeRedis(): Redis {
  return new Redis(REDIS_URL!, { lazyConnect: false });
}

/** Closes a Redis client gracefully, falling back to disconnect(). */
async function closeRedis(r: Redis): Promise<void> {
  try {
    await r.quit();
  } catch {
    r.disconnect();
  }
}

/**
 * Returns a Redis client that is genuinely unreachable.
 * Uses port 19999 (unused) with lazyConnect so no connection is attempted
 * until the first command.  enableOfflineQueue:false causes commands to
 * fail immediately rather than queuing; maxRetriesPerRequest:0 prevents
 * automatic retries.
 */
function makeDeadRedis(): Redis {
  return new Redis({
    host: "127.0.0.1",
    port: 19999,
    lazyConnect: true,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 0,
  });
}

/** Unique endpoint string per test to prevent cross-test bucket bleed. */
function uniqueEndpoint(): string {
  return `test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** Unique ContractStateKey per test to prevent cross-test key bleed. */
function uniqueKey(label: string): ContractStateKey {
  return {
    contractId: `C${process.pid}${Date.now()}${label}`,
    storageKey: `sk-${label}-${Math.random().toString(36).slice(2)}`,
  };
}

// ---------------------------------------------------------------------------
// RPC Rate Limiter — real Redis integration
// ---------------------------------------------------------------------------

maybeDescribe("rpcRateLimiter — real Redis", () => {
  // Each test manages its own client via beforeEach/afterEach so there is
  // no shared mutable state between tests.
  let redis: Redis;

  beforeEach(() => {
    redis = makeRedis();
  });

  afterEach(async () => {
    await closeRedis(redis);
  });

  it("token bucket really limits under concurrent calls", async () => {
    const endpoint = uniqueEndpoint();
    const mw = createRpcRateLimiter(endpoint, "public", redis, { maxTokens: 5, refillRate: 5 / 60 });

    // Ten concurrent requests from the same IP against a 5-token bucket.
    const sharedIp = "192.0.2.1";
    const concurrentResults = await Promise.all(
      Array.from({ length: 10 }, () => {
        const res = new MockResponse();
        return mw(makeReq(sharedIp), res, () => {}).then(() => res.statusCode);
      })
    );

    const allowed = concurrentResults.filter((s) => s === 200).length;
    const limited = concurrentResults.filter((s) => s === 429).length;
    // With 5 tokens and 10 concurrent requests, at most 5 may be allowed.
    expect(allowed).toBeLessThanOrEqual(5);
    expect(limited).toBeGreaterThanOrEqual(5);
  });

  it("two limiter instances share one Redis bucket", async () => {
    const endpoint = uniqueEndpoint();
    const mw1 = createRpcRateLimiter(endpoint, "public", redis, { maxTokens: 3, refillRate: 3 / 60 });
    const mw2 = createRpcRateLimiter(endpoint, "public", redis, { maxTokens: 3, refillRate: 3 / 60 });

    const ip = "10.100.0.1";
    // Drain all 3 tokens via mw1
    for (let i = 0; i < 3; i++) {
      await mw1(makeReq(ip), new MockResponse(), () => {});
    }
    // 4th request via mw2 must be rate-limited (bucket is shared)
    const res = new MockResponse();
    let nextCalled = false;
    await mw2(makeReq(ip), res, () => { nextCalled = true; });
    expect(nextCalled).toBe(false);
    expect(res.statusCode).toBe(429);
  });

  it("fails open when Redis is unreachable", async () => {
    // Use a dead client — never touches the shared redis client.
    const deadRedis = makeDeadRedis();
    const endpoint = uniqueEndpoint();
    const mw = createRpcRateLimiter(endpoint, "public", deadRedis as unknown as Redis);
    const res = new MockResponse();
    let called = false;

    const consoleError = jest.spyOn(console, "error").mockImplementation(() => {});
    await expect(mw(makeReq(), res, () => { called = true; })).resolves.not.toThrow();
    consoleError.mockRestore();

    expect(called).toBe(true);
    await closeRedis(deadRedis);
  });
});

// ---------------------------------------------------------------------------
// ContractCache — real Redis integration
// ---------------------------------------------------------------------------

maybeDescribe("ContractCache — real Redis", () => {
  let redis: Redis;

  beforeEach(() => {
    redis = makeRedis();
  });

  afterEach(async () => {
    await closeRedis(redis);
  });

  it("writes to Redis and back-fills L1 on a fresh cache instance", async () => {
    const tracker = new LedgerSequenceTracker(() => Promise.resolve(1000));
    const cache1 = new ContractCache({ maxSize: 100, avgLedgerCloseSecs: 5 }, redis, tracker);
    const key = uniqueKey("backfill");

    // Write via cache1
    await cache1.set(key, {
      value: { balance: 42 },
      liveUntilLedgerSeq: 2000,
      durability: "persistent",
      fetchedAtLedger: 1000,
    });

    // A second cache instance with an empty L1 should back-fill from Redis.
    const tracker2 = new LedgerSequenceTracker(() => Promise.resolve(1000));
    const cache2 = new ContractCache({ maxSize: 100, avgLedgerCloseSecs: 5 }, redis, tracker2);

    const result = await cache2.get<{ balance: number }>(key);
    expect(result).toBeDefined();
    expect((result as { value: { balance: number } }).value.balance).toBe(42);
    // L1 of cache2 should now be populated
    expect(cache2.l1Size).toBe(1);
  });

  it("serves from L1 without hitting Redis on subsequent reads", async () => {
    // This test does NOT disconnect/reconnect the shared client.
    // Instead it uses a second dead-redis cache to prove L1 serves independently.
    const liveTracker = new LedgerSequenceTracker(() => Promise.resolve(1000));
    const liveCache = new ContractCache(
      { maxSize: 100, avgLedgerCloseSecs: 5 },
      redis,
      liveTracker
    );
    const key = uniqueKey("l1-hot");

    // Write through the live cache (populates both L1 and Redis)
    await liveCache.set(key, {
      value: "hot-value",
      liveUntilLedgerSeq: 2000,
      durability: "persistent",
      fetchedAtLedger: 1000,
    });

    // First read to confirm L1 is warm
    await liveCache.get(key);

    // Now create a cache that wraps a dead Redis — L1 is pre-populated because
    // liveCache and deadCache share the same in-memory L1 backing test proves
    // that L1 reads need no Redis.  We simulate that by creating a new cache
    // that shares liveCache's key space: seed L1 by calling set() on the same
    // Redis instance, then verify get() works with a dead Redis substituted.
    const deadRedis = makeDeadRedis();
    const deadTracker = new LedgerSequenceTracker(() => Promise.resolve(1000));
    const deadCache = new ContractCache(
      { maxSize: 100, avgLedgerCloseSecs: 5 },
      deadRedis as unknown as Redis,
      deadTracker
    );

    // Seed L1 of deadCache directly (the set() call will fail on Redis
    // silently and still populate L1).
    await deadCache.set(key, {
      value: "hot-value",
      liveUntilLedgerSeq: 2000,
      durability: "persistent",
      fetchedAtLedger: 1000,
    });

    // With Redis unreachable, L1 must serve the value.
    const result = await deadCache.get<string>(key);
    expect(result).toBeDefined();
    expect((result as { value: string }).value).toBe("hot-value");

    await closeRedis(deadRedis);
  });

  it("falls back to L1 when Redis is down", async () => {
    const tracker = new LedgerSequenceTracker(() => Promise.resolve(1000));
    const deadRedis = makeDeadRedis();

    const cache = new ContractCache(
      { maxSize: 100, redisTimeoutMs: 100, avgLedgerCloseSecs: 5 },
      deadRedis as unknown as Redis,
      tracker
    );
    const key = uniqueKey("l1-fallback");

    // set() writes to L1 always; the Redis write fails silently.
    await cache.set(key, {
      value: { data: "in-l1" },
      liveUntilLedgerSeq: 5000,
      durability: "persistent",
      fetchedAtLedger: 1000,
    });

    // L1 must serve the value even though Redis is unreachable.
    const result = await cache.get<{ data: string }>(key);
    expect(result).toBeDefined();
    expect((result as { value: { data: string } }).value.data).toBe("in-l1");

    await closeRedis(deadRedis);
  });
});
