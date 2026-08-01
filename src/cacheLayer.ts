/**
 * Dynamic Multi-Tier Object Cache Layer
 *
 * Two-tier caching strategy:
 *   L1: In-memory LRU cache (hot cache, instant access, deep-cloned on read)
 *   L2: Redis (persistent, shared across instances)
 *
 * Features:
 * - L1 checked before L2 (hot-cache priority)
 * - Redis calls time out after 200ms, falling back to L1
 * - Cache stampede prevention via per-key coalescing locks
 * - Deep clone on L1 retrieval to prevent mutation of cached data
 * - Configurable TTL per entry
 * - Graceful degradation when Redis is unavailable
 */

import type Redis from "ioredis";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CacheConfig {
  /** Maximum number of items in the L1 LRU cache (default: 500) */
  maxSize?: number;
  /** Redis read/write timeout in milliseconds (default: 200) */
  redisTimeoutMs?: number;
  /** Default TTL in seconds when none is specified (default: 300) */
  defaultTtl?: number;
}

export interface CacheEntry<T> {
  value: T;
  /** Unix timestamp (ms) when this entry expires */
  expiresAt: number;
}

// ---------------------------------------------------------------------------
// Deep clone utility (handles circular refs gracefully)
// ---------------------------------------------------------------------------

function deepClone<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  try {
    return JSON.parse(JSON.stringify(value)) as T;
  } catch {
    // Fallback for non-serializable values: return as-is
    return value;
  }
}

// ---------------------------------------------------------------------------
// L1: In-Memory LRU Cache
// ---------------------------------------------------------------------------

/**
 * A minimal Least Recently Used (LRU) cache backed by a Map.
 *
 * JavaScript's Map preserves insertion order, so we move accessed entries
 * to the end (most-recently-used) and evict from the front (least-recently-used).
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

    // Evict if expired
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return undefined;
    }

    // Move to end (most-recently-used)
    this.store.delete(key);
    this.store.set(key, entry);

    // Return a deep clone to prevent mutation of cached state
    return deepClone(entry.value);
  }

  set(key: string, value: T, ttlSeconds: number): void {
    // Evict existing entry first to re-insert at end
    if (this.store.has(key)) this.store.delete(key);

    // Evict LRU entry if at capacity
    if (this.store.size >= this.maxSize) {
      const lruKey = this.store.keys().next().value;
      if (lruKey !== undefined) this.store.delete(lruKey);
    }

    this.store.set(key, {
      value,
      expiresAt: Date.now() + ttlSeconds * 1000,
    });
  }

  delete(key: string): void {
    this.store.delete(key);
  }

  has(key: string): boolean {
    const entry = this.store.get(key);
    if (!entry) return false;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return false;
    }
    return true;
  }

  get size(): number {
    return this.store.size;
  }

  /** Clears all entries (useful for testing) */
  clear(): void {
    this.store.clear();
  }
}

// ---------------------------------------------------------------------------
// Cache Stampede Lock
// ---------------------------------------------------------------------------

/**
 * Simple per-key coalescing lock.
 * The first caller triggers value computation; subsequent callers wait.
 */
class StampedeLock {
  private readonly locks: Map<string, Promise<unknown>> = new Map();

  /**
   * Ensures only one inflight computation per key.
   *
   * @param key     - Cache key
   * @param compute - Function that fetches/computes the value
   * @returns The computed value (shared across concurrent callers)
   */
  async coalesce<T>(key: string, compute: () => Promise<T>): Promise<T> {
    const existing = this.locks.get(key) as Promise<T> | undefined;
    if (existing) return existing;

    const promise = compute().finally(() => {
      this.locks.delete(key);
    });

    this.locks.set(key, promise);
    return promise;
  }

  get size(): number {
    return this.locks.size;
  }
}

// ---------------------------------------------------------------------------
// Main: MultiTierCache
// ---------------------------------------------------------------------------

/**
 * Abstract multi-tier cache with LRU memory (L1) + Redis (L2).
 *
 * Retrieval order: L1 → L2 → miss (returns undefined)
 * On L2 hit: populates L1 for subsequent hot reads.
 * On Redis timeout/error: falls back to L1 only.
 */
export class MultiTierCache {
  private readonly l1: LRUCache<unknown>;
  private readonly redis: Redis | null;
  private readonly redisTimeoutMs: number;
  private readonly defaultTtl: number;
  private readonly stampede: StampedeLock;

