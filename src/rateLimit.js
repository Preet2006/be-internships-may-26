import { getDatabase } from "./db.js";

export const WINDOW_MS = 60_000;

const statements = new WeakMap();

function getStatements(db) {
  let cached = statements.get(db);
  if (!cached) {
    cached = {
      consume: db.prepare(`
        INSERT INTO rate_limits (user_id, window_start, request_count)
        VALUES (?, ?, 1)
        ON CONFLICT(user_id, window_start) DO UPDATE SET
          request_count = request_count + 1
        RETURNING request_count
      `),
    };
    statements.set(db, cached);
  }
  return cached;
}

export function checkAndConsume(
  userId,
  nowMs = Date.now(),
  connection = getDatabase(),
) {
  const rate = Math.max(1, Number(process.env.RATE_LIMIT_PER_MIN || 5));
  const windowStart = Math.floor(nowMs / WINDOW_MS) * WINDOW_MS;
  const { request_count: count } = getStatements(connection).consume.get(
    userId,
    windowStart,
  );

  return {
    ok: count <= rate,
    remaining: Math.max(rate - count, 0),
    resetMs: windowStart + WINDOW_MS,
  };
}
