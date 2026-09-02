/**
 * Soroban Contract State Cache — Ledger-Sequence-Aware
 *
 * Two-tier caching strategy for Soroban contract data reads, with expiration
 * driven by the real on-chain TTL model rather than wall-clock guesses.
 *
 * ## How Soroban TTL works
 *
 * Every CONTRACT_DATA and CONTRACT_CODE ledger entry has a companion TTL entry
 * that records `liveUntilLedgerSeq` — the last ledger at which the entry is
 * still considered live. The Soroban RPC returns this field on every
 * `getLedgerEntries` response entry.
 *
 * - If `currentLedger > liveUntilLedgerSeq` the entry has expired/been archived.
 *   Restoring it requires a `RestoreFootprintOperation`, not a normal refetch.
 * - If `liveUntilLedgerSeq === 0` the RPC signals the entry is no longer live.
 *
 * Durability also matters:
 * - **Persistent** entries survive indefinitely as long as their TTL is extended
 *   (e.g. via `ExtendFootprintTTLOp`). They must be explicitly restored after
 *   archival — they are never silently deleted, just moved to the archive.
 * - **Temporary** entries are deleted permanently when their TTL expires; there
 *   is no restore path. They should be cached more conservatively.
 *
 * ## What this cache does
 *
 * 1. Stores each entry alongside its `liveUntilLedgerSeq` and `durability`.
 * 2. Tracks the current network ledger sequence via a short-lived
 *    `LedgerSequenceTracker` that re-fetches `getLatestLedger` at most once
 *    every `ledgerPollIntervalMs` (default 4 s — slightly less than one ledger).
 * 3. On every cache read, compares the stored `liveUntilLedgerSeq` against the
 *    current ledger. If expired:
 *    - Persistent entry → returns `{ entryArchived: true }` so the caller knows
 *      a `RestoreFootprintOp` is needed before refetching.
 *    - Temporary entry → returns a plain cache miss (the entry is gone on-chain).
 * 4. Wall-clock TTL (via LRU) acts as a secondary safety net to evict entries
 *    whose `liveUntilLedgerSeq` the cache has not yet noticed (e.g. during a
 *    ledger-sequence poll interval).
 *
 * ## What the caller must provide
 *
 * The caller's `fetch` function must return a `SorobanEntryResult<T>` that
 * includes `liveUntilLedgerSeq` and `durability` as returned by the RPC.
 * These come directly from the `getLedgerEntries` or `getContractData` response.
 */

import type { Redis } from "ioredis";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Soroban storage durability, mirroring xdr.ContractDataDurability */
export type ContractDataDurability = "persistent" | "temporary";

/**
 * The result shape the caller's fetch function must return.
 * Maps directly onto the fields returned by `getLedgerEntries`.
 */
export interface SorobanEntryResult<T> {
  /** The decoded contract data value */
  value: T;
  /**
   * The last ledger at which this entry is live, as returned by the RPC.
   * A value of 0 means the entry is already not live.
   */
  liveUntilLedgerSeq: number;
  /** Storage durability of this entry */
  durability: ContractDataDurability;
  /** The ledger sequence at which this data was fetched (latestLedger from the RPC response) */
  fetchedAtLedger: number;
}

/**
 * What the cache returns when an entry has expired and was Persistent.
 * The caller must submit a RestoreFootprintOperation before reading again.
 */
export interface ArchivedEntryResult {
  entryArchived: true;
  /** The ledger at which the entry expired */
  liveUntilLedgerSeq: number;
  durability: "persistent";
  contractId: string;
  storageKey: string;
}

/** Discriminated result from getOrFetch */
export type CacheResult<T> =
  | { entryArchived: false; value: T }
  | ArchivedEntryResult;

/** Composite key for a Soroban contract state entry */
export interface ContractStateKey {
  /** Soroban contract address (C…) */
  contractId: string;
  /**
   * Storage key — the XDR-encoded ScVal key, typically as a base64 or hex
   * string matching what you passed to getLedgerEntries.
   */
  storageKey: string;
}

export interface ContractCacheConfig {
  /** Maximum number of entries in the L1 LRU cache (default: 500) */
  maxSize?: number;
  /** Redis read/write timeout in milliseconds (default: 200) */
  redisTimeoutMs?: number;
  /**
   * Fallback wall-clock TTL in seconds used when liveUntilLedgerSeq cannot be
   * converted (e.g. when avgLedgerCloseSecs is not set). Default: 30 s.
   */
  fallbackTtlSeconds?: number;
  /**
   * Assumed average ledger close time in seconds (default: 5).
   * Used to convert `liveUntilLedgerSeq - currentLedger` into a wall-clock TTL
   * for the L1/L2 backing store.
   */
  avgLedgerCloseSecs?: number;
  /**
   * How often to re-fetch the current ledger sequence from the network
   * in milliseconds (default: 4000 — slightly less than one Soroban ledger).
   */
  ledgerPollIntervalMs?: number;
}

