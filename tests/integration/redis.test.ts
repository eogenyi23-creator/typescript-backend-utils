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
 */

import { Redis } from "ioredis";
import { createRpcRateLimiter, RpcRateLimiter, RpcRequest, RpcResponse } from "../../src/rpcRateLimiter.js";
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

class MockResponse {
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

/** Unique key prefix per test run to avoid cross-test bleed in a shared Redis. */
function uniqueEndpoint(): string {
  return `test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

// ---------------------------------------------------------------------------
// RPC Rate Limiter — real Redis integration
// ---------------------------------------------------------------------------

maybeDescribe("rpcRateLimiter — real Redis", () => {
  let redis: Redis;

  beforeAll(() => {
    redis = new Redis(REDIS_URL!);
  });

  afterAll(async () => {
    await redis.quit();
  });

  it("token bucket really limits under concurrent calls", async () => {
    const endpoint = uniqueEndpoint();
    const mw = createRpcRateLimiter(endpoint, "public", redis, { maxTokens: 5, refillRate: 5 / 60 });

    // Fire 10 concurrent requests against a 5-token bucket.
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) => {
        const res = new MockResponse();
        return mw(makeReq(`10.0.0.${i}`), res, () => {}).then(() => res.statusCode);
      })
    );

    // All use the same IP implicitly (we vary IPs so each call gets its own bucket;
    // use a single IP below to test real contention on one bucket).
    const sharedIp = "192.0.2.1";
    const concurrentResults = await Promise.all(
      Array.from({ length: 10 }, () => {
        const res = new MockResponse();
        return mw(makeReq(sharedIp), res, () => {}).then(() => res.statusCode);
      })
    );

    const allowed = concurrentResults.filter((s) => s === 200).length;
    const limited = concurrentResults.filter((s) => s === 429).length;
    // With 5 tokens and 10 concurrent requests, some must be limited.
    expect(allowed).toBeLessThanOrEqual(5);
    expect(limited).toBeGreaterThanOrEqual(5);
    void results; // suppress unused warning
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
    let next = false;
    await mw2(makeReq(ip), res, () => { next = true; });
    expect(next).toBe(false);
    expect(res.statusCode).toBe(429);
  });

  it("fails open when Redis is unreachable", async () => {
    // Connect to a port where nothing is listening.
    const deadRedis = new Redis({ host: "127.0.0.1", port: 19999, lazyConnect: true,
      enableOfflineQueue: false, maxRetriesPerRequest: 0 });
    const endpoint = uniqueEndpoint();
    const mw = createRpcRateLimiter(endpoint, "public", deadRedis as unknown as Redis);
    const res = new MockResponse();
    let called = false;

    // Should not throw; should call next() (fail-open)
    const consoleError = jest.spyOn(console, "error").mockImplementation(() => {});
    await expect(mw(makeReq(), res, () => { called = true; })).resolves.not.toThrow();
    consoleError.mockRestore();

    expect(called).toBe(true);
    await deadRedis.quit().catch(() => {});
  });
});

// ---------------------------------------------------------------------------
// ContractCache — real Redis integration
// ---------------------------------------------------------------------------

maybeDescribe("ContractCache — real Redis", () => {
  let redis: Redis;

  beforeAll(() => {
    redis = new Redis(REDIS_URL!);
  });

  afterAll(async () => {
    await redis.quit();
  });

  function uniqueKey(label: string): ContractStateKey {
    return {
      contractId: `C${process.pid}${Date.now()}${label}`,
      storageKey: `sk-${label}`,
    };
  }

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
    const tracker = new LedgerSequenceTracker(() => Promise.resolve(1000));
    const cache = new ContractCache({ maxSize: 100, avgLedgerCloseSecs: 5 }, redis, tracker);
    const key = uniqueKey("l1-hot");

    await cache.set(key, {
      value: "hot-value",
      liveUntilLedgerSeq: 2000,
      durability: "persistent",
      fetchedAtLedger: 1000,
    });

    // First read populates L1
    await cache.get(key);
    // Now disconnect Redis — L1 should still serve
    await redis.disconnect();

    const result = await cache.get<string>(key);
    expect(result).toBeDefined();
    expect((result as { value: string }).value).toBe("hot-value");

    // Reconnect for subsequent tests
    await redis.connect();
  });

  it("falls back to L1 when Redis is down", async () => {
    const tracker = new LedgerSequenceTracker(() => Promise.resolve(1000));
    const deadRedis = new Redis({ host: "127.0.0.1", port: 19999, lazyConnect: true,
      enableOfflineQueue: false, maxRetriesPerRequest: 0 });

    const cache = new ContractCache(
      { maxSize: 100, redisTimeoutMs: 100, avgLedgerCloseSecs: 5 },
      deadRedis as unknown as Redis,
      tracker
    );
    const key = uniqueKey("l1-fallback");

    // Manually seed L1 by setting via a healthy cache first, then read with the dead-redis cache.
    // Since the dead-redis cache can't reach Redis, it starts with an empty L1.
    // Set directly into L1 by calling set() — the Redis write will fail silently.
    await cache.set(key, {
      value: { data: "in-l1" },
      liveUntilLedgerSeq: 5000,
      durability: "persistent",
      fetchedAtLedger: 1000,
    });

    // L1 should have been populated even if Redis write failed
    const result = await cache.get<{ data: string }>(key);
    expect(result).toBeDefined();
    expect((result as { value: { data: string } }).value.data).toBe("in-l1");

    await deadRedis.quit().catch(() => {});
  });
});
