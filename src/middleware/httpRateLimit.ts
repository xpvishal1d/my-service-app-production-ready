import type { NextFunction, Request, Response } from "express";
import { clientIp, fixedWindowLimit } from "../lib/rateLimit.js";
import { redis } from "../lib/redis.js";

export function createHttpRateLimiter(prefix: string, limit: number, windowSec: number) {
  return async function httpRateLimitJson(_req: Request, res: Response, next: NextFunction) {
    const ip = clientIp(_req);
    const bucket = Math.floor(Date.now() / (windowSec * 1000));
    const key = `rl:http:${prefix}:${ip}:${bucket}`;
    const r = await fixedWindowLimit({ redis, key, limit, windowSec });
    if (!r.ok) {
      res.setHeader("Retry-After", String(r.retryAfterSec ?? windowSec));
      return res.status(429).json({
        error: "too_many_requests",
        retryAfterSec: r.retryAfterSec
      });
    }
    next();
  };
}
