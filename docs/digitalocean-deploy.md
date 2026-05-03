# Deploy on Digital Ocean

This project cannot be deployed for you automatically: you (or your team) need a Digital Ocean account, billing, and access to your GitHub repo. Use this guide to run **my-service-app** on **Digital Ocean App Platform** (recommended) or on a **Droplet** with Docker.

**Auth note:** If you use [accounts.xpvishal.dev](https://accounts.xpvishal.dev/), read the **OIDC** and **`AUTH_ISSUER`** rules in [railway-deploy.md](railway-deploy.md) (same environment variables apply on any host). Discovery: [OpenID configuration](https://accounts.xpvishal.dev/.well-known/openid-configuration).

---

## What you need

| Resource | Why |
|----------|-----|
| **PostgreSQL** | Sessions and user rows (Drizzle). |
| **Redis or Valkey** | Checkbox bitmap, Pub/Sub, rate limits (`REDIS_URL`). |
| **Secrets** | `APP_DATA_ENCRYPTION_KEY`, `AUTH_CLIENT_SECRET`, DB/Redis URLs if not auto-linked. |

---

## Option A — App Platform (managed, GitHub deploys)

Best if you want HTTPS, deploy-on-push, and minimal server administration.

### 1. Push code to GitHub

Ensure `.env` is **not** committed (see `.gitignore`). Production secrets belong only in Digital Ocean.

### 2. Create resources in the control panel

1. **Databases → Create**  
   - Create a **PostgreSQL** cluster (note region).  
   - Create **Managed Redis** (or Valkey if offered in your region) — or run Redis on a small Droplet only if you accept ops overhead.

2. **App Platform → Create app → GitHub**  
   - Select this repository and branch.  
   - Digital Ocean should detect the **`Dockerfile`**.

### 3. Configure the web service

- **HTTP / internal port:** App Platform sets **`PORT`** at runtime. Your server reads `process.env.PORT` ([`src/config/env.ts`](../src/config/env.ts)).  
  - In the App spec / UI, set **HTTP port** to the **same** value as `PORT` (often `8080` on DO). If DO injects `PORT=8080`, the container must listen on `8080` — which happens automatically if `PORT` is passed into the container.

Confirm in the service settings that **Build strategy** = Dockerfile and the **Run command** is the image default (`node dist/server.js` from the Dockerfile).

### 4. Environment variables (App → Settings → App-Level / Component)

Set at least:

| Variable | Notes |
|----------|--------|
| `NODE_ENV` | `production` |
| `PORT` | Only if the platform does not inject it; match the **HTTP port** you configured. |
| `DATABASE_URL` | From your **Managed PostgreSQL** “Connection string” (SSL usually required; use the URI the dashboard gives you). |
| `REDIS_URL` | From **Managed Redis** connection details (`rediss://` if TLS). |
| `APP_BASE_URL` | Your live URL: `https://<your-app-domain>` (no trailing slash). After first deploy, use the **default App Platform URL** or your custom domain. |
| `APP_DATA_ENCRYPTION_KEY` | Long random secret (≥ 20 chars); keep stable across deploys. |
| `AUTH_*` | Same as Railway guide: copy from OIDC discovery; `AUTH_REDIRECT_URI` = `https://<your-app-host>/callback`. |

Mark secrets as **Encrypted / Secret** in the UI.

### 5. Database schema

Run migrations once against production Postgres:

```bash
# Example: from your laptop with DATABASE_URL pointing at production (use SSL params from DO)
DATABASE_URL="postgresql://..." pnpm db:push
```

Or use a **temporary App Platform job / console** if Digital Ocean provides one, or SSH only if you use a Droplet-based workflow.

### 6. OAuth client

In your IdP, register redirect URI:

`https://<your-digital-ocean-app-host>/callback`

### 7. Health check (optional)

Use path `/healthz` if the platform asks for a health check.

**Docs:** [App Platform](https://docs.digitalocean.com/products/app-platform/), [App spec reference](https://docs.digitalocean.com/products/app-platform/reference/app-specification/).

---

## Option B — Droplet + Docker (you operate the VM)

1. Create an **Ubuntu Droplet** (2 GB RAM minimum is reasonable for Node + containers).
2. Install [Docker Engine](https://docs.docker.com/engine/install/ubuntu/) and Docker Compose plugin.
3. Clone your repo and create an `.env` file on the server (never commit it) with the same variables as above (`DATABASE_URL`, `REDIS_URL`, `APP_BASE_URL`, OIDC, etc.).
4. Use **Managed Postgres + Managed Redis** from Digital Ocean (recommended) and paste connection strings into `.env`.

Example **run** using your existing Dockerfile:

```bash
docker build -t my-service-app .
docker run -d --name app --env-file .env -p 80:8080 -e PORT=8080 my-service-app
```

Put **Nginx**, **Caddy**, or **Traefik** in front for HTTPS and proxy to the container; set `APP_BASE_URL` to `https://your-domain`.

For Postgres/Redis **inside** the same Droplet with `docker-compose`, you can reuse patterns from [`docker-compose.yml`](../docker-compose.yml) — production hardening (TLS, backups, firewall) is your responsibility.

---

## Example App Platform spec (starter)

You can maintain an app spec in Git and edit it in the DO UI. Replace placeholders (`your-github-org/your-repo`, regions, sizes).

See **[`digitalocean-app-spec.example.yaml`](digitalocean-app-spec.example.yaml)** in this folder. Validate fields against the current [App spec reference](https://docs.digitalocean.com/products/app-platform/reference/app-specification/) before apply.

---

## Checklist

- [ ] Postgres + Redis reachable from the app (firewall / trusted sources / VPC as required by DO).  
- [ ] `APP_BASE_URL` matches the URL users open in the browser (HTTPS).  
- [ ] `AUTH_REDIRECT_URI` and IdP client redirect match exactly.  
- [ ] `AUTH_ISSUER` matches OIDC discovery `issuer` (token `iss` claim).  
- [ ] `pnpm db:push` run once on production DB.  
- [ ] Dockerfile includes `public/` (already fixed in this repo’s `Dockerfile`).

If something fails, compare env vars with [railway-deploy.md](railway-deploy.md) — the same names and semantics apply on Digital Ocean.
