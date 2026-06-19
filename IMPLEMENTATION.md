# Implementation and Run Guide

This document explains how to install, run, test, and verify the Signals
Service implementation.

## Requirements

- Node.js 20 or newer
- npm
- PowerShell, Command Prompt, Bash, or another terminal

Check the installed versions:

```powershell
node --version
npm.cmd --version
```

## Project setup

Open PowerShell and move into the project directory:

```powershell
cd D:\OMLI\be-internships-may-26
```

Install the dependencies:

```powershell
npm.cmd install
```

Create the local environment file:

```powershell
Copy-Item .env.example .env -Force
```

The default `.env.example` values are:

```dotenv
API_KEY=change-me
PORT=8080
DATABASE_URL=./data/signals.db
RATE_LIMIT_PER_MIN=5
DB_FAIL_RATE=0
DB_RETRY_ATTEMPTS=4
DB_RETRY_BASE_MS=15
```

Change `API_KEY` before using the service outside local development.

## Run the service

Start the development server:

```powershell
npm.cmd run dev
```

The terminal should show:

```text
Server listening at http://0.0.0.0:8080
```

Keep this terminal open while using the API. Press `Ctrl+C` to stop the
service.

## Verify the health endpoint

Open a second PowerShell terminal:

```powershell
Invoke-RestMethod -Method Get -Uri http://localhost:8080/healthz
```

Expected result:

```text
ok
--
True
```

The equivalent curl command is:

```bash
curl http://localhost:8080/healthz
```

Expected JSON:

```json
{ "ok": true }
```

## Create a signal

PowerShell:

```powershell
$headers = @{
  "X-API-Key" = "change-me"
  "Idempotency-Key" = "example-key-1"
}

$body = @{
  userId = "user-123"
  type = "note"
  payload = "hello"
} | ConvertTo-Json

Invoke-RestMethod `
  -Method Post `
  -Uri http://localhost:8080/v1/signals `
  -Headers $headers `
  -ContentType "application/json" `
  -Body $body
```

curl:

```bash
curl -X POST http://localhost:8080/v1/signals \
  -H "X-API-Key: change-me" \
  -H "Idempotency-Key: example-key-1" \
  -H "Content-Type: application/json" \
  -d '{"userId":"user-123","type":"note","payload":"hello"}'
```

Sending the same request again with the same `Idempotency-Key` returns the
same signal instead of inserting a duplicate.

## List signals

PowerShell:

```powershell
$headers = @{ "X-API-Key" = "change-me" }

Invoke-RestMethod `
  -Method Get `
  -Uri "http://localhost:8080/v1/signals?userId=user-123&limit=20" `
  -Headers $headers
```

curl:

```bash
curl "http://localhost:8080/v1/signals?userId=user-123&limit=20" \
  -H "X-API-Key: change-me"
```

## Run the automated tests

Stop any manually running development server if it is no longer needed, then
run:

```powershell
npm.cmd test
```

The tests verify:

- atomic idempotency during parallel requests;
- idempotency persistence after a server restart;
- concurrency-safe burst rate limiting;
- rate-limit sharing between two server processes;
- graceful handling and recovery from simulated database failures.

## Run the benchmark

Start the service in one terminal:

```powershell
npm.cmd run dev
```

Run the included health-endpoint benchmark from another terminal:

```powershell
npm.cmd run bench
```

The benchmark uses Autocannon with 20 connections for 10 seconds.

## Use another port

If port `8080` is occupied, run the server on port `8081`:

```powershell
$env:PORT = "8081"
npm.cmd run dev
```

The health URL then becomes:

```text
http://localhost:8081/healthz
```

To reset the temporary environment override:

```powershell
Remove-Item Env:PORT
```

## Find and stop a process using port 8080

Check the port:

```powershell
Get-NetTCPConnection -LocalPort 8080 -State Listen -ErrorAction SilentlyContinue
```

Stop the process only when a listener exists:

```powershell
$connection = Get-NetTCPConnection `
  -LocalPort 8080 `
  -State Listen `
  -ErrorAction SilentlyContinue

if ($connection) {
  $connection |
    Select-Object -ExpandProperty OwningProcess -Unique |
    ForEach-Object { Stop-Process -Id $_ -Force }
} else {
  Write-Host "Port 8080 is already free."
}
```

## Implementation overview

### Atomic idempotency

The `signals.idempotency_key` column has a database-level unique constraint.
Signal creation uses `INSERT ... ON CONFLICT DO NOTHING RETURNING` inside an
immediate SQLite transaction. Concurrent requests therefore return one
canonical resource without a check-then-insert race.

### Concurrency-safe rate limiting

Rate-limit counters are stored in SQLite using the composite primary key
`(user_id, window_start)`. An atomic upsert increments the counter, allowing
multiple local server processes sharing the database to enforce one limit.
The default limit is five accepted creates per user per minute.

An idempotent replay is checked before consuming the rate limit, so retrying a
successful request does not use additional capacity.

### Database retries

Transient SQLite errors such as `SQLITE_BUSY` and `SQLITE_LOCKED` are retried
with bounded exponential backoff and jitter. The complete transaction is
retried, preserving atomicity and preventing duplicate signals.

`DB_FAIL_RATE` can simulate transient failures. For example, `1` forces every
database operation to fail and allows verification of the `503` response.

### SQLite configuration

The local implementation enables:

- write-ahead logging (WAL);
- a five-second busy timeout;
- normal synchronous mode;
- indexes for idempotency and user/time-based listing;
- periodic cleanup of expired rate-limit windows.

SQLite is appropriate for the assignment and local multi-process
verification. The production design for 10k RPS is documented in
[`SCALE.md`](SCALE.md), including PostgreSQL, Redis Cluster, queues,
horizontal scaling, observability, and failure handling.

## Main response codes

| Status | Meaning                                                      |
| ------ | ------------------------------------------------------------ |
| `200`  | Signal created, replayed, listed, or health check successful |
| `400`  | Invalid body, idempotency key, user ID, or limit             |
| `401`  | Missing or incorrect `X-API-Key`                             |
| `429`  | Per-user rate limit exceeded                                 |
| `503`  | Database remained unavailable after retries                  |

## Git workflow

The completed implementation is maintained on the `assignment-solution`
branch. The repository's `main` branch remains at the original assignment
commit.

To switch to the implementation branch:

```powershell
git switch assignment-solution
```

To verify the branch:

```powershell
git branch --show-current
```

The expected output is:

```text
assignment-solution
```
