/**
 * Stellar Horizon Event Handler
 *
 * Secure, idempotent handler for Stellar Horizon streaming events —
 * payments, account activity, ledger entries, and Soroban contract events.
 *
 * Stellar context:
 * - Horizon exposes SSE (Server-Sent Events) streams for real-time data.
 * - Many dApps and indexers receive Horizon webhook callbacks via third-party
 *   services (e.g. Stellar Expert, Meridian, or custom relayers).
 * - This handler provides HMAC-SHA256 signature verification, replay attack
 *   prevention, and idempotency so you can safely process Horizon events
 *   in your backend without duplicate processing or spoofed payloads.
 *
 * Features:
 * - Constant-time HMAC-SHA256 signature verification
 * - Replay attack prevention (configurable timestamp window)
 * - Raw body capture for accurate signature matching
 * - In-memory idempotency store (swap for RedisIdempotencyStore in production)
 * - Redis-backed idempotency store for multi-instance / restart-safe deduplication
 * - Immediate 202 Accepted + async queue offload
 * - Typed Stellar event payload (payment, account, contract, ledger)
 */

import { createHmac, timingSafeEqual } from "crypto";
import type Redis from "ioredis";

// ---------------------------------------------------------------------------
// Stellar Event Types
// ---------------------------------------------------------------------------

export type StellarEventType =
  | "payment"
  | "account_credited"
  | "account_debited"
  | "contract_event"
  | "ledger_closed"
  | "offer_created"
  | "offer_removed";

export interface HorizonEventPayload {
  /** Unique event identifier for idempotency (Horizon paging token or UUID) */
  id: string;
  /** Unix timestamp in seconds when the event was created */
  timestamp: number;
  /** Stellar event type */
  type: StellarEventType | string;
  /** Ledger sequence number this event occurred in */
  ledger?: number;
  /** Arbitrary event data (transaction hash, amounts, addresses, etc.) */
  data: Record<string, unknown>;
}

export interface HorizonEventHandlerConfig {
  /** HMAC-SHA256 secret shared with the webhook relay */
  secret: string;
  /** Maximum age of an event in seconds before it is rejected (default: 300) */
  maxAgeSeconds?: number;
  /** Callback invoked with verified events for async processing */
  onEvent?: (payload: HorizonEventPayload) => void | Promise<void>;
}

export interface HorizonEventRequest {
  /** Raw, unparsed body bytes — must not be pre-parsed */
  rawBody: Buffer;
  headers: Record<string, string | string[] | undefined>;
}

export interface HorizonEventResponse {
  status(code: number): HorizonEventResponse;
  json(body: unknown): void;
  end(body?: string): void;
}

export interface HorizonEventResult {
  accepted: boolean;
  reason?: string;
  payload?: HorizonEventPayload;
}

// ---------------------------------------------------------------------------
// Idempotency Store interface
// ---------------------------------------------------------------------------

/**
 * Interface for event idempotency stores. Implement this to plug in your own
 * backend (e.g. PostgreSQL, DynamoDB).
 */
export interface IdempotencyStore {
  has(eventId: string): boolean | Promise<boolean>;
  mark(eventId: string, ts: number): void | Promise<void>;
}

// ---------------------------------------------------------------------------
// In-memory Idempotency Store
// ---------------------------------------------------------------------------

/**
 * In-memory idempotency store. Suitable for single-instance deployments or
 * testing. In production with multiple instances or process restarts, use
 * `RedisIdempotencyStore` instead.
 */
export class HorizonIdempotencyStore implements IdempotencyStore {
  private seen: Map<string, number> = new Map();

  has(eventId: string): boolean { return this.seen.has(eventId); }
  mark(eventId: string, ts: number): void { this.seen.set(eventId, ts); }

  /** Purges events older than maxAgeSeconds. Call periodically in production. */
  purgeExpired(maxAgeSeconds: number): void {
    const cutoff = Math.floor(Date.now() / 1000) - maxAgeSeconds;
    for (const [id, ts] of this.seen) {
      if (ts < cutoff) this.seen.delete(id);
    }
  }

  get size(): number { return this.seen.size; }
}

// ---------------------------------------------------------------------------
// Redis-backed Idempotency Store
// ---------------------------------------------------------------------------

/**
 * Redis-backed idempotency store for production use.
 *
 * Uses `SET NX EX` (set-if-not-exists with TTL) for atomic idempotency checks.
 * Safe to use across multiple server instances and survives process restarts.
 *
 * @example
 * import Redis from "ioredis";
 * const redis = new Redis(process.env.REDIS_URL);
 * const idempotency = new RedisIdempotencyStore(redis, { ttlSeconds: 300 });
 * const handler = HorizonEventHandler.create({ secret: process.env.SECRET! }, idempotency);
 */
