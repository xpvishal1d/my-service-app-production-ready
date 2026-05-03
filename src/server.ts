import http from "node:http";
import path from "node:path";
import express from "express";
import cookieParser from "cookie-parser";
import helmet from "helmet";
import { and, eq } from "drizzle-orm";
import { env } from "./config/env.js";
import { db } from "./db/index.js";
import { appSessions, loginEvents, users } from "./db/schema.js";
import {
  createOidcNonce,
  createOidcState,
  createPkcePair,
  exchangeCodeForTokens,
  refreshTokens,
  revokeRefreshToken,
  verifyIdToken
} from "./lib/oidc.js";
import { decryptText, encryptText, randomToken } from "./lib/crypto.js";
import { clientIp, fixedWindowLimit } from "./lib/rateLimit.js";
import { redis } from "./lib/redis.js";
import { getSessionById, requireAuth } from "./middleware/auth.js";
import { createHttpRateLimiter } from "./middleware/httpRateLimit.js";
import { gridApiRouter } from "./routes/gridApi.js";
import { errorPage } from "./views.js";
import { attachCheckboxWs } from "./ws/checkboxWs.js";

const app = express();
app.set("trust proxy", 1);
app.use(helmet());
app.use(express.urlencoded({ extended: false }));
app.use(express.json());
app.use(cookieParser());

const isProd = env.NODE_ENV === "production";

const apiRateLimit = createHttpRateLimiter(
  "api",
  env.RL_API_PER_WINDOW,
  env.RL_API_WINDOW_SEC
);

async function rejectIfLimitedHtml(
  req: express.Request,
  res: express.Response,
  prefix: string,
  limit: number,
  windowSec: number
) {
  const ip = clientIp(req);
  const bucket = Math.floor(Date.now() / (windowSec * 1000));
  const key = `rl:http:${prefix}:${ip}:${bucket}`;
  const r = await fixedWindowLimit({ redis, key, limit, windowSec });
  if (!r.ok) {
    res.status(429).type("html").send(
      errorPage(
        "Too many requests",
        `Please try again in about ${r.retryAfterSec ?? windowSec} seconds.`
      )
    );
    return true;
  }
  return false;
}

function cookieOptions(maxAgeMs: number) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: isProd,
    path: "/",
    maxAge: maxAgeMs
  };
}

async function createSession() {
  const sessionId = randomToken(32);
  const expiresAt = new Date(Date.now() + env.SESSION_TTL_DAYS * 24 * 60 * 60 * 1000);

  await db.insert(appSessions).values({
    id: sessionId,
    expiresAt
  });

  return { sessionId, expiresAt };
}

async function saveEvent(input: {
  sessionId: string;
  result: string;
  ipAddress?: string | null;
  userAgent?: string | null;
  metadata?: Record<string, unknown>;
}) {
  await db.insert(loginEvents).values({
    sessionId: input.sessionId,
    result: input.result,
    ipAddress: input.ipAddress ?? null,
    userAgent: input.userAgent ?? null,
    metadata: input.metadata ?? {}
  });
}

async function ensureAuthenticatedAccessToken(sessionId: string) {
  const rows = await db.select().from(appSessions).where(eq(appSessions.id, sessionId)).limit(1);
  const session = rows[0];
  if (!session || !session.isAuthenticated || !session.userId) {
    throw new Error("not_authenticated");
  }

  const now = new Date();
  const accessTokenExpiresAt = session.accessTokenExpiresAt ?? new Date(0);

  if (session.accessTokenEnc && accessTokenExpiresAt > new Date(now.getTime() + 30_000)) {
    return decryptText(session.accessTokenEnc);
  }

  if (!session.refreshTokenEnc) {
    throw new Error("missing_refresh_token");
  }

  const refreshToken = decryptText(session.refreshTokenEnc);
  const refreshed = await refreshTokens({ refreshToken });
  const nextAccessToken = refreshed.access_token;
  const nextRefreshToken = refreshed.refresh_token ?? refreshToken;

  const update: Record<string, unknown> = {
    accessTokenEnc: encryptText(nextAccessToken),
    tokenType: refreshed.token_type,
    tokenScope: refreshed.scope ?? session.tokenScope,
    accessTokenExpiresAt: new Date(Date.now() + refreshed.expires_in * 1000),
    updatedAt: now
  };

  if (refreshed.refresh_token) {
    update.refreshTokenEnc = encryptText(nextRefreshToken);
  }

  await db.update(appSessions).set(update).where(eq(appSessions.id, session.id));

  return nextAccessToken;
}

