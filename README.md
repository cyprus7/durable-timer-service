# Durable Timer Service

See [security settings and upgrade procedure](docs/security-and-upgrade.md)
before upgrading an existing HTTP deployment. Capacity limits are configurable
with generous defaults; TLS termination requires explicit configuration.

A small TypeScript service for durable, one-shot timer delivery. PostgreSQL stores pending timers, and workers deliver due timers to a server-configured HTTP callback.

## Guarantees

- Delivery is at least once. Consumers must treat `timerId` and `generation` as idempotency inputs.
- Scheduling is conditional by generation, so a stale request cannot replace a newer timer.
- Pending work survives process restarts because PostgreSQL is the source of truth.
- Multiple instances can safely share one database using `FOR UPDATE SKIP LOCKED` and expiring leases.
- Callback URLs are selected from the operator-controlled `TIMER_TARGETS` registry. Request bodies cannot supply arbitrary URLs.
- Callback responses and incoming request bodies have configurable size limits.

The service stores timer and delivery metadata only. The callback consumer remains responsible for deciding whether a delivered timer is still applicable.

## Requirements

- Node.js 22 or newer
- PostgreSQL 16 or newer

## Quick start

```bash
npm ci
cp .env.example .env
npm run build
```

Edit `.env` for your database, callback target and authentication/transport
settings. Export the same `DATABASE_URL` in your shell for the `psql` commands
below; `psql` does not read `.env` automatically.