// ---------------------------------------------------------------------------
// Internal stored shape
// ---------------------------------------------------------------------------

interface StoredEntry<T> {
  value: T;
  liveUntilLedgerSeq: number;
  durability: ContractDataDurability;
  /** Wall-clock expiry timestamp (ms) — secondary safety net */
  expiresAt: number;
}

// ---------------------------------------------------------------------------
// LedgerSequenceTracker
// ---------------------------------------------------------------------------

/**
 * Tracks the current Stellar network ledger sequence by periodically calling
 * `getLatestLedger`. The sequence is cached locally for `pollIntervalMs`
 * to avoid a network call on every cache read.
 *
 * The caller provides a `fetchSequence` function so this class has no direct
 * dependency on any particular Stellar SDK version.
 *
 * @example
 * const tracker = new LedgerSequenceTracker(
 *   () => server.getLatestLedger().then(r => r.sequence),
 *   { pollIntervalMs: 4000 }
 * );
 */
export class LedgerSequenceTracker {
  private cachedSequence: number | null = null;
  private lastFetchedAt = 0;
  private readonly pollIntervalMs: number;
  private readonly fetchSequence: () => Promise<number>;
  private inflight: Promise<number> | null = null;

  constructor(
    fetchSequence: () => Promise<number>,
    options: { pollIntervalMs?: number } = {}
  ) {
    this.fetchSequence = fetchSequence;
    this.pollIntervalMs = options.pollIntervalMs ?? 4_000;
  }

  /**
   * Returns the current ledger sequence. Re-fetches from the network at most
   * once per `pollIntervalMs`; coalesces concurrent callers onto one request.
   */
  async current(): Promise<number> {
    const now = Date.now();
    if (
      this.cachedSequence !== null &&
      now - this.lastFetchedAt < this.pollIntervalMs
    ) {
      return this.cachedSequence;
    }

    // Coalesce concurrent fetches
    if (this.inflight) return this.inflight;

    this.inflight = this.fetchSequence()
      .then((seq) => {
        this.cachedSequence = seq;
        this.lastFetchedAt = Date.now();
        return seq;
      })
      .finally(() => {
        this.inflight = null;
      });

    return this.inflight;
  }

  /** Force-sets the sequence (useful in tests / when you already have latestLedger from a response) */
  seed(sequence: number): void {
    this.cachedSequence = sequence;
    this.lastFetchedAt = Date.now();
  }

  /** Returns the last known sequence without a network call. Returns null if never fetched. */
  get lastKnown(): number | null {
    return this.cachedSequence;
  }
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

export function encodeContractKey(key: ContractStateKey): string {
  return `soroban:${key.contractId}:${key.storageKey}`;
}

function deepClone<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  try {
    return JSON.parse(JSON.stringify(value)) as T;
  } catch {
    return value;
  }
}

// ---------------------------------------------------------------------------
// L1: In-Memory LRU Cache (stores StoredEntry<unknown>)
// ---------------------------------------------------------------------------

export class LRUCache<T> {
  private readonly maxSize: number;
  private readonly store: Map<string, T & { expiresAt: number }> = new Map();

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
    return deepClone(entry) as T;
  }

  set(key: string, value: T & { expiresAt: number }): void {
    if (this.store.has(key)) this.store.delete(key);
    if (this.store.size >= this.maxSize) {
      const lruKey = this.store.keys().next().value;
      if (lruKey !== undefined) this.store.delete(lruKey);
    }
    this.store.set(key, value);
  }

  delete(key: string): void { this.store.delete(key); }

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
 * Ledger-sequence-aware two-tier cache (LRU memory + Redis) for Soroban
 * contract state reads.
 *
 * On every read the cache checks `liveUntilLedgerSeq` against the current
 * network ledger. If the entry has expired:
 *   - Persistent: returns `{ entryArchived: true }` — caller must restore.
 *   - Temporary:  returns a cache miss — caller can refetch (but the value is
 *                 gone on-chain; the refetch will return not-found).
 *
 * @example
 * const tracker = new LedgerSequenceTracker(
 *   () => server.getLatestLedger().then(r => r.sequence)
 * );
 * const cache = new ContractCache({ maxSize: 500 }, null, tracker);
 *
 * const result = await cache.getOrFetch(
 *   { contractId: "CXXX", storageKey: "balance_key_base64" },
 *   async () => {
 *     const resp = await server.getLedgerEntries(ledgerKey);
 *     const entry = resp.entries[0];
 *     return {
 *       value:               decodeScVal(entry.xdr),
 *       liveUntilLedgerSeq: entry.liveUntilLedgerSeq,
 *       durability:         "persistent",
 *       fetchedAtLedger:    resp.latestLedger,
 *     };
 *   }
 * );
 *
 * if (result.entryArchived) {
 *   // Submit RestoreFootprintOperation, then retry
 * } else {
 *   console.log(result.value);
 * }
 */
