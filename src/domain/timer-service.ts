import type { AppConfig } from '../config.js'
import type { CallbackRegistry } from '../delivery/callback-registry.js'
import type {
  CancelSessionResult,
  CancelTimerResult,
  ScheduleTimerResult,
} from '../domain/types.js'
import type { TimerMetrics } from '../metrics.js'
import type { TimerStore } from '../storage/timer-store.js'
import { ServiceError } from '../utils/errors.js'
import { parseCancelSessionRequest, parseCancelTimerRequest, parseScheduleTimerRequest } from './validation.js'

export class TimerApplicationService {
  constructor(
    private readonly store: TimerStore,
    private readonly registry: CallbackRegistry,
    private readonly config: AppConfig,
    private readonly metrics: TimerMetrics,
  ) {}

  listTargets(): readonly string[] {
    return this.registry.listTargets()
  }

  async schedule(raw: unknown): Promise<ScheduleTimerResult> {
    const command = parseScheduleTimerRequest(raw, this.config)

    if (!this.registry.resolve(command.target)) {
      throw new ServiceError(400, 'unknown_target', `Unknown timer target: ${command.target}`)
    }

    const result = await this.store.scheduleTimer(command, {
      maxTimerStorageBytes: this.config.maxTimerStorageBytes ?? 10 * 1024 ** 3,
      maxSchedulesPerMinute: this.config.maxSchedulesPerMinute ?? 60_000,
      maxTimersPerSession: this.config.maxTimersPerSession ?? 100_000,
      now: new Date(),
      receiptRetentionMs: this.config.receiptRetentionMs,
    })
    this.metrics.recordSchedule(result.status)
    return result
  }

  async cancel(raw: unknown): Promise<CancelTimerResult> {
    const result = await this.store.cancelTimer(parseCancelTimerRequest(raw), {
      now: new Date(),
      receiptRetentionMs: this.config.receiptRetentionMs,
    })
    this.metrics.recordCancel(result.status)
    return result
  }

  async cancelSession(raw: unknown): Promise<CancelSessionResult> {
    const result = await this.store.cancelSession(parseCancelSessionRequest(raw), {
      maxCancelSessionTimers: this.config.maxCancelSessionTimers ?? 100_000,
      now: new Date(),
      receiptRetentionMs: this.config.receiptRetentionMs,
    })
    this.metrics.recordCancelSession(result.cancelled)
    return result
  }
}
