/**
 * Tests for the Soroban contract state cache (LRU + Redis).
 */

import { LRUCache, ContractCache, encodeContractKey, ContractStateKey } from "../src/contractCache.js";

// ---------------------------------------------------------------------------
// Mock Redis
// ---------------------------------------------------------------------------

class MockRedis {
  private store: Map<string, { value: string; expiresAt: number }> = new Map();
  private latencyMs = 0;
  private shouldError = false;

  setLatency(ms: number): void { this.latencyMs = ms; }
  setError(error: boolean): void { this.shouldError = error; }

  private async delay(): Promise<void> {
    if (this.latencyMs > 0) await new Promise((r) => setTimeout(r, this.latencyMs));
  }

  async get(key: string): Promise<string | null> {
    await this.delay();
    if (this.shouldError) throw new Error("Redis connection error");
    const entry = this.store.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) { this.store.delete(key); return null; }
    return entry.value;
  }

  async set(key: string, value: string, _mode?: string, ttl?: number): Promise<string> {
    await this.delay();
    if (this.shouldError) throw new Error("Redis connection error");
    this.store.set(key, { value, expiresAt: Date.now() + (ttl ?? 300) * 1000 });
    return "OK";
  }

  async del(key: string): Promise<number> {
    await this.delay();
    if (this.shouldError) throw new Error("Redis connection error");
    const existed = this.store.has(key);
    this.store.delete(key);
    return existed ? 1 : 0;
  }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeKey(contractId = "CAAAAA", storageKey = "balance"): ContractStateKey {
  return { contractId, storageKey };
}

// ---------------------------------------------------------------------------
// encodeContractKey
// ---------------------------------------------------------------------------

describe("encodeContractKey", () => {
  it("produces a stable string from a ContractStateKey", () => {
    const key = makeKey("CCONTRACT123", "owner");
    expect(encodeContractKey(key)).toBe("soroban:CCONTRACT123:owner");
  });

  it("two keys with same contractId + storageKey produce the same cache key", () => {
    const a = makeKey("CA", "k");
    const b = makeKey("CA", "k");
    expect(encodeContractKey(a)).toBe(encodeContractKey(b));
  });

  it("different storageKeys produce different cache keys", () => {
    expect(encodeContractKey(makeKey("CA", "k1"))).not.toBe(encodeContractKey(makeKey("CA", "k2")));
  });
});

// ---------------------------------------------------------------------------
// LRUCache
// ---------------------------------------------------------------------------

describe("LRUCache", () => {
  it("stores and retrieves Soroban contract state values", () => {
    const cache = new LRUCache<string>(10);
    cache.set("soroban:CA:balance", "1000", 60);
    expect(cache.get("soroban:CA:balance")).toBe("1000");
  });

  it("returns undefined for missing keys", () => {
    const cache = new LRUCache<string>(10);
    expect(cache.get("missing")).toBeUndefined();
  });

  it("returns undefined for expired entries", async () => {
    const cache = new LRUCache<string>(10);
    cache.set("short", "value", 0.01); // 10ms TTL
    await new Promise((r) => setTimeout(r, 20));
    expect(cache.get("short")).toBeUndefined();
  });

  it("evicts least recently used entry at capacity", () => {
    const cache = new LRUCache<number>(3);
    cache.set("a", 1, 60);
    cache.set("b", 2, 60);
    cache.set("c", 3, 60);
    cache.get("a"); // access 'a', making 'b' the LRU
    cache.set("d", 4, 60); // should evict 'b'
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("a")).toBe(1);
    expect(cache.get("c")).toBe(3);
    expect(cache.get("d")).toBe(4);
  });

  it("returns deep clone to prevent external mutation of contract state", () => {
    const cache = new LRUCache<{ balance: number }>(10);
    cache.set("obj", { balance: 500 }, 60);
    const first = cache.get("obj")!;
    first.balance = 999; // mutate the copy
    expect(cache.get("obj")!.balance).toBe(500); // original must be unchanged
  });

  it("throws for maxSize < 1", () => {
    expect(() => new LRUCache<string>(0)).toThrow(RangeError);
  });
});

// ---------------------------------------------------------------------------
// ContractCache
// ---------------------------------------------------------------------------

