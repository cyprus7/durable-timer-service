export const SECOND_MS = 1000
export const MINUTE_MS = 60 * SECOND_MS
export const HOUR_MS = 60 * MINUTE_MS
export const DAY_MS = 24 * HOUR_MS

export interface RetryScheduleOptions {
  readonly baseMs: number
  readonly maxMs: number
  readonly jitterRatio: number
  readonly random?: () => number
}

export function addMs(date: Date, ms: number): Date {
  return new Date(date.getTime() + ms)
}

export function computeNextAttemptAt(
  attempt: number,
  now: Date,
  deliverUntil: Date,
  options: RetryScheduleOptions,
): Date {
  const exponent = Math.min(Math.max(attempt, 0), 10)
  const baseDelay = Math.min(options.maxMs, options.baseMs * 2 ** exponent)
  const random = options.random ?? Math.random
  const jitter = baseDelay * options.jitterRatio * (random() * 2 - 1)
  const delay = Math.max(0, Math.round(baseDelay + jitter))
  const next = addMs(now, delay)

  return next.getTime() > deliverUntil.getTime() ? deliverUntil : next
}
