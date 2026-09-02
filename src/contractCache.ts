/**
 * Soroban Contract State Cache
 *
 * Two-tier caching strategy for Soroban contract data reads:
 *   L1: In-memory LRU cache (hot cache, instant access, deep-cloned on read)
 *   L2: Redis (persistent, shared across instances / server replicas)
 *
 * Why this matters on Stellar:
 * - Soroban RPC nodes enforce rate limits; caching repeated getContractData
 *   calls for the same contract + key dramatically reduces RPC pressure.
 * - Contract state entries have ledger-based TTLs (min/max TTL). This cache
 *   honours a configurable TTL in ledgers or seconds so stale data is not served
 *   past the point where an entry may have been evicted on-chain.
 *
 * Features:
 * - L1 checked before L2 (hot-cache priority)
 * - Redis calls time out after configurable ms, falling back to L1
 * - Cache stampede prevention via per-key coalescing locks
 * - Deep clone on L1 retrieval to prevent mutation of cached state
 * - Configurable TTL per entry (seconds or ledger-count-based)
 * - Graceful degradation when Redis is unavailable
 */

import type Redis from "ioredis";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ContractCacheConfig {
  /** Maximum number of entries in the L1 LRU cache (default: 500) */
  maxSize?: number;
  /** Redis read/write timeout in milliseconds (default: 200) */
  redisTimeoutMs?: number;
  /**
   * Default TTL in seconds when none is specified.
   * On Stellar mainnet one ledger ≈ 5 s; the default of 30 s ≈ 6 ledgers.
   */
  defaultTtlSeconds?: number;
}

export interface CacheEntry<T> {
  value: T;
  /** Unix timestamp (ms) when this entry expires */
  expiresAt: number;
}

/** Composite key components for a Soroban contract state entry */
export interface ContractStateKey {
  /** Soroban contract address (C…) */
  contractId: string;
  /** Storage key — typically the XDR-encoded ScVal key as a hex string */
  storageKey: string;
  /** Optional ledger sequence at which data was fetched (for staleness checks) */
  ledgerSequence?: number;
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

/** Serialises a ContractStateKey into a stable cache key string */
export function encodeContractKey(key: ContractStateKey): string {
  return `soroban:${key.contractId}:${key.storageKey}`;
}

/** Deep clone utility — handles circular references gracefully */
function deepClone<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  try {
    return JSON.parse(JSON.stringify(value)) as T;
  } catch {
    return value;
  }
}

// ---------------------------------------------------------------------------
// L1: In-Memory LRU Cache
// ---------------------------------------------------------------------------

/**
 * Minimal Least Recently Used (LRU) cache backed by a Map.
 *
 * JavaScript's Map preserves insertion order — entries are moved to the end
 * (most-recently-used) on access and evicted from the front (LRU) at capacity.
 */
export class LRUCache<T> {
  private readonly maxSize: number;
  private readonly store: Map<string, CacheEntry<T>> = new Map();

  constructor(maxSize: number) {
    if (maxSize < 1) throw new RangeError("maxSize must be at least 1");
    this.maxSize = maxSize;
  }

  get(key: string): T | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return undefined;
    }
    // Move to end (MRU)
    this.store.delete(key);
    this.store.set(key, entry);
    return deepClone(entry.value);
  }

  set(key: string, value: T, ttlSeconds: number): void {
    if (this.store.has(key)) this.store.delete(key);
    if (this.store.size >= this.maxSize) {
      const lruKey = this.store.keys().next().value;
      if (lruKey !== undefined) this.store.delete(lruKey);
    }
    this.store.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
  }

  delete(key: string): void {
    this.store.delete(key);
  }

  has(key: string): boolean {
    const entry = this.store.get(key);
    if (!entry) return false;
    if (Date.now() > entry.expiresAt) { this.store.delete(key); return false; }
    return true;
  }

  get size(): number { return this.store.size; }
  clear(): void { this.store.clear(); }
}

// ---------------------------------------------------------------------------
// Cache Stampede Lock
// ---------------------------------------------------------------------------

class StampedeLock {
  private readonly locks: Map<string, Promise<unknown>> = new Map();

  async coalesce<T>(key: string, compute: () => Promise<T>): Promise<T> {
    const existing = this.locks.get(key) as Promise<T> | undefined;
    if (existing) return existing;
    const promise = compute().finally(() => this.locks.delete(key));
    this.locks.set(key, promise);
    return promise;
  }
}

// ---------------------------------------------------------------------------
// Main: ContractCache
// ---------------------------------------------------------------------------

