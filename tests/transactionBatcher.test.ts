/**
 * Tests for the Soroban transaction batcher.
 */

import { TransactionBatcher, TransactionBatcherConfig, TransactionTask } from "../src/transactionBatcher.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Simulates a Soroban sendTransaction response */
interface SorobanSendResult {
  hash: string;
  status: "PENDING" | "SUCCESS" | "FAILED";
}

function resolveAfter<T>(value: T, delayMs = 0): TransactionTask<T> {
  return () => new Promise<T>((resolve) => setTimeout(() => resolve(value), delayMs));
}

function failThenResolve<T>(value: T, failTimes: number, msg = "txInsufficientFee"): TransactionTask<T> {
  let calls = 0;
  return () => {
    calls++;
    if (calls <= failTimes) return Promise.reject(new Error(msg));
    return Promise.resolve(value);
  };
}

function alwaysReject(msg = "txBadSeq"): TransactionTask<never> {
  return () => Promise.reject(new Error(msg));
}

const defaultConfig: TransactionBatcherConfig = {
  maxConcurrency: 3,
  batchSize: 5,
  retryInterval: 10,
  maxRetries: 3,
  backoffMultiplier: 2,
  maxJitter: 5,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("TransactionBatcher", () => {
  describe("basic execution", () => {
    it("submits all transactions and returns results in order", async () => {
      const batcher = new TransactionBatcher<SorobanSendResult>(defaultConfig);
      const txs = ["hash1", "hash2", "hash3"].map((hash) =>
        resolveAfter<SorobanSendResult>({ hash, status: "PENDING" })
      );
      const records = await batcher.run(txs);
      expect(records).toHaveLength(3);
      records.forEach((r, i) => {
        expect(r.status).toBe("fulfilled");
        expect(r.result?.hash).toBe(`hash${i + 1}`);
      });
    });

    it("handles a single transaction", async () => {
      const batcher = new TransactionBatcher<string>(defaultConfig);
      const records = await batcher.run([resolveAfter("txhash_abc")]);
      expect(records[0].status).toBe("fulfilled");
      expect(records[0].result).toBe("txhash_abc");
    });

    it("handles an empty transaction list", async () => {
      const batcher = new TransactionBatcher<string>(defaultConfig);
      expect(await batcher.run([])).toHaveLength(0);
    });
  });

  describe("retry on transient Soroban errors", () => {
    it("retries txInsufficientFee and eventually fulfills", async () => {
      const batcher = new TransactionBatcher<string>(defaultConfig);
      const task = failThenResolve("success", 2, "txInsufficientFee");
      const [record] = await batcher.run([task]);
      expect(record.status).toBe("fulfilled");
      expect(record.result).toBe("success");
      expect(record.attempts).toBe(3);
    }, 10_000);

    it("marks transactions as rejected after maxRetries exhausted", async () => {
      const batcher = new TransactionBatcher<string>({ ...defaultConfig, maxRetries: 2 });
      const [record] = await batcher.run([alwaysReject("txBadAuth")]);
      expect(record.status).toBe("rejected");
      expect(record.error?.message).toBe("txBadAuth");
      expect(record.attempts).toBe(3);
    }, 10_000);
  });

  describe("concurrency throttling", () => {
    it("respects maxConcurrency to avoid overwhelming the RPC node", async () => {
      let concurrent = 0;
      let maxObserved = 0;
      const MAX = 3;

      const batcher = new TransactionBatcher<void>({ maxConcurrency: MAX, batchSize: 10, retryInterval: 10 });
      const tasks: TransactionTask<void>[] = Array.from({ length: 10 }, () => async () => {
        concurrent++;
        maxObserved = Math.max(maxObserved, concurrent);
        await new Promise<void>((r) => setTimeout(r, 15));
        concurrent--;
      });

      await batcher.run(tasks);
      expect(maxObserved).toBeLessThanOrEqual(MAX);
    }, 15_000);

    it("processes all transactions even with low concurrency", async () => {
      const batcher = new TransactionBatcher<number>({ maxConcurrency: 2, batchSize: 10, retryInterval: 10 });
      const tasks = Array.from({ length: 8 }, (_, i) => resolveAfter(i));
      const records = await batcher.run(tasks);
      expect(records.every((r) => r.status === "fulfilled")).toBe(true);
    });
  });

  describe("AbortSignal integration", () => {
    it("cancels pending transactions when signal is aborted", async () => {
      const controller = new AbortController();
      const batcher = new TransactionBatcher<number>({ maxConcurrency: 1, batchSize: 10, retryInterval: 10 });
      let executed = 0;
      const tasks: TransactionTask<number>[] = Array.from({ length: 10 }, (_, i) => async () => {
        executed++;
        if (i === 1) controller.abort();
        await new Promise<void>((r) => setTimeout(r, 5));
        return i;
      });
      const records = await batcher.run(tasks, controller.signal);
      expect(executed).toBeLessThan(10);
      expect(records.some((r) => r.status === "rejected")).toBe(true);
    }, 10_000);
  });

  describe("mixed results", () => {
    it("handles mix of successful and permanently failing transactions", async () => {
      const batcher = new TransactionBatcher<string>({ ...defaultConfig, maxRetries: 1 });
      const tasks: TransactionTask<string>[] = [
        resolveAfter("tx1"),
        alwaysReject("txBadSeq"),
        resolveAfter("tx2"),
        alwaysReject("txBadSeq"),
        resolveAfter("tx3"),
      ];
      const records = await batcher.run(tasks);
      expect(records.filter((r) => r.status === "fulfilled")).toHaveLength(3);
      expect(records.filter((r) => r.status === "rejected")).toHaveLength(2);
    }, 15_000);
  });

  describe("status reporting", () => {
    it("returns arrays for pending, fulfilled, and rejected", () => {
      const batcher = new TransactionBatcher<number>(defaultConfig);
      const status = batcher.getStatus();
      expect(Array.isArray(status.pending)).toBe(true);
      expect(Array.isArray(status.fulfilled)).toBe(true);
      expect(Array.isArray(status.rejected)).toBe(true);
    });
  });
});