export class ContractCache {
  private readonly l1: LRUCache<StoredEntry<unknown>>;
  private readonly redis: Redis | null;
  private readonly redisTimeoutMs: number;
  private readonly fallbackTtl: number;
  private readonly avgLedgerCloseSecs: number;
  private readonly stampede: StampedeLock;
  readonly ledgerTracker: LedgerSequenceTracker | null;

  constructor(
    config: ContractCacheConfig = {},
    redis: Redis | null = null,
    ledgerTracker: LedgerSequenceTracker | null = null
  ) {
    this.l1 = new LRUCache<StoredEntry<unknown>>(config.maxSize ?? 500);
    this.redis = redis;
    this.redisTimeoutMs = config.redisTimeoutMs ?? 200;
    this.fallbackTtl = config.fallbackTtlSeconds ?? 30;
    this.avgLedgerCloseSecs = config.avgLedgerCloseSecs ?? 5;
    this.stampede = new StampedeLock();
    this.ledgerTracker = ledgerTracker;
  }

  // ---------------------------------------------------------------------------
  // Private: ledger-aware expiry check
  // ---------------------------------------------------------------------------

  /**
   * Checks a stored entry against the current ledger sequence.
   * Returns:
   *   - `"live"` — the entry is still live on-chain
   *   - `"archived"` — expired persistent entry (needs RestoreFootprintOp)
   *   - `"expired"` — expired temporary entry (gone permanently)
   *   - `"unknown"` — no ledger tracker, fall back to wall-clock TTL
   */
  private async _checkLiveness(
    entry: StoredEntry<unknown>
  ): Promise<"live" | "archived" | "expired" | "unknown"> {
    if (!this.ledgerTracker) return "unknown";

    let currentLedger: number;
    try {
      currentLedger = await this.ledgerTracker.current();
    } catch {
      // Network unavailable — fall back to wall-clock TTL
      return "unknown";
    }

    if (
      entry.liveUntilLedgerSeq === 0 ||
      currentLedger > entry.liveUntilLedgerSeq
    ) {
      return entry.durability === "persistent" ? "archived" : "expired";
    }

    return "live";
  }

