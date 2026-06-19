# Scale Plan

The SQLite implementation is intentionally suitable for this assignment and a
single host. At 10k RPS, the API should keep the same semantics but move shared
coordination to managed, horizontally scalable services.

## Data model and indexes

- Store signals in partitioned PostgreSQL (or DynamoDB at very high write
  volume). Keep a unique index on `idempotency_key`.
- Keep the read index `(user_id, created_at DESC, id DESC)` and use cursor
  pagination instead of large offsets.
- Partition by time and/or hash of `user_id`; archive old partitions to object
  storage according to retention requirements.
- Put a maximum size on `payload`, and move large payloads to object storage
  with only a reference in the primary database.

## Idempotency across instances

- Every API instance uses the same database constraint. Create with
  `INSERT ... ON CONFLICT ... RETURNING`; never use an unprotected
  check-then-insert.
- Scope keys by tenant/API client if keys are not globally unique, and store a
  request hash. A reused key with different content should return `409`.
- Retain idempotency records for the documented retry window. If signal rows
  expire sooner, keep a small dedicated idempotency table.

## Rate limiting across instances

- Use Redis Cluster and an atomic Lua script for token-bucket or sliding-window
  consumption. Key by tenant and `userId`, set TTLs, and shard naturally by
  Redis key.
- Define fail-open versus fail-closed behavior by endpoint risk. Signal writes
  should normally fail closed with a short timeout; an emergency local limiter
  can cap damage during a Redis outage.
- The assignment implementation uses an atomic SQLite upsert. It is safe for
  multiple processes sharing one database file, but SQLite's single-writer
  design is not the 10k RPS target architecture.

## Reliability and failure handling

- Use bounded exponential backoff with jitter only for transient errors.
  Preserve the same idempotency key on every retry.
- Add database connection pooling, strict connect/query timeouts, circuit
  breakers, and readiness checks for required dependencies.
- Publish accepted signals through an outbox table. Workers relay outbox rows
  to Kafka/SQS, preventing the database-write/message-publish dual-write gap.
- Apply queue backpressure and dead-letter queues. During partial outages,
  shed load with `429`/`503` rather than allowing unbounded memory growth.
- Deploy across at least two availability zones and test restore procedures,
  not only backups.

## Observability

- Emit structured logs containing request ID, tenant/user hash, route, status,
  latency, retry count, and idempotency outcome; never log API keys or raw
  sensitive payloads.
- Measure RPS, p50/p95/p99 latency, error and retry rates, rate-limit decisions,
  idempotency replays/conflicts, DB pool saturation, Redis latency, queue lag,
  and outbox age.
- Alert on SLO burn rate, sustained `5xx`, dependency saturation, replication
  lag, queue backlog, and exhausted dead-letter queues. Trace API, database,
  cache, and worker spans with OpenTelemetry.

## 10k RPS deployment sketch

1. CDN/WAF and load balancer terminate TLS and reject abusive traffic early.
2. Stateless Fastify containers run across multiple zones with autoscaling.
3. Redis Cluster performs shared rate limiting.
4. PostgreSQL receives atomic signal/idempotency/outbox transactions; read
   replicas serve suitable list traffic.
5. Outbox workers publish to Kafka or SQS; consumers process asynchronously.
6. Object storage holds large payloads and long-term archives.

Start load tests around 12-15k RPS to leave headroom, then size from measured
p99 latency and dependency utilization. A practical managed baseline is
roughly 8-20 API vCPUs, a multi-AZ database, a small Redis cluster, and a
durable queue. Depending heavily on region, retention, payload size, and
egress, expect an order-of-magnitude cost of low thousands of USD per month;
benchmarking is required before giving a defensible budget.
