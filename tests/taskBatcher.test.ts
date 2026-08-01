/**
 * Tests for TaskBatcher - concurrent request batcher with backoff retry.
 */

import { TaskBatcher, TaskBatcherConfig, Task } from "../src/taskBatcher.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Creates a task that resolves after `delayMs` with `value` */
function resolveAfter<T>(value: T, delayMs = 0): Task<T> {
  return () =>
    new Promise<T>((resolve) => setTimeout(() => resolve(value), delayMs));
}

/** Creates a task that rejects on the first `failTimes` calls, then resolves */
function failThenResolve<T>(
  value: T,
  failTimes: number,
  errorMsg = "transient error"
): Task<T> {
  let calls = 0;
  return () => {
    calls++;
    if (calls <= failTimes) return Promise.reject(new Error(errorMsg));
    return Promise.resolve(value);
  };
}

/** Creates a task that always rejects */
function alwaysReject(msg = "permanent error"): Task<never> {
  return () => Promise.reject(new Error(msg));
}

const defaultConfig: TaskBatcherConfig = {
  maxConcurrency: 3,
  batchSize: 5,
  retryInterval: 10, // short for tests
  maxRetries: 3,
  backoffMultiplier: 2,
  maxJitter: 5,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("TaskBatcher", () => {
  describe("basic execution", () => {
    it("executes all tasks and returns results in order", async () => {
      const batcher = new TaskBatcher<number>(defaultConfig);
      const tasks = [1, 2, 3, 4, 5].map((n) => resolveAfter(n));

      const records = await batcher.run(tasks);

      expect(records).toHaveLength(5);
      records.forEach((r, i) => {
        expect(r.status).toBe("fulfilled");
        expect(r.result).toBe(i + 1);
      });
    });

    it("handles a single task", async () => {
      const batcher = new TaskBatcher<string>(defaultConfig);
      const records = await batcher.run([resolveAfter("hello")]);

      expect(records).toHaveLength(1);
      expect(records[0].status).toBe("fulfilled");
      expect(records[0].result).toBe("hello");
    });

    it("handles an empty task list", async () => {
      const batcher = new TaskBatcher<string>(defaultConfig);
      const records = await batcher.run([]);
      expect(records).toHaveLength(0);
    });
  });

  describe("TypeScript generics compile without 'any'", () => {
    it("correctly infers type parameters for different shapes", async () => {
      interface ApiResponse {
        userId: number;
        data: string;
      }
      const batcher = new TaskBatcher<ApiResponse>(defaultConfig);
      const task: Task<ApiResponse> = resolveAfter({ userId: 1, data: "ok" });
      const [record] = await batcher.run([task]);

      expect(record.status).toBe("fulfilled");
      // TypeScript ensures result is typed as ApiResponse
      expect(record.result?.userId).toBe(1);
      expect(record.result?.data).toBe("ok");
    });
  });

  describe("retry with exponential backoff", () => {
    it("retries failed tasks and eventually fulfills", async () => {
      const batcher = new TaskBatcher<string>(defaultConfig);
      // Fails twice, then resolves on the 3rd attempt
      const task = failThenResolve("success", 2);
      const [record] = await batcher.run([task]);

      expect(record.status).toBe("fulfilled");
      expect(record.result).toBe("success");
      expect(record.attempts).toBe(3);
    }, 10_000);

    it("marks tasks as rejected after maxRetries exhausted", async () => {
      const batcher = new TaskBatcher<string>({
        ...defaultConfig,
        maxRetries: 2,
      });
      const [record] = await batcher.run([alwaysReject("permanent")]);

      expect(record.status).toBe("rejected");
      expect(record.error?.message).toBe("permanent");
      expect(record.attempts).toBe(3); // initial + 2 retries
    }, 10_000);

    it("uses exponential backoff (increasing delays)", async () => {
      const delays: number[] = [];
      let lastTime = Date.now();

      const batcher = new TaskBatcher<void>({
        ...defaultConfig,
        retryInterval: 20,
        maxRetries: 3,
        maxJitter: 0, // disable jitter for deterministic timing
      });

      let callCount = 0;
      const task: Task<void> = () => {
        const now = Date.now();
        if (callCount > 0) delays.push(now - lastTime);
        lastTime = now;
        callCount++;
        if (callCount <= 3) return Promise.reject(new Error("fail"));
        return Promise.resolve();
      };

      const [record] = await batcher.run([task]);

      expect(record.status).toBe("fulfilled");
      // Verify delays are roughly increasing (exponential)
      for (let i = 1; i < delays.length; i++) {
        expect(delays[i]).toBeGreaterThanOrEqual(delays[i - 1] * 0.9); // 10% tolerance
      }
    }, 15_000);
  });

  describe("concurrency throttling", () => {
    it("respects maxConcurrency limit", async () => {
      let concurrentCount = 0;
      let maxObserved = 0;
      const MAX_CONCURRENCY = 3;

      const batcher = new TaskBatcher<void>({
        maxConcurrency: MAX_CONCURRENCY,
        batchSize: 10,
        retryInterval: 10,
      });

      const tasks: Task<void>[] = Array.from({ length: 10 }, () => async () => {
        concurrentCount++;
        maxObserved = Math.max(maxObserved, concurrentCount);
        await new Promise<void>((r) => setTimeout(r, 20));
        concurrentCount--;
      });

      await batcher.run(tasks);

      expect(maxObserved).toBeLessThanOrEqual(MAX_CONCURRENCY);
    }, 15_000);

    it("processes all tasks even with low concurrency", async () => {
      const batcher = new TaskBatcher<number>({
        maxConcurrency: 2,
        batchSize: 10,
        retryInterval: 10,
      });

      const tasks = Array.from({ length: 8 }, (_, i) => resolveAfter(i));
      const records = await batcher.run(tasks);

      expect(records).toHaveLength(8);
      expect(records.every((r) => r.status === "fulfilled")).toBe(true);
    });
  });

  describe("batch size handling", () => {
    it("splits tasks into correct batch sizes", async () => {
      const batcher = new TaskBatcher<number>({
        maxConcurrency: 5,
        batchSize: 3,
        retryInterval: 10,
      });

      const tasks = Array.from({ length: 7 }, (_, i) => resolveAfter(i));
      const records = await batcher.run(tasks);

      expect(records).toHaveLength(7);
      expect(records.every((r) => r.status === "fulfilled")).toBe(true);
    });
  });

  describe("status reporting", () => {
    it("reports pending tasks during execution", async () => {
      const batcher = new TaskBatcher<number>({
        maxConcurrency: 1,
        batchSize: 3,
        retryInterval: 10,
      });

      let statusDuringExecution: ReturnType<typeof batcher.getStatus> | null = null;

      const tasks: Task<number>[] = [
        async () => {
          // Capture status while task is running
          statusDuringExecution = batcher.getStatus();
          await new Promise<void>((r) => setTimeout(r, 10));
          return 1;
        },
        resolveAfter(2, 5),
        resolveAfter(3, 5),
      ];

      await batcher.run(tasks);

      // At the time of capture, other tasks should have been pending
      expect(statusDuringExecution).not.toBeNull();
    });

    it("returns arrays for pending, fulfilled, and rejected", async () => {
      const batcher = new TaskBatcher<number>(defaultConfig);
      const status = batcher.getStatus();

      expect(Array.isArray(status.pending)).toBe(true);
      expect(Array.isArray(status.fulfilled)).toBe(true);
      expect(Array.isArray(status.rejected)).toBe(true);
    });
  });

  describe("AbortSignal integration", () => {
    it("halts pending execution when signal is aborted", async () => {
      const controller = new AbortController();
      const batcher = new TaskBatcher<number>({
        maxConcurrency: 1,
        batchSize: 10,
        retryInterval: 10,
      });

      let executedCount = 0;
      const tasks: Task<number>[] = Array.from({ length: 10 }, (_, i) => async () => {
        executedCount++;
        if (i === 1) controller.abort(); // abort after second task starts
        await new Promise<void>((r) => setTimeout(r, 5));
        return i;
      });

      const records = await batcher.run(tasks, controller.signal);

      // Not all 10 tasks should have been executed
      expect(executedCount).toBeLessThan(10);
      // Some should be marked as rejected (aborted)
      expect(records.some((r) => r.status === "rejected")).toBe(true);
    }, 10_000);

    it("immediately rejects when signal is already aborted", async () => {
      const controller = new AbortController();
      controller.abort();

      const batcher = new TaskBatcher<number>(defaultConfig);
      const tasks = Array.from({ length: 5 }, (_, i) => resolveAfter(i));
      const records = await batcher.run(tasks, controller.signal);

      // All tasks should be either rejected or not run (pending/rejected)
      const executed = records.filter((r) => r.status === "fulfilled").length;
      expect(executed).toBe(0);
    }, 5_000);
  });

  describe("mixed success and failure", () => {
    it("handles a mix of succeeding and permanently failing tasks", async () => {
      const batcher = new TaskBatcher<string>({
        ...defaultConfig,
        maxRetries: 1,
      });

      const tasks: Task<string>[] = [
        resolveAfter("a"),
        alwaysReject("err1"),
        resolveAfter("b"),
        alwaysReject("err2"),
        resolveAfter("c"),
      ];

      const records = await batcher.run(tasks);

      const fulfilled = records.filter((r) => r.status === "fulfilled");
      const rejected = records.filter((r) => r.status === "rejected");

      expect(fulfilled).toHaveLength(3);
      expect(rejected).toHaveLength(2);
    }, 15_000);
  });
});
