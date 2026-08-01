/**
 * Concurrent Request Batcher with Exponential Backoff Retry
 *
 * Executes tasks in configurable batch sizes with concurrency control,
 * exponential backoff + jitter on failure, and AbortSignal support.
 */

export interface TaskBatcherConfig {
  /** Maximum number of tasks running concurrently */
  maxConcurrency: number;
  /** Number of tasks per batch dispatch */
  batchSize: number;
  /** Base retry interval in milliseconds */
  retryInterval: number;
  /** Maximum number of retry attempts per task (default: 3) */
  maxRetries?: number;
  /** Exponential backoff multiplier (default: 2) */
  backoffMultiplier?: number;
  /** Maximum jitter added to backoff in ms (default: 100) */
  maxJitter?: number;
}

export type TaskStatus = "pending" | "fulfilled" | "rejected";

export interface TaskRecord<T> {
  id: string;
  status: TaskStatus;
  result?: T;
  error?: Error;
  attempts: number;
}

export interface BatcherStatus<T> {
  pending: TaskRecord<T>[];
  fulfilled: TaskRecord<T>[];
  rejected: TaskRecord<T>[];
}

/** A unit of work: a function returning a Promise */
export type Task<T> = () => Promise<T>;

/**
 * Calculates exponential backoff with full jitter.
 *
 * Formula: min(cap, base * (multiplier ^ attempt)) + random jitter
 */
function calcBackoff(
  attempt: number,
  baseMs: number,
  multiplier: number,
  maxJitter: number,
  cap = 30_000
): number {
  const exponential = Math.min(cap, baseMs * Math.pow(multiplier, attempt));
  const jitter = Math.random() * maxJitter;
  return exponential + jitter;
}

/** Promise-based sleep that respects AbortSignal */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(resolve, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

let _idCounter = 0;
function nextId(): string {
  return `task-${++_idCounter}-${Date.now()}`;
}

/**
 * Batches and executes tasks with configurable concurrency, batch size,
 * exponential backoff retry, jitter, and abort signal support.
 */
export class TaskBatcher<T> {
  private readonly config: Required<TaskBatcherConfig>;
  /**
   * Live tracking map for tasks that are currently running.
   * Terminal records are removed from this map after run() collects results.
   */
  private liveRecords: Map<string, TaskRecord<T>> = new Map();

  constructor(config: TaskBatcherConfig) {
    this.config = {
      maxRetries: 3,
      backoffMultiplier: 2,
      maxJitter: 100,
      ...config,
    };
  }

  /**
   * Submits an array of tasks for execution.
   *
   * @param tasks   - Array of task functions to run
   * @param signal  - Optional AbortSignal to cancel the entire batch
   * @returns       - Array of settled task records in input order
   */
  async run(tasks: Task<T>[], signal?: AbortSignal): Promise<TaskRecord<T>[]> {
    if (tasks.length === 0) return [];

    // Register all tasks as pending and store initial records
    const ids: string[] = tasks.map((_, i) => {
      const id = nextId();
      this.liveRecords.set(id, { id, status: "pending", attempts: 0 });
      return id;
    });

    const taskPairs = tasks.map((task, i) => ({ task, id: ids[i] }));

    // Process in batches
    for (
      let batchStart = 0;
      batchStart < taskPairs.length;
      batchStart += this.config.batchSize
    ) {
      if (signal?.aborted) {
        // Mark all remaining tasks as rejected
        for (let j = batchStart; j < taskPairs.length; j++) {
          const rec = this.liveRecords.get(taskPairs[j].id);
          if (rec && rec.status === "pending") {
            rec.status = "rejected";
            rec.error = new DOMException("Aborted", "AbortError") as Error;
          }
        }
        break;
      }

      const batch = taskPairs.slice(
        batchStart,
        batchStart + this.config.batchSize
      );
      await this._executeBatch(batch, signal);
    }

    // Collect results before flushing terminal records from the live map
    const results = ids.map((id) => {
      const rec = this.liveRecords.get(id);
      if (!rec) {
        // Should not happen, but provide a safe fallback
        return { id, status: "rejected" as TaskStatus, attempts: 0, error: new Error("Unknown task") };
      }
      return { ...rec }; // snapshot copy
    });

    // Flush terminal records to free memory (lazy GC)
    for (const id of ids) {
      const rec = this.liveRecords.get(id);
      if (rec && rec.status !== "pending") {
        this.liveRecords.delete(id);
      }
    }

    return results;
  }

  /**
   * Executes a single batch, throttling concurrency to maxConcurrency.
   */
  private async _executeBatch(
    batch: { task: Task<T>; id: string }[],
    signal?: AbortSignal
  ): Promise<void> {
    const executing = new Set<Promise<void>>();

    for (const { task, id } of batch) {
      if (signal?.aborted) {
        // Mark remaining batch tasks as rejected
        const rec = this.liveRecords.get(id);
        if (rec && rec.status === "pending") {
          rec.status = "rejected";
          rec.error = new DOMException("Aborted", "AbortError") as Error;
        }
        continue;
      }

      const p = this._executeTask(task, id, signal).finally(() => {
        executing.delete(p);
      });
      executing.add(p);

      if (executing.size >= this.config.maxConcurrency) {
        // Wait for the first slot to free up
        await Promise.race(executing);
      }
    }

    // Drain remaining
    await Promise.allSettled(executing);
  }

  /**
   * Runs a single task with exponential backoff retries.
   */
  private async _executeTask(
    task: Task<T>,
    id: string,
    signal?: AbortSignal
  ): Promise<void> {
    const record = this.liveRecords.get(id);
    if (!record) return;

    const { maxRetries, retryInterval, backoffMultiplier, maxJitter } =
      this.config;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (signal?.aborted) {
        record.status = "rejected";
        record.error = new DOMException("Aborted", "AbortError") as Error;
        return;
      }

      try {
        record.attempts++;
        const result = await task();
        record.status = "fulfilled";
        record.result = result;
        return;
      } catch (err) {
        const isLastAttempt = attempt === maxRetries;
        if (isLastAttempt) {
          record.status = "rejected";
          record.error =
            err instanceof Error ? err : new Error(String(err));
          return;
        }

        // Wait with exponential backoff + jitter before retrying
        const backoffMs = calcBackoff(
          attempt,
          retryInterval,
          backoffMultiplier,
          maxJitter
        );
        try {
          await sleep(backoffMs, signal);
        } catch {
          // Aborted during sleep
          record.status = "rejected";
          record.error = new DOMException("Aborted", "AbortError") as Error;
          return;
        }
      }
    }
  }

  /**
   * Returns a real-time snapshot of all currently tracked live task statuses.
   * Records are flushed from the map after run() completes.
   */
  getStatus(): BatcherStatus<T> {
    const pending: TaskRecord<T>[] = [];
    const fulfilled: TaskRecord<T>[] = [];
    const rejected: TaskRecord<T>[] = [];

    for (const record of this.liveRecords.values()) {
      const copy = { ...record };
      if (record.status === "pending") pending.push(copy);
      else if (record.status === "fulfilled") fulfilled.push(copy);
      else rejected.push(copy);
    }

    return { pending, fulfilled, rejected };
  }

  /**
   * Returns the count of currently tracked live tasks.
   */
  get size(): number {
    return this.liveRecords.size;
  }
}
