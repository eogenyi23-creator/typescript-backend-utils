/**
 * Multi-Provider Webhook Ingestion Engine
 *
 * Secure, idempotent webhook handler with:
 * - Constant-time HMAC-SHA256 signature verification
 * - Replay attack prevention (5-minute timestamp window)
 * - Raw body capture for accurate signature matching
 * - In-memory idempotency store (swap for Redis/DB in production)
 * - Immediate 202 Accepted response with async queue offload
 */

import { createHmac, timingSafeEqual } from "crypto";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WebhookPayload {
  /** Unique event identifier for idempotency */
  id: string;
  /** Unix timestamp in seconds when the event was created */
  timestamp: number;
  /** Event type string (e.g. "payment.success") */
  event: string;
  /** Arbitrary event data */
  data: Record<string, unknown>;
}

export interface WebhookHandlerConfig {
  /** HMAC-SHA256 secret shared with the webhook provider */
  secret: string;
  /** Maximum age of a webhook event in seconds (default: 300 = 5 minutes) */
  maxAgeSeconds?: number;
  /** Callback invoked with verified events for async processing */
  onEvent?: (payload: WebhookPayload) => void | Promise<void>;
}

export interface WebhookRequest {
  /** Raw, unparsed body bytes — must not be JSON-parsed beforehand */
  rawBody: Buffer;
  headers: Record<string, string | string[] | undefined>;
}

export interface WebhookResponse {
  status(code: number): WebhookResponse;
  json(body: unknown): void;
  end(body?: string): void;
}

export type WebhookNextFunction = () => void | Promise<void>;

export interface WebhookHandlerResult {
  accepted: boolean;
  reason?: string;
  payload?: WebhookPayload;
}

// ---------------------------------------------------------------------------
// Idempotency store (in-memory; replace with Redis SET NX in production)
// ---------------------------------------------------------------------------

export class IdempotencyStore {
  private seen: Map<string, number> = new Map();

  /** Returns true if this eventId has already been processed */
  has(eventId: string): boolean {
    return this.seen.has(eventId);
  }

  /** Marks an event as processed with its timestamp */
  mark(eventId: string, ts: number): void {
    this.seen.set(eventId, ts);
  }

  /**
   * Purges events older than maxAgeSeconds to prevent unbounded growth.
   * Call this periodically in production.
   */
  purgeExpired(maxAgeSeconds: number): void {
    const cutoff = Math.floor(Date.now() / 1000) - maxAgeSeconds;
    for (const [id, ts] of this.seen) {
      if (ts < cutoff) this.seen.delete(id);
    }
  }

  get size(): number {
    return this.seen.size;
  }
}

// ---------------------------------------------------------------------------
// In-memory processing queue
// ---------------------------------------------------------------------------

export class WebhookQueue {
  private queue: WebhookPayload[] = [];

  enqueue(payload: WebhookPayload): void {
    this.queue.push(payload);
  }

  dequeue(): WebhookPayload | undefined {
    return this.queue.shift();
  }

  get length(): number {
    return this.queue.length;
  }

  /** Peek at all queued payloads without consuming them (for testing) */
  peek(): readonly WebhookPayload[] {
    return this.queue;
  }
}

// ---------------------------------------------------------------------------
// Signature verification helpers
// ---------------------------------------------------------------------------

/**
 * Computes the expected HMAC-SHA256 signature for a raw body.
 *
 * @param secret  - Shared HMAC secret
 * @param rawBody - Unparsed raw request body buffer
 * @returns Hex-encoded HMAC digest
 */
export function computeSignature(secret: string, rawBody: Buffer): string {
  return createHmac("sha256", secret).update(rawBody).digest("hex");
}

/**
 * Validates an inbound signature header against the expected HMAC.
 *
 * Uses crypto.timingSafeEqual to prevent timing-attack signature guessing.
 *
 * @param secret    - Shared HMAC secret
 * @param rawBody   - Unparsed raw request body buffer
 * @param signature - Value from X-Signature-SHA256 header
 * @returns true if signature is valid
 */
export function verifySignature(
  secret: string,
  rawBody: Buffer,
  signature: string
): boolean {
  if (!signature) return false;

  // Strip optional "sha256=" prefix (used by some providers like GitHub)
  const normalizedSig = signature.replace(/^sha256=/, "");

  const expected = computeSignature(secret, rawBody);

  // Pad to same length to avoid length-leak before timingSafeEqual
  if (normalizedSig.length !== expected.length) return false;

  const expectedBuf = Buffer.from(expected, "utf8");
  const receivedBuf = Buffer.from(normalizedSig, "utf8");

  return timingSafeEqual(expectedBuf, receivedBuf);
}

// ---------------------------------------------------------------------------
// Payload validation
// ---------------------------------------------------------------------------

/**
 * Validates that the parsed payload matches the WebhookPayload schema.
 */
