/**
 * Soroban Transaction Batcher
 *
 * Submits multiple Soroban transactions concurrently with configurable
 * batch sizes, concurrency limits, exponential backoff retry, and
 * AbortSignal support.
 *
 * Stellar context:
 * - Soroban transactions must be submitted individually (no batch endpoint).
 * - Network congestion and surge pricing mean transactions can fail
 *   transiently (status: FAILED, error: txInsufficientFee).
 * - This batcher handles the concurrency and retry plumbing so you can
 *   focus on building your transaction envelopes.
 *
 * Features:
 * - Generic over the submission result type T
 * - Configurable maxConcurrency, batchSize, maxRetries, backoff
 * - Exponential backoff with full jitter (thundering-herd prevention)
 * - AbortSignal support for cancellation
 * - Per-task status tracking (pending / fulfilled / rejected)
 * - `submitWithResults()` helper for typed split of fulfilled vs rejected
 * - Memory management: completed records flushed after run()
 */
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
/**
 * Calculates exponential backoff with full jitter.
 * Full jitter prevents thundering-herd re-submission after fee spikes.
 */
function calcBackoff(attempt, baseMs, multiplier, maxJitter, cap = 30000) {
    const exponential = Math.min(cap, baseMs * Math.pow(multiplier, attempt));
    return exponential + Math.random() * maxJitter;
}
/** Promise-based sleep that respects AbortSignal */
function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) {
            reject(new DOMException("Aborted", "AbortError"));
            return;
        }
        const timer = setTimeout(resolve, ms);
        signal?.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(new DOMException("Aborted", "AbortError"));
        }, { once: true });
    });
}
// ---------------------------------------------------------------------------
// TransactionBatcher
// ---------------------------------------------------------------------------
/**
 * Batches and submits Soroban transactions with configurable concurrency,
 * exponential backoff retry, and abort signal support.
 *
 * @example
 * const batcher = new TransactionBatcher({ maxConcurrency: 5, batchSize: 10, retryInterval: 1000 });
 *
 * // Run and get all results:
 * const records = await batcher.run(txEnvelopes.map(xdr => () => server.sendTransaction(xdr)));
 *
 * // Or use the typed split helper:
 * const { fulfilled, rejected } = await batcher.submitWithResults(tasks);
 * console.log(`${fulfilled.length} succeeded, ${rejected.length} failed`);
 */
export class TransactionBatcher {
    config;
    liveRecords = new Map();
    /** Instance-level counter to generate unique task IDs without global state */
    idCounter = 0;
    constructor(config) {
        this.config = {
            maxRetries: 3,
            backoffMultiplier: 2,
            maxJitter: 200,
            ...config,
        };
    }
    nextId() {
        return `tx-${++this.idCounter}-${Date.now()}`;
    }
    /**
     * Submits an array of transaction tasks.
     *
     * @param tasks   - Array of async functions, each submitting one transaction
     * @param signal  - Optional AbortSignal to cancel pending submissions
     * @returns       - Settled records in input order
     */
    async run(tasks, signal) {
        if (tasks.length === 0)
            return [];
        const ids = tasks.map(() => {
            const id = this.nextId();
            this.liveRecords.set(id, { id, status: "pending", attempts: 0 });
            return id;
        });
        const taskPairs = tasks.map((task, i) => ({ task, id: ids[i] }));
        for (let batchStart = 0; batchStart < taskPairs.length; batchStart += this.config.batchSize) {
            if (signal?.aborted) {
                for (let j = batchStart; j < taskPairs.length; j++) {
                    const rec = this.liveRecords.get(taskPairs[j].id);
                    if (rec?.status === "pending") {
                        rec.status = "rejected";
                        rec.error = new DOMException("Aborted", "AbortError");
                    }
                }
                break;
            }
            const batch = taskPairs.slice(batchStart, batchStart + this.config.batchSize);
            await this._executeBatch(batch, signal);
        }
        const results = ids.map((id) => {
            const rec = this.liveRecords.get(id);
            if (!rec)
                return { id, status: "rejected", attempts: 0, error: new Error("Unknown task") };
            return { ...rec };
        });
        // Flush terminal records to free memory
        for (const id of ids) {
            const rec = this.liveRecords.get(id);
            if (rec?.status !== "pending")
                this.liveRecords.delete(id);
        }
        return results;
    }
    /**
     * Convenience wrapper around `run()` that returns a typed split of
     * fulfilled and rejected records instead of a mixed flat array.
     *
     * @param tasks   - Array of async functions, each submitting one transaction
     * @param signal  - Optional AbortSignal to cancel pending submissions
     * @returns       - `{ fulfilled, rejected }` with narrow types on each record
     *
     * @example
     * const { fulfilled, rejected } = await batcher.submitWithResults(tasks);
     * for (const r of fulfilled) console.log('hash:', r.result.hash);
     * for (const r of rejected)  console.error('error:', r.error.message);
     */
    async submitWithResults(tasks, signal) {
        const records = await this.run(tasks, signal);
        const fulfilled = [];
        const rejected = [];
        for (const record of records) {
            if (record.status === "fulfilled") {
                fulfilled.push(record);
            }
            else if (record.status === "rejected") {
                rejected.push(record);
            }
        }
        return { fulfilled, rejected };
    }
    async _executeBatch(batch, signal) {
        const executing = new Set();
        for (const { task, id } of batch) {
            if (signal?.aborted) {
                const rec = this.liveRecords.get(id);
                if (rec?.status === "pending") {
                    rec.status = "rejected";
                    rec.error = new DOMException("Aborted", "AbortError");
                }
                continue;
            }
            const p = this._executeTask(task, id, signal).finally(() => executing.delete(p));
            executing.add(p);
            if (executing.size >= this.config.maxConcurrency) {
                await Promise.race(executing);
            }
        }
        await Promise.allSettled(executing);
    }
    async _executeTask(task, id, signal) {
        const record = this.liveRecords.get(id);
        if (!record)
            return;
        const { maxRetries, retryInterval, backoffMultiplier, maxJitter } = this.config;
        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            if (signal?.aborted) {
                record.status = "rejected";
                record.error = new DOMException("Aborted", "AbortError");
                return;
            }
            try {
                record.attempts++;
                record.result = await task();
                record.status = "fulfilled";
                return;
            }
            catch (err) {
                if (attempt === maxRetries) {
                    record.status = "rejected";
                    record.error = err instanceof Error ? err : new Error(String(err));
                    return;
                }
                const backoffMs = calcBackoff(attempt, retryInterval, backoffMultiplier, maxJitter);
                try {
                    await sleep(backoffMs, signal);
                }
                catch {
                    record.status = "rejected";
                    record.error = new DOMException("Aborted", "AbortError");
                    return;
                }
            }
        }
    }
    /** Real-time snapshot of all currently tracked live transaction statuses. */
    getStatus() {
        const pending = [];
        const fulfilled = [];
        const rejected = [];
        for (const record of this.liveRecords.values()) {
            const copy = { ...record };
            if (record.status === "pending")
                pending.push(copy);
            else if (record.status === "fulfilled")
                fulfilled.push(copy);
            else
                rejected.push(copy);
        }
        return { pending, fulfilled, rejected };
    }
    get size() { return this.liveRecords.size; }
}
