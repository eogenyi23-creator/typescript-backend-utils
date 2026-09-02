/**
 * Tests for the Stellar Horizon event handler.
 */

import {
  createHorizonEventHandler,
  computeHorizonSignature,
  verifyHorizonSignature,
  validateHorizonPayload,
  HorizonIdempotencyStore,
  HorizonEventQueue,
  HorizonEventPayload,
  HorizonEventRequest,
  HorizonEventResponse,
} from "../src/horizonEventHandler.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_SECRET = "stellar-test-secret-key-xyz";

function makePayload(overrides?: Partial<HorizonEventPayload>): HorizonEventPayload {
  return {
    id: `evt-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    timestamp: Math.floor(Date.now() / 1000),
    type: "payment",
    ledger: 54321,
    data: { amount: "100.0000000", asset: "XLM", from: "GABC...", to: "GDEF..." },
    ...overrides,
  };
}

function makeRequest(payload: HorizonEventPayload, secret = TEST_SECRET, overrides?: Partial<HorizonEventRequest>): HorizonEventRequest {
  const rawBody = Buffer.from(JSON.stringify(payload), "utf8");
  return {
    rawBody,
    headers: { "x-stellar-signature": computeHorizonSignature(secret, rawBody) },
    ...overrides,
  };
}

class MockResponse {
  statusCode = 200;
  body: unknown = null;
  status(code: number): this { this.statusCode = code; return this; }
  json(b: unknown): void { this.body = b; }
  end(b?: string): void { this.body = b; }
}

// ---------------------------------------------------------------------------
// computeHorizonSignature
// ---------------------------------------------------------------------------

describe("computeHorizonSignature", () => {
  it("produces a 64-char hex string", () => {
    const sig = computeHorizonSignature("secret", Buffer.from("body"));
    expect(sig).toHaveLength(64);
    expect(/^[0-9a-f]+$/.test(sig)).toBe(true);
  });

  it("differs with different secrets", () => {
    const b = Buffer.from("body");
    expect(computeHorizonSignature("s1", b)).not.toBe(computeHorizonSignature("s2", b));
  });
});

// ---------------------------------------------------------------------------
// verifyHorizonSignature
// ---------------------------------------------------------------------------

describe("verifyHorizonSignature", () => {
  it("returns true for a valid Horizon signature", () => {
    const body = Buffer.from("stellar_event");
    const sig = computeHorizonSignature(TEST_SECRET, body);
    expect(verifyHorizonSignature(TEST_SECRET, body, sig)).toBe(true);
  });

  it("accepts sha256= prefix (standard format)", () => {
    const body = Buffer.from("stellar_event");
    const sig = "sha256=" + computeHorizonSignature(TEST_SECRET, body);
    expect(verifyHorizonSignature(TEST_SECRET, body, sig)).toBe(true);
  });

  it("returns false for a tampered body", () => {
    const body = Buffer.from("original");
    const sig = computeHorizonSignature(TEST_SECRET, body);
    expect(verifyHorizonSignature(TEST_SECRET, Buffer.from("tampered"), sig)).toBe(false);
  });

  it("returns false for empty signature", () => {
    expect(verifyHorizonSignature(TEST_SECRET, Buffer.from("body"), "")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// validateHorizonPayload
// ---------------------------------------------------------------------------

describe("validateHorizonPayload", () => {
  it("accepts a valid payment event", () => {
    expect(validateHorizonPayload(makePayload()).valid).toBe(true);
  });

  it("accepts a contract_event type", () => {
    expect(validateHorizonPayload(makePayload({ type: "contract_event" })).valid).toBe(true);
  });

  it("rejects null", () => {
    expect(validateHorizonPayload(null).valid).toBe(false);
  });

  it("rejects missing id", () => {
    const r = validateHorizonPayload({ timestamp: 1000, type: "payment", data: {} });
    expect(r.valid).toBe(false);
    if (!r.valid) expect(r.reason).toMatch(/id/);
  });

  it("rejects missing type", () => {
    const r = validateHorizonPayload({ id: "1", timestamp: 1000, data: {} });
    expect(r.valid).toBe(false);
    if (!r.valid) expect(r.reason).toMatch(/type/);
  });
});

// ---------------------------------------------------------------------------
// HorizonIdempotencyStore
// ---------------------------------------------------------------------------

describe("HorizonIdempotencyStore", () => {
  it("reports unseen events as not present", () => {
    const store = new HorizonIdempotencyStore();
    expect(store.has("evt-1")).toBe(false);
  });

  it("marks and tracks seen events", () => {
    const store = new HorizonIdempotencyStore();
    store.mark("evt-1", 1000);
    expect(store.has("evt-1")).toBe(true);
  });

  it("purges expired events", () => {
    const store = new HorizonIdempotencyStore();
    const oldTs = Math.floor(Date.now() / 1000) - 400;
    store.mark("old", oldTs);
    store.purgeExpired(300);
    expect(store.has("old")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// createHorizonEventHandler
// ---------------------------------------------------------------------------

describe("createHorizonEventHandler", () => {
  let idempotency: HorizonIdempotencyStore;
  let queue: HorizonEventQueue;

  beforeEach(() => {
    idempotency = new HorizonIdempotencyStore();
    queue = new HorizonEventQueue();
  });

  describe("successful acceptance", () => {
    it("returns 202 for a valid Stellar payment event", async () => {
      const handler = createHorizonEventHandler({ secret: TEST_SECRET }, idempotency, queue);
      const payload = makePayload({ type: "payment" });
      const res = new MockResponse();
      const result = await handler(makeRequest(payload), res);
      expect(res.statusCode).toBe(202);
      expect(result.accepted).toBe(true);
      expect(result.payload?.type).toBe("payment");
    });

    it("enqueues valid Horizon events for async processing", async () => {
      const handler = createHorizonEventHandler({ secret: TEST_SECRET }, idempotency, queue);
      const payload = makePayload();
      await handler(makeRequest(payload), new MockResponse());
      expect(queue.length).toBe(1);
      expect(queue.peek()[0].id).toBe(payload.id);
    });

    it("calls onEvent callback with the verified Stellar event", async () => {
      let received: HorizonEventPayload | null = null;
      const handler = createHorizonEventHandler(
        { secret: TEST_SECRET, onEvent: (p) => { received = p; } },
        idempotency, queue
      );
      const payload = makePayload();
      await handler(makeRequest(payload), new MockResponse());
      await new Promise((r) => setTimeout(r, 10));
      expect((received as HorizonEventPayload | null)?.id).toBe(payload.id);
    });
  });

  describe("signature verification", () => {
    it("returns 401 for missing signature", async () => {
      const handler = createHorizonEventHandler({ secret: TEST_SECRET }, idempotency, queue);
      const payload = makePayload();
      const req: HorizonEventRequest = { rawBody: Buffer.from(JSON.stringify(payload)), headers: {} };
      const result = await handler(req, new MockResponse());
      expect(result.reason).toBe("invalid_signature");
    });

    it("returns 401 for tampered body", async () => {
      const handler = createHorizonEventHandler({ secret: TEST_SECRET }, idempotency, queue);
      const payload = makePayload();
      const req = makeRequest(payload);
      req.rawBody = Buffer.from('{"tampered":true}');
      const result = await handler(req, new MockResponse());
      expect(result.reason).toBe("invalid_signature");
    });
  });

  describe("replay attack prevention", () => {
    it("rejects Stellar events older than 300s", async () => {
      const handler = createHorizonEventHandler({ secret: TEST_SECRET }, idempotency, queue);
      const payload = makePayload({ timestamp: Math.floor(Date.now() / 1000) - 400 });
      const result = await handler(makeRequest(payload), new MockResponse());
      expect(result.reason).toBe("replay_attack");
    });

    it("rejects events far in the future (clock skew protection)", async () => {
      const handler = createHorizonEventHandler({ secret: TEST_SECRET }, idempotency, queue);
      const payload = makePayload({ timestamp: Math.floor(Date.now() / 1000) + 200 });
      const result = await handler(makeRequest(payload), new MockResponse());
      expect(result.reason).toBe("future_timestamp");
    });
  });

  describe("idempotency", () => {
    it("accepts duplicate Horizon event IDs without reprocessing", async () => {
      const handler = createHorizonEventHandler({ secret: TEST_SECRET }, idempotency, queue);
      const payload = makePayload();
      await handler(makeRequest(payload), new MockResponse());
      const result = await handler(makeRequest(payload), new MockResponse());
      expect(result.reason).toBe("duplicate");
      expect(queue.length).toBe(1); // only processed once
    });

    it("processes different ledger events independently", async () => {
      const handler = createHorizonEventHandler({ secret: TEST_SECRET }, idempotency, queue);
      const p1 = makePayload({ id: "ledger-evt-1" });
      const p2 = makePayload({ id: "ledger-evt-2" });
      await handler(makeRequest(p1), new MockResponse());
      await handler(makeRequest(p2), new MockResponse());
      expect(queue.length).toBe(2);
    });
  });
});
