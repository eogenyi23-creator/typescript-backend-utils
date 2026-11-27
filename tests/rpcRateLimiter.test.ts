/**
 * Tests for the Stellar RPC / Horizon rate limiter middleware.
 */

import { createRpcRateLimiter, RpcRateLimiter, RpcRequest, RpcResponse } from "../src/rpcRateLimiter.js";

// ---------------------------------------------------------------------------
// Mock Redis
// ---------------------------------------------------------------------------

class MockRedis {
  private store: Map<string, Record<string, string>> = new Map();

  async eval(
    _script: string,
    _numKeys: number,
    key: string,
    maxTokens: string,
    refillRate: string,
    nowMs: string,
    _ttlSec: string
  ): Promise<[number, number, number]> {
    const max = parseFloat(maxTokens);
    const rate = parseFloat(refillRate);
    const now = parseFloat(nowMs);

    const entry = this.store.get(key);
    let tokens = entry ? parseFloat(entry.tokens) : max;
    const lastRefill = entry ? parseFloat(entry.last_refill) : now;

    const elapsed = (now - lastRefill) / 1000;
    tokens = Math.min(max, tokens + elapsed * rate);

    let allowed = 0;
    let retryAfter = 0;
    if (tokens >= 1) { tokens -= 1; allowed = 1; }
    else { retryAfter = Math.ceil((1 - tokens) / rate); }

    this.store.set(key, { tokens: String(tokens), last_refill: String(now) });
    return [allowed, Math.floor(tokens), retryAfter];
  }

