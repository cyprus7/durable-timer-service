# Security and compatibility upgrade

This change combines optional callback authentication and PostgreSQL idle-pool
recovery with the existing timing-safe bearer comparison and bounded callback
response reader. API payloads, fencing, dispositions and successful responses
are unchanged. There is no application-specific code or dependency.

## Deployment order

1. Review capacity and set the environment values below on **all** replicas.
2. Apply `migrations/002_admission.sql` after `001_init.sql` before starting the
   new binaries (`AUTO_MIGRATE=true` applies both). The migration is additive and
   idempotent; it does not rewrite or discard existing timers or receipts.
3. Configure native HTTPS with `TLS_CERT_FILE` and `TLS_KEY_FILE`. Existing
   deployments using HTTP behind a trusted TLS terminator must explicitly set
   `ALLOW_INSECURE_HTTP=true` before upgrading. Restrict listener access to that
   proxy. Forwarded headers alone never establish transport trust.
4. Upgrade **all scheduler replicas together**: old binaries bypass admission.
   Verify readiness, a real scheduled callback, cancellation and metrics.
5. A binary rollback can leave the additive admission table in place, but it
   restores the old vulnerabilities. Never rotate callback credentials while
   outstanding callbacks still require the previous credential.

Native HTTPS also serves health probes over HTTPS; configure probe schemes
accordingly. The no-auth development mode still requires the existing explicit
`ALLOW_INSECURE_NO_AUTH=true`. It is unsuitable for an exposed listener.

## Configurable admission limits

| Environment variable | Default | Scope and behavior |
| --- | ---: | --- |
| `MAX_TIMER_STORAGE_BYTES` | 10 GiB (10737418240) | Combined PostgreSQL size of slots, receipts and dead letters, including indexes/TOAST. Returns 429 for new mutations at the threshold. |
| `MAX_SCHEDULES_PER_MINUTE` | 60000 | Shared fixed one-minute window across all replicas using the same database. Counts inserts and supersessions, including changes to other sessions/namespaces. |
| `MAX_TIMERS_PER_SESSION` | 100000 | Active timers per namespace/session. A move into a full session is rejected; replacement within it remains possible. |
| `MAX_CANCEL_SESSION_TIMERS` | 100000 | Above this count cancellation returns 413 **without changing anything**. Raise the setting or cancel known individual timer identities. |
| `MAX_CONCURRENT_REQUESTS` | 256 | Per process; excess concurrent requests return 503. |

All accept positive safe integers. Configure the same limits on every replica;
replicas with higher limits otherwise allow higher admission. 429 includes
`Retry-After: 60`; capacity limits may need cleanup or an operator action, so use
bounded retries and backoff rather than treating every 429 as transient.
Idempotent/finished/stale schedule retries do not consume admission quota.
Cancellation and delivery continue when admission closes.

These deliberately generous defaults are **not a disk reservation**. Choose the
storage threshold well below the actual volume size and leave space for WAL,
delivery receipts/dead letters, other databases and maintenance. Outstanding
deliveries can still increase storage after admission closes. VACUUM generally
reuses existing pages rather than shrinking relation size; after a threshold is
hit, inspect bloat/retention and reclaim capacity or raise the threshold only
with adequate disk space. Continue monitoring disk usage and backlog. Admission
is serialized using one database row, not one lock per untrusted namespace; this
also avoids an unbounded quota registry. Benchmark throughput for large workloads.

Cancel-session no longer brings payloads into application memory or writes one
receipt per SQL round trip: a single statement deletes identities and inserts
receipts. The bounded response still contains all `timerIds`, so existing clients
do not accidentally interpret a partial cancellation as success.

## Callback behavior

`TIMER_CALLBACK_SECRET` optionally adds `X-Timer-Callback-Secret` to each callback.
This is separate from the scheduling `API_TOKEN`; configure consumers to check
it and use trusted transport. All HTTP redirects now fail delivery and enter
the existing bounded retry/dead-letter flow. Configure the final callback URL
directly in `TIMER_TARGETS`; redirect-dependent integrations must update it.
No redirect setting can forward secrets or payloads outside the registry.

Tests cover real PostgreSQL concurrency across instances, quota rollover,
capacity rejection, atomic oversized cancellation, HTTPS/auth, callback secrets,
all redirect statuses and idle database connection recovery. Certificates under
`test/fixtures` are public test-only fixtures, never deployment credentials.