export class RedisIdempotencyStore implements IdempotencyStore {
  private readonly redis: Redis;
  private readonly ttlSeconds: number;
  private readonly keyPrefix: string;

  constructor(
    redis: Redis,
    options: {
      /** TTL for idempotency keys in seconds (default: 300, matching maxAgeSeconds) */
      ttlSeconds?: number;
      /** Redis key prefix (default: "horizon:idempotency:") */
      keyPrefix?: string;
    } = {}
  ) {
    this.redis = redis;
    this.ttlSeconds = options.ttlSeconds ?? 300;
    this.keyPrefix = options.keyPrefix ?? "horizon:idempotency:";
  }

  private key(eventId: string): string {
    return `${this.keyPrefix}${eventId}`;
  }

  /**
   * Atomically checks and marks an event as seen in a single Redis operation.
   * Returns true if the event was already seen, false if it was freshly marked.
   *
   * Uses SET NX EX to guarantee atomicity — no TOCTOU race between check and set.
   */
  async hasAndMark(eventId: string, ts: number): Promise<boolean> {
    const result = await this.redis.set(
      this.key(eventId),
      String(ts),
      "EX",
      this.ttlSeconds,
      "NX"
    );
    // SET NX returns null when the key already existed → duplicate
    return result === null;
  }

  /**
   * Checks whether an event ID has been seen.
   * Note: prefer `hasAndMark()` for atomic check-and-set in a single round trip.
   */
  async has(eventId: string): Promise<boolean> {
    const result = await this.redis.exists(this.key(eventId));
    return result > 0;
  }

  /**
   * Marks an event ID as seen with the given timestamp.
   * Note: prefer `hasAndMark()` for atomic check-and-set in a single round trip.
   */
  async mark(eventId: string, _ts: number): Promise<void> {
    await this.redis.set(this.key(eventId), "1", "EX", this.ttlSeconds, "NX");
  }
}

// ---------------------------------------------------------------------------
// Event Queue
// ---------------------------------------------------------------------------

export class HorizonEventQueue {
  private queue: HorizonEventPayload[] = [];

  enqueue(payload: HorizonEventPayload): void { this.queue.push(payload); }
  dequeue(): HorizonEventPayload | undefined { return this.queue.shift(); }
  get length(): number { return this.queue.length; }
  peek(): readonly HorizonEventPayload[] { return this.queue; }
}

// ---------------------------------------------------------------------------
// Signature helpers
// ---------------------------------------------------------------------------

/** Computes the expected HMAC-SHA256 signature for a raw body */
export function computeHorizonSignature(secret: string, rawBody: Buffer): string {
  return createHmac("sha256", secret).update(rawBody).digest("hex");
}

/**
 * Validates an inbound signature header against the expected HMAC.
 * Uses crypto.timingSafeEqual to prevent timing-attack signature guessing.
 */
export function verifyHorizonSignature(
  secret: string,
  rawBody: Buffer,
  signature: string
): boolean {
  if (!signature) return false;
  // Strip optional "sha256=" prefix
  const normalised = signature.replace(/^sha256=/, "");
  const expected = computeHorizonSignature(secret, rawBody);
  if (normalised.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(expected, "utf8"), Buffer.from(normalised, "utf8"));
}

// ---------------------------------------------------------------------------
// Payload validation
// ---------------------------------------------------------------------------

export function validateHorizonPayload(
  body: unknown
): { valid: true; payload: HorizonEventPayload } | { valid: false; reason: string } {
  if (typeof body !== "object" || body === null || Array.isArray(body))
    return { valid: false, reason: "Payload must be a JSON object" };

  const obj = body as Record<string, unknown>;

  if (typeof obj.id !== "string" || obj.id.trim() === "")
    return { valid: false, reason: "Missing or invalid field: id (string)" };

  if (typeof obj.timestamp !== "number" || !Number.isFinite(obj.timestamp))
    return { valid: false, reason: "Missing or invalid field: timestamp (number)" };

  if (typeof obj.type !== "string" || obj.type.trim() === "")
    return { valid: false, reason: "Missing or invalid field: type (string)" };

  if (typeof obj.data !== "object" || obj.data === null || Array.isArray(obj.data))
    return { valid: false, reason: "Missing or invalid field: data (object)" };

  return {
    valid: true,
    payload: {
      id: obj.id,
      timestamp: obj.timestamp,
      type: obj.type as StellarEventType,
      ledger: typeof obj.ledger === "number" ? obj.ledger : undefined,
      data: obj.data as Record<string, unknown>,
    },
  };
}

// ---------------------------------------------------------------------------
// Main handler factory
// ---------------------------------------------------------------------------

