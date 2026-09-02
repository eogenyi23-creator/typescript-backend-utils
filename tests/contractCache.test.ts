/**
 * Tests for the ledger-sequence-aware Soroban contract state cache.
 *
 * Key scenarios covered:
 * - Entry expiring mid-session due to ledger advancement
 * - Persistent vs temporary TTL divergence on expiry
 * - Archived-entry detection and surface
 * - LedgerSequenceTracker polling and coalescing
 * - L1/L2 fallback, stampede prevention, Redis degradation
 */

import {
  LRUCache,
  ContractCache,
  LedgerSequenceTracker,
  encodeContractKey,
  ContractStateKey,
  SorobanEntryResult,
  ContractCacheConfig,
} from "../src/contractCache.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeKey(contractId = "CAAAAA", storageKey = "balance"): ContractStateKey {
  return { contractId, storageKey };
}

function makeEntry<T>(
  value: T,
  opts: {
    liveUntilLedgerSeq?: number;
    durability?: "persistent" | "temporary";
    fetchedAtLedger?: number;
  } = {}
): SorobanEntryResult<T> {
  return {
    value,
    liveUntilLedgerSeq: opts.liveUntilLedgerSeq ?? 1000,
    durability: opts.durability ?? "persistent",
    fetchedAtLedger: opts.fetchedAtLedger ?? 900,
  };
}

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
// encodeContractKey
// ---------------------------------------------------------------------------

describe("encodeContractKey", () => {
  it("produces a stable string", () => {
    expect(encodeContractKey(makeKey("CCONTRACT", "owner"))).toBe("soroban:CCONTRACT:owner");
  });

  it("same inputs → same key", () => {
    expect(encodeContractKey(makeKey("CA", "k"))).toBe(encodeContractKey(makeKey("CA", "k")));
  });

  it("different storageKeys → different cache keys", () => {
    expect(encodeContractKey(makeKey("CA", "k1"))).not.toBe(encodeContractKey(makeKey("CA", "k2")));
  });
});

// ---------------------------------------------------------------------------
// LRUCache
// ---------------------------------------------------------------------------

describe("LRUCache", () => {
  it("stores and retrieves entries", () => {
    const cache = new LRUCache<{ value: string; expiresAt: number }>(10);
    cache.set("k", { value: "hello", expiresAt: Date.now() + 60_000 });
    expect(cache.get("k")?.value).toBe("hello");
  });

  it("returns undefined for missing keys", () => {
    const cache = new LRUCache<{ value: string; expiresAt: number }>(10);
    expect(cache.get("nope")).toBeUndefined();
  });

  it("evicts expired entries on read", async () => {
    const cache = new LRUCache<{ value: string; expiresAt: number }>(10);
    cache.set("k", { value: "x", expiresAt: Date.now() + 10 });
    await new Promise((r) => setTimeout(r, 20));
    expect(cache.get("k")).toBeUndefined();
  });

  it("evicts LRU entry at capacity", () => {
    const cache = new LRUCache<{ v: number; expiresAt: number }>(3);
    cache.set("a", { v: 1, expiresAt: Date.now() + 60_000 });
    cache.set("b", { v: 2, expiresAt: Date.now() + 60_000 });
    cache.set("c", { v: 3, expiresAt: Date.now() + 60_000 });
    cache.get("a"); // promote 'a'
    cache.set("d", { v: 4, expiresAt: Date.now() + 60_000 }); // evicts 'b'
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("a")?.v).toBe(1);
    expect(cache.get("d")?.v).toBe(4);
  });

  it("returns a deep clone to prevent mutation of cached state", () => {
    const cache = new LRUCache<{ data: { balance: number }; expiresAt: number }>(10);
    cache.set("k", { data: { balance: 500 }, expiresAt: Date.now() + 60_000 });
    const first = cache.get("k")!;
    first.data.balance = 999;
    expect(cache.get("k")!.data.balance).toBe(500);
  });

  it("throws for maxSize < 1", () => {
    expect(() => new LRUCache(0)).toThrow(RangeError);
  });
});

// ---------------------------------------------------------------------------
// LedgerSequenceTracker
// ---------------------------------------------------------------------------

