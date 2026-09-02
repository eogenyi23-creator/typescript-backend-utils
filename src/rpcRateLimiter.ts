/**
 * Stellar RPC / Horizon Rate Limiter
 *
 * Implements a Token Bucket algorithm using Redis with atomic Lua scripts.
 * Designed specifically for protecting Stellar RPC node and Horizon API
 * endpoints from being overloaded — both by your own services and by
 * external callers to your dApp backend.
 *
 * Stellar context:
 * - Soroban RPC nodes (soroban-rpc) enforce per-IP and global rate limits.
 * - Horizon has published rate limits (default: 3600 req/hr per IP).
 * - This limiter lets you apply your own limits before requests hit upstream,
 *   preventing 429s from cascading into your application.
 *
 * Features:
 * - Token bucket with lazy replenishment (atomic Lua script in Redis)
 * - Two built-in tiers: 'public' (60 req/min) and 'authenticated' (300 req/min)
 * - Custom tier support for any endpoint
 * - Fails open on Redis outages to prevent crashes
 * - Framework-agnostic middleware interface (Express / Hono / Fastify)
 * - `trustProxy` option to safely honour X-Forwarded-For from a trusted upstream
 */

import type { Redis } from "ioredis";

export interface RpcRateLimiterConfig {
  /** Maximum tokens (requests) allowed per window */
  maxTokens: number;
  /** Window duration in seconds */
  windowSeconds: number;
  /** Token refill rate: tokens added per second */
  refillRate: number;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfter: number; // seconds until next token is available
}

/**
 * Built-in tier configurations suited to common Stellar backend usage patterns.
 *
 * 'public'        — unauthenticated callers (e.g. wallet connection)
 * 'authenticated' — signed-in users (e.g. transaction submission)
 */
const TIER_CONFIGS: Record<"public" | "authenticated", RpcRateLimiterConfig> = {
  public: {
    maxTokens: 60,
    windowSeconds: 60,
    refillRate: 1.0, // 1 token/sec
  },
  authenticated: {
    maxTokens: 300,
    windowSeconds: 60,
    refillRate: 5.0, // 5 tokens/sec
  },
};

/**
 * Lua script for atomic token bucket check-and-consume.
 *
 * KEYS[1] = bucket key (e.g. "rl:soroban-rpc:public:{ip}")
 * ARGV[1] = maxTokens
 * ARGV[2] = refillRate  (tokens per second, float)
 * ARGV[3] = now         (current unix timestamp in ms)
 * ARGV[4] = windowSeconds (TTL for the key)
 *
 * Returns: [allowed (0|1), remaining_tokens, retry_after_seconds]
 */
const TOKEN_BUCKET_LUA = `
local key         = KEYS[1]
local max_tokens  = tonumber(ARGV[1])
local refill_rate = tonumber(ARGV[2])
local now_ms      = tonumber(ARGV[3])
local ttl_sec     = tonumber(ARGV[4])

local data = redis.call('HMGET', key, 'tokens', 'last_refill')
local tokens      = tonumber(data[1])
local last_refill = tonumber(data[2])

if tokens == nil then
  tokens      = max_tokens
  last_refill = now_ms
end

local elapsed_sec = (now_ms - last_refill) / 1000
local new_tokens  = elapsed_sec * refill_rate
tokens = math.min(max_tokens, tokens + new_tokens)

local allowed     = 0
local retry_after = 0

if tokens >= 1 then
  tokens  = tokens - 1
  allowed = 1
else
  local tokens_needed = 1 - tokens
  retry_after = math.ceil(tokens_needed / refill_rate)
end

redis.call('HMSET', key, 'tokens', tokens, 'last_refill', now_ms)
redis.call('EXPIRE', key, ttl_sec * 2)

return {allowed, math.floor(tokens), retry_after}
`;

/** Framework-agnostic request interface */
export interface RpcRequest {
  headers: Record<string, string | string[] | undefined>;
  ip?: string;
  socket?: { remoteAddress?: string };
}

export interface RpcResponse {
  status(code: number): RpcResponse;
  setHeader(name: string, value: string | number): void;
  end(body?: string): void;
}

export type NextFunction = () => void | Promise<void>;

/**
 * Options for createRpcRateLimiter / RpcRateLimiter.create
 */
export interface RpcRateLimiterOptions {
  /**
   * When true, the rate limiter will trust the `X-Forwarded-For` header to
   * determine the real client IP. Only enable this if your service sits behind
   * a trusted reverse proxy (nginx, AWS ALB, Cloudflare, etc.) that sets this
   * header — otherwise clients can spoof it to bypass per-IP limits.
   *
   * Default: false (uses req.ip / req.socket.remoteAddress only)
   */
  trustProxy?: boolean;
}

