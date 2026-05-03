import type { NextFunction, Request, Response } from "express";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "../db/index.js";
import { appSessions, users } from "../db/schema.js";
import { env } from "../config/env.js";

export async function getSessionById(sessionId?: string) {
  if (!sessionId) return null;

  const rows = await db
    .select()
    .from(appSessions)
    .where(and(eq(appSessions.id, sessionId), isNull(appSessions.revokedAt)))
    .limit(1);

  const session = rows[0];
  if (!session) return null;
  if (session.expiresAt <= new Date()) return null;
  return session;
}

export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const session = await getSessionById(req.cookies?.[env.SESSION_COOKIE_NAME]);

  if (!session || !session.isAuthenticated || !session.userId) {
    return res.status(401).json({ error: "unauthorized" });
  }

  const userRows = await db.select().from(users).where(eq(users.id, session.userId)).limit(1);
  const user = userRows[0];

  if (!user) {
    return res.status(401).json({ error: "unauthorized" });
  }

  (req as Request & { authSession?: typeof session; authUser?: typeof user }).authSession = session;
  (req as Request & { authUser?: typeof user }).authUser = user;
  next();
}