describe("LedgerSequenceTracker", () => {
  it("fetches the current ledger sequence", async () => {
    const tracker = new LedgerSequenceTracker(async () => 54321);
    expect(await tracker.current()).toBe(54321);
  });

  it("caches the sequence within pollIntervalMs", async () => {
    let calls = 0;
    const tracker = new LedgerSequenceTracker(async () => { calls++; return 100 + calls; }, { pollIntervalMs: 500 });
    const first = await tracker.current();
    const second = await tracker.current();
    expect(calls).toBe(1);
    expect(first).toBe(second);
  });

  it("re-fetches after pollIntervalMs elapses", async () => {
    let seq = 100;
    const tracker = new LedgerSequenceTracker(async () => seq++, { pollIntervalMs: 20 });
    const first = await tracker.current();
    await new Promise((r) => setTimeout(r, 30));
    const second = await tracker.current();
    expect(second).toBeGreaterThan(first);
  });

  it("coalesces concurrent callers onto one network request", async () => {
    let calls = 0;
    const tracker = new LedgerSequenceTracker(async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 10));
      return 42;
    });
    const results = await Promise.all([tracker.current(), tracker.current(), tracker.current()]);
    expect(calls).toBe(1);
    expect(results).toEqual([42, 42, 42]);
  });

  it("seed() sets the sequence without a network call", async () => {
    const tracker = new LedgerSequenceTracker(async () => { throw new Error("should not fetch"); });
    tracker.seed(9999);
    expect(await tracker.current()).toBe(9999);
    expect(tracker.lastKnown).toBe(9999);
  });

  it("falls back gracefully when fetch throws", async () => {
    const tracker = new LedgerSequenceTracker(async () => { throw new Error("RPC down"); });
    await expect(tracker.current()).rejects.toThrow("RPC down");
  });
});

// ---------------------------------------------------------------------------
// ContractCache — basic get/set
// ---------------------------------------------------------------------------

describe("ContractCache — basic get/set", () => {
  let cache: ContractCache;
  let tracker: LedgerSequenceTracker;

  beforeEach(() => {
    tracker = new LedgerSequenceTracker(async () => 900);
    tracker.seed(900);
    cache = new ContractCache({ maxSize: 100, avgLedgerCloseSecs: 5 }, null, tracker);
  });

  it("stores and retrieves a persistent contract state entry", async () => {
    const key = makeKey("CA", "balance");
    await cache.set(key, makeEntry("5000", { liveUntilLedgerSeq: 1000, fetchedAtLedger: 900 }));
    const result = await cache.get(key);
    expect(result).not.toBeUndefined();
    expect((result as { value: string }).value).toBe("5000");
  });

  it("returns undefined on cache miss", async () => {
    expect(await cache.get(makeKey("CA", "nonexistent"))).toBeUndefined();
  });

  it("stores complex contract state objects", async () => {
    const key = makeKey("CA", "auction");
    const state = { highBid: 1000, bidder: "GABC", endsAtLedger: 2000 };
    await cache.set(key, makeEntry(state, { liveUntilLedgerSeq: 1000, fetchedAtLedger: 900 }));
    const result = await cache.get(key);
    expect((result as { value: typeof state }).value).toEqual(state);
  });

  it("seeds the ledger tracker with fetchedAtLedger on set", async () => {
    await cache.set(makeKey("CA", "k"), makeEntry("v", { liveUntilLedgerSeq: 1000, fetchedAtLedger: 950 }));
    expect(tracker.lastKnown).toBe(950);
  });
});

// ---------------------------------------------------------------------------
// ContractCache — ledger-sequence expiry mid-session
// ---------------------------------------------------------------------------

