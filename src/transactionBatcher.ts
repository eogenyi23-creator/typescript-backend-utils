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
 * - Memory management: completed records flushed after run()
 */

export interface TransactionBatcherConfig {
  /** Maximum number of transactions submitting concurrently */
  maxConcurrency: number;
  /** Number of transactions per dispatch batch */
  batchSize: number;
  /** Base retry interval in milliseconds */
  retryInterval: number;
  /** Maximum number of retry attempts per transaction (default: 3) */
  maxRetries?: number;
  /** Exponential backoff multiplier (default: 2) */
  backoffMultiplier?: number;
  /** Maximum random jitter added to backoff in ms (default: 200) */
  maxJitter?: number;
}

export type TransactionStatus = "pending" | "fulfilled" | "rejected";

export interface TransactionRecord<T> {
  id: string;
  status: TransactionStatus;
  result?: T;
  error?: Error;
  attempts: number;
}

export interface BatcherStatus<T> {
  pending: TransactionRecord<T>[];
  fulfilled: TransactionRecord<T>[];
  rejected: TransactionRecord<T>[];
}

/** A unit of work: an async function that submits one transaction */
export type TransactionTask<T> = () => Promise<T>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Calculates exponential backoff with full jitter.
 * Full jitter prevents thundering-herd re-submission after fee spikes.
 */
function calcBackoff(
  attempt: number,
  baseMs: number,
  multiplier: number,
  maxJitter: number,
  cap = 30_000
): number {
  const exponential = Math.min(cap, baseMs * Math.pow(multiplier, attempt));
  return exponential + Math.random() * maxJitter;
}

/** Promise-based sleep that respects AbortSignal */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
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

let _idCounter = 0;
function nextId(): string {
  return `tx-${++_idCounter}-${Date.now()}`;
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
 * const results = await batcher.run(txEnvelopes.map(xdr => () => server.sendTransaction(xdr)));
 */
export class TransactionBatcher<T> {
  private readonly config: Required<TransactionBatcherConfig>;
  private liveRecords: Map<string, TransactionRecord<T>> = new Map();

  constructor(config: TransactionBatcherConfig) {
    this.config = {
      maxRetries: 3,
      backoffMultiplier: 2,
      maxJitter: 200,
      ...config,
    };
  }

  /**
   * Submits an array of transaction tasks.
   *
   * @param tasks   - Array of async functions, each submitting one transaction
   * @param signal  - Optional AbortSignal to cancel pending submissions
   * @returns       - Settled records in input order
   */
  async run(tasks: TransactionTask<T>[], signal?: AbortSignal): Promise<TransactionRecord<T>[]> {
    if (tasks.length === 0) return [];

    const ids: string[] = tasks.map(() => {
      const id = nextId();
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
            rec.error = new DOMException("Aborted", "AbortError") as Error;
          }
        }
        break;
      }
      const batch = taskPairs.slice(batchStart, batchStart + this.config.batchSize);
      await this._executeBatch(batch, signal);
    }

    const results = ids.map((id) => {
      const rec = this.liveRecords.get(id);
      if (!rec) return { id, status: "rejected" as TransactionStatus, attempts: 0, error: new Error("Unknown task") };
      return { ...rec };
    });

    // Flush terminal records to free memory
    for (const id of ids) {
      const rec = this.liveRecords.get(id);
      if (rec?.status !== "pending") this.liveRecords.delete(id);
    }

    return results;
  }

  private async _executeBatch(
    batch: { task: TransactionTask<T>; id: string }[],
    signal?: AbortSignal
  ): Promise<void> {
    const executing = new Set<Promise<void>>();

    for (const { task, id } of batch) {
      if (signal?.aborted) {
        const rec = this.liveRecords.get(id);
        if (rec?.status === "pending") {
          rec.status = "rejected";
          rec.error = new DOMException("Aborted", "AbortError") as Error;
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

  private async _executeTask(
    task: TransactionTask<T>,
    id: string,
    signal?: AbortSignal
  ): Promise<void> {
    const record = this.liveRecords.get(id);
    if (!record) return;

    const { maxRetries, retryInterval, backoffMultiplier, maxJitter } = this.config;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (signal?.aborted) {
        record.status = "rejected";
        record.error = new DOMException("Aborted", "AbortError") as Error;
        return;
      }

      try {
        record.attempts++;
        record.result = await task();
        record.status = "fulfilled";
        return;
      } catch (err) {
        if (attempt === maxRetries) {
          record.status = "rejected";
          record.error = err instanceof Error ? err : new Error(String(err));
          return;
        }
        const backoffMs = calcBackoff(attempt, retryInterval, backoffMultiplier, maxJitter);
        try {
          await sleep(backoffMs, signal);
        } catch {
          record.status = "rejected";
          record.error = new DOMException("Aborted", "AbortError") as Error;
          return;
        }
      }
    }
  }

  /** Real-time snapshot of all currently tracked live transaction statuses. */
  getStatus(): BatcherStatus<T> {
    const pending: TransactionRecord<T>[] = [];
    const fulfilled: TransactionRecord<T>[] = [];
    const rejected: TransactionRecord<T>[] = [];

    for (const record of this.liveRecords.values()) {
      const copy = { ...record };
      if (record.status === "pending") pending.push(copy);
      else if (record.status === "fulfilled") fulfilled.push(copy);
      else rejected.push(copy);
    }

    return { pending, fulfilled, rejected };
  }

  get size(): number { return this.liveRecords.size; }
}