app.use("/api", apiRateLimit, gridApiRouter);

app.get("/healthz", (_req, res) => {
  res.json({ ok: true });
});

app.get("/login", async (req, res) => {
  if (await rejectIfLimitedHtml(req, res, "login", env.RL_LOGIN_PER_WINDOW, env.RL_LOGIN_WINDOW_SEC)) {
    return;
  }

  const sid = req.cookies[env.SESSION_COOKIE_NAME];
  const existing = await getSessionById(sid);

  const { codeVerifier, codeChallenge } = createPkcePair();
  const state = createOidcState();
  const nonce = createOidcNonce();

  const session =
    existing && !existing.isAuthenticated
      ? existing
      : await createSession().then((created) => {
          res.cookie(env.SESSION_COOKIE_NAME, created.sessionId, cookieOptions(created.expiresAt.getTime() - Date.now()));
          return { id: created.sessionId };
        });

  await db
    .update(appSessions)
    .set({
      state,
      nonce,
      codeVerifier,
      userId: null,
      isAuthenticated: false,
      accessTokenEnc: null,
      refreshTokenEnc: null,
      idTokenEnc: null,
      tokenScope: null,
      tokenType: null,
      accessTokenExpiresAt: null,
      refreshTokenExpiresAt: null,
      revokedAt: null,
      updatedAt: new Date()
    })
    .where(eq(appSessions.id, session.id));

  const authorizeUrl = new URL(env.AUTH_AUTHORIZATION_ENDPOINT);
  authorizeUrl.search = new URLSearchParams({
    client_id: env.AUTH_CLIENT_ID,
    redirect_uri: env.AUTH_REDIRECT_URI,
    response_type: "code",
    scope: env.AUTH_SCOPES,
    state,
    nonce,
    code_challenge: codeChallenge,
    code_challenge_method: "S256"
  }).toString();

  return res.redirect(authorizeUrl.toString());
});

app.get("/callback", async (req, res) => {
  if (
    await rejectIfLimitedHtml(req, res, "callback", env.RL_CALLBACK_PER_WINDOW, env.RL_CALLBACK_WINDOW_SEC)
  ) {
    return;
  }

  const code = typeof req.query.code === "string" ? req.query.code : null;
  const returnedState = typeof req.query.state === "string" ? req.query.state : null;

  if (!code || !returnedState) {
    return res.status(400).type("html").send(errorPage("Callback error", "Missing code or state"));
  }

  const sid = req.cookies[env.SESSION_COOKIE_NAME];
  const session = await getSessionById(sid);

  if (!session || !session.state || !session.nonce || !session.codeVerifier) {
    return res.status(400).type("html").send(errorPage("Callback error", "Session missing login state"));
  }

  if (session.state !== returnedState) {
    return res.status(400).type("html").send(errorPage("Callback error", "State mismatch"));
  }

  try {
    const tokenSet = await exchangeCodeForTokens({
      code,
      codeVerifier: session.codeVerifier
    });

    const identity = await verifyIdToken(tokenSet.id_token, session.nonce);

    const now = new Date();
    const existingUserRows = await db
      .select()
      .from(users)
      .where(
        and(
          eq(users.oidcIssuer, identity.issuer),
          eq(users.oidcSubject, identity.subject)
        )
      )
      .limit(1);

    const nextEmail = identity.email.toLowerCase();
    const existingUser = existingUserRows[0];
    let user = existingUser;

    if (!user) {
      const created = await db
        .insert(users)
        .values({
          oidcIssuer: identity.issuer,
          oidcSubject: identity.subject,
          email: nextEmail,
          name: identity.name,
          createdAt: now,
          updatedAt: now
        })
        .returning();

      user = created[0];
    } else {
      const updated = await db
        .update(users)
        .set({
          email: nextEmail,
          name: identity.name,
          updatedAt: now
        })
        .where(eq(users.id, existingUser.id))
        .returning();

      user = updated[0];
    }

    const expiresAt = new Date(Date.now() + env.SESSION_TTL_DAYS * 24 * 60 * 60 * 1000);
    const accessTokenExpiresAt = new Date(Date.now() + tokenSet.expires_in * 1000);

    await db
      .update(appSessions)
      .set({
        userId: user.id,
        isAuthenticated: true,
        state: null,
        nonce: null,
        codeVerifier: null,
        accessTokenEnc: encryptText(tokenSet.access_token),
        refreshTokenEnc: tokenSet.refresh_token ? encryptText(tokenSet.refresh_token) : null,
        idTokenEnc: encryptText(tokenSet.id_token),
        tokenScope: tokenSet.scope ?? env.AUTH_SCOPES,
        tokenType: tokenSet.token_type,
        accessTokenExpiresAt,
        refreshTokenExpiresAt: tokenSet.refresh_token ? new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) : null,
        expiresAt,
        updatedAt: now
      })
      .where(eq(appSessions.id, session.id));

    await saveEvent({
      sessionId: session.id,
      result: "success",
      ipAddress: req.ip,
      userAgent: req.get("user-agent"),
      metadata: {
        userId: user.id,
        issuer: identity.issuer,
        subject: identity.subject
      }
    });

    res.cookie(env.SESSION_COOKIE_NAME, session.id, cookieOptions(expiresAt.getTime() - Date.now()));
    return res.redirect("/");
  } catch (error) {
    await saveEvent({
      sessionId: session.id,
      result: "failure",
      ipAddress: req.ip,
      userAgent: req.get("user-agent"),
      metadata: {
        error: error instanceof Error ? error.message : "unknown_error"
      }
    });

    return res.status(400).type("html").send(
      errorPage(
        "Login failed",
        error instanceof Error ? error.message : "Unknown error"
      )
    );
  }
});