describe("ContractCache — ledger-sequence expiry mid-session", () => {
  it("returns a live entry when current ledger < liveUntilLedgerSeq", async () => {
    const tracker = new LedgerSequenceTracker(async () => 900);
    tracker.seed(900);
    const cache = new ContractCache({}, null, tracker);

    await cache.set(makeKey(), makeEntry("alive", { liveUntilLedgerSeq: 950, fetchedAtLedger: 900 }));
    const result = await cache.get(makeKey());
    expect(result).not.toBeUndefined();
    expect("entryArchived" in result!).toBe(false);
  });

  it("returns undefined for a temporary entry once ledger advances past liveUntilLedgerSeq", async () => {
    // Start at ledger 900, entry expires at 910
    let currentLedger = 900;
    const tracker = new LedgerSequenceTracker(async () => currentLedger, { pollIntervalMs: 0 });
    const cache = new ContractCache({}, null, tracker);

    await cache.set(makeKey(), makeEntry("temp-value", {
      liveUntilLedgerSeq: 910,
      durability: "temporary",
      fetchedAtLedger: 900,
    }));

    // Advance ledger past expiry
    currentLedger = 911;

    const result = await cache.get(makeKey());
    expect(result).toBeUndefined(); // temporary entries just disappear
  });

  it("returns ArchivedEntryResult for a persistent entry once ledger advances past liveUntilLedgerSeq", async () => {
    let currentLedger = 900;
    const tracker = new LedgerSequenceTracker(async () => currentLedger, { pollIntervalMs: 0 });
    const cache = new ContractCache({}, null, tracker);

    const key = makeKey("CPERSIST", "state");
    await cache.set(key, makeEntry("persist-value", {
      liveUntilLedgerSeq: 910,
      durability: "persistent",
      fetchedAtLedger: 900,
    }));

    // Advance ledger past expiry
    currentLedger = 920;

    const result = await cache.get(key);
    expect(result).not.toBeUndefined();
    expect((result as { entryArchived: boolean }).entryArchived).toBe(true);
    const archived = result as { entryArchived: true; liveUntilLedgerSeq: number; durability: string };
    expect(archived.liveUntilLedgerSeq).toBe(910);
    expect(archived.durability).toBe("persistent");
  });

  it("returns ArchivedEntryResult when liveUntilLedgerSeq === 0", async () => {
    const tracker = new LedgerSequenceTracker(async () => 900);
    tracker.seed(900);
    const cache = new ContractCache({}, null, tracker);

    await cache.set(makeKey(), makeEntry("value", {
      liveUntilLedgerSeq: 0,  // RPC signals entry is not live
      durability: "persistent",
      fetchedAtLedger: 900,
    }));

    const result = await cache.get(makeKey());
    expect((result as { entryArchived: boolean }).entryArchived).toBe(true);
  });

  it("evicts the L1 entry after detecting a persistent entry is archived", async () => {
    let currentLedger = 900;
    const tracker = new LedgerSequenceTracker(async () => currentLedger, { pollIntervalMs: 0 });
    const cache = new ContractCache({}, null, tracker);

    await cache.set(makeKey(), makeEntry("v", { liveUntilLedgerSeq: 910, durability: "persistent", fetchedAtLedger: 900 }));
    expect(cache.l1Size).toBe(1);

    currentLedger = 920;
    await cache.get(makeKey()); // triggers eviction

    expect(cache.l1Size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// ContractCache — persistent vs temporary TTL divergence
// ---------------------------------------------------------------------------

describe("ContractCache — persistent vs temporary durability", () => {
  it("persistent entry: archived after expiry, not silently dropped", async () => {
    let ledger = 500;
    const tracker = new LedgerSequenceTracker(async () => ledger, { pollIntervalMs: 0 });
    const cache = new ContractCache({}, null, tracker);

    await cache.set(makeKey(), makeEntry("data", {
      liveUntilLedgerSeq: 600,
      durability: "persistent",
      fetchedAtLedger: 500,
    }));

    // Still live
    ledger = 599;
    let result = await cache.get(makeKey());
    expect("entryArchived" in result!).toBe(false);

    // Just expired
    ledger = 601;
    result = await cache.get(makeKey());
    expect((result as { entryArchived: boolean }).entryArchived).toBe(true);
  });

  it("temporary entry: plain miss after expiry, no archived signal", async () => {
    let ledger = 500;
    const tracker = new LedgerSequenceTracker(async () => ledger, { pollIntervalMs: 0 });
    const cache = new ContractCache({}, null, tracker);

    await cache.set(makeKey(), makeEntry("tmp", {
      liveUntilLedgerSeq: 600,
      durability: "temporary",
      fetchedAtLedger: 500,
    }));

    ledger = 601;
    const result = await cache.get(makeKey());
    expect(result).toBeUndefined(); // not archived, just gone
  });

  it("temporary entry does NOT return entryArchived even well past its TTL", async () => {
    let ledger = 500;
    const tracker = new LedgerSequenceTracker(async () => ledger, { pollIntervalMs: 0 });
    const cache = new ContractCache({}, null, tracker);

    await cache.set(makeKey(), makeEntry("tmp", {
      liveUntilLedgerSeq: 550,
      durability: "temporary",
      fetchedAtLedger: 500,
    }));

    ledger = 10_000; // far in the future
    const result = await cache.get(makeKey());
    // Must be undefined, not an archived result
    expect(result).toBeUndefined();
    if (result !== undefined) {
      expect("entryArchived" in result).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// ContractCache — getOrFetch
// ---------------------------------------------------------------------------

describe("ContractCache — getOrFetch", () => {
  it("returns { entryArchived: false, value } for a live entry", async () => {
    const tracker = new LedgerSequenceTracker(async () => 900);
    tracker.seed(900);
    const cache = new ContractCache({}, null, tracker);

    const result = await cache.getOrFetch(makeKey(), async () =>
      makeEntry("100", { liveUntilLedgerSeq: 1000, fetchedAtLedger: 900 })
    );

    expect(result.entryArchived).toBe(false);
    expect((result as { entryArchived: false; value: string }).value).toBe("100");
  });

  it("calls fetch only once for concurrent requests (stampede prevention)", async () => {
    const tracker = new LedgerSequenceTracker(async () => 900);
    tracker.seed(900);
    const cache = new ContractCache({}, null, tracker);
    let fetchCount = 0;

    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        cache.getOrFetch(makeKey(), async () => {
          fetchCount++;
          await new Promise((r) => setTimeout(r, 10));
          return makeEntry("v", { liveUntilLedgerSeq: 1000, fetchedAtLedger: 900 });
        })
      )
    );

    expect(fetchCount).toBe(1);
    results.forEach((r) => expect(r.entryArchived).toBe(false));
  });

  it("surfaces ArchivedEntryResult from cache without calling fetch", async () => {
    let ledger = 900;
    const tracker = new LedgerSequenceTracker(async () => ledger, { pollIntervalMs: 0 });
    const cache = new ContractCache({}, null, tracker);

    // Populate cache while still live
    await cache.set(makeKey(), makeEntry("v", {
      liveUntilLedgerSeq: 910,
      durability: "persistent",
      fetchedAtLedger: 900,
    }));

    // Advance ledger past expiry
    ledger = 920;

    let fetchCalled = false;
    const result = await cache.getOrFetch(makeKey(), async () => {
      fetchCalled = true;
      return makeEntry("new", { liveUntilLedgerSeq: 2000, fetchedAtLedger: 920 });
    });

    expect(result.entryArchived).toBe(true);
    // fetch should NOT have been called — archived entries need RestoreFootprintOp first
    expect(fetchCalled).toBe(false);
  });

  it("does not call fetch again on subsequent reads after initial fetch", async () => {
    const tracker = new LedgerSequenceTracker(async () => 900);
    tracker.seed(900);
    const cache = new ContractCache({}, null, tracker);
    let fetchCount = 0;

    await cache.getOrFetch(makeKey(), async () => { fetchCount++; return makeEntry("v", { liveUntilLedgerSeq: 1000, fetchedAtLedger: 900 }); });
    await cache.getOrFetch(makeKey(), async () => { fetchCount++; return makeEntry("v", { liveUntilLedgerSeq: 1000, fetchedAtLedger: 900 }); });
    await cache.getOrFetch(makeKey(), async () => { fetchCount++; return makeEntry("v", { liveUntilLedgerSeq: 1000, fetchedAtLedger: 900 }); });

    expect(fetchCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// ContractCache — no ledger tracker (wall-clock fallback)
// ---------------------------------------------------------------------------

describe("ContractCache — no ledger tracker (wall-clock only)", () => {
  it("serves entries based on wall-clock TTL when no tracker is set", async () => {
    const cache = new ContractCache({ avgLedgerCloseSecs: 5 });
    const key = makeKey("CA", "balance");
    // liveUntilLedgerSeq=1000 at fetchedAtLedger=900 → 100 ledgers × 5s = 500s TTL
    await cache.set(key, makeEntry("500", { liveUntilLedgerSeq: 1000, fetchedAtLedger: 900 }));
    const result = await cache.get(key);
    expect((result as { value: string }).value).toBe("500");
  });

  it("getOrFetch returns value normally without a tracker", async () => {
    const cache = new ContractCache({ avgLedgerCloseSecs: 5 });
    const result = await cache.getOrFetch(makeKey(), async () =>
      makeEntry("data", { liveUntilLedgerSeq: 1000, fetchedAtLedger: 900 })
    );
    expect(result.entryArchived).toBe(false);
    expect((result as { entryArchived: false; value: string }).value).toBe("data");
  });
});

// ---------------------------------------------------------------------------
// ContractCache — Redis integration
// ---------------------------------------------------------------------------

describe("ContractCache — Redis integration", () => {
  let redis: MockRedis;
  let tracker: LedgerSequenceTracker;
  let cache: ContractCache;

  beforeEach(() => {
    redis = new MockRedis();
    tracker = new LedgerSequenceTracker(async () => 900);
    tracker.seed(900);
    cache = new ContractCache({ maxSize: 100, redisTimeoutMs: 200, avgLedgerCloseSecs: 5 }, redis as never, tracker);
  });

  it("serves from L1 without hitting Redis on hot read", async () => {
    const key = makeKey("CA", "balance");
    await cache.set(key, makeEntry("1000", { liveUntilLedgerSeq: 1000, fetchedAtLedger: 900 }));
    redis.setLatency(500);
    const start = Date.now();
    const result = await cache.get(key);
    expect((result as { value: string }).value).toBe("1000");
    expect(Date.now() - start).toBeLessThan(100);
  });

  it("back-fills L1 from Redis on L1 miss", async () => {
    const key = makeKey("CB", "owner");
    const cacheKey = encodeContractKey(key);
    const stored = {
      value: "GOWNER",
      liveUntilLedgerSeq: 1000,
      durability: "persistent",
      expiresAt: Date.now() + 500_000,
      wallClockTtl: 500,
    };
    await redis.set(cacheKey, JSON.stringify(stored), "EX", 500);
    const result = await cache.get<string>(key);
    expect((result as { value: string }).value).toBe("GOWNER");
    // Second read should hit L1
    redis.setLatency(500);
    const start = Date.now();
    const second = await cache.get<string>(key);
    expect((second as { value: string }).value).toBe("GOWNER");
    expect(Date.now() - start).toBeLessThan(100);
  });

  it("falls back to L1 when Redis times out", async () => {
    const key = makeKey("CA", "supply");
    await cache.set(key, makeEntry("999", { liveUntilLedgerSeq: 1000, fetchedAtLedger: 900 }));
    redis.setLatency(500);
    const start = Date.now();
    const result = await cache.get(key);
    expect((result as { value: string }).value).toBe("999");
    expect(Date.now() - start).toBeLessThan(250);
  }, 5000);

  it("does not throw when Redis is down", async () => {
    redis.setError(true);
    await expect(cache.get(makeKey("CA", "x"))).resolves.toBeUndefined();
  });

  it("stores in L1 even when Redis write fails", async () => {
    redis.setError(true);
    const key = makeKey("CA", "supply");
    await cache.set(key, makeEntry("1M", { liveUntilLedgerSeq: 1000, fetchedAtLedger: 900 }));
    redis.setError(false);
    redis.setLatency(500);
    const result = await cache.get(key);
    expect((result as { value: string }).value).toBe("1M");
  }, 5000);

  it("delete removes entry from both L1 and Redis", async () => {
    const key = makeKey("CA", "balance");
    await cache.set(key, makeEntry("500", { liveUntilLedgerSeq: 1000, fetchedAtLedger: 900 }));
    await cache.delete(key);
    expect(await cache.get(key)).toBeUndefined();
  });

  it("detects archived entries read from Redis and evicts them", async () => {
    // Write a persistent entry into Redis that has expired
    const key = makeKey("CA", "archived");
    const cacheKey = encodeContractKey(key);
    const stored = {
      value: "old-value",
      liveUntilLedgerSeq: 800, // already expired (current = 900)
      durability: "persistent",
      expiresAt: Date.now() + 500_000,
      wallClockTtl: 500,
    };
    await redis.set(cacheKey, JSON.stringify(stored), "EX", 500);

    const result = await cache.get(key);
    expect((result as { entryArchived: boolean }).entryArchived).toBe(true);
  });
});