  simulateError(should: boolean): void {
    if (should) {
      (this as unknown as Record<string, unknown>).eval = async () => {
        throw new Error("Redis connection refused");
      };
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

class MockResponse {
  statusCode = 200;
  headers: Record<string, string | number> = {};
  body = "";

  status(code: number): this { this.statusCode = code; return this; }
  setHeader(name: string, value: string | number): void { this.headers[name] = value; }
  end(body?: string): void { if (body) this.body = body; }
}

function makeReq(ip = "127.0.0.1"): RpcRequest {
  return { headers: {}, ip };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createRpcRateLimiter", () => {
  let redis: MockRedis;

  beforeEach(() => { redis = new MockRedis(); });

  describe("public tier (60 req/min)", () => {
    it("allows requests within the bucket", async () => {
      const mw = createRpcRateLimiter("soroban-rpc", "public", redis as never);
      const res = new MockResponse();
      let next = false;
      await mw(makeReq(), res, () => { next = true; });
      expect(next).toBe(true);
      expect(res.statusCode).toBe(200);
    });

    it("returns 429 after exhausting the 60-token public bucket", async () => {
      const mw = createRpcRateLimiter("soroban-rpc", "public", redis as never);
      for (let i = 0; i < 60; i++) {
        await mw(makeReq("10.0.0.1"), new MockResponse(), () => {});
      }
      const res = new MockResponse();
      let next = false;
      await mw(makeReq("10.0.0.1"), res, () => { next = true; });
      expect(next).toBe(false);
      expect(res.statusCode).toBe(429);
    });

    it("sets X-RateLimit-Retry-After on 429", async () => {
      const mw = createRpcRateLimiter("soroban-rpc", "public", redis as never);
      for (let i = 0; i < 60; i++) await mw(makeReq("10.0.0.2"), new MockResponse(), () => {});
      const res = new MockResponse();
      await mw(makeReq("10.0.0.2"), res, () => {});
      expect(res.statusCode).toBe(429);
      expect(typeof res.headers["X-RateLimit-Retry-After"]).toBe("number");
    });

    it("sets informational rate-limit headers on allowed requests", async () => {
      const mw = createRpcRateLimiter("soroban-rpc", "public", redis as never);
      const res = new MockResponse();
      await mw(makeReq("10.0.0.3"), res, () => {});
      expect(res.headers["X-RateLimit-Limit"]).toBe(60);
      expect(res.headers["X-RateLimit-Window"]).toBe(60);
      expect(typeof res.headers["X-RateLimit-Remaining"]).toBe("number");
    });

    it("tracks separate buckets per IP (Stellar address or user IP)", async () => {
      const mw = createRpcRateLimiter("soroban-rpc", "public", redis as never);
      for (let i = 0; i < 60; i++) await mw(makeReq("10.0.0.10"), new MockResponse(), () => {});
      const res = new MockResponse();
      let next = false;
      await mw(makeReq("10.0.0.11"), res, () => { next = true; });
      expect(next).toBe(true);
    });
  });

  describe("authenticated tier (300 req/min)", () => {
    it("allows 300 requests before rate limiting", async () => {
      const mw = createRpcRateLimiter("horizon", "authenticated", redis as never);
      for (let i = 0; i < 300; i++) {
        const res = new MockResponse();
        let next = false;
        await mw(makeReq("auth-user"), res, () => { next = true; });
        expect(next).toBe(true);
      }
      const res = new MockResponse();
      let next = false;
      await mw(makeReq("auth-user"), res, () => { next = true; });
      expect(next).toBe(false);
      expect(res.statusCode).toBe(429);
    });
  });

  describe("custom config override", () => {
    it("uses custom maxTokens when provided", async () => {
      const mw = createRpcRateLimiter("soroban-rpc", "public", redis as never, { maxTokens: 5, refillRate: 5 / 60 });
      for (let i = 0; i < 5; i++) await mw(makeReq("custom-ip"), new MockResponse(), () => {});
      const res = new MockResponse();
      let next = false;
      await mw(makeReq("custom-ip"), res, () => { next = true; });
      expect(next).toBe(false);
      expect(res.statusCode).toBe(429);
    });
  });

  describe("fail-open on Redis error", () => {
    it("calls next() and does not crash when Redis is unavailable", async () => {
      redis.simulateError(true);
      const mw = createRpcRateLimiter("soroban-rpc", "public", redis as never);
      const res = new MockResponse();
      let next = false;
      await expect(mw(makeReq(), res, () => { next = true; })).resolves.not.toThrow();
      expect(next).toBe(true);
    });
  });

  describe("trustProxy and IP resolution", () => {
    it("uses X-Forwarded-For when trustProxy is true", async () => {
      // Two requests from the same forwarded IP should share a bucket
      const mw = createRpcRateLimiter("soroban-rpc", "public", redis as never, { maxTokens: 1 }, { trustProxy: true });
      const req1: RpcRequest = { headers: { "x-forwarded-for": "203.0.113.1" } };
      const req2: RpcRequest = { headers: { "x-forwarded-for": "203.0.113.1" } };
      await mw(req1, new MockResponse(), () => {});
      const res = new MockResponse();
      let next = false;
      await mw(req2, res, () => { next = true; });
      expect(next).toBe(false);
      expect(res.statusCode).toBe(429);
    });

    it("picks the leftmost IP from a comma-separated X-Forwarded-For list", async () => {
      const mw = createRpcRateLimiter("soroban-rpc", "public", redis as never, { maxTokens: 1 }, { trustProxy: true });
      const req1: RpcRequest = { headers: { "x-forwarded-for": "10.0.0.1, 10.0.0.2, 10.0.0.3" } };
      const req2: RpcRequest = { headers: { "x-forwarded-for": "10.0.0.1" } };
      await mw(req1, new MockResponse(), () => {});
      const res = new MockResponse();
      let next = false;
      await mw(req2, res, () => { next = true; });
      // Both requests resolve to 10.0.0.1 — second should be rate-limited
      expect(next).toBe(false);
      expect(res.statusCode).toBe(429);
    });

    it("accepts X-Forwarded-For as an array header", async () => {
      const mw = createRpcRateLimiter("soroban-rpc", "public", redis as never, { maxTokens: 1 }, { trustProxy: true });
      const req1: RpcRequest = { headers: { "x-forwarded-for": ["203.0.113.5", "10.0.0.1"] } };
      await mw(req1, new MockResponse(), () => {});
      const req2: RpcRequest = { headers: { "x-forwarded-for": ["203.0.113.5"] } };
      const res = new MockResponse();
      let next = false;
      await mw(req2, res, () => { next = true; });
      expect(next).toBe(false);
      expect(res.statusCode).toBe(429);
    });

    it("falls back to socket.remoteAddress when no req.ip", async () => {
      const mw = createRpcRateLimiter("soroban-rpc", "public", redis as never, { maxTokens: 1 });
      const req: RpcRequest = { headers: {}, socket: { remoteAddress: "192.168.1.1" } };
      await mw(req, new MockResponse(), () => {});
      const req2: RpcRequest = { headers: {}, socket: { remoteAddress: "192.168.1.1" } };
      const res = new MockResponse();
      let next = false;
      await mw(req2, res, () => { next = true; });
      expect(next).toBe(false);
      expect(res.statusCode).toBe(429);
    });

    it("uses 'unknown' when no IP can be resolved", async () => {
      const mw = createRpcRateLimiter("soroban-rpc", "public", redis as never, { maxTokens: 1 });
      const req: RpcRequest = { headers: {} }; // no ip, no socket
      await mw(req, new MockResponse(), () => {});
      const res = new MockResponse();
      let next = false;
      await mw(req, res, () => { next = true; });
      expect(next).toBe(false);
      expect(res.statusCode).toBe(429);
    });
  });

  describe("RpcRateLimiter class (OO interface)", () => {
    it("RpcRateLimiter.create() returns a limiter with a working middleware()", async () => {
      const limiter = RpcRateLimiter.create("soroban-rpc", redis as never, "public");
      const mw = limiter.middleware();
      const res = new MockResponse();
      let called = false;
      await mw(makeReq("oo-test-ip"), res, () => { called = true; });
      expect(called).toBe(true);
    });

    it("middleware() respects rate limits set via RpcRateLimiter.create()", async () => {
      const limiter = RpcRateLimiter.create("soroban-rpc", redis as never, "public", { maxTokens: 2 });
      const mw = limiter.middleware();
      await mw(makeReq("oo-ip-2"), new MockResponse(), () => {});
      await mw(makeReq("oo-ip-2"), new MockResponse(), () => {});
      const res = new MockResponse();
      let next = false;
      await mw(makeReq("oo-ip-2"), res, () => { next = true; });
      expect(next).toBe(false);
      expect(res.statusCode).toBe(429);
    });
  });
});