app.get("/me", requireAuth, async (req, res) => {
  const typedReq = req as express.Request & {
    authUser: typeof users.$inferSelect;
    authSession: typeof appSessions.$inferSelect;
  };

  res.json({
    authenticated: true,
    user: {
      id: typedReq.authUser.id,
      oidcIssuer: typedReq.authUser.oidcIssuer,
      oidcSubject: typedReq.authUser.oidcSubject,
      email: typedReq.authUser.email,
      name: typedReq.authUser.name
    },
    session: {
      id: typedReq.authSession.id,
      expiresAt: typedReq.authSession.expiresAt,
      tokenScope: typedReq.authSession.tokenScope,
      tokenExpiresAt: typedReq.authSession.accessTokenExpiresAt
    }
  });
});

app.get("/profile", requireAuth, async (req, res) => {
  const sid = req.cookies[env.SESSION_COOKIE_NAME];
  if (!sid) {
    return res.status(401).json({ error: "unauthorized" });
  }

  try {
    const accessToken = await ensureAuthenticatedAccessToken(sid);

    const response = await fetch(env.AUTH_USERINFO_ENDPOINT, {
      headers: {
        Authorization: `Bearer ${accessToken}`
      }
    });

    if (!response.ok) {
      return res.status(400).json({
        error: "userinfo_failed"
      });
    }

    const data = await response.json();
    return res.json(data);
  } catch (error) {
    return res.status(401).json({
      error: "unauthorized",
      details: error instanceof Error ? error.message : "unknown_error"
    });
  }
});

app.post("/logout", requireAuth, async (req, res) => {
  const sid = req.cookies[env.SESSION_COOKIE_NAME];
  if (!sid) {
    return res.json({ ok: true });
  }

  const sessionRows = await db.select().from(appSessions).where(eq(appSessions.id, sid)).limit(1);
  const session = sessionRows[0];

  if (session?.refreshTokenEnc) {
    await revokeRefreshToken(decryptText(session.refreshTokenEnc));
  }

  await db
    .update(appSessions)
    .set({
      revokedAt: new Date(),
      isAuthenticated: false,
      updatedAt: new Date()
    })
    .where(eq(appSessions.id, sid));

  res.clearCookie(env.SESSION_COOKIE_NAME, { path: "/" });
  return res.json({ ok: true });
});

app.get("/debug/session", async (req, res) => {
  const sid = req.cookies[env.SESSION_COOKIE_NAME];
  const session = await getSessionById(sid);
  if (!session) {
    return res.json(null);
  }

  return res.json({
    id: session.id,
    userId: session.userId,
    isAuthenticated: session.isAuthenticated,
    state: Boolean(session.state),
    nonce: Boolean(session.nonce),
    codeVerifier: Boolean(session.codeVerifier),
    tokenScope: session.tokenScope,
    accessTokenExpiresAt: session.accessTokenExpiresAt,
    refreshTokenExpiresAt: session.refreshTokenExpiresAt,
    expiresAt: session.expiresAt,
    revokedAt: session.revokedAt
  });
});

app.use(express.static(path.join(process.cwd(), "public")));

app.use((_req, res) => {
  res.status(404).type("html").send(errorPage("Not found", "The requested route does not exist"));
});

const server = http.createServer(app);

attachCheckboxWs(server);

server.listen(env.PORT, () => {
  console.log(`my-service-app listening on ${env.APP_BASE_URL}`);
});
