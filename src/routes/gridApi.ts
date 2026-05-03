import { Router } from "express";
import { eq } from "drizzle-orm";
import { env } from "../config/env.js";
import { db } from "../db/index.js";
import { users } from "../db/schema.js";
import { getStateBytes, GRID_COLS, GRID_ROWS, TOTAL_CELLS } from "../lib/grid.js";
import { getSessionById } from "../middleware/auth.js";

export const gridApiRouter = Router();

gridApiRouter.get("/grid/meta", (_req, res) => {
  res.json({
    cols: GRID_COLS,
    rows: GRID_ROWS,
    total: TOTAL_CELLS,
    /** Packed bitmap length in bytes (ceil(totalBits / 8)). */
    stateBytes: Math.ceil(TOTAL_CELLS / 8)
  });
});

gridApiRouter.get("/grid/state", async (_req, res) => {
  try {
    const buf = await getStateBytes();
    res.json({
      encoding: "base64",
      bytes: buf.length,
      data: buf.toString("base64")
    });
  } catch (error) {
    console.error("grid state:", error);
    res.status(500).json({ error: "grid_state_failed" });
  }
});

gridApiRouter.get("/session", async (req, res) => {
  const sid = req.cookies?.[env.SESSION_COOKIE_NAME];
  const session = await getSessionById(sid);

  if (!session?.isAuthenticated || !session.userId) {
    return res.json({
      authenticated: false,
      readOnly: true
    });
  }

  const userRows = await db.select().from(users).where(eq(users.id, session.userId)).limit(1);
  const user = userRows[0];

  if (!user) {
    return res.json({ authenticated: false, readOnly: true });
  }

  return res.json({
    authenticated: true,
    readOnly: false,
    user: {
      id: user.id,
      email: user.email,
      name: user.name
    }
  });
});
