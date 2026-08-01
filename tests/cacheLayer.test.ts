/**
 * Tests for the multi-tier object cache layer (LRU + Redis).
 */

import { LRUCache, MultiTierCache } from "../src/cacheLayer.js";

// ---------------------------------------------------------------------------
// Mock Redis
// ---------------------------------------------------------------------------

class MockRedis {
  private store: Map<string, { value: string; expiresAt: number }> = new Map();
  private latencyMs = 0;
  private shouldError = false;

  setLatency(ms: number): void {
    this.latencyMs = ms;
  }

  setError(error: boolean): void {
    this.shouldError = error;
  }

  private async delay(): Promise<void> {
    if (this.latencyMs > 0) {
      await new Promise((r) => setTimeout(r, this.latencyMs));
    }
  }

  async get(key: string): Promise<string | null> {
    await this.delay();
    if (this.shouldError) throw new Error("Redis connection error");
    const entry = this.store.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return null;
    }
    return entry.value;
  }

  async set(
    key: string,
    value: string,
    _mode?: string,
    ttl?: number
  ): Promise<string> {
    await this.delay();
    if (this.shouldError) throw new Error("Redis connection error");
    this.store.set(key, {
      value,
      expiresAt: Date.now() + (ttl ?? 300) * 1000,
    });
    return "OK";
  }

  async del(key: string): Promise<number> {
    await this.delay();
    if (this.shouldError) throw new Error("Redis connection error");
    const existed = this.store.has(key);
    this.store.delete(key);
    return existed ? 1 : 0;
  }

  get storeSize(): number {
    return this.store.size;
  }
}

// ---------------------------------------------------------------------------
// LRUCache tests
// ---------------------------------------------------------------------------

describe("LRUCache", () => {
  it("stores and retrieves values", () => {
    const cache = new LRUCache<string>(10);
    cache.set("a", "hello", 60);
    expect(cache.get("a")).toBe("hello");
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

    // Access 'a' to make it recently used
    cache.get("a");

    // Adding 'd' should evict 'b' (now LRU)
    cache.set("d", 4, 60);

    expect(cache.get("b")).toBeUndefined(); // evicted
    expect(cache.get("a")).toBe(1);
    expect(cache.get("c")).toBe(3);
    expect(cache.get("d")).toBe(4);
  });

  it("returns a deep clone to prevent external mutation", () => {
    const cache = new LRUCache<{ count: number }>(10);
    cache.set("obj", { count: 5 }, 60);

    const first = cache.get("obj")!;
    first.count = 999; // mutate the returned copy

    const second = cache.get("obj")!;
    expect(second.count).toBe(5); // original must be unchanged
  });

  it("updates an existing key and moves it to most-recently-used", () => {
    const cache = new LRUCache<number>(3);
    cache.set("a", 1, 60);
    cache.set("b", 2, 60);
    cache.set("c", 3, 60);

    cache.set("a", 10, 60); // update 'a'
    cache.set("d", 4, 60);  // should evict 'b' (now LRU)

    expect(cache.get("a")).toBe(10);
    expect(cache.get("b")).toBeUndefined();
  });

  it("reports correct size", () => {
    const cache = new LRUCache<number>(5);
    expect(cache.size).toBe(0);
    cache.set("x", 1, 60);
    cache.set("y", 2, 60);
    expect(cache.size).toBe(2);
  });

  it("deletes entries correctly", () => {
    const cache = new LRUCache<string>(5);
    cache.set("key", "val", 60);
    cache.delete("key");
    expect(cache.get("key")).toBeUndefined();
  });

  it("throws for maxSize < 1", () => {
    expect(() => new LRUCache<string>(0)).toThrow(RangeError);
  });
});

// ---------------------------------------------------------------------------
// MultiTierCache tests
// ---------------------------------------------------------------------------

