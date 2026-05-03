import type { Redis } from "ioredis";

/**
 * Fixed-window counter rate limit using Redis INCR + TTL.
 * Window bucket rolls with time; first hit sets expiry to 2× window so rolling buckets stay valid.
 */
export async function fixedWindowLimit(input: {
  redis: Redis;
  key: string;
  limit: number;
  windowSec: number;
}): Promise<{ ok: boolean; count: number; remaining: number; retryAfterSec?: number }> {
  const { redis, key, limit, windowSec } = input;
  const count = await redis.incr(key);
  if (count === 1) {
    await redis.expire(key, windowSec * 2);
  }
  const ttl = await redis.ttl(key);
  const retryAfterSec = ttl > 0 ? ttl : windowSec;
  if (count <= limit) {
    return { ok: true, count, remaining: Math.max(0, limit - count) };
  }
  return {
    ok: false,
    count,
    remaining: 0,
    retryAfterSec
  };
}

export function clientIp(req: { ip?: string; socket?: { remoteAddress?: string } }) {
  const forwarded = req.ip;
  if (forwarded && forwarded !== "::1") return forwarded;
  return req.socket?.remoteAddress ?? "unknown";
}
