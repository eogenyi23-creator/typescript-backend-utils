/**
 * Distributed Rate Limiter Middleware
 *
 * Implements a Token Bucket algorithm using Redis with atomic Lua scripts.
 * Supports 'free' and 'premium' tiers with sliding-window replenishment.
 * Fails open on Redis outages to prevent server crashes.
 */

import Redis from "ioredis";

export interface RateLimiterConfig {
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

/** Tier configurations */
const TIER_CONFIGS: Record<"free" | "premium", RateLimiterConfig> = {
  free: {
    maxTokens: 20,
    windowSeconds: 60,
    refillRate: 20 / 60, // ~0.33 tokens/sec
  },
  premium: {
    maxTokens: 100,
    windowSeconds: 60,
    refillRate: 100 / 60, // ~1.67 tokens/sec
  },
};

/**
 * Lua script for atomic token bucket check-and-consume.
 *
 * KEYS[1] = bucket key (e.g. "rl:{tier}:{identifier}")
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
  -- First request: start with a full bucket
  tokens      = max_tokens
  last_refill = now_ms
end

-- Lazy replenishment: calculate tokens earned since last request
local elapsed_sec = (now_ms - last_refill) / 1000
local new_tokens  = elapsed_sec * refill_rate
tokens = math.min(max_tokens, tokens + new_tokens)

local allowed     = 0
local retry_after = 0

if tokens >= 1 then
  tokens  = tokens - 1
  allowed = 1
else
  -- How many ms until we have 1 token again
  local tokens_needed = 1 - tokens
  retry_after = math.ceil(tokens_needed / refill_rate)
end

redis.call('HMSET', key, 'tokens', tokens, 'last_refill', now_ms)
redis.call('EXPIRE', key, ttl_sec * 2)

return {allowed, math.floor(tokens), retry_after}
`;

/** Minimal request/response interface for framework-agnostic middleware */
export interface RateLimitRequest {
  headers: Record<string, string | string[] | undefined>;
  ip?: string;
  socket?: { remoteAddress?: string };
}

export interface RateLimitResponse {
  status(code: number): RateLimitResponse;
  setHeader(name: string, value: string | number): void;
  end(body?: string): void;
}

export type NextFunction = () => void | Promise<void>;

/**
 * Creates a rate limiter middleware for the given tier.
 *
 * @param tier    - 'free' or 'premium'
 * @param redis   - ioredis client instance
 * @returns Express-compatible middleware
 */
export function rateLimiter(
  tier: "free" | "premium",
  redis: Redis
): (
  req: RateLimitRequest,
  res: RateLimitResponse,
  next: NextFunction
) => Promise<void> {
  const config = TIER_CONFIGS[tier];

  return async (
    req: RateLimitRequest,
    res: RateLimitResponse,
    next: NextFunction
  ): Promise<void> => {
    // Identify caller: use X-Forwarded-For, then IP, then fallback
    const forwarded = req.headers["x-forwarded-for"];
    const identifier =
      (Array.isArray(forwarded) ? forwarded[0] : forwarded) ??
      req.ip ??
      req.socket?.remoteAddress ??
      "unknown";

    const bucketKey = `rl:${tier}:${identifier}`;

    try {
      const nowMs = Date.now();
      const result = (await redis.eval(
        TOKEN_BUCKET_LUA,
        1,
        bucketKey,
        String(config.maxTokens),
        String(config.refillRate),
        String(nowMs),
        String(config.windowSeconds)
      )) as [number, number, number];

      const [allowed, remaining, retryAfter] = result;

      // Always set informational headers
      res.setHeader("X-RateLimit-Limit", config.maxTokens);
      res.setHeader("X-RateLimit-Remaining", remaining);
      res.setHeader("X-RateLimit-Window", config.windowSeconds);

      if (!allowed) {
        res.setHeader("X-RateLimit-Retry-After", retryAfter);
        res
          .status(429)
          .end(
            JSON.stringify({
              error: "Too Many Requests",
              retryAfter,
              message: `Rate limit exceeded. Try again in ${retryAfter} second(s).`,
            })
          );
        return;
      }

      await next();
    } catch (err) {
      // Fail-open: log the error and allow the request through
      console.error("[RateLimiter] Redis error, failing open:", err);
      await next();
    }
  };
}