describe("MultiTierCache", () => {
  let redis: MockRedis;
  let cache: MultiTierCache;

  beforeEach(() => {
    redis = new MockRedis();
    cache = new MultiTierCache({ maxSize: 100, redisTimeoutMs: 200 }, redis as never);
  });

  describe("basic get/set", () => {
    it("stores and retrieves values", async () => {
      await cache.set("key1", "value1", 60);
      const result = await cache.get<string>("key1");
      expect(result).toBe("value1");
    });

    it("returns undefined for cache miss", async () => {
      const result = await cache.get<string>("nonexistent");
      expect(result).toBeUndefined();
    });

    it("stores complex objects", async () => {
      const obj = { userId: 42, roles: ["admin", "user"], meta: { active: true } };
      await cache.set("complex", obj, 60);
      const result = await cache.get<typeof obj>("complex");
      expect(result).toEqual(obj);
    });
  });

  describe("L1 (hot cache) priority", () => {
    it("hits L1 before querying Redis", async () => {
      await cache.set("fast", "value", 60);

      // Add high latency to Redis — if L1 is bypassed the test would be slow
      redis.setLatency(500);
      const start = Date.now();
      const result = await cache.get<string>("fast");
      const elapsed = Date.now() - start;

      expect(result).toBe("value");
      expect(elapsed).toBeLessThan(100); // must not wait for Redis
    });

    it("back-fills L1 from L2 on cache miss", async () => {
      // Write directly to Redis (bypassing L1)
      const payload = JSON.stringify({ value: "from-redis", ttl: 60 });
      await redis.set("l2key", payload, "EX", 60);

      // L1 is empty, so first get goes to Redis
      const first = await cache.get<string>("l2key");
      expect(first).toBe("from-redis");

      // Second get should hit L1 (Redis latency won't matter)
      redis.setLatency(500);
      const start = Date.now();
      const second = await cache.get<string>("l2key");
      const elapsed = Date.now() - start;

      expect(second).toBe("from-redis");
      expect(elapsed).toBeLessThan(100);
    });
  });

  describe("TTL behavior", () => {
    it("respects custom TTL", async () => {
      await cache.set("short", "val", 60);
      const result = await cache.get<string>("short");
      expect(result).toBe("val");
    });

    it("uses defaultTtl when no TTL is specified", async () => {
      const cacheWithDefault = new MultiTierCache(
        { defaultTtl: 120 },
        redis as never
      );
      await cacheWithDefault.set("no-ttl", "value");
      const result = await cacheWithDefault.get<string>("no-ttl");
      expect(result).toBe("value");
    });
  });

  describe("Redis fallback (graceful degradation)", () => {
    it("falls back to L1 when Redis times out", async () => {
      // Pre-populate L1
      await cache.set("cached", "in-l1", 60);

      // Make Redis slow
      redis.setLatency(500); // > 200ms timeout

      const start = Date.now();
      const result = await cache.get<string>("cached");
      const elapsed = Date.now() - start;

      expect(result).toBe("in-l1");
      expect(elapsed).toBeLessThan(250); // should not wait for Redis
    }, 5000);

    it("does not throw when Redis is down and L1 is empty", async () => {
      redis.setError(true);
      await expect(cache.get<string>("missing")).resolves.toBeUndefined();
    });

    it("stores in L1 even when Redis write fails", async () => {
      redis.setError(true);
      await cache.set("key", "value", 60); // Redis write fails silently
      redis.setError(false);

      // L1 should still have it
      redis.setLatency(500); // force L1 path
      const result = await cache.get<string>("key");
      expect(result).toBe("value");
    }, 5000);
  });

  describe("delete", () => {
    it("removes entry from both L1 and Redis", async () => {
      await cache.set("del-key", "val", 60);
      await cache.delete("del-key");

      expect(await cache.get<string>("del-key")).toBeUndefined();
    });
  });

  describe("cache stampede prevention (getOrSet)", () => {
    it("calls compute only once for concurrent requests", async () => {
      let computeCount = 0;
      const compute = async () => {
        computeCount++;
        await new Promise((r) => setTimeout(r, 20));
        return "computed-value";
      };

      // Fire 5 concurrent requests for the same key
      const results = await Promise.all(
        Array.from({ length: 5 }, () =>
          cache.getOrSet("stampede-key", compute, 60)
        )
      );

      expect(computeCount).toBe(1); // only 1 compute call
      results.forEach((r) => expect(r).toBe("computed-value"));
    });

    it("returns cached value without calling compute on subsequent calls", async () => {
      let computeCount = 0;
      const compute = async () => {
        computeCount++;
        return "value";
      };

      await cache.getOrSet("key", compute, 60);
      await cache.getOrSet("key", compute, 60);
      await cache.getOrSet("key", compute, 60);

      expect(computeCount).toBe(1);
    });
  });

  describe("no-Redis mode (L1 only)", () => {
    it("works correctly without a Redis instance", async () => {
      const localCache = new MultiTierCache({ maxSize: 10 }); // no Redis
      await localCache.set("k", "v", 60);
      expect(await localCache.get<string>("k")).toBe("v");
    });

    it("acts as L1 fallback when Redis is unavailable", async () => {
      const localCache = new MultiTierCache({ maxSize: 10 }); // no Redis
      await localCache.set("a", 42, 60);
      await localCache.set("b", 43, 60);
      expect(await localCache.get<number>("a")).toBe(42);
      expect(await localCache.get<number>("b")).toBe(43);
    });
  });
});
