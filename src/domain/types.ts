export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { readonly [key: string]: JsonValue }

export type TimerDisposition = 'applied' | 'obsolete' | 'already_applied' | 'retry' | 'rejected'

export type ReceiptDisposition =
  | 'applied'
  | 'obsolete'
  | 'already_applied'
  | 'cancelled'
  | 'superseded'
  | 'dead_letter'

export const terminalCallbackDispositions = new Set<TimerDisposition>([
  'applied',
  'obsolete',
  'already_applied',
])

export interface ScheduleTimerCommand {
  readonly namespace: string
  readonly timerKey: string
  readonly timerId: string
  readonly generation: number
  readonly sessionId: string
  readonly kind: string
  readonly lane: string
  readonly dueAt: Date
  readonly deliverUntil: Date
  readonly target: string
  readonly routingKey: string | null
  readonly payload: JsonValue
}

export interface CancelTimerCommand {
  readonly namespace: string
  readonly timerKey: string
  readonly timerId: string
  readonly generation: number
}

export interface CancelSessionCommand {
  readonly namespace: string
  readonly sessionId: string
}

export interface ClaimedTimer extends ScheduleTimerCommand {
  readonly attempt: number
  readonly leaseOwner: string
  readonly leaseUntil: Date
  readonly scheduledAt: Date
  readonly updatedAt: Date
}

export interface ScheduleTimerResult {
  readonly status: 'scheduled' | 'idempotent' | 'stale' | 'superseded' | 'finished'
  readonly namespace: string
  readonly timerKey: string
  readonly timerId: string
  readonly generation: number
  readonly currentGeneration?: number
  readonly disposition?: ReceiptDisposition
}

export interface CancelTimerResult {
  readonly status: 'cancelled' | 'not_found' | 'stale' | 'mismatch' | 'already_finished'
  readonly namespace: string
  readonly timerKey: string
  readonly timerId: string
  readonly generation: number
  readonly currentGeneration?: number
  readonly disposition?: ReceiptDisposition
}

export interface CancelSessionResult {
  readonly namespace: string
  readonly sessionId: string
  readonly cancelled: number
  readonly timerIds: readonly string[]
}

export interface DeliveryErrorInfo {
  readonly reason: string
  readonly statusCode?: number
  readonly disposition?: TimerDisposition
  readonly message?: string
  readonly responseBody?: string
}