describe("ContractCache", () => {
  let redis: MockRedis;
  let cache: ContractCache;

  beforeEach(() => {
    redis = new MockRedis();
    cache = new ContractCache({ maxSize: 100, redisTimeoutMs: 200 }, redis as never);
  });

  describe("basic get/set", () => {
    it("stores and retrieves Soroban contract state", async () => {
      const key = makeKey("CA", "balance");
      await cache.set(key, "5000", 30);
      const result = await cache.get<string>(key);
      expect(result).toBe("5000");
    });

    it("returns undefined on cache miss", async () => {
      const result = await cache.get<string>(makeKey("CA", "nonexistent"));
      expect(result).toBeUndefined();
    });

    it("stores complex contract state objects", async () => {
      const key = makeKey("CA", "auction_state");
      const state = { highBid: 1000, bidder: "GABC...", endsAt: 1234567890 };
      await cache.set(key, state, 30);
      expect(await cache.get(key)).toEqual(state);
    });
  });

  describe("L1 hot-cache priority", () => {
    it("serves contract state from L1 without hitting Redis", async () => {
      const key = makeKey("CA", "balance");
      await cache.set(key, "1000", 30);
      redis.setLatency(500); // high latency — L1 should be used
      const start = Date.now();
      const result = await cache.get<string>(key);
      expect(result).toBe("1000");
      expect(Date.now() - start).toBeLessThan(100);
    });

    it("back-fills L1 from Redis on L1 miss", async () => {
      const key = makeKey("CB", "owner");
      const cacheKey = encodeContractKey(key);
      await redis.set(cacheKey, JSON.stringify({ value: "GBOB...", ttl: 30 }), "EX", 30);
      const first = await cache.get<string>(key);
      expect(first).toBe("GBOB...");
      // Second read should hit L1
      redis.setLatency(500);
      const start = Date.now();
      const second = await cache.get<string>(key);
      expect(second).toBe("GBOB...");
      expect(Date.now() - start).toBeLessThan(100);
    });
  });

  describe("Redis fallback (graceful degradation)", () => {
    it("falls back to L1 when Redis times out", async () => {
      const key = makeKey("CA", "balance");
      await cache.set(key, "999", 30);
      redis.setLatency(500); // > 200ms timeout
      const start = Date.now();
      const result = await cache.get<string>(key);
      expect(result).toBe("999");
      expect(Date.now() - start).toBeLessThan(250);
    }, 5000);

    it("does not throw when Redis is down", async () => {
      redis.setError(true);
      await expect(cache.get<string>(makeKey("CA", "x"))).resolves.toBeUndefined();
    });

    it("stores in L1 even when Redis write fails", async () => {
      redis.setError(true);
      const key = makeKey("CA", "supply");
      await cache.set(key, "1000000", 30);
      redis.setError(false);
      redis.setLatency(500);
      const result = await cache.get<string>(key);
      expect(result).toBe("1000000");
    }, 5000);
  });

  describe("delete", () => {
    it("removes contract state from both L1 and Redis", async () => {
      const key = makeKey("CA", "balance");
      await cache.set(key, "500", 30);
      await cache.delete(key);
      expect(await cache.get<string>(key)).toBeUndefined();
    });
  });

  describe("getOrFetch — stampede prevention", () => {
    it("calls fetch only once for concurrent requests to the same contract key", async () => {
      let fetchCount = 0;
      const fetch = async () => {
        fetchCount++;
        await new Promise((r) => setTimeout(r, 20));
        return "contract-value";
      };
      const key = makeKey("CA", "balance");
      const results = await Promise.all(
        Array.from({ length: 5 }, () => cache.getOrFetch<string>(key, fetch, 30))
      );
      expect(fetchCount).toBe(1);
      results.forEach((r) => expect(r).toBe("contract-value"));
    });

    it("does not call fetch again on subsequent reads", async () => {
      let fetchCount = 0;
      const key = makeKey("CA", "balance");
      const fetch = async () => { fetchCount++; return "val"; };
      await cache.getOrFetch(key, fetch, 30);
      await cache.getOrFetch(key, fetch, 30);
      await cache.getOrFetch(key, fetch, 30);
      expect(fetchCount).toBe(1);
    });
  });

  describe("no-Redis mode", () => {
    it("works as a pure L1 LRU cache without Redis", async () => {
      const localCache = new ContractCache({ maxSize: 10 });
      const key = makeKey("CA", "data");
      await localCache.set(key, "stellar", 30);
      expect(await localCache.get<string>(key)).toBe("stellar");
    });
  });
});
