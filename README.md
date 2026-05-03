# Real-time checkbox grid (Express + WebSockets + Redis + OIDC)

A learning-oriented demo inspired by “million checkboxes” sites: a large bitmap-backed grid synchronized in real time across browsers. Checkbox state lives in **Redis** as a compact **bitmap** (`SETBIT` / `GETBIT`). Updates propagate through **Redis Pub/Sub** so multiple Node processes can share the same grid. **OIDC (OAuth 2.0 Authorization Code + PKCE)** protects write access; anonymous visitors get **read-only** views and live updates.

## Project overview

- **Frontend**: static HTML/CSS/JS served by Express, virtualized checkbox rendering (only visible cells mount in the DOM).
- **Backend**: Node.js, Express 5, `ws` WebSocket server on `/ws`.
- **State**: Redis string bitmap (`grid:checkboxes:v1`) — about **125 KB** for one million bits (plus Redis overhead). Toggles run in a **Lua script** so flip/read/write is atomic under concurrency.
- **Horizontal scaling**: each instance publishes change events to Redis; every subscriber process forwards to its local WebSocket clients. Run several Node replicas behind a load balancer **with sticky sessions for WebSockets** (or use a shared WS gateway); HTTP APIs remain stateless aside from the session cookie.
- **Rate limiting**: implemented with **Redis counters + TTL** (no `express-rate-limit`). Separate policies for login/callback routes, REST `/api/*`, and per-user WebSocket toggles.

## Tech stack

| Area | Choice |
|------|--------|
| Runtime | Node.js (ESM, TypeScript) |
| HTTP | Express 5 |
| Real-time | `ws` |
| Data / pub-sub | Redis (`ioredis`) |
| Sessions / users | PostgreSQL + Drizzle ORM |
| Auth | OIDC Authorization Code + PKCE (`jose`) |
| Static UI | `express.static` → `public/` |

## Features implemented

- Large grid dimensions via `GRID_COLS` × `GRID_ROWS` (default **1000×1000 = 1,000,000** cells).
- Initial snapshot: `GET /api/grid/state` returns **base64** packed bits; fast refresh after reload.
- Live updates: WebSocket `update` events after each toggle.
- **Anonymous**: can load state and receive updates; **cannot** toggle (`read_only` on socket).
- **Authenticated**: session cookie validated on WebSocket connect; toggles subject to Redis rate limits.
- **Custom rate limits** for HTTP and WebSocket (see below).
- OIDC login/logout preserved from the starter (`/login`, `/callback`, `/logout`, `/me`).

## How to run locally

### Prerequisites

- Node.js 20+
- pnpm (or npm/yarn)
- PostgreSQL (for sessions/users)
- Redis

### Setup

```bash
pnpm install
cp .env.example .env
# Fill DATABASE_URL, REDIS_URL, APP_DATA_ENCRYPTION_KEY, OIDC provider values
pnpm db:push
pnpm dev
```

Open `http://localhost:4000` (or your `APP_BASE_URL`).

### Production build

```bash
pnpm build
pnpm start
```

Run from the project root so `public/` resolves for static files.

## Deploy on Railway (with `accounts.xpvishal.dev` auth)

Step-by-step guide (Postgres, Redis, OIDC env vars, custom domain, troubleshooting): **[docs/railway-deploy.md](docs/railway-deploy.md)**.

## Deploy on Digital Ocean

This repo cannot deploy itself to your account; use **[docs/digitalocean-deploy.md](docs/digitalocean-deploy.md)** (App Platform or Droplet + Docker). Example App Platform spec: **[docs/digitalocean-app-spec.example.yaml](docs/digitalocean-app-spec.example.yaml)**.

## Environment variables

See `.env.example`. Important keys:

| Variable | Purpose |
|----------|---------|
| `DATABASE_URL` | PostgreSQL connection string |
| `REDIS_URL` | Redis connection URL |
| `APP_BASE_URL` | Public base URL (links, redirects) |
| `APP_DATA_ENCRYPTION_KEY` | Symmetric key for token encryption at rest |
| `GRID_COLS`, `GRID_ROWS` | Grid dimensions (total cells = product) |
| `AUTH_*` | OIDC provider endpoints and client credentials |
| `RL_*` | Optional overrides for rate-limit windows (defaults in `src/config/env.ts`) |

## Redis setup

Install Redis locally or use Docker:

```bash
docker run --name redis -p 6379:6379 -d redis:7-alpine
```

Set `REDIS_URL=redis://localhost:6379`. The app uses:

- Bitmap key `grid:checkboxes:v1`
- Channel `checkbox:grid:updates` for Pub/Sub
- Keys prefixed `rl:` for rate limiting

## Auth flow (OIDC)

1. User hits **`/login`**. Server creates/updates a row in `app_sessions`, stores PKCE verifier + state + nonce, redirects to the IdP authorize URL.
2. IdP returns to **`/callback`** with `code` + `state`. Server validates state, exchanges the code for tokens, verifies the ID token (JWKS, nonce), upserts `users`, marks the session authenticated, sets an **httpOnly** cookie.
3. **`/api/session`** exposes whether the browser session is authenticated (used by the SPA shell).
4. **WebSocket** reads the same cookie on upgrade; `getSessionById` determines `readOnly`.
5. **`/logout`** revokes refresh token when configured, clears the cookie.

## WebSocket flow

1. Browser opens `ws(s)://<host>/ws` (same origin → cookies sent).
2. Server sends `welcome` with `readOnly`, `socketId`, grid dimensions, and local connection count.
3. Client sends `{ "type": "toggle", "index": <0-based linear index> }`.
4. Server enforces auth + rate limits, runs **atomic** `toggleBit` in Redis, **`PUBLISH`**es JSON on `checkbox:grid:updates`.
5. Every Node process subscribed to that channel broadcasts `{ type: "update", index, value, userId }` to its WebSockets.

## Rate limiting logic

All limits use **fixed-window counters** in Redis: `INCR` on a key that includes a **time bucket**, `EXPIRE` on first hit (long enough to cover drift). No external rate-limit middleware.

- **Login / callback routes**: separate prefix keys per client IP to reduce brute force (`rl:http:login:…`, `rl:http:callback:…`).
- **`/api/*`**: general API bucket per IP (`rl:http:api:…`).
- **WebSocket toggles** (authenticated): per **user id** and per **IP** per calendar minute bucket (`rl:ws:toggle:<userId>:<minuteBucket>` and `rl:ws:toggle:ip:<ip>:<minuteBucket>`). Default **5** toggles per minute per user (`RL_TOGGLE_PER_MIN`). When exceeded, the server returns `{ type: "error", code: "rate_limited", retryAfterSec }` and the UI shows a **please wait** banner, disables all checkboxes for that countdown, then re-enables them.

Tune via `RL_*` variables in `.env`.

## Screenshots / demo

Add your own screenshot and **YouTube unlisted** demo link here after recording. The demo should show:

1. Login / auth flow  
2. Grid loading  
3. Toggling cells  
4. Two browser windows receiving the same update in real time  

## Submission checklist

- [ ] GitHub repository public  
- [ ] README complete (this file)  
- [ ] `.env.example` up to date  
- [ ] YouTube unlisted demo (no Google Drive link)  
- [ ] Optional: live deployment URL  

## License

Private / educational use unless you add your own license.