/**
 * Resolves the real client identifier from the request.
 *
 * If `trustProxy` is true the leftmost (client-supplied) IP in
 * `X-Forwarded-For` is used, which is the de-facto standard set by trusted
 * reverse proxies. When false, the direct socket address is used.
 */
function resolveIdentifier(req: RpcRequest, trustProxy: boolean): string {
  if (trustProxy) {
    const forwarded = req.headers["x-forwarded-for"];
    const first = Array.isArray(forwarded) ? forwarded[0] : forwarded;
    if (first) return first.split(",")[0].trim();
  }
  return req.ip ?? req.socket?.remoteAddress ?? "unknown";
}

/**
 * Creates an RPC rate limiter for the given tier and endpoint name.
 *
 * @param endpoint  - Logical name for the endpoint (e.g. 'soroban-rpc', 'horizon')
 * @param tier      - 'public' or 'authenticated' (or supply a custom config)
 * @param redis     - ioredis client instance
 * @param config    - Optional custom rate limit config (overrides tier defaults)
 * @param options   - Additional options (e.g. trustProxy)
 */
export function createRpcRateLimiter(
  endpoint: string,
  tier: "public" | "authenticated",
  redis: Redis,
  config?: Partial<RpcRateLimiterConfig>,
  options: RpcRateLimiterOptions = {}
): (req: RpcRequest, res: RpcResponse, next: NextFunction) => Promise<void> {
  const baseConfig = TIER_CONFIGS[tier];
  const resolvedConfig: RpcRateLimiterConfig = { ...baseConfig, ...config };
  const trustProxy = options.trustProxy ?? false;

  return async (req: RpcRequest, res: RpcResponse, next: NextFunction): Promise<void> => {
    const identifier = resolveIdentifier(req, trustProxy);
    const bucketKey = `rl:${endpoint}:${tier}:${identifier}`;

    try {
      const nowMs = Date.now();
      const result = (await redis.eval(
        TOKEN_BUCKET_LUA,
        1,
        bucketKey,
        String(resolvedConfig.maxTokens),
        String(resolvedConfig.refillRate),
        String(nowMs),
        String(resolvedConfig.windowSeconds)
      )) as [number, number, number];

      const [allowed, remaining, retryAfter] = result;

      res.setHeader("X-RateLimit-Limit", resolvedConfig.maxTokens);
      res.setHeader("X-RateLimit-Remaining", remaining);
      res.setHeader("X-RateLimit-Window", resolvedConfig.windowSeconds);

      if (!allowed) {
        res.setHeader("X-RateLimit-Retry-After", retryAfter);
        res.status(429).end(
          JSON.stringify({
            error: "Too Many Requests",
            retryAfter,
            message: `Rate limit exceeded for ${endpoint}. Retry in ${retryAfter}s.`,
          })
        );
        return;
      }

      await next();
    } catch (err) {
      // Fail-open: allow the request through if Redis is unreachable
      console.error(`[RpcRateLimiter:${endpoint}] Redis error, failing open:`, err);
      await next();
    }
  };
}

/**
 * Convenience class wrapping createRpcRateLimiter for OO usage.
 *
 * @example
 * // Behind a trusted reverse proxy (e.g. nginx / AWS ALB):
 * const limiter = RpcRateLimiter.create('soroban-rpc', redis, 'public', {}, { trustProxy: true });
 * app.use('/rpc', limiter.middleware());
 *
 * // Direct exposure (no proxy):
 * const limiter = RpcRateLimiter.create('soroban-rpc', redis);
 * app.use('/rpc', limiter.middleware());
 */
export class RpcRateLimiter {
  private readonly handler: ReturnType<typeof createRpcRateLimiter>;

  private constructor(handler: ReturnType<typeof createRpcRateLimiter>) {
    this.handler = handler;
  }

  static create(
    endpoint: string,
    redis: Redis,
    tier: "public" | "authenticated" = "public",
    config?: Partial<RpcRateLimiterConfig>,
    options?: RpcRateLimiterOptions
  ): RpcRateLimiter {
    return new RpcRateLimiter(createRpcRateLimiter(endpoint, tier, redis, config, options));
  }

  middleware(): (req: RpcRequest, res: RpcResponse, next: NextFunction) => Promise<void> {
    return this.handler;
  }
}