export function validatePayload(
  body: unknown
): { valid: true; payload: WebhookPayload } | { valid: false; reason: string } {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { valid: false, reason: "Payload must be a JSON object" };
  }

  const obj = body as Record<string, unknown>;

  if (typeof obj.id !== "string" || obj.id.trim() === "") {
    return { valid: false, reason: "Missing or invalid field: id (string)" };
  }

  if (typeof obj.timestamp !== "number" || !Number.isFinite(obj.timestamp)) {
    return {
      valid: false,
      reason: "Missing or invalid field: timestamp (number)",
    };
  }

  if (typeof obj.event !== "string" || obj.event.trim() === "") {
    return {
      valid: false,
      reason: "Missing or invalid field: event (string)",
    };
  }

  if (
    typeof obj.data !== "object" ||
    obj.data === null ||
    Array.isArray(obj.data)
  ) {
    return { valid: false, reason: "Missing or invalid field: data (object)" };
  }

  return {
    valid: true,
    payload: {
      id: obj.id,
      timestamp: obj.timestamp,
      event: obj.event,
      data: obj.data as Record<string, unknown>,
    },
  };
}

// ---------------------------------------------------------------------------
// Main webhook handler
// ---------------------------------------------------------------------------

/**
 * Creates a webhook handler function that:
 * 1. Verifies HMAC-SHA256 signature (constant-time)
 * 2. Validates payload schema
 * 3. Rejects events older than maxAgeSeconds (replay attack prevention)
 * 4. Enforces idempotency via event ID tracking
 * 5. Enqueues valid events and returns 202 Accepted immediately
 *
 * @param config        - Handler configuration
 * @param idempotency   - Idempotency store (injected for testability)
 * @param queue         - Processing queue (injected for testability)
 */
export function createWebhookHandler(
  config: WebhookHandlerConfig,
  idempotency: IdempotencyStore = new IdempotencyStore(),
  queue: WebhookQueue = new WebhookQueue()
): (req: WebhookRequest, res: WebhookResponse) => Promise<WebhookHandlerResult> {
  const maxAge = config.maxAgeSeconds ?? 300;

  return async (
    req: WebhookRequest,
    res: WebhookResponse
  ): Promise<WebhookHandlerResult> => {
    // ------------------------------------------------------------------
    // 1. Extract and verify signature
    // ------------------------------------------------------------------
    const sigHeader = req.headers["x-signature-sha256"];
    const signature = Array.isArray(sigHeader) ? sigHeader[0] : sigHeader ?? "";

    if (!verifySignature(config.secret, req.rawBody, signature)) {
      res.status(401).json({
        error: "Unauthorized",
        message: "Invalid or missing X-Signature-SHA256 header",
      });
      return { accepted: false, reason: "invalid_signature" };
    }

    // ------------------------------------------------------------------
    // 2. Parse body (AFTER signature verification)
    // ------------------------------------------------------------------
    let parsed: unknown;
    try {
      parsed = JSON.parse(req.rawBody.toString("utf8"));
    } catch {
      res.status(400).json({ error: "Bad Request", message: "Invalid JSON body" });
      return { accepted: false, reason: "invalid_json" };
    }

    // ------------------------------------------------------------------
    // 3. Validate payload schema
    // ------------------------------------------------------------------
    const validation = validatePayload(parsed);
    if (!validation.valid) {
      res.status(400).json({ error: "Bad Request", message: validation.reason });
      return { accepted: false, reason: "invalid_payload" };
    }

    const { payload } = validation;

    // ------------------------------------------------------------------
    // 4. Replay attack check: reject events older than maxAge seconds
    // ------------------------------------------------------------------
    const nowSec = Math.floor(Date.now() / 1000);
    const age = nowSec - payload.timestamp;

    if (age > maxAge) {
      res.status(400).json({
        error: "Bad Request",
        message: `Event timestamp too old (age: ${age}s, max: ${maxAge}s)`,
      });
      return { accepted: false, reason: "replay_attack" };
    }

    // Also reject future-dated events (clock skew > 60s)
    if (age < -60) {
      res.status(400).json({
        error: "Bad Request",
        message: "Event timestamp is too far in the future",
      });
      return { accepted: false, reason: "future_timestamp" };
    }

    // ------------------------------------------------------------------
    // 5. Idempotency check
    // ------------------------------------------------------------------
    if (idempotency.has(payload.id)) {
      // Return 202 silently — duplicate events are not errors
      res.status(202).json({
        status: "accepted",
        duplicate: true,
        id: payload.id,
      });
      return { accepted: true, reason: "duplicate", payload };
    }

    idempotency.mark(payload.id, payload.timestamp);

    // ------------------------------------------------------------------
    // 6. Enqueue and respond immediately with 202 Accepted
    // ------------------------------------------------------------------
    queue.enqueue(payload);

    // Fire-and-forget async processing
    if (config.onEvent) {
      Promise.resolve(config.onEvent(payload)).catch((err) => {
        console.error("[WebhookHandler] onEvent error:", err);
      });
    }

    res.status(202).json({
      status: "accepted",
      id: payload.id,
    });

    return { accepted: true, payload };
  };
}