  constructor(config: CacheConfig = {}, redis: Redis | null = null) {
    this.l1 = new LRUCache<unknown>(config.maxSize ?? 500);
    this.redis = redis;
    this.redisTimeoutMs = config.redisTimeoutMs ?? 200;
    this.defaultTtl = config.defaultTtl ?? 300;
    this.stampede = new StampedeLock();
  }

  /**
   * Retrieves a value from the cache.
   *
   * Checks L1 first; if missed, checks L2 (Redis) with a timeout.
   * On L2 hit, back-fills L1.
   *
   * @param key - Cache key
   * @returns The cached value, or undefined on miss
   */
  async get<T>(key: string): Promise<T | undefined> {
    // L1 check (hot path — no network)
    const l1Value = this.l1.get(key) as T | undefined;
    if (l1Value !== undefined) return l1Value;

    // L2 check (Redis with timeout)
    if (this.redis) {
      try {
        const raw = await this._redisGetWithTimeout(key);
        if (raw !== null && raw !== undefined) {
          const parsed = JSON.parse(raw) as { value: T; ttl: number };
          // Back-fill L1
          this.l1.set(key, parsed.value, parsed.ttl);
          return deepClone(parsed.value) as T;
        }
      } catch {
        // Redis unavailable — degrade to L1 only (which was a miss)
      }
    }

    return undefined;
  }

  /**
   * Stores a value in both L1 and L2 caches.
   *
   * @param key   - Cache key
   * @param value - Value to cache (must be JSON-serializable for Redis)
   * @param ttl   - Time-to-live in seconds (uses defaultTtl if omitted)
   */
  async set(key: string, value: unknown, ttl?: number): Promise<void> {
    const resolvedTtl = ttl ?? this.defaultTtl;

    // Write to L1 immediately
    this.l1.set(key, value, resolvedTtl);

    // Write to L2 (fire-and-forget with timeout)
    if (this.redis) {
      try {
        const serialized = JSON.stringify({ value, ttl: resolvedTtl });
        await this._redisSetWithTimeout(key, serialized, resolvedTtl);
      } catch {
        // Redis write failure is non-fatal; L1 is the source of truth locally
      }
    }
  }

  /**
   * Deletes a key from both L1 and L2.
   */
  async delete(key: string): Promise<void> {
    this.l1.delete(key);
    if (this.redis) {
      try {
        await this._redisWithTimeout(() => this.redis!.del(key));
      } catch {
        // Non-fatal
      }
    }
  }

  /**
   * Retrieves a cached value or computes it on miss, with stampede protection.
   *
   * On a cache miss, only the first concurrent request computes the value.
   * Subsequent concurrent requests wait and share the result.
   *
   * @param key     - Cache key
   * @param compute - Async function to compute the value on miss
   * @param ttl     - TTL in seconds for the computed value
   */
  async getOrSet<T>(
    key: string,
    compute: () => Promise<T>,
    ttl?: number
  ): Promise<T> {
    const cached = await this.get<T>(key);
    if (cached !== undefined) return cached;

    return this.stampede.coalesce(key, async () => {
      // Double-check after acquiring the lock (another caller may have set it)
      const rechecked = await this.get<T>(key);
      if (rechecked !== undefined) return rechecked;

      const value = await compute();
      await this.set(key, value, ttl);
      return value;
    });
  }

  /** Clears L1 cache (useful for testing; does not affect Redis) */
  clearL1(): void {
    this.l1.clear();
  }

  get l1Size(): number {
    return this.l1.size;
  }

  // ---------------------------------------------------------------------------
  // Private Redis helpers with timeout
  // ---------------------------------------------------------------------------

  private _redisGetWithTimeout(key: string): Promise<string | null> {
    return this._redisWithTimeout(() => this.redis!.get(key));
  }

  private _redisSetWithTimeout(
    key: string,
    value: string,
    ttlSeconds: number
  ): Promise<string | null> {
    return this._redisWithTimeout(() =>
      this.redis!.set(key, value, "EX", ttlSeconds)
    );
  }

  private _redisWithTimeout<T>(fn: () => Promise<T>): Promise<T> {
    return Promise.race([
      fn(),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error("Redis timeout")),
          this.redisTimeoutMs
        )
      ),
    ]);
  }
}
