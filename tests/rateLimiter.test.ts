/**
 * Tests for the distributed rate limiter middleware.
 *
 * Uses a mock Redis client to avoid needing a live Redis instance.
 */

import { rateLimiter, RateLimitRequest, RateLimitResponse } from "../src/rateLimiter.js";

// ---------------------------------------------------------------------------
// Mock Redis client
// ---------------------------------------------------------------------------

class MockRedis {
  private store: Map<string, Record<string, string>> = new Map();

  /** Minimal HMGET/HMSET/EXPIRE simulation used by the Lua evaluator shim */
  async eval(
    _script: string,
    _numKeys: number,
    key: string,
    maxTokens: string,
    refillRate: string,
    nowMs: string,
    ttlSec: string
  ): Promise<[number, number, number]> {
    return this._runTokenBucket(key, maxTokens, refillRate, nowMs, ttlSec);
  }

  /** In-process replication of the Lua token bucket logic */
  private _runTokenBucket(
    key: string,
    maxTokensStr: string,
    refillRateStr: string,
    nowMsStr: string,
    _ttlSec: string
  ): [number, number, number] {
    const maxTokens = parseFloat(maxTokensStr);
    const refillRate = parseFloat(refillRateStr);
    const nowMs = parseFloat(nowMsStr);

    const entry = this.store.get(key);
    let tokens = entry ? parseFloat(entry.tokens) : maxTokens;
    const lastRefill = entry ? parseFloat(entry.last_refill) : nowMs;

    // Lazy replenishment
    const elapsedSec = (nowMs - lastRefill) / 1000;
    tokens = Math.min(maxTokens, tokens + elapsedSec * refillRate);

    let allowed = 0;
    let retryAfter = 0;

    if (tokens >= 1) {
      tokens -= 1;
      allowed = 1;
    } else {
      const needed = 1 - tokens;
      retryAfter = Math.ceil(needed / refillRate);
    }

    this.store.set(key, {
      tokens: String(tokens),
      last_refill: String(nowMs),
    });

    return [allowed, Math.floor(tokens), retryAfter];
  }

