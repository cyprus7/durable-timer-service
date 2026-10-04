import type {
  CancelSessionCommand,
  CancelSessionResult,
  CancelTimerCommand,
  CancelTimerResult,
  ClaimedTimer,
  DeliveryErrorInfo,
  ReceiptDisposition,
  ScheduleTimerCommand,
  ScheduleTimerResult,
} from '../domain/types.js'

export interface ScheduleStoreOptions {
  readonly maxTimerStorageBytes?: number
  readonly maxSchedulesPerMinute?: number
  readonly maxTimersPerSession?: number
  readonly now: Date
  readonly receiptRetentionMs: number
}

export interface CancelStoreOptions {
  readonly maxCancelSessionTimers?: number
  readonly now: Date
  readonly receiptRetentionMs: number
}

export interface ClaimDueTimersOptions {
  readonly now: Date
  readonly ownerId: string
  readonly leaseUntil: Date
  readonly lanes: readonly string[]
  readonly limit: number
}

export interface CompleteTimerOptions {
  readonly now: Date
  readonly receiptRetentionMs: number
}

export interface RecordFailureOptions {
  readonly now: Date
  readonly ownerId: string
  readonly nextAttemptAt: Date
  readonly error: DeliveryErrorInfo
  readonly receiptRetentionMs: number
  readonly deadLetterRetentionMs: number
}

export interface CleanupOptions {
  readonly now: Date
  readonly limit: number
  readonly receiptRetentionMs: number
  readonly deadLetterRetentionMs: number
}

export interface CleanupResult {
  readonly expiredReceipts: number
  readonly expiredDeadLetters: number
  readonly movedOverdueTimers: number
}

export interface TimerStore {
  ping(): Promise<void>
  runMigrationFile(path: string): Promise<void>
  close(): Promise<void>
  scheduleTimer(command: ScheduleTimerCommand, options: ScheduleStoreOptions): Promise<ScheduleTimerResult>
  cancelTimer(command: CancelTimerCommand, options: CancelStoreOptions): Promise<CancelTimerResult>
  cancelSession(command: CancelSessionCommand, options: CancelStoreOptions): Promise<CancelSessionResult>
  claimDueTimers(options: ClaimDueTimersOptions): Promise<readonly ClaimedTimer[]>
  completeTimer(timer: ClaimedTimer, disposition: ReceiptDisposition, options: CompleteTimerOptions): Promise<boolean>
  recordDeliveryFailure(timer: ClaimedTimer, options: RecordFailureOptions): Promise<boolean>
  cleanup(options: CleanupOptions): Promise<CleanupResult>
}
