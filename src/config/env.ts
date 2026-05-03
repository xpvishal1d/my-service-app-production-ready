import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().default(4000),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  APP_BASE_URL: z.string().url(),
  SESSION_COOKIE_NAME: z.string().default("app_sid"),
  SESSION_TTL_DAYS: z.coerce.number().default(30),
  APP_DATA_ENCRYPTION_KEY: z.string().min(20),
  /** Defaults to 1000×1000 = 1_000_000 checkboxes (stored as a Redis bitmap). */
  GRID_COLS: z.coerce.number().int().positive().default(1000),
  GRID_ROWS: z.coerce.number().int().positive().default(1000),
  /** Identifies this Node process in Redis pub/sub fan-out (optional). */
  INSTANCE_ID: z.string().min(1).optional(),
  /** Fixed-window HTTP rate limits (per IP, Redis-backed). */
  RL_LOGIN_PER_WINDOW: z.coerce.number().int().positive().default(20),
  RL_LOGIN_WINDOW_SEC: z.coerce.number().int().positive().default(900),
  RL_CALLBACK_PER_WINDOW: z.coerce.number().int().positive().default(60),
  RL_CALLBACK_WINDOW_SEC: z.coerce.number().int().positive().default(900),
  RL_API_PER_WINDOW: z.coerce.number().int().positive().default(300),
  RL_API_WINDOW_SEC: z.coerce.number().int().positive().default(60),
  /** Allowed checkbox toggles per authenticated user per calendar minute bucket (WebSocket). */
  RL_TOGGLE_PER_MIN: z.coerce.number().int().positive().default(5),
  AUTH_ISSUER: z.string().url(),
  AUTH_AUTHORIZATION_ENDPOINT: z.string().url(),
  AUTH_TOKEN_ENDPOINT: z.string().url(),
  AUTH_USERINFO_ENDPOINT: z.string().url(),
  AUTH_JWKS_URI: z.string().url(),
  AUTH_REVOKE_ENDPOINT: z.string().url().optional(),
  AUTH_CLIENT_ID: z.string().min(1),
  AUTH_CLIENT_SECRET: z.string().min(1),
  AUTH_REDIRECT_URI: z.string().url(),
  AUTH_SCOPES: z.string().min(1)
});

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  console.error("Environment validation failed (fix these in your host / App Platform env):");
  for (const issue of parsed.error.issues) {
    const path = issue.path.length ? issue.path.join(".") : "(root)";
    console.error(`  - ${path}: ${issue.message}`);
  }
  process.exit(1);
}

export const env = parsed.data;