  /**
   * Converts `liveUntilLedgerSeq` into a wall-clock TTL for L1/L2 storage.
   * Uses the known current ledger if available, otherwise uses fetchedAtLedger.
   *
   * Returns 0 when the entry is already at or past expiry — callers must not
   * cache a 0-TTL entry.
   */
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
    // Never cache for less than 1 second when there are ledgers remaining
    return Math.max(wallClockSecs, 1);
  }

  // ---------------------------------------------------------------------------
  // Core get/set
  // ---------------------------------------------------------------------------

  /**
   * Reads a Soroban contract state entry from the cache.
   *
   * Returns:
   * - The stored entry if live
   * - `undefined` if not in cache or wall-clock expired (standard miss)
   * - `ArchivedEntryResult` if the on-chain ledger sequence has passed
   *   `liveUntilLedgerSeq` for a **persistent** entry
   *
   * Temporary entries that have expired are treated as a plain miss.
   */
  async get<T>(
    key: ContractStateKey
  ): Promise<StoredEntry<T> | ArchivedEntryResult | undefined> {
    const cacheKey = encodeContractKey(key);

    // --- L1 ---
    const l1Entry = this.l1.get(cacheKey) as StoredEntry<T> | undefined;
    if (l1Entry !== undefined) {
      const liveness = await this._checkLiveness(l1Entry);
      if (liveness === "archived") {
        this.l1.delete(cacheKey);
        return {
          entryArchived: true,
          liveUntilLedgerSeq: l1Entry.liveUntilLedgerSeq,
          durability: "persistent",
          contractId: key.contractId,
          storageKey: key.storageKey,
        };
      }
      if (liveness === "expired") {
        this.l1.delete(cacheKey);
        return undefined;
      }
      // "live" or "unknown" (wall-clock TTL still valid) → serve from cache
      return l1Entry;
    }

    // --- L2 (Redis) ---
    if (this.redis) {
      try {
        const raw = await this._redisGetWithTimeout(cacheKey);
        if (raw !== null && raw !== undefined) {
          const stored = JSON.parse(raw) as StoredEntry<T> & { wallClockTtl: number };
          const liveness = await this._checkLiveness(stored);
          if (liveness === "archived") {
            void this._redisWithTimeout(() => this.redis!.del(cacheKey)).catch(() => {});
            return {
              entryArchived: true,
              liveUntilLedgerSeq: stored.liveUntilLedgerSeq,
              durability: "persistent",
              contractId: key.contractId,
              storageKey: key.storageKey,
            };
          }
          if (liveness === "expired") {
            void this._redisWithTimeout(() => this.redis!.del(cacheKey)).catch(() => {});
            return undefined;
          }
          // Back-fill L1
          const entry: StoredEntry<T> = {
            value: stored.value,
            liveUntilLedgerSeq: stored.liveUntilLedgerSeq,
            durability: stored.durability,
            expiresAt: stored.expiresAt,
          };
          this.l1.set(cacheKey, { ...entry, expiresAt: entry.expiresAt });
          return entry;
        }
      } catch {
        // Redis unavailable — degrade gracefully
      }
    }

    return undefined;
  }

  /**
   * Stores a Soroban RPC entry result in L1 and L2.
   * The wall-clock TTL is derived from `liveUntilLedgerSeq` so local expiry
   * tracks the on-chain TTL.
   *
   * Entries with `liveUntilLedgerSeq === 0` or that are already at expiry
   * boundary are not stored (TTL would be 0).
   */
  async set<T>(key: ContractStateKey, entry: SorobanEntryResult<T>): Promise<void> {
    const cacheKey = encodeContractKey(key);
    const wallClockTtl = this._toWallClockTtl(
      entry.liveUntilLedgerSeq,
      entry.fetchedAtLedger
    );

    // Don't cache entries that are already expired
    if (wallClockTtl === 0) return;

    const expiresAt = Date.now() + wallClockTtl * 1000;

    // Seed the ledger tracker with the RPC-returned latestLedger so we don't
    // need an extra getLatestLedger call immediately after a fetch.
    this.ledgerTracker?.seed(entry.fetchedAtLedger);

    const stored: StoredEntry<T> = {
      value: entry.value,
      liveUntilLedgerSeq: entry.liveUntilLedgerSeq,
      durability: entry.durability,
      expiresAt,
    };

    this.l1.set(cacheKey, { ...stored, expiresAt });

    if (this.redis) {
      try {
        const serialized = JSON.stringify({ ...stored, wallClockTtl });
        await this._redisSetWithTimeout(cacheKey, serialized, wallClockTtl);
      } catch {
        // Non-fatal; L1 is the local source of truth
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
   * Returns a cached value or fetches it on miss — stampede-safe.
   *
   * The `fetch` function must return a `SorobanEntryResult<T>` with the
   * `liveUntilLedgerSeq`, `durability`, and `fetchedAtLedger` fields populated
   * from the RPC response.
   *
   * Returns `CacheResult<T>`:
   * - `{ entryArchived: false, value: T }` — live value (from cache or fresh fetch)
   * - `ArchivedEntryResult` — entry has expired and was persistent; restore required
   */
  async getOrFetch<T>(
    key: ContractStateKey,
    fetch: () => Promise<SorobanEntryResult<T>>
  ): Promise<CacheResult<T>> {
    const cached = await this.get<T>(key);

    if (cached !== undefined) {
      // Archived entry — bubble up without fetching
      if ("entryArchived" in cached) return cached as ArchivedEntryResult;
      return { entryArchived: false, value: (cached as StoredEntry<T>).value };
    }

    const cacheKey = encodeContractKey(key);
    return this.stampede.coalesce(cacheKey, async () => {
      // Double-check after acquiring lock
      const rechecked = await this.get<T>(key);
      if (rechecked !== undefined) {
        if ("entryArchived" in rechecked) return rechecked as ArchivedEntryResult;
        return { entryArchived: false, value: (rechecked as StoredEntry<T>).value };
      }

      const entry = await fetch();
      await this.set(key, entry);
      return { entryArchived: false, value: entry.value };
    }) as Promise<CacheResult<T>>;
  }

  clearL1(): void { this.l1.clear(); }
  get l1Size(): number { return this.l1.size; }

  // ---------------------------------------------------------------------------
  // Private Redis helpers
  // ---------------------------------------------------------------------------

  private _redisGetWithTimeout(key: string): Promise<string | null> {
    return this._redisWithTimeout(() => this.redis!.get(key));
  }

  private _redisSetWithTimeout(key: string, value: string, ttlSeconds: number): Promise<string | null> {
    return this._redisWithTimeout(() =>
      this.redis!.set(key, value, "EX", Math.max(1, Math.ceil(ttlSeconds)))
    );
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
