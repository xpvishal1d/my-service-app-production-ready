import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import { env } from "../config/env.js";
import { randomToken, sha256 } from "./crypto.js";

export function createPkcePair() {
  const codeVerifier = randomToken(32);
  const codeChallenge = sha256(codeVerifier);
  return { codeVerifier, codeChallenge };
}

export function createOidcState() {
  return randomToken(32);
}

export function createOidcNonce() {
  return randomToken(32);
}

const jwks = createRemoteJWKSet(new URL(env.AUTH_JWKS_URI));

function stringClaim(claim: JWTPayload[string]): string {
  if (typeof claim !== "string") {
    throw new Error("missing_or_invalid_claim");
  }
  return claim;
}

export async function verifyIdToken(idToken: string, nonce: string) {
  const verified = await jwtVerify(idToken, jwks, {
    issuer: env.AUTH_ISSUER,
    audience: env.AUTH_CLIENT_ID
  });

  if (verified.payload.nonce !== nonce) {
    throw new Error("invalid_nonce");
  }

  const issuer = stringClaim(verified.payload.iss);
  const subject = stringClaim(verified.payload.sub);
  const email = stringClaim(verified.payload.email);
  const name = stringClaim(verified.payload.name);

  return {
    issuer,
    subject,
    email,
    name,
    payload: verified.payload
  };
}

export async function exchangeCodeForTokens(input: {
  code: string;
  codeVerifier: string;
}) {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: input.code,
    redirect_uri: env.AUTH_REDIRECT_URI,
    client_id: env.AUTH_CLIENT_ID,
    client_secret: env.AUTH_CLIENT_SECRET,
    code_verifier: input.codeVerifier
  });

  const response = await fetch(env.AUTH_TOKEN_ENDPOINT, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded"
    },
    body: body.toString()
  });

  if (!response.ok) {
    const details = await response.text();
    throw new Error(`token_exchange_failed:${details}`);
  }

  return response.json() as Promise<{
    access_token: string;
    id_token: string;
    refresh_token?: string;
    token_type: string;
    expires_in: number;
    scope?: string;
  }>;
}

export async function refreshTokens(input: { refreshToken: string }) {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: input.refreshToken,
    client_id: env.AUTH_CLIENT_ID,
    client_secret: env.AUTH_CLIENT_SECRET
  });

  const response = await fetch(env.AUTH_TOKEN_ENDPOINT, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded"
    },
    body: body.toString()
  });

  if (!response.ok) {
    const details = await response.text();
    throw new Error(`refresh_failed:${details}`);
  }

  return response.json() as Promise<{
    access_token: string;
    refresh_token?: string;
    token_type: string;
    expires_in: number;
    scope?: string;
  }>;
}

export async function revokeRefreshToken(refreshToken: string) {
  if (!env.AUTH_REVOKE_ENDPOINT) return;

  const body = new URLSearchParams({
    token: refreshToken,
    token_type_hint: "refresh_token",
    client_id: env.AUTH_CLIENT_ID,
    client_secret: env.AUTH_CLIENT_SECRET
  });

  await fetch(env.AUTH_REVOKE_ENDPOINT, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded"
    },
    body: body.toString()
  }).catch(() => undefined);
}
