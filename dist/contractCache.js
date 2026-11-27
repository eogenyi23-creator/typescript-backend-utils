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
    cachedSequence = null;
    lastFetchedAt = 0;
    pollIntervalMs;
    fetchSequence;
    inflight = null;
    constructor(fetchSequence, options = {}) {
        this.fetchSequence = fetchSequence;
        this.pollIntervalMs = options.pollIntervalMs ?? 4000;
    }
    /**
     * Returns the current ledger sequence. Re-fetches from the network at most
     * once per `pollIntervalMs`; coalesces concurrent callers onto one request.
     */
    async current() {
        const now = Date.now();
        if (this.cachedSequence !== null &&
            now - this.lastFetchedAt < this.pollIntervalMs) {
            return this.cachedSequence;
        }
        // Coalesce concurrent fetches
        if (this.inflight)
            return this.inflight;
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
    seed(sequence) {
        this.cachedSequence = sequence;
        this.lastFetchedAt = Date.now();
    }
    /** Returns the last known sequence without a network call. Returns null if never fetched. */
    get lastKnown() {
        return this.cachedSequence;
    }
}
// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------
export function encodeContractKey(key) {
    return `soroban:${key.contractId}:${key.storageKey}`;
}
function deepClone(value) {
    if (value === null || typeof value !== "object")
        return value;
    try {
        return JSON.parse(JSON.stringify(value));
    }
    catch {
        return value;
    }
}
// ---------------------------------------------------------------------------
// L1: In-Memory LRU Cache (stores StoredEntry<unknown>)
// ---------------------------------------------------------------------------
export class LRUCache {
    maxSize;
    store = new Map();
    constructor(maxSize) {
        if (maxSize < 1)
            throw new RangeError("maxSize must be at least 1");
        this.maxSize = maxSize;
    }
    get(key) {
        const entry = this.store.get(key);
        if (!entry)
            return undefined;
        if (Date.now() > entry.expiresAt) {
            this.store.delete(key);
            return undefined;
        }
        // Move to end (MRU)
        this.store.delete(key);
        this.store.set(key, entry);
        return deepClone(entry);
    }
    set(key, value) {
        if (this.store.has(key))
            this.store.delete(key);
        if (this.store.size >= this.maxSize) {
            const lruKey = this.store.keys().next().value;
            if (lruKey !== undefined)
                this.store.delete(lruKey);
        }
        this.store.set(key, value);
    }
    delete(key) { this.store.delete(key); }
    has(key) {
        const entry = this.store.get(key);
        if (!entry)
            return false;
        if (Date.now() > entry.expiresAt) {
            this.store.delete(key);
            return false;
        }
        return true;
    }
    get size() { return this.store.size; }
    clear() { this.store.clear(); }
}
// ---------------------------------------------------------------------------
// Cache Stampede Lock
// ---------------------------------------------------------------------------
class StampedeLock {
    locks = new Map();
    async coalesce(key, compute) {
        const existing = this.locks.get(key);
        if (existing)
            return existing;
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
    l1;
    redis;
    redisTimeoutMs;
    fallbackTtl;
    avgLedgerCloseSecs;
    stampede;
    ledgerTracker;
    constructor(config = {}, redis = null, ledgerTracker = null) {
        this.l1 = new LRUCache(config.maxSize ?? 500);
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
    async _checkLiveness(entry) {
        if (!this.ledgerTracker)
            return "unknown";
        let currentLedger;
        try {
            currentLedger = await this.ledgerTracker.current();
        }
        catch {
            // Network unavailable — fall back to wall-clock TTL
            return "unknown";
        }
        if (entry.liveUntilLedgerSeq === 0 ||
            currentLedger > entry.liveUntilLedgerSeq) {
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
    _toWallClockTtl(liveUntilLedgerSeq, fetchedAtLedger) {
        if (liveUntilLedgerSeq === 0)
            return 0;
        const currentLedger = this.ledgerTracker?.lastKnown ?? fetchedAtLedger;
        const ledgersRemaining = Math.max(0, liveUntilLedgerSeq - currentLedger);
        if (ledgersRemaining === 0)
            return 0;
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
    async get(key) {
        const cacheKey = encodeContractKey(key);
        // --- L1 ---
        const l1Entry = this.l1.get(cacheKey);
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
                    const stored = JSON.parse(raw);
                    const liveness = await this._checkLiveness(stored);
                    if (liveness === "archived") {
                        void this._redisWithTimeout(() => this.redis.del(cacheKey)).catch(() => { });
                        return {
                            entryArchived: true,
                            liveUntilLedgerSeq: stored.liveUntilLedgerSeq,
                            durability: "persistent",
                            contractId: key.contractId,
                            storageKey: key.storageKey,
                        };
                    }
                    if (liveness === "expired") {
                        void this._redisWithTimeout(() => this.redis.del(cacheKey)).catch(() => { });
                        return undefined;
                    }
                    // Back-fill L1
                    const entry = {
                        value: stored.value,
                        liveUntilLedgerSeq: stored.liveUntilLedgerSeq,
                        durability: stored.durability,
                        expiresAt: stored.expiresAt,
                    };
                    this.l1.set(cacheKey, { ...entry, expiresAt: entry.expiresAt });
                    return entry;
                }
            }
            catch {
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
     * Entries with `liveUntilLedgerSeq === 0` and `durability === "temporary"`
     * are not stored (already gone on-chain, no restore path).
     * Persistent entries with `liveUntilLedgerSeq === 0` are stored with the
     * fallback TTL so that a subsequent `get()` can return `ArchivedEntryResult`.
     */
    async set(key, entry) {
        const cacheKey = encodeContractKey(key);
        const wallClockTtl = this._toWallClockTtl(entry.liveUntilLedgerSeq, entry.fetchedAtLedger);
        // For persistent entries with liveUntilLedgerSeq === 0, the RPC has
        // signalled the entry is already archived. Store it briefly so that a
        // subsequent get() can return ArchivedEntryResult instead of a plain miss.
        const alreadyArchived = entry.liveUntilLedgerSeq === 0 && entry.durability === "persistent";
        // Don't cache entries that are already expired (except archived persistent ones)
        if (wallClockTtl === 0 && !alreadyArchived)
            return;
        // For already-archived entries wallClockTtl is 0; use fallbackTtl so the
        // entry survives in L1 long enough for get() to return ArchivedEntryResult.
        const effectiveTtl = wallClockTtl === 0 ? this.fallbackTtl : wallClockTtl;
        const expiresAt = Date.now() + effectiveTtl * 1000;
        // Seed the ledger tracker with the RPC-returned latestLedger so we don't
        // need an extra getLatestLedger call immediately after a fetch.
        this.ledgerTracker?.seed(entry.fetchedAtLedger);
        const stored = {
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
            }
            catch {
                // Non-fatal; L1 is the local source of truth
            }
        }
    }
    /** Deletes a contract state entry from both L1 and L2. */
    async delete(key) {
        const cacheKey = encodeContractKey(key);
        this.l1.delete(cacheKey);
        if (this.redis) {
            try {
                await this._redisWithTimeout(() => this.redis.del(cacheKey));
            }
            catch { /* non-fatal */ }
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
    async getOrFetch(key, fetch) {
        const cached = await this.get(key);
        if (cached !== undefined) {
            // Archived entry — bubble up without fetching
            if ("entryArchived" in cached)
                return cached;
            return { entryArchived: false, value: cached.value };
        }
        const cacheKey = encodeContractKey(key);
        return this.stampede.coalesce(cacheKey, async () => {
            // Double-check after acquiring lock
            const rechecked = await this.get(key);
            if (rechecked !== undefined) {
                if ("entryArchived" in rechecked)
                    return rechecked;
                return { entryArchived: false, value: rechecked.value };
            }
            const entry = await fetch();
            await this.set(key, entry);
            return { entryArchived: false, value: entry.value };
        });
    }
    clearL1() { this.l1.clear(); }
    get l1Size() { return this.l1.size; }
    // ---------------------------------------------------------------------------
    // Private Redis helpers
    // ---------------------------------------------------------------------------
    _redisGetWithTimeout(key) {
        return this._redisWithTimeout(() => this.redis.get(key));
    }
    _redisSetWithTimeout(key, value, ttlSeconds) {
        return this._redisWithTimeout(() => this.redis.set(key, value, "EX", Math.max(1, Math.ceil(ttlSeconds))));
    }
    _redisWithTimeout(fn) {
        return Promise.race([
            fn(),
            new Promise((_, reject) => setTimeout(() => reject(new Error("Redis timeout")), this.redisTimeoutMs)),
        ]);
    }
}