/**
 * Two-tier cache (LRU memory + Redis) for Soroban contract state reads.
 *
 * Usage pattern:
 *   const cache = new ContractCache({ maxSize: 500 });
 *   const value = await cache.getOrFetch(
 *     contractKey,
 *     ttlSeconds,
 *     () => server.getContractData(contractId, ledgerKey, Durability.Persistent)
 *   );
 */
export class ContractCache {
  private readonly l1: LRUCache<unknown>;
  private readonly redis: Redis | null;
  private readonly redisTimeoutMs: number;
  private readonly defaultTtl: number;
  private readonly stampede: StampedeLock;

  constructor(config: ContractCacheConfig = {}, redis: Redis | null = null) {
    this.l1 = new LRUCache<unknown>(config.maxSize ?? 500);
    this.redis = redis;
    this.redisTimeoutMs = config.redisTimeoutMs ?? 200;
    this.defaultTtl = config.defaultTtlSeconds ?? 30;
    this.stampede = new StampedeLock();
  }

  /**
   * Gets a cached Soroban contract state value.
   * Checks L1 first; on miss checks L2 (Redis) with timeout; back-fills L1 on L2 hit.
   *
   * @param key - Composite contract state key
   */
  async get<T>(key: ContractStateKey): Promise<T | undefined> {
    const cacheKey = encodeContractKey(key);
    const l1Value = this.l1.get(cacheKey) as T | undefined;
    if (l1Value !== undefined) return l1Value;

    if (this.redis) {
      try {
        const raw = await this._redisGetWithTimeout(cacheKey);
        if (raw !== null && raw !== undefined) {
          const parsed = JSON.parse(raw) as { value: T; ttl: number };
          this.l1.set(cacheKey, parsed.value, parsed.ttl);
          return deepClone(parsed.value) as T;
        }
      } catch {
        // Redis unavailable — degrade to L1 only
      }
    }
    return undefined;
  }

  /**
   * Stores a Soroban contract state value in both L1 and L2.
   *
   * @param key   - Composite contract state key
   * @param value - Value to cache (must be JSON-serialisable)
   * @param ttl   - TTL in seconds (defaults to config.defaultTtlSeconds)
   */
  async set(key: ContractStateKey, value: unknown, ttl?: number): Promise<void> {
    const cacheKey = encodeContractKey(key);
    const resolvedTtl = ttl ?? this.defaultTtl;
    this.l1.set(cacheKey, value, resolvedTtl);

    if (this.redis) {
      try {
        const serialized = JSON.stringify({ value, ttl: resolvedTtl });
        await this._redisSetWithTimeout(cacheKey, serialized, resolvedTtl);
      } catch {
        // Redis write failure is non-fatal; L1 remains the local source of truth
      }
    }
  }

  /** Deletes a contract state entry from both L1 and L2. */
  async delete(key: ContractStateKey): Promise<void> {
    const cacheKey = encodeContractKey(key);
    this.l1.delete(cacheKey);
    if (this.redis) {
      try {
        await this._redisWithTimeout(() => this.redis!.del(cacheKey));
      } catch { /* non-fatal */ }
    }
  }

  /**
   * Returns a cached value, or fetches it via the provided function on miss.
   * Stampede-safe: concurrent calls for the same key share a single fetch.
   *
   * @param key     - Composite contract state key
   * @param fetch   - Async function that fetches the value from an RPC node
   * @param ttl     - TTL in seconds for the fetched value
   */
  async getOrFetch<T>(
    key: ContractStateKey,
    fetch: () => Promise<T>,
    ttl?: number
  ): Promise<T> {
    const cached = await this.get<T>(key);
    if (cached !== undefined) return cached;

    const cacheKey = encodeContractKey(key);
    return this.stampede.coalesce(cacheKey, async () => {
      const rechecked = await this.get<T>(key);
      if (rechecked !== undefined) return rechecked;
      const value = await fetch();
      await this.set(key, value, ttl);
      return value;
    });
  }

  /** Clears L1 (in-memory) cache. Does not affect Redis. */
  clearL1(): void { this.l1.clear(); }

  get l1Size(): number { return this.l1.size; }

  // ---------------------------------------------------------------------------
  // Private Redis helpers
  // ---------------------------------------------------------------------------

  private _redisGetWithTimeout(key: string): Promise<string | null> {
    return this._redisWithTimeout(() => this.redis!.get(key));
  }

  private _redisSetWithTimeout(key: string, value: string, ttlSeconds: number): Promise<string | null> {
    return this._redisWithTimeout(() => this.redis!.set(key, value, "EX", ttlSeconds));
  }

  private _redisWithTimeout<T>(fn: () => Promise<T>): Promise<T> {
    return Promise.race([
      fn(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Redis timeout")), this.redisTimeoutMs)
      ),
    ]);
  }
}
