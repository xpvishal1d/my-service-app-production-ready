# Deploy to Railway (with `accounts.xpvishal.dev` auth)

This guide deploys **my-service-app** to [Railway](https://railway.app) and connects it to your OIDC auth at **[https://accounts.xpvishal.dev/](https://accounts.xpvishal.dev/)**.

## 1. How your auth service is exposed

The root of your auth app returns JSON that includes a canonical **issuer** (see [accounts.xpvishal.dev](https://accounts.xpvishal.dev/)). OIDC discovery is available at:

**[https://accounts.xpvishal.dev/.well-known/openid-configuration](https://accounts.xpvishal.dev/.well-known/openid-configuration)**

From that document, the important fields for *this* app are:

| Field | Purpose in this repo |
|--------|----------------------|
| `issuer` | Must match `AUTH_ISSUER` and the `iss` claim in ID tokens (see below). |
| `authorization_endpoint` | `AUTH_AUTHORIZATION_ENDPOINT` |
| `token_endpoint` | `AUTH_TOKEN_ENDPOINT` |
| `userinfo_endpoint` | `AUTH_USERINFO_ENDPOINT` |
| `jwks_uri` | `AUTH_JWKS_URI` |
| `revocation_endpoint` | `AUTH_REVOKE_ENDPOINT` (optional but recommended for logout) |

**Critical:** ID tokens are issued with `iss` equal to the **`issuer`** value in that JSON (today it is the `*.railway.app` URL), **not** necessarily `https://accounts.xpvishal.dev`. Your code verifies JWTs with `issuer: env.AUTH_ISSUER`, so **`AUTH_ISSUER` must be exactly the `issuer` string from the discovery document** (copy/paste from the JSON response).

You can still use the friendly domain for documentation or bookmarks; environment variables for OIDC must use the **same issuer and endpoints as discovery** (typically the Railway URLs listed there).

## 2. Railway resources you need

Create **one Railway project** with:

1. **This application service** (from your GitHub repo, built with the included `Dockerfile`).
2. **PostgreSQL** plugin → provides `DATABASE_URL`.
3. **Redis** (Railway “Redis” template/add-on) → provides `REDIS_URL`.

Without Postgres **and** Redis/Valkey-equivalent, the app will not start.

## 3. Register an OAuth client on your auth server

In your auth admin UI (your starter exposes registration at the `registration_endpoint` from discovery), **create a confidential client** with:

- **Redirect URI:** `https://<YOUR-RAILWAY-APP-DOMAIN>/callback`  
  - Example before custom domain: `https://my-service-app-production.up.railway.app/callback`
  - After you attach a custom domain to Railway: `https://grid.example.com/callback`
- **Grant type:** Authorization Code (with PKCE — this app already sends PKCE).
- **Scopes:** at least `openid profile email` (matches `AUTH_SCOPES` default).

Save the **client id** and **client secret** for Railway variables below.

## 4. Environment variables on Railway

Set these on your **application** service (Variables tab). Do **not** commit secrets to git.

### Required

| Variable | Example / notes |
|----------|------------------|
| `NODE_ENV` | `production` |
| `PORT` | Railway usually injects `PORT` automatically. **Do not** hard-code `4000` unless your start command expects it; this app reads `process.env.PORT` (default 4000). Prefer letting Railway set `PORT`. |
| `DATABASE_URL` | From Railway Postgres plugin (reference `${{Postgres.DATABASE_URL}}` if using references). |
| `REDIS_URL` | From Railway Redis plugin (`${{Redis.REDIS_URL}}` or similar). |
| `APP_BASE_URL` | **Public URL of this app only**, no trailing slash: `https://my-service-app-production.up.railway.app` or your custom domain. |
| `APP_DATA_ENCRYPTION_KEY` | Long random secret (32+ chars). Used to encrypt tokens at rest in Postgres. Generate once and keep stable across deploys. |
| `SESSION_COOKIE_NAME` | Optional; default `app_sid`. |
| `SESSION_TTL_DAYS` | Optional; default `30`. |

### OIDC — copy from discovery or use these shapes

Use the live discovery document so values never drift:

```bash
curl -s https://accounts.xpvishal.dev/.well-known/openid-configuration
```

Set:

| Variable | Source |
|----------|--------|
| `AUTH_ISSUER` | JSON field **`issuer`** (must match token `iss`). |
| `AUTH_AUTHORIZATION_ENDPOINT` | `authorization_endpoint` |
| `AUTH_TOKEN_ENDPOINT` | `token_endpoint` |
| `AUTH_USERINFO_ENDPOINT` | `userinfo_endpoint` |
| `AUTH_JWKS_URI` | `jwks_uri` |
| `AUTH_REVOKE_ENDPOINT` | `revocation_endpoint` (optional) |
| `AUTH_CLIENT_ID` | From your auth admin |
| `AUTH_CLIENT_SECRET` | From your auth admin |
| `AUTH_REDIRECT_URI` | **Exactly** the redirect URI you registered: `https://<your-app-host>/callback` |
| `AUTH_SCOPES` | `openid profile email` |

### Optional tuning

| Variable | Purpose |
|----------|---------|
| `GRID_COLS`, `GRID_ROWS` | Grid size (default 1000×1000). Lower on small Redis plans if needed. |
| `RL_*` | Rate limits (see main README). |
| `INSTANCE_ID` | Optional label for multi-instance logs. |

## 5. Deploy steps (high level)

1. Push your repo to GitHub (ensure `.env` is **not** committed; `.gitignore` should ignore it).
2. Railway → **New Project** → **Deploy from GitHub** → select the repo.
3. Railway should detect the **Dockerfile** and build `pnpm build` in the image.
4. Add **PostgreSQL** and **Redis** to the project; link variables to your service.
5. Set all environment variables from section 4.
6. **Deploy** and wait for the build to go green.
7. **Run DB migrations** once (see section 6).

## 6. Database schema on Railway

After the first successful deploy (or from a one-off shell):

```bash
pnpm db:push
```

Locally, point `DATABASE_URL` at your Railway Postgres URL (temporarily) or use **Railway CLI**:

```bash
railway run pnpm db:push
```

(Exact CLI depends on your Railway setup; the goal is to run Drizzle `push` against production `DATABASE_URL`.)

## 7. Health checks and URLs

- **HTTP health:** `GET /healthz` → `{ "ok": true }` — use as Railway health check path if you configure one.
- **App URL:** Set `APP_BASE_URL` to the same host users open in the browser (https, no trailing slash).

## 8. WebSockets and cookies

- The UI connects to **`wss://<your-host>/ws`** automatically when the page is served over HTTPS.
- Sessions use **httpOnly** cookies with `secure: true` in production, so **HTTPS is required** on your public URL (Railway provides this).

## 9. Custom domains

1. In Railway, attach a domain to this service (e.g. `grid.yourdomain.com`).
2. Update **`APP_BASE_URL`** and **`AUTH_REDIRECT_URI`** to use that domain.
3. In your **auth client**, add the **same** redirect URI (`https://grid.yourdomain.com/callback`).

## 10. Troubleshooting

| Symptom | What to check |
|---------|----------------|
| `invalid_issuer` / JWT verify fails | `AUTH_ISSUER` must equal discovery `issuer` (same string as in ID token `iss`). |
| Redirect mismatch after login | IdP client redirect URI must match `AUTH_REDIRECT_URI` exactly (scheme, host, path). |
| Cookie not sent | Same-site: ensure you’re not mixing bare HTTP with HTTPS; use `APP_BASE_URL` https everywhere. |
| Redis errors on boot | `REDIS_URL` missing or wrong plugin reference. |
| Static UI 404 / empty | Production Docker image must include `public/` (the repo Dockerfile copies `public` into the image). |

## 11. Checklist before going live

- [ ] Postgres + Redis attached; `DATABASE_URL` + `REDIS_URL` set  
- [ ] `APP_BASE_URL` = public https URL of this Railway service  
- [ ] OIDC vars copied from [discovery](https://accounts.xpvishal.dev/.well-known/openid-configuration); `AUTH_ISSUER` = `issuer` field  
- [ ] OAuth client redirect = `https://<same-host-as-APP_BASE_URL>/callback`  
- [ ] `pnpm db:push` applied to production DB  
- [ ] Login → callback → grid works; second browser sees real-time updates  

---

**Reference:** Auth discovery — [https://accounts.xpvishal.dev/.well-known/openid-configuration](https://accounts.xpvishal.dev/.well-known/openid-configuration)
