import { Redis } from "ioredis";
import { env } from "../config/env.js";

/** Commands + pub/sub publisher */
export const redis = new Redis(env.REDIS_URL, {
  maxRetriesPerRequest: 3,
  enableReadyCheck: true
});

/** Dedicated subscriber connection (ioredis requirement). */
export const redisSubscriber = new Redis(env.REDIS_URL, {
  maxRetriesPerRequest: null,
  enableReadyCheck: true
});

export const GRID_BITMAP_KEY = "grid:checkboxes:v1";
export const PUBSUB_CHANNEL = "checkbox:grid:updates";
