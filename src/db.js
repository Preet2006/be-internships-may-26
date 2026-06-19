import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

const dbPath = process.env.DATABASE_URL || "./data/signals.db";
if (dbPath !== ":memory:") {
  fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
}

const db = new Database(dbPath);
db.pragma("journal_mode = WAL");
db.pragma("synchronous = NORMAL");
db.pragma("busy_timeout = 5000");
db.pragma("foreign_keys = ON");

db.exec(`
CREATE TABLE IF NOT EXISTS signals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  type TEXT NOT NULL,
  payload TEXT NOT NULL,
  idempotency_key TEXT UNIQUE,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_signals_user_created
  ON signals(user_id, created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS rate_limits (
  user_id TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  request_count INTEGER NOT NULL CHECK (request_count >= 0),
  PRIMARY KEY (user_id, window_start)
);
CREATE INDEX IF NOT EXISTS idx_rate_limits_window
  ON rate_limits(window_start);
`);

const insertStatement = db.prepare(`
  INSERT INTO signals (user_id, type, payload, idempotency_key, created_at)
  VALUES (@userId, @type, @payload, @idempotencyKey, @createdAt)
  ON CONFLICT(idempotency_key) DO NOTHING
  RETURNING
    id,
    user_id AS userId,
    type,
    payload,
    idempotency_key AS idempotencyKey,
    created_at AS createdAt
`);

const getByIdempotencyStatement = db.prepare(`
  SELECT
    id,
    user_id AS userId,
    type,
    payload,
    idempotency_key AS idempotencyKey,
    created_at AS createdAt
  FROM signals
  WHERE idempotency_key = ?
`);

const listStatements = new Map();
let transactionDepth = 0;

function maybeFail() {
  if (transactionDepth > 0) return;
  const rate = Number(process.env.DB_FAIL_RATE || 0);
  if (rate > 0 && Math.random() < rate) {
    const error = new Error("simulated_db_failure");
    error.code = "SQLITE_BUSY";
    throw error;
  }
}

export function getDatabase() {
  return db;
}

export function withImmediateTransaction(operation) {
  maybeFail();
  return db
    .transaction(() => {
      transactionDepth += 1;
      try {
        return operation();
      } finally {
        transactionDepth -= 1;
      }
    })
    .immediate();
}

export function insertSignal(
  userId,
  type,
  payload,
  idempotencyKey,
  createdAt,
  connection = db,
) {
  maybeFail();
  const values = {
    userId,
    type,
    payload: String(payload),
    idempotencyKey: idempotencyKey || null,
    createdAt,
  };

  if (connection === db) {
    return insertStatement.get(values);
  }

  return connection.prepare(insertStatement.source).get(values);
}

export function getByIdemKey(idempotencyKey, connection = db) {
  if (!idempotencyKey) return undefined;
  maybeFail();

  if (connection === db) {
    return getByIdempotencyStatement.get(idempotencyKey);
  }

  return connection
    .prepare(getByIdempotencyStatement.source)
    .get(idempotencyKey);
}

export function listSignals(userId, limit) {
  maybeFail();
  const safeLimit = Math.max(1, Math.min(Number(limit) || 20, 100));
  let statement = listStatements.get(safeLimit);
  if (!statement) {
    statement = db.prepare(`
      SELECT
        id,
        user_id AS userId,
        type,
        payload,
        idempotency_key AS idempotencyKey,
        created_at AS createdAt
      FROM signals
      WHERE user_id = ?
      ORDER BY created_at DESC, id DESC
      LIMIT ${safeLimit}
    `);
    listStatements.set(safeLimit, statement);
  }
  return statement.all(userId);
}

export function deleteExpiredRateLimits(cutoffMs) {
  return db
    .prepare("DELETE FROM rate_limits WHERE window_start < ?")
    .run(cutoffMs);
}

export function closeDatabase() {
  if (db.open) db.close();
}
