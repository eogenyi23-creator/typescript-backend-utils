/**
 * Tests for the multi-provider webhook ingestion engine.
 */

import {
  createWebhookHandler,
  computeSignature,
  verifySignature,
  validatePayload,
  IdempotencyStore,
  WebhookQueue,
  WebhookPayload,
  WebhookRequest,
  WebhookResponse,
} from "../src/webhookHandler.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_SECRET = "test-secret-key-abc123";

function makePayload(overrides?: Partial<WebhookPayload>): WebhookPayload {
  return {
    id: `evt-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    timestamp: Math.floor(Date.now() / 1000),
    event: "payment.success",
    data: { amount: 100, currency: "USD" },
    ...overrides,
  };
}

function makeRequest(
  payload: WebhookPayload,
  secret = TEST_SECRET,
  overrides?: Partial<WebhookRequest>
): WebhookRequest {
  const rawBody = Buffer.from(JSON.stringify(payload), "utf8");
  const signature = computeSignature(secret, rawBody);

  return {
    rawBody,
    headers: {
      "x-signature-sha256": signature,
      "content-type": "application/json",
    },
    ...overrides,
  };
}

class MockResponse {
  statusCode = 200;
  body: unknown = null;

  status(code: number): this {
    this.statusCode = code;
    return this;
  }

  json(b: unknown): void {
    this.body = b;
  }

  end(b?: string): void {
    this.body = b;
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("computeSignature", () => {
  it("produces a hex string of length 64", () => {
    const sig = computeSignature("secret", Buffer.from("hello"));
    expect(typeof sig).toBe("string");
    expect(sig).toHaveLength(64);
    expect(/^[0-9a-f]+$/.test(sig)).toBe(true);
  });

  it("produces different signatures for different secrets", () => {
    const body = Buffer.from("body");
    const s1 = computeSignature("secret1", body);
    const s2 = computeSignature("secret2", body);
    expect(s1).not.toBe(s2);
  });

  it("produces different signatures for different bodies", () => {
    const s1 = computeSignature("secret", Buffer.from("body1"));
    const s2 = computeSignature("secret", Buffer.from("body2"));
    expect(s1).not.toBe(s2);
  });
});

describe("verifySignature", () => {
  it("returns true for a valid signature", () => {
    const body = Buffer.from("test body");
    const sig = computeSignature(TEST_SECRET, body);
    expect(verifySignature(TEST_SECRET, body, sig)).toBe(true);
  });

  it("returns true for signature with sha256= prefix", () => {
    const body = Buffer.from("test body");
    const sig = "sha256=" + computeSignature(TEST_SECRET, body);
    expect(verifySignature(TEST_SECRET, body, sig)).toBe(true);
  });

  it("returns false for a tampered body", () => {
    const original = Buffer.from("original");
    const sig = computeSignature(TEST_SECRET, original);
    const tampered = Buffer.from("tampered");
    expect(verifySignature(TEST_SECRET, tampered, sig)).toBe(false);
  });

  it("returns false for a wrong secret", () => {
    const body = Buffer.from("body");
    const sig = computeSignature("wrong-secret", body);
    expect(verifySignature(TEST_SECRET, body, sig)).toBe(false);
  });

  it("returns false for an empty signature", () => {
    const body = Buffer.from("body");
    expect(verifySignature(TEST_SECRET, body, "")).toBe(false);
  });
});

describe("validatePayload", () => {
  it("accepts a valid payload", () => {
    const payload = makePayload();
    const result = validatePayload(payload);
    expect(result.valid).toBe(true);
  });

  it("rejects null", () => {
    const result = validatePayload(null);
    expect(result.valid).toBe(false);
  });

  it("rejects an array", () => {
    const result = validatePayload([]);
    expect(result.valid).toBe(false);
  });

  it("rejects missing id", () => {
    const result = validatePayload({ timestamp: 1000, event: "x", data: {} });
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toMatch(/id/);
  });

  it("rejects missing timestamp", () => {
    const result = validatePayload({ id: "1", event: "x", data: {} });
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toMatch(/timestamp/);
  });

  it("rejects missing event", () => {
    const result = validatePayload({ id: "1", timestamp: 1000, data: {} });
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toMatch(/event/);
  });

  it("rejects missing data", () => {
    const result = validatePayload({ id: "1", timestamp: 1000, event: "x" });
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toMatch(/data/);
  });
});

describe("IdempotencyStore", () => {
  it("reports unseen events as not present", () => {
    const store = new IdempotencyStore();
    expect(store.has("evt-1")).toBe(false);
  });

  it("reports seen events correctly", () => {
    const store = new IdempotencyStore();
    store.mark("evt-1", 1000);
    expect(store.has("evt-1")).toBe(true);
  });

  it("purges expired events", () => {
    const store = new IdempotencyStore();
    const oldTs = Math.floor(Date.now() / 1000) - 400;
    store.mark("old-event", oldTs);
    expect(store.has("old-event")).toBe(true);

    store.purgeExpired(300);
    expect(store.has("old-event")).toBe(false);
  });
});

describe("createWebhookHandler", () => {
  let idempotency: IdempotencyStore;
  let queue: WebhookQueue;

  beforeEach(() => {
    idempotency = new IdempotencyStore();
    queue = new WebhookQueue();
  });

  describe("successful acceptance", () => {
    it("returns 202 Accepted for a valid webhook", async () => {
      const handler = createWebhookHandler(
        { secret: TEST_SECRET },
        idempotency,
        queue
      );
      const payload = makePayload();
      const req = makeRequest(payload);
      const res = new MockResponse();

      const result = await handler(req, res);

      expect(res.statusCode).toBe(202);
      expect(result.accepted).toBe(true);
      expect(result.payload?.id).toBe(payload.id);
    });

    it("enqueues valid payload for async processing", async () => {
      const handler = createWebhookHandler(
        { secret: TEST_SECRET },
        idempotency,
        queue
      );
      const payload = makePayload();
      await handler(makeRequest(payload), new MockResponse());

      expect(queue.length).toBe(1);
      expect(queue.peek()[0].id).toBe(payload.id);
    });

    it("calls onEvent callback with verified payload", async () => {
      let received: WebhookPayload | null = null;
      const handler = createWebhookHandler(
        { secret: TEST_SECRET, onEvent: (p) => { received = p; } },
        idempotency,
        queue
      );
      const payload = makePayload();
      await handler(makeRequest(payload), new MockResponse());

      // Give the fire-and-forget microtask time to run
      await new Promise((r) => setTimeout(r, 10));
      expect(received).not.toBeNull();
      expect((received as WebhookPayload | null)?.id).toBe(payload.id);
    });
  });

  describe("signature verification", () => {
    it("returns 401 for a missing signature header", async () => {
      const handler = createWebhookHandler(
        { secret: TEST_SECRET },
        idempotency,
        queue
      );
      const payload = makePayload();
      const req: WebhookRequest = {
        rawBody: Buffer.from(JSON.stringify(payload)),
        headers: {},
      };
      const res = new MockResponse();

      const result = await handler(req, res);

      expect(res.statusCode).toBe(401);
      expect(result.accepted).toBe(false);
      expect(result.reason).toBe("invalid_signature");
    });

    it("returns 401 for a tampered body", async () => {
      const handler = createWebhookHandler(
        { secret: TEST_SECRET },
        idempotency,
        queue
      );
      const payload = makePayload();
      const req = makeRequest(payload);
      // Tamper with the body after signing
      req.rawBody = Buffer.from('{"tampered":true}');
      const res = new MockResponse();

      const result = await handler(req, res);

      expect(res.statusCode).toBe(401);
      expect(result.reason).toBe("invalid_signature");
    });

    it("returns 401 for a wrong secret", async () => {
      const handler = createWebhookHandler(
        { secret: TEST_SECRET },
        idempotency,
        queue
      );
      const payload = makePayload();
      const req = makeRequest(payload, "wrong-secret");
      const res = new MockResponse();

      const result = await handler(req, res);

      expect(res.statusCode).toBe(401);
      expect(result.reason).toBe("invalid_signature");
    });

    it("accepts signatures with sha256= prefix", async () => {
      const handler = createWebhookHandler(
        { secret: TEST_SECRET },
        idempotency,
        queue
      );
      const payload = makePayload();
      const rawBody = Buffer.from(JSON.stringify(payload));
      const sig = "sha256=" + computeSignature(TEST_SECRET, rawBody);
      const req: WebhookRequest = {
        rawBody,
        headers: { "x-signature-sha256": sig },
      };
      const res = new MockResponse();

      const result = await handler(req, res);
      expect(res.statusCode).toBe(202);
      expect(result.accepted).toBe(true);
    });
  });

  describe("replay attack prevention", () => {
    it("rejects events older than maxAgeSeconds (default 300s)", async () => {
      const handler = createWebhookHandler(
        { secret: TEST_SECRET },
        idempotency,
        queue
      );
      const payload = makePayload({
        timestamp: Math.floor(Date.now() / 1000) - 400, // 400s ago
      });
      const res = new MockResponse();

      const result = await handler(makeRequest(payload), res);

      expect(res.statusCode).toBe(400);
      expect(result.reason).toBe("replay_attack");
    });

    it("rejects events older than custom maxAgeSeconds", async () => {
      const handler = createWebhookHandler(
        { secret: TEST_SECRET, maxAgeSeconds: 60 },
        idempotency,
        queue
      );
      const payload = makePayload({
        timestamp: Math.floor(Date.now() / 1000) - 120, // 120s ago
      });
      const res = new MockResponse();
      const result = await handler(makeRequest(payload), res);

      expect(res.statusCode).toBe(400);
      expect(result.reason).toBe("replay_attack");
    });

    it("accepts events within the time window", async () => {
      const handler = createWebhookHandler(
        { secret: TEST_SECRET, maxAgeSeconds: 300 },
        idempotency,
        queue
      );
      const payload = makePayload({
        timestamp: Math.floor(Date.now() / 1000) - 100,
      });
      const res = new MockResponse();
      const result = await handler(makeRequest(payload), res);

      expect(res.statusCode).toBe(202);
      expect(result.accepted).toBe(true);
    });

    it("rejects events with timestamps far in the future", async () => {
      const handler = createWebhookHandler(
        { secret: TEST_SECRET },
        idempotency,
        queue
      );
      const payload = makePayload({
        timestamp: Math.floor(Date.now() / 1000) + 200, // 200s in future
      });
      const res = new MockResponse();
      const result = await handler(makeRequest(payload), res);

      expect(res.statusCode).toBe(400);
      expect(result.reason).toBe("future_timestamp");
    });
  });

  describe("idempotency", () => {
    it("returns 202 for duplicate event IDs without reprocessing", async () => {
      const handler = createWebhookHandler(
        { secret: TEST_SECRET },
        idempotency,
        queue
      );
      const payload = makePayload();

      await handler(makeRequest(payload), new MockResponse()); // first
      const res2 = new MockResponse();
      const result = await handler(makeRequest(payload), res2); // duplicate

      expect(res2.statusCode).toBe(202);
      expect(result.reason).toBe("duplicate");
      // Queue should only have 1 item (not 2)
      expect(queue.length).toBe(1);
    });

    it("processes different event IDs independently", async () => {
      const handler = createWebhookHandler(
        { secret: TEST_SECRET },
        idempotency,
        queue
      );

      const p1 = makePayload({ id: "evt-aaa" });
      const p2 = makePayload({ id: "evt-bbb" });

      await handler(makeRequest(p1), new MockResponse());
      await handler(makeRequest(p2), new MockResponse());

      expect(queue.length).toBe(2);
    });
  });

  describe("payload validation", () => {
    it("returns 400 for invalid JSON body", async () => {
      const handler = createWebhookHandler(
        { secret: TEST_SECRET },
        idempotency,
        queue
      );
      const rawBody = Buffer.from("not-json");
      const sig = computeSignature(TEST_SECRET, rawBody);
      const req: WebhookRequest = {
        rawBody,
        headers: { "x-signature-sha256": sig },
      };
      const res = new MockResponse();
      const result = await handler(req, res);

      expect(res.statusCode).toBe(400);
      expect(result.reason).toBe("invalid_json");
    });

    it("returns 400 for a payload missing required fields", async () => {
      const handler = createWebhookHandler(
        { secret: TEST_SECRET },
        idempotency,
        queue
      );
      const rawBody = Buffer.from(JSON.stringify({ foo: "bar" }));
      const sig = computeSignature(TEST_SECRET, rawBody);
      const req: WebhookRequest = {
        rawBody,
        headers: { "x-signature-sha256": sig },
      };
      const res = new MockResponse();
      const result = await handler(req, res);

      expect(res.statusCode).toBe(400);
      expect(result.reason).toBe("invalid_payload");
    });
  });
});
