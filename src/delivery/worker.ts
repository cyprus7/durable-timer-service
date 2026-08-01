import { setTimeout as delay } from 'node:timers/promises'
import type { AppConfig } from '../config.js'
import type { ClaimedTimer, DeliveryErrorInfo, ReceiptDisposition } from '../domain/types.js'
import type { Logger } from '../logger.js'
import type { TimerMetrics } from '../metrics.js'
import type { TimerStore } from '../storage/timer-store.js'
import { addMs, computeNextAttemptAt } from '../utils/time.js'
import type { HttpCallbackClient } from './callback-client.js'

export class TimerWorker {
  private readonly abortController = new AbortController()
  private loopPromise: Promise<void> | null = null
  private cleanupPromise: Promise<void> | null = null

  constructor(
    private readonly store: TimerStore,
    private readonly callbackClient: HttpCallbackClient,
    private readonly config: AppConfig,
    private readonly logger: Logger,
    private readonly metrics: TimerMetrics,
  ) {}

  start(): void {
    this.loopPromise = this.runDeliveryLoop()
    this.cleanupPromise = this.runCleanupLoop()
  }

  async stop(): Promise<void> {
    this.abortController.abort()
    await Promise.allSettled([this.loopPromise, this.cleanupPromise].filter(Boolean))
  }

  private async runDeliveryLoop(): Promise<void> {
    while (!this.abortController.signal.aborted) {
      try {
        const now = new Date()
        const timers = await this.store.claimDueTimers({
          now,
          ownerId: this.config.instanceId,
          leaseUntil: addMs(now, this.config.leaseMs),
          lanes: this.config.lanes,
          limit: this.config.claimBatchSize,
        })

        if (timers.length === 0) {
          this.metrics.recordClaimCycle('empty')
          await sleep(this.config.pollIntervalMs, this.abortController.signal)
          continue
        }

        this.metrics.recordClaimCycle('claimed')
        this.metrics.recordClaimedTimers(
          timers.length,
          timers.map((timer) => timer.lane),
        )
        await Promise.allSettled(timers.map((timer) => this.deliver(timer)))
      } catch (error) {
        this.metrics.recordClaimCycle('error')
        this.logger.error('timer_worker_loop_failed', { error })
        await sleep(this.config.pollIntervalMs, this.abortController.signal)
      }
    }
  }

  private async runCleanupLoop(): Promise<void> {
    while (!this.abortController.signal.aborted) {
      try {
        await sleep(this.config.cleanupIntervalMs, this.abortController.signal)

        if (this.abortController.signal.aborted) {
          return
        }

        const result = await this.store.cleanup({
          now: new Date(),
          limit: this.config.claimBatchSize,
          receiptRetentionMs: this.config.receiptRetentionMs,
          deadLetterRetentionMs: this.config.deadLetterRetentionMs,
        })
        this.metrics.recordCleanup(result)

        if (result.expiredDeadLetters + result.expiredReceipts + result.movedOverdueTimers > 0) {
          this.logger.info('timer_cleanup_completed', { result })
        }
      } catch (error) {
        this.logger.error('timer_cleanup_failed', { error })
      }
    }
  }

  private async deliver(timer: ClaimedTimer): Promise<void> {
    this.metrics.recordDeliveryStarted()

    try {
      const result = await this.callbackClient.deliver(timer)
      const now = new Date()

      if (result.kind === 'terminal') {
        await this.store.completeTimer(timer, result.disposition as ReceiptDisposition, {
          now,
          receiptRetentionMs: this.config.receiptRetentionMs,
        })
        this.metrics.recordDeliveryTerminal(result.disposition)
        this.logger.info('timer_delivery_completed', {
          timerId: timer.timerId,
          timerKey: timer.timerKey,
          generation: timer.generation,
          disposition: result.disposition,
        })
        return
      }

      const error: DeliveryErrorInfo = {
        reason: result.reason,
        ...(result.statusCode === undefined ? {} : { statusCode: result.statusCode }),
        ...(result.disposition === undefined ? {} : { disposition: result.disposition }),
        ...(result.message === undefined ? {} : { message: result.message }),
        ...(result.responseBody === undefined ? {} : { responseBody: result.responseBody }),
      }
      const nextAttemptAt = computeNextAttemptAt(timer.attempt, now, timer.deliverUntil, {
        baseMs: this.config.retryBaseMs,
        maxMs: this.config.retryMaxMs,
        jitterRatio: this.config.retryJitterRatio,
      })

      const changed = await this.store.recordDeliveryFailure(timer, {
        now,
        ownerId: this.config.instanceId,
        nextAttemptAt,
        error,
        receiptRetentionMs: this.config.receiptRetentionMs,
        deadLetterRetentionMs: this.config.deadLetterRetentionMs,
      })

      if (changed) {
        if (now.getTime() >= timer.deliverUntil.getTime()) {
          this.metrics.recordDeliveryDeadLetter(result.reason)
        } else {
          this.metrics.recordDeliveryRetry(result.reason)
        }
        this.logger.warn('timer_delivery_retry_scheduled', {
          timerId: timer.timerId,
          timerKey: timer.timerKey,
          generation: timer.generation,
          nextAttemptAt: nextAttemptAt.toISOString(),
          error,
        })
      }
    } finally {
      this.metrics.recordDeliveryFinished()
    }
  }
}

async function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return
  }

  try {
    await delay(ms, undefined, { signal })
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      return
    }

    throw error
  }
}