  /** Simulate a connection error for fail-open tests */
  simulateError(shouldError: boolean): void {
    if (shouldError) {
      (this as unknown as Record<string, unknown>).eval = async () => {
        throw new Error("Redis connection refused");
      };
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeReqRes(ip = "127.0.0.1"): {
  req: RateLimitRequest;
  res: MockResponse;
} {
  const req: RateLimitRequest = {
    headers: {},
    ip,
  };
  const res = new MockResponse();
  return { req, res };
}

class MockResponse {
  statusCode = 200;
  headers: Record<string, string | number> = {};
  body = "";

  status(code: number): this {
    this.statusCode = code;
    return this;
  }

  setHeader(name: string, value: string | number): void {
    this.headers[name] = value;
  }

  end(body?: string): void {
    if (body !== undefined) this.body = body;
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("rateLimiter middleware", () => {
  let redis: MockRedis;

  beforeEach(() => {
    redis = new MockRedis();
  });

  describe("free tier", () => {
    it("allows requests within the limit", async () => {
      const middleware = rateLimiter("free", redis as never);
      const { req, res } = makeReqRes();
      let nextCalled = false;

      await middleware(req, res, () => {
        nextCalled = true;
      });

      expect(nextCalled).toBe(true);
      expect(res.statusCode).toBe(200);
    });

    it("returns 429 after exhausting the free bucket (20 tokens)", async () => {
      const middleware = rateLimiter("free", redis as never);

      // Drain the 20-token free bucket
      for (let i = 0; i < 20; i++) {
        const { req, res } = makeReqRes("10.0.0.1");
        let nextCalled = false;
        await middleware(req, res, () => {
          nextCalled = true;
        });
        expect(nextCalled).toBe(true);
      }

      // The 21st request must be rejected
      const { req, res } = makeReqRes("10.0.0.1");
      let nextCalled = false;
      await middleware(req, res, () => {
        nextCalled = true;
      });

      expect(nextCalled).toBe(false);
      expect(res.statusCode).toBe(429);
    });

    it("sets X-RateLimit-Retry-After header on 429", async () => {
      const middleware = rateLimiter("free", redis as never);

      // Exhaust bucket
      for (let i = 0; i < 20; i++) {
        const { req, res } = makeReqRes("10.0.0.2");
        await middleware(req, res, () => {});
      }

      const { req, res } = makeReqRes("10.0.0.2");
      await middleware(req, res, () => {});

      expect(res.statusCode).toBe(429);
      expect(typeof res.headers["X-RateLimit-Retry-After"]).toBe("number");
      expect(res.headers["X-RateLimit-Retry-After"]).toBeGreaterThan(0);
    });

    it("sets informational rate-limit headers on allowed requests", async () => {
      const middleware = rateLimiter("free", redis as never);
      const { req, res } = makeReqRes("10.0.0.3");

      await middleware(req, res, () => {});

      expect(res.headers["X-RateLimit-Limit"]).toBe(20);
      expect(res.headers["X-RateLimit-Window"]).toBe(60);
      expect(typeof res.headers["X-RateLimit-Remaining"]).toBe("number");
    });

    it("tracks separate buckets per IP address", async () => {
      const middleware = rateLimiter("free", redis as never);

      // Exhaust IP A
      for (let i = 0; i < 20; i++) {
        const { req, res } = makeReqRes("192.168.1.1");
        await middleware(req, res, () => {});
      }

      // IP B should still have a full bucket
      const { req, res } = makeReqRes("192.168.1.2");
      let nextCalled = false;
      await middleware(req, res, () => {
        nextCalled = true;
      });

      expect(nextCalled).toBe(true);
      expect(res.statusCode).toBe(200);
    });
  });

  describe("premium tier", () => {
    it("allows more requests than free tier (100 tokens)", async () => {
      const middleware = rateLimiter("premium", redis as never);

      for (let i = 0; i < 100; i++) {
        const { req, res } = makeReqRes("premium-user");
        let nextCalled = false;
        await middleware(req, res, () => {
          nextCalled = true;
        });
        expect(nextCalled).toBe(true);
      }

      // 101st should be rejected
      const { req, res } = makeReqRes("premium-user");
      let nextCalled = false;
      await middleware(req, res, () => {
        nextCalled = true;
      });
      expect(nextCalled).toBe(false);
      expect(res.statusCode).toBe(429);
    });
  });

  describe("concurrent burst simulation", () => {
    it("rejects excess requests in a rapid concurrent burst", async () => {
      const middleware = rateLimiter("free", redis as never);
      const BURST = 30;
      const results: { nextCalled: boolean; status: number }[] = [];

      // Fire BURST requests "simultaneously" (all scheduled before any await resolves)
      const promises = Array.from({ length: BURST }, async () => {
        const { req, res } = makeReqRes("burst-ip");
        let nextCalled = false;
        await middleware(req, res, () => {
          nextCalled = true;
        });
        results.push({ nextCalled, status: res.statusCode });
      });

      await Promise.all(promises);

      const allowed = results.filter((r) => r.nextCalled).length;
      const rejected = results.filter((r) => r.status === 429).length;

      expect(allowed).toBe(20); // exactly max free tokens
      expect(rejected).toBe(10); // rest are rejected
    });
  });

  describe("fail-open on Redis error", () => {
    it("calls next() and does not crash when Redis is unavailable", async () => {
      redis.simulateError(true);
      const middleware = rateLimiter("free", redis as never);
      const { req, res } = makeReqRes();
      let nextCalled = false;

      // Should not throw
      await expect(
        middleware(req, res, () => {
          nextCalled = true;
        })
      ).resolves.not.toThrow();

      expect(nextCalled).toBe(true);
      expect(res.statusCode).toBe(200);
    });
  });
});
