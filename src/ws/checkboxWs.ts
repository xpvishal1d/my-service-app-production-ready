import type { Server } from "node:http";
import { eq } from "drizzle-orm";
import { WebSocketServer, WebSocket } from "ws";
import { db } from "../db/index.js";
import { users } from "../db/schema.js";
import { env } from "../config/env.js";
import { parseCookies } from "../lib/cookies.js";
import { indexInRange, toggleBit, TOTAL_CELLS, GRID_COLS, GRID_ROWS } from "../lib/grid.js";
import { getInstanceId } from "../lib/instanceId.js";
import { clientIp, fixedWindowLimit } from "../lib/rateLimit.js";
import { PUBSUB_CHANNEL, redis, redisSubscriber } from "../lib/redis.js";
import { getSessionById } from "../middleware/auth.js";
import { randomUUID } from "node:crypto";

type PubPayload = {
  type: "checkbox_update";
  index: number;
  value: 0 | 1;
  userId: string | null;
  instanceId: string;
};

export function attachCheckboxWs(server: Server) {
  const wss = new WebSocketServer({ server, path: "/ws" });
  let localConnections = 0;

  function broadcast(message: object) {
    const raw = JSON.stringify(message);
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(raw);
      }
    }
  }

  redisSubscriber.on("message", (_channel: string, payload: string) => {
    try {
      const msg = JSON.parse(payload) as PubPayload;
      if (msg.type !== "checkbox_update") return;
      broadcast({
        type: "update",
        index: msg.index,
        value: msg.value,
        userId: msg.userId
      });
    } catch {
      // ignore malformed pub/sub payloads
    }
  });

  redisSubscriber.subscribe(PUBSUB_CHANNEL).catch((err: unknown) => {
    console.error("Redis subscribe failed:", err);
  });

  wss.on("connection", async (socket, req) => {
    localConnections += 1;
    const socketId = randomUUID();
    const cookies = parseCookies(req.headers.cookie);
    const sid = cookies[env.SESSION_COOKIE_NAME];
    const session = await getSessionById(sid);
    const userId = session?.isAuthenticated && session.userId ? session.userId : null;
    let userEmail: string | null = null;
    let userName: string | null = null;

    if (userId) {
      const rows = await db.select().from(users).where(eq(users.id, userId)).limit(1);
      const u = rows[0];
      if (u) {
        userEmail = u.email;
        userName = u.name;
      }
    }

    const readOnly = !userId;

    socket.send(
      JSON.stringify({
        type: "welcome",
        socketId,
        readOnly,
        user: userId
          ? { id: userId, email: userEmail, name: userName }
          : null,
        grid: { cols: GRID_COLS, rows: GRID_ROWS, total: TOTAL_CELLS },
        connectionsOnServer: localConnections
      })
    );

    socket.on("message", async (data) => {
      let parsed: { type?: string; index?: number };
      try {
        parsed = JSON.parse(data.toString()) as { type?: string; index?: number };
      } catch {
        socket.send(JSON.stringify({ type: "error", code: "invalid_json" }));
        return;
      }

      if (parsed.type !== "toggle") return;

      if (readOnly || !userId) {
        socket.send(JSON.stringify({ type: "error", code: "read_only" }));
        return;
      }

      const index = parsed.index;
      if (typeof index !== "number" || !indexInRange(index)) {
        socket.send(JSON.stringify({ type: "error", code: "invalid_index" }));
        return;
      }

      const minuteBucket = Math.floor(Date.now() / 60_000);
      const rlKey = `rl:ws:toggle:${userId}:${minuteBucket}`;
      const rl = await fixedWindowLimit({
        redis,
        key: rlKey,
        limit: env.RL_TOGGLE_PER_MIN,
        windowSec: 120
      });
      if (!rl.ok) {
        socket.send(
          JSON.stringify({
            type: "error",
            code: "rate_limited",
            retryAfterSec: rl.retryAfterSec
          })
        );
        return;
      }

      const ip = clientIp(req);
      const ipKey = `rl:ws:toggle:ip:${ip}:${minuteBucket}`;
      const ipRl = await fixedWindowLimit({
        redis,
        key: ipKey,
        limit: env.RL_TOGGLE_PER_MIN * 2,
        windowSec: 120
      });
      if (!ipRl.ok) {
        socket.send(
          JSON.stringify({
            type: "error",
            code: "rate_limited",
            retryAfterSec: ipRl.retryAfterSec
          })
        );
        return;
      }

      try {
        const next = await toggleBit(index);

        const pub: PubPayload = {
          type: "checkbox_update",
          index,
          value: next,
          userId,
          instanceId: getInstanceId()
        };
        await redis.publish(PUBSUB_CHANNEL, JSON.stringify(pub));
      } catch (err) {
        console.error("toggle failed:", err);
        socket.send(JSON.stringify({ type: "error", code: "server_error" }));
      }
    });

    socket.on("close", () => {
      localConnections = Math.max(0, localConnections - 1);
    });
  });

  return wss;
}
