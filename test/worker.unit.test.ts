import assert from 'node:assert/strict'
import { getEventListeners, setMaxListeners } from 'node:events'
import test from 'node:test'
import type { AppConfig } from '../src/config.js'
import type { HttpCallbackClient } from '../src/delivery/callback-client.js'
import { TimerWorker } from '../src/delivery/worker.js'
import type { ClaimedTimer } from '../src/domain/types.js'
import type { Logger } from '../src/logger.js'
import { TimerMetrics } from '../src/metrics.js'
import type { TimerStore } from '../src/storage/timer-store.js'

test('idle polling does not accumulate abort listeners', async () => {
  let claimCount = 0
  let resolveReady: (() => void) | undefined
  const ready = new Promise<void>((resolve) => {
    resolveReady = resolve
  })

  const store = {
    claimDueTimers: async () => {
      claimCount += 1
      if (claimCount === 25) {
        resolveReady?.()
      }
      return []
    },
    cleanup: async () => ({
      expiredReceipts: 0,
      expiredDeadLetters: 0,
      movedOverdueTimers: 0,
    }),
  } as unknown as TimerStore
  const callbackClient = {} as HttpCallbackClient
  const logger: Logger = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  }
  const config: AppConfig = {
    port: 0,
    databaseUrl: 'postgres://unused',
    autoMigrate: false,
    apiToken: null,
    workerEnabled: true,
    instanceId: 'worker-listener-test',
    targets: new Map(),
    lanes: ['realtime'],
    claimBatchSize: 10,
    leaseMs: 1_000,
    pollIntervalMs: 1,
    cleanupIntervalMs: 60_000,
    httpClientTimeoutMs: 1_000,
    maxCallbackResponseBytes: 64 * 1024,
    retryBaseMs: 25,
    retryMaxMs: 250,
    retryJitterRatio: 0,
    receiptRetentionMs: 86_400_000,
    deadLetterRetentionMs: 604_800_000,
    maxScheduleAheadMs: 86_400_000,
    maxDeliveryWindowMs: 3_600_000,
    maxPayloadBytes: 16_384,
    defaultLane: 'realtime',
  }
  const worker = new TimerWorker(
    store,
    callbackClient,
    config,
    logger,
    new TimerMetrics({ instanceId: config.instanceId }),
  )
  const signal = (
    worker as unknown as { abortController: AbortController }
  ).abortController.signal
  setMaxListeners(100, signal)

  worker.start()

  try {
    await Promise.race([
      ready,
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('worker did not complete enough idle polls')), 2_000)
      }),
    ])

    assert.ok(claimCount >= 25)
    assert.ok(getEventListeners(signal, 'abort').length <= 2)
  } finally {
    await worker.stop()
  }

  assert.equal(getEventListeners(signal, 'abort').length, 0)
})

test('a callback from a stale lease is not reported as a completed delivery', async () => {
  const warnings: string[] = []
  const infos: string[] = []
  const logger: Logger = {
    debug: () => {},
    info: message => { infos.push(message) },
    warn: message => { warnings.push(message) },
    error: () => {},
  }
  const store = { completeTimer: async () => false } as unknown as TimerStore
  const callbackClient = {
    deliver: async () => ({ kind: 'terminal', disposition: 'applied' }),
  } as unknown as HttpCallbackClient
  const config = { instanceId: 'stale-lease-test', receiptRetentionMs: 60_000 } as AppConfig
  const metrics = new TimerMetrics({ instanceId: config.instanceId })
  const worker = new TimerWorker(store, callbackClient, config, logger, metrics)
  const now = new Date()
  const timer: ClaimedTimer = {
    namespace: 'test', timerKey: 'stale', timerId: 'stale-id', generation: 1,
    sessionId: 'session', kind: 'test', lane: 'realtime', dueAt: now,
    deliverUntil: new Date(now.getTime() + 60_000), target: 'test', routingKey: null,
    payload: {}, attempt: 0, leaseOwner: 'old-worker',
    leaseUntil: new Date(now.getTime() + 1_000), scheduledAt: now, updatedAt: now,
  }

  await (worker as unknown as { deliver(timer: ClaimedTimer): Promise<void> }).deliver(timer)

  assert.deepEqual(infos, [])
  assert.deepEqual(warnings, ['timer_delivery_stale_claim_ignored'])
  assert.doesNotMatch(metrics.render(), /timer_service_deliveries_total/)
})
