import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { join } from 'node:path'
import { afterEach, before, beforeEach, test } from 'node:test'
import pg from 'pg'
import { createApiServer } from '../src/api/server.js'
import type { AppConfig } from '../src/config.js'
import { HttpCallbackClient } from '../src/delivery/callback-client.js'
import { StaticCallbackRegistry } from '../src/delivery/callback-registry.js'
import { TimerWorker } from '../src/delivery/worker.js'
import { TimerApplicationService } from '../src/domain/timer-service.js'
import { createLogger } from '../src/logger.js'
import { TimerMetrics } from '../src/metrics.js'
import { PostgresTimerStore } from '../src/storage/postgres-timer-store.js'
import type { TimerStore } from '../src/storage/timer-store.js'

const { Pool } = pg

const databaseUrl =
  process.env.TIMER_E2E_DATABASE_URL ?? 'postgres://timer:timer@localhost:55432/timer_service'

const activeHarnesses: Harness[] = []

before(async () => {
  const pool = new Pool({ connectionString: databaseUrl })

  try {
    const migration = await readFile(join(process.cwd(), 'migrations', '001_init.sql'), 'utf8')
    await pool.query(migration)
  } finally {
    await pool.end()
  }
})

beforeEach(async () => {
  const pool = new Pool({ connectionString: databaseUrl })

  try {
    await pool.query('TRUNCATE timer_dead_letters, timer_receipts, timer_slots RESTART IDENTITY')
  } finally {
    await pool.end()
  }
})

afterEach(async () => {
  await Promise.allSettled(activeHarnesses.splice(0).map((harness) => harness.stop()))
})

test('delivers a due timer to the configured callback target and writes a receipt', async () => {
  const callbackRequests: unknown[] = []
  const callback = await startCallbackServer(async (body) => {
    callbackRequests.push(body)

    return { disposition: 'applied' }
  })
  const harness = await startHarness(callback.url)

  const response = await postJson(`${harness.baseUrl}/v1/timers`, {
    namespace: 'example',
    timerKey: 'workflow:8d12:retry',
    timerId: 'timer-deliver-1',
    generation: 42,
    sessionId: 'workflow:8d12',
    kind: 'job.retry',
    lane: 'realtime',
    dueAt: new Date(Date.now() - 100).toISOString(),
    deliverUntil: new Date(Date.now() + 10_000).toISOString(),
    target: 'example-worker',
    routingKey: '8d12',
    payload: {
      expectedAttempt: 2,
      expectedStatus: 'pending',
      expectedRevision: 131,
    },
  })

  assert.equal(response.status, 'scheduled')

  await waitFor(() => callbackRequests.length === 1)

  const callbackPayload = callbackRequests[0] as Record<string, unknown>
  assert.equal(callbackPayload.timerKey, 'workflow:8d12:retry')
  assert.equal(callbackPayload.timerId, 'timer-deliver-1')
  assert.equal(callbackPayload.generation, 42)

  const pool = new Pool({ connectionString: databaseUrl })

  try {
    const slots = await pool.query('SELECT count(*)::int AS count FROM timer_slots')
    const receipts = await pool.query('SELECT disposition FROM timer_receipts WHERE timer_id = $1', [
      'timer-deliver-1',
    ])

    assert.equal(slots.rows[0].count, 0)
    assert.equal(receipts.rows[0].disposition, 'applied')
  } finally {
    await pool.end()
  }
})

test('does not let a stale cancel delete a newer active timer', async () => {
  const callback = await startCallbackServer(async () => ({ disposition: 'applied' }))
  const harness = await startHarness(callback.url, { workerEnabled: false })
  const dueAt = new Date(Date.now() + 60_000).toISOString()
  const deliverUntil = new Date(Date.now() + 120_000).toISOString()

  await postJson(`${harness.baseUrl}/v1/timers`, {
    namespace: 'example',
    timerKey: 'workflow:8d12:retry',
    timerId: 'timer-old',
    generation: 1,
    sessionId: 'workflow:8d12',
    kind: 'job.retry',
    lane: 'realtime',
    dueAt,
    deliverUntil,
    target: 'example-worker',
    payload: {},
  })

  const supersede = await postJson(`${harness.baseUrl}/v1/timers`, {
    namespace: 'example',
    timerKey: 'workflow:8d12:retry',
    timerId: 'timer-new',
    generation: 2,
    sessionId: 'workflow:8d12',
    kind: 'job.retry',
    lane: 'realtime',
    dueAt,
    deliverUntil,
    target: 'example-worker',
    payload: {},
  })

  assert.equal(supersede.status, 'superseded')

  const staleCancel = await postJson(`${harness.baseUrl}/v1/timers/cancel`, {
    namespace: 'example',
    timerKey: 'workflow:8d12:retry',
    timerId: 'timer-old',
    generation: 1,
  })

  assert.equal(staleCancel.status, 'stale')

  const pool = new Pool({ connectionString: databaseUrl })

  try {
    const slot = await pool.query('SELECT timer_id, generation::int AS generation FROM timer_slots')
    const oldReceipt = await pool.query('SELECT disposition FROM timer_receipts WHERE timer_id = $1', [
      'timer-old',
    ])

    assert.equal(slot.rows[0].timer_id, 'timer-new')
    assert.equal(slot.rows[0].generation, 2)
    assert.equal(oldReceipt.rows[0].disposition, 'superseded')
  } finally {
    await pool.end()
  }
})

