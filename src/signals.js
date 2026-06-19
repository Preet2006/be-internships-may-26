import {
  deleteExpiredRateLimits,
  getByIdemKey,
  insertSignal,
  listSignals,
  withImmediateTransaction,
} from "./db.js";
import { checkAndConsume, WINDOW_MS } from "./rateLimit.js";

const MAX_DB_ATTEMPTS = Math.max(1, Number(process.env.DB_RETRY_ATTEMPTS || 4));
const BASE_RETRY_MS = Math.max(1, Number(process.env.DB_RETRY_BASE_MS || 15));

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTransientDatabaseError(error) {
  return (
    error?.code === "SQLITE_BUSY" ||
    error?.code === "SQLITE_LOCKED" ||
    error?.message === "simulated_db_failure"
  );
}

export async function withDatabaseRetry(operation, onRetry = () => {}) {
  for (let attempt = 1; attempt <= MAX_DB_ATTEMPTS; attempt += 1) {
    try {
      return operation();
    } catch (error) {
      if (!isTransientDatabaseError(error) || attempt === MAX_DB_ATTEMPTS) {
        throw error;
      }

      const exponentialDelay = BASE_RETRY_MS * 2 ** (attempt - 1);
      const jitter = Math.random() * exponentialDelay;
      onRetry(error, attempt, exponentialDelay + jitter);
      await sleep(exponentialDelay + jitter);
    }
  }
}

function createOrReplaySignal({ userId, type, payload, idempotencyKey }) {
  return withImmediateTransaction(() => {
    if (idempotencyKey) {
      const existing = getByIdemKey(idempotencyKey);
      if (existing) return { kind: "replay", signal: existing };
    }

    const createdAt = Date.now();
    const rateLimit = checkAndConsume(userId, createdAt);
    if (!rateLimit.ok) return { kind: "rate_limited", rateLimit };

    const signal = insertSignal(
      userId,
      type,
      payload,
      idempotencyKey,
      createdAt,
    );

    if (signal) return { kind: "created", signal };

    // A unique conflict means another writer committed this key. This lookup
    // occurs in the same transaction and returns that canonical resource.
    return {
      kind: "replay",
      signal: getByIdemKey(idempotencyKey),
    };
  });
}

export async function postSignal(req, reply) {
  const idempotencyKey = req.headers["idempotency-key"] || null;
  const { userId, type, payload } = req.body || {};

  if (
    typeof userId !== "string" ||
    userId.trim() === "" ||
    typeof type !== "string" ||
    type.trim() === "" ||
    typeof payload !== "string"
  ) {
    return reply.code(400).send({ error: "invalid_body" });
  }

  if (
    idempotencyKey !== null &&
    (typeof idempotencyKey !== "string" ||
      idempotencyKey.length === 0 ||
      idempotencyKey.length > 255)
  ) {
    return reply.code(400).send({ error: "invalid_idempotency_key" });
  }

  try {
    const result = await withDatabaseRetry(
      () =>
        createOrReplaySignal({
          userId,
          type,
          payload,
          idempotencyKey,
        }),
      (error, attempt, delayMs) => {
        req.log.warn({
          err: error,
          attempt,
          delayMs,
          ctx: "createOrReplaySignal",
        });
      },
    );

    if (result.kind === "rate_limited") {
      const { remaining, resetMs } = result.rateLimit;
      return reply
        .header(
          "Retry-After",
          Math.max(1, Math.ceil((resetMs - Date.now()) / 1000)),
        )
        .code(429)
        .send({ error: "rate_limited", remaining, resetMs });
    }

    return result.signal;
  } catch (error) {
    req.log.error({ err: error, ctx: "createOrReplaySignal" });
    return reply.code(503).send({ error: "db_unavailable" });
  }
}

export async function getSignals(req, reply) {
  const { userId, limit = 20 } = req.query || {};
  if (typeof userId !== "string" || userId.trim() === "") {
    return reply.code(400).send({ error: "missing_userId" });
  }

  const parsedLimit = Number(limit);
  if (!Number.isInteger(parsedLimit) || parsedLimit < 1) {
    return reply.code(400).send({ error: "invalid_limit" });
  }

  try {
    const rows = await withDatabaseRetry(
      () => listSignals(userId, Math.min(parsedLimit, 100)),
      (error, attempt, delayMs) => {
        req.log.warn({ err: error, attempt, delayMs, ctx: "listSignals" });
      },
    );
    return { items: rows };
  } catch (error) {
    req.log.error({ err: error, ctx: "listSignals" });
    return reply.code(503).send({ error: "db_unavailable" });
  }
}

// Keep the shared limiter table bounded without putting cleanup on the hot path.
const cleanupTimer = setInterval(() => {
  try {
    deleteExpiredRateLimits(Date.now() - 2 * WINDOW_MS);
  } catch {
    // A later interval retries cleanup; request handling is unaffected.
  }
}, WINDOW_MS);
cleanupTimer.unref();
