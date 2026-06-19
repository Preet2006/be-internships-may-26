# Signals Service

A production-leaning Fastify service that accepts user signals, enforces a
shared per-user rate limit, and provides atomic idempotency.

## Run locally

Requires Node.js 20 or newer.

```bash
npm install
copy .env.example .env
npm run dev
```

The service listens on `http://localhost:8080` by default.

## Configuration

| Variable             |             Default | Purpose                                         |
| -------------------- | ------------------: | ----------------------------------------------- |
| `API_KEY`            |         `change-me` | Required `X-API-Key` value                      |
| `PORT`               |              `8080` | HTTP listen port                                |
| `DATABASE_URL`       | `./data/signals.db` | SQLite database path                            |
| `RATE_LIMIT_PER_MIN` |                 `5` | Accepted creates per user per fixed minute      |
| `DB_FAIL_RATE`       |                 `0` | Probability of a simulated transient DB failure |
| `DB_RETRY_ATTEMPTS`  |                 `4` | Maximum attempts for transient DB operations    |
| `DB_RETRY_BASE_MS`   |                `15` | Initial exponential-backoff delay               |

Do not use the example API key in a deployed environment.

## API

All `/v1` routes require `X-API-Key`.

### Create a signal

```http
POST /v1/signals
X-API-Key: change-me
Idempotency-Key: optional-client-key
Content-Type: application/json

{
  "userId": "user-123",
  "type": "note",
  "payload": "hello"
}
```

`userId` and `type` must be non-empty strings. `payload` is stored as a
string. An idempotency key may be at most 255 characters.

- Reusing a key returns the originally created resource, including after a
  restart.
- Replays do not consume additional rate-limit capacity.
- A rejected create returns `429`, `Retry-After`, `remaining`, and `resetMs`.
- Exhausted transient database retries return `503`.

### List signals

```http
GET /v1/signals?userId=user-123&limit=20
X-API-Key: change-me
```

`limit` must be a positive integer and is capped at 100.

### Health

```http
GET /healthz
```

Returns `{ "ok": true }` and does not require authentication.

## Concurrency design

The create path runs in one `BEGIN IMMEDIATE` SQLite transaction:

1. Return an existing idempotent resource, if present.
2. Atomically upsert the shared `(user_id, window_start)` rate-limit counter.
3. Insert with a database-level unique idempotency constraint.

WAL mode and a busy timeout allow multiple local processes to coordinate on
the same database. Transient lock/failure errors retry the complete
transaction with bounded exponential backoff and jitter. See [SCALE.md](SCALE.md)
for the 10k RPS production architecture.

## Tests

```bash
npm test
```

The suite covers parallel idempotent creates, restart persistence, burst
limiting, and rate-limit sharing across two server instances.