interface Harness {
  readonly baseUrl: string
  stop(): Promise<void>
}

async function startHarness(
  callbackUrl: string,
  overrides: Partial<AppConfig> = {},
): Promise<Harness> {
  const config = createE2eConfig(callbackUrl, overrides)
  const logger = createLogger({ service: 'timer-service-e2e', instanceId: config.instanceId })
  const metrics = new TimerMetrics({ instanceId: config.instanceId })
  const store = new PostgresTimerStore(config.databaseUrl)
  const registry = new StaticCallbackRegistry(config.targets)
  const service = new TimerApplicationService(store, registry, config, metrics)
  const callbackClient = new HttpCallbackClient(
    registry,
    config.httpClientTimeoutMs,
    config.maxCallbackResponseBytes,
  )
  const worker = config.workerEnabled ? new TimerWorker(store, callbackClient, config, logger, metrics) : null
  const server = createApiServer({ config, service, store, logger, metrics })

  await listen(server)
  worker?.start()

  const address = server.address()

  if (!address || typeof address === 'string') {
    throw new Error('Failed to start test server')
  }

  const harness: Harness = {
    baseUrl: `http://127.0.0.1:${address.port}`,
    stop: async () => {
      await Promise.allSettled([worker?.stop() ?? Promise.resolve(), closeServer(server), store.close()])
    },
  }

  activeHarnesses.push(harness)

  return harness
}

function createE2eConfig(callbackUrl: string, overrides: Partial<AppConfig>): AppConfig {
  return {
    port: 0,
    databaseUrl,
    autoMigrate: false,
    apiToken: null,
    workerEnabled: true,
    instanceId: `e2e-${process.pid}-${Math.random().toString(16).slice(2)}`,
    targets: new Map([['example-worker', callbackUrl]]),
    lanes: ['realtime'],
    claimBatchSize: 10,
    leaseMs: 1000,
    pollIntervalMs: 25,
    cleanupIntervalMs: 60_000,
    httpClientTimeoutMs: 1000,
    maxCallbackResponseBytes: 64 * 1024,
    retryBaseMs: 25,
    retryMaxMs: 250,
    retryJitterRatio: 0,
    receiptRetentionMs: 24 * 60 * 60 * 1000,
    deadLetterRetentionMs: 7 * 24 * 60 * 60 * 1000,
    maxScheduleAheadMs: 24 * 60 * 60 * 1000,
    maxDeliveryWindowMs: 60 * 60 * 1000,
    maxPayloadBytes: 16 * 1024,
    defaultLane: 'realtime',
    ...overrides,
  }
}

async function startCallbackServer(
  handler: (body: unknown) => Promise<Record<string, unknown>> | Record<string, unknown>,
): Promise<{ readonly url: string; readonly server: Server }> {
  const server = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = []

      for await (const chunk of request) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
      }

      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
      const result = await handler(body)
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify(result))
    })().catch((error: unknown) => {
      response.statusCode = 500
      response.end(error instanceof Error ? error.message : String(error))
    })
  })

  await listen(server)

  const address = server.address()

  if (!address || typeof address === 'string') {
    throw new Error('Failed to start callback server')
  }

  activeHarnesses.push({
    baseUrl: `http://127.0.0.1:${address.port}`,
    stop: () => closeServer(server),
  })

  return {
    url: `http://127.0.0.1:${address.port}/callback`,
    server,
  }
}

async function postJson(url: string, body: unknown): Promise<Record<string, unknown>> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const responseBody = (await response.json()) as Record<string, unknown>

  assert.equal(response.status, 200, JSON.stringify(responseBody))

  return responseBody
}

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const startedAt = Date.now()

  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) {
      return
    }

    await new Promise((resolve) => setTimeout(resolve, 25))
  }

  assert.fail('Timed out waiting for condition')
}

function listen(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', resolve)
  })
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error)
        return
      }

      resolve()
    })
  })
}