/**
 * Creates a Horizon event handler that:
 * 1. Verifies HMAC-SHA256 signature (constant-time)
 * 2. Validates payload schema
 * 3. Rejects events older than maxAgeSeconds (replay attack prevention)
 * 4. Enforces idempotency via event ID tracking (in-memory or Redis)
 * 5. Enqueues valid events and returns 202 Accepted immediately
 *
 * @param config      - Handler configuration
 * @param idempotency - Idempotency store (injected for testability; use RedisIdempotencyStore in production)
 * @param queue       - Processing queue (injected for testability)
 */
export function createHorizonEventHandler(
  config: HorizonEventHandlerConfig,
  idempotency: HorizonIdempotencyStore | RedisIdempotencyStore = new HorizonIdempotencyStore(),
  queue: HorizonEventQueue = new HorizonEventQueue()
): (req: HorizonEventRequest, res: HorizonEventResponse) => Promise<HorizonEventResult> {
  const maxAge = config.maxAgeSeconds ?? 300;

  return async (req, res): Promise<HorizonEventResult> => {
    // 1. Signature verification
    const sigHeader = req.headers["x-stellar-signature"] ?? req.headers["x-signature-sha256"];
    const signature = Array.isArray(sigHeader) ? sigHeader[0] : sigHeader ?? "";

    if (!verifyHorizonSignature(config.secret, req.rawBody, signature)) {
      res.status(401).json({ error: "Unauthorized", message: "Invalid or missing signature" });
      return { accepted: false, reason: "invalid_signature" };
    }

    // 2. Parse body
    let parsed: unknown;
    try {
      parsed = JSON.parse(req.rawBody.toString("utf8"));
    } catch {
      res.status(400).json({ error: "Bad Request", message: "Invalid JSON body" });
      return { accepted: false, reason: "invalid_json" };
    }

    // 3. Validate schema
    const validation = validateHorizonPayload(parsed);
    if (!validation.valid) {
      res.status(400).json({ error: "Bad Request", message: validation.reason });
      return { accepted: false, reason: "invalid_payload" };
    }

    const { payload } = validation;

    // 4. Replay attack check
    const nowSec = Math.floor(Date.now() / 1000);
    const age = nowSec - payload.timestamp;

    if (age > maxAge) {
      res.status(400).json({ error: "Bad Request", message: `Event too old (age: ${age}s)` });
      return { accepted: false, reason: "replay_attack" };
    }
    if (age < -60) {
      res.status(400).json({ error: "Bad Request", message: "Event timestamp too far in the future" });
      return { accepted: false, reason: "future_timestamp" };
    }

    // 5. Idempotency check
    // RedisIdempotencyStore exposes hasAndMark() for atomic check-and-set
    if (idempotency instanceof RedisIdempotencyStore) {
      const isDuplicate = await idempotency.hasAndMark(payload.id, payload.timestamp);
      if (isDuplicate) {
        res.status(202).json({ status: "accepted", duplicate: true, id: payload.id });
        return { accepted: true, reason: "duplicate", payload };
      }
    } else {
      if (idempotency.has(payload.id)) {
        res.status(202).json({ status: "accepted", duplicate: true, id: payload.id });
        return { accepted: true, reason: "duplicate", payload };
      }
      idempotency.mark(payload.id, payload.timestamp);
    }

    // 6. Enqueue and respond 202
    queue.enqueue(payload);

    if (config.onEvent) {
      Promise.resolve(config.onEvent(payload)).catch((err) => {
        console.error("[HorizonEventHandler] onEvent error:", err);
      });
    }

    res.status(202).json({ status: "accepted", id: payload.id, type: payload.type });
    return { accepted: true, payload };
  };
}

/**
 * Convenience class for OO usage.
 *
 * @example
 * // Single-instance / testing — in-memory idempotency:
 * const handler = HorizonEventHandler.create({ secret: process.env.SECRET! });
 * app.post('/horizon/events', handler.middleware());
 *
 * // Production — Redis-backed idempotency:
 * const idempotency = new RedisIdempotencyStore(redis, { ttlSeconds: 300 });
 * const handler = HorizonEventHandler.create({ secret: process.env.SECRET! }, idempotency);
 * app.post('/horizon/events', handler.middleware());
 */
export class HorizonEventHandler {
  private readonly handler: ReturnType<typeof createHorizonEventHandler>;

  private constructor(handler: ReturnType<typeof createHorizonEventHandler>) {
    this.handler = handler;
  }

  static create(
    config: HorizonEventHandlerConfig,
    idempotency?: HorizonIdempotencyStore | RedisIdempotencyStore,
    queue?: HorizonEventQueue
  ): HorizonEventHandler {
    return new HorizonEventHandler(createHorizonEventHandler(config, idempotency, queue));
  }

  middleware(): (req: HorizonEventRequest, res: HorizonEventResponse) => Promise<HorizonEventResult> {
    return this.handler;
  }
}