For a new database, apply **both** migrations in order before starting the service:

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/001_init.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/002_admission.sql
```

For an existing database that already has `001_init.sql`, apply only
`002_admission.sql` before upgrading the binaries. Keep the migrations separate:
replacing `001` with a combined file would not upgrade databases where `001` has
already been applied. `AUTO_MIGRATE=true` applies both at startup for a
single-instance local environment; use the explicit migration step for a
multi-replica deployment. See the [upgrade order](docs/security-and-upgrade.md).

```bash
node --env-file=.env dist/src/main.js
```

`API_TOKEN` is required by default. Generate a long random value and send it as a bearer token to all `/v1/*` endpoints. `ALLOW_INSECURE_NO_AUTH=true` disables this requirement and should only be used for isolated local development.

## Configuration

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `8080` | HTTP listen port. |
| `DATABASE_URL` | required | PostgreSQL connection string. |
| `API_TOKEN` | required | Bearer token for `/v1/*` endpoints. |
| `ALLOW_INSECURE_NO_AUTH` | `false` | Explicitly allow startup without `API_TOKEN`; local development only. |
| `TIMER_TARGETS` | empty | JSON object or comma-separated `name=url` callback registry. |
| `TIMER_LANES` | `realtime` | Comma-separated lanes processed by this instance. |
| `WORKER_ENABLED` | `true` | Enable background delivery workers. |
| `AUTO_MIGRATE` | `false` | Apply both bundled migrations at startup; use only for single-instance local development. |
| `CLAIM_BATCH_SIZE` | `25` | Maximum timers claimed per poll. |
| `LEASE_MS` | `20000` | Claim lease duration. |
| `POLL_INTERVAL_MS` | `250` | Worker polling interval. |
| `CLEANUP_INTERVAL_MS` | `60000` | Receipt and dead-letter cleanup interval. |
| `HTTP_CLIENT_TIMEOUT_MS` | `5000` | Callback request timeout. |
| `MAX_CALLBACK_RESPONSE_BYTES` | `65536` | Maximum callback response bytes read into memory. |
| `MAX_PAYLOAD_BYTES` | `16384` | Maximum request body and timer payload size. |
| `MAX_SCHEDULE_AHEAD_MS` | `86400000` | Maximum allowed distance between now and `dueAt`, capped at 24 hours by the database schema. |
| `MAX_DELIVERY_WINDOW_MS` | `3600000` | Maximum allowed distance between `dueAt` and `deliverUntil`, capped at 1 hour by the database schema. |
| `RETRY_BASE_MS` | `1000` | Initial retry delay. |
| `RETRY_MAX_MS` | `60000` | Maximum retry delay. |
| `RETRY_JITTER_RATIO` | `0.2` | Random retry jitter ratio. |

The `timer_slots` constraints in `migrations/001_init.sql` enforce a 24-hour
scheduling horizon and a 1-hour delivery window. Smaller configured limits
still apply. Larger values are accepted as configuration but do not raise these
effective limits; requests outside the schema limits return HTTP 400 with
`due_at_too_far` or `delivery_window_too_large`. Raising the hard limits
requires a schema migration and matching validation change.

Example target registry:

```dotenv
TIMER_TARGETS={"example-worker":"http://worker:3000/timers/callback"}
```

## API

All `/v1/*` requests require `Authorization: Bearer <API_TOKEN>` unless insecure local mode is explicitly enabled.

### Schedule a timer

`POST /v1/timers`

```json
{
  "namespace": "example",
  "timerKey": "workflow:8d12:retry",
  "timerId": "019abc",
  "generation": 42,
  "sessionId": "workflow:8d12",
  "kind": "job.retry",
  "lane": "realtime",
  "dueAt": "2026-08-01T18:10:44.250Z",
  "deliverUntil": "2026-08-01T18:12:44.250Z",
  "target": "example-worker",
  "routingKey": "8d12",
  "payload": {
    "expectedAttempt": 2,
    "expectedRevision": 131
  }
}
```

With no active slot, the timer is inserted. Repeating the same generation and timer ID is idempotent. An older generation is a stale no-op, while a newer generation atomically supersedes the active timer.

### Cancel one timer

`POST /v1/timers/cancel`

```json
{
  "namespace": "example",
  "timerKey": "workflow:8d12:retry",
  "timerId": "019abc",
  "generation": 42
}
```

Cancellation must match both `timerId` and `generation`.

### Cancel a session

`POST /v1/timers/cancel-session`

```json
{
  "namespace": "example",
  "sessionId": "workflow:8d12"
}
```

### Introspection

- `GET /v1/targets` returns configured logical target names and requires authentication.
- `GET /health/live` reports process liveness.
- `GET /health/ready` checks database connectivity and the required tables and admission row. An incomplete schema returns 503 with code `schema_not_ready`; startup also fails before listening when a migration is missing.
- `GET /metrics` exposes Prometheus text metrics.
- `timer_service_delivery_start_lag_seconds` is a fixed-bucket histogram of the time from `dueAt` to the start of each delivery attempt (including retries). Negative lag is recorded as zero. It has no timer-specific labels.
- `timer_service_due_backlog_timers` and `timer_service_oldest_due_seconds` sample, every 10 seconds, timers eligible for a new claim in the instance's configured lanes. Active leases, future retries and elapsed delivery windows are excluded. Each replica reports the same database-wide queue for its lanes; use `max`, not `sum`, across replicas. These are exact database counts, so watch query cost at large queue sizes.
- `timer_service_backlog_sample_success`, `timer_service_backlog_sample_timestamp_seconds` and `timer_service_backlog_sample_failures_total` distinguish a fresh zero backlog from a failed or stale sample. A sample failure does not clear the previous backlog gauges.

Example Prometheus alert rules are in [`docs/prometheus-alert-rules.yaml`](docs/prometheus-alert-rules.yaml). Adjust thresholds to the application's deadline and traffic profile.

Protect health and metrics endpoints at the network perimeter when they are not intended to be public.

## Callback contract

Callbacks receive the scheduled timer fields plus the current delivery `attempt`. A successful consumer returns:

```json
{
  "disposition": "applied"
}
```

Terminal dispositions are `applied`, `obsolete`, and `already_applied`. `retry`, `rejected`, network errors, invalid responses, oversized responses, and non-success HTTP statuses are retried until `deliverUntil`, then moved to dead letters.

## Development

```bash
npm run build
npm test
npm run check
```

Run the PostgreSQL integration tests with:

```bash
npm run e2e:up
npm run test:e2e
npm run e2e:down
```

The compose file exposes PostgreSQL on port `55432`. Override it with `TIMER_E2E_PG_PORT` and set the matching `TIMER_E2E_DATABASE_URL` when needed.

## Container image

```bash
docker build -t durable-timer-service:local .
```

The runtime image uses an unprivileged `node` user and contains only production dependencies, compiled output, and migrations.
