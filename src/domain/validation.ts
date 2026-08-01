import { ServiceError } from '../utils/errors.js'
import type { CancelSessionCommand, CancelTimerCommand, JsonValue, ScheduleTimerCommand } from './types.js'

const SAFE_TEXT = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,191}$/
const SAFE_KIND = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/

export interface ValidationLimits {
  readonly maxScheduleAheadMs: number
  readonly maxDeliveryWindowMs: number
  readonly maxPayloadBytes: number
  readonly defaultLane: string
}

export function parseScheduleTimerRequest(raw: unknown, limits: ValidationLimits): ScheduleTimerCommand {
  const body = requireObject(raw)
  const namespace = readSafeString(body, 'namespace', SAFE_TEXT)
  const timerKey = readSafeString(body, 'timerKey', SAFE_TEXT)
  const timerId = readSafeString(body, 'timerId', SAFE_TEXT)
  const generation = readGeneration(body, 'generation')
  const sessionId = readSafeString(body, 'sessionId', SAFE_TEXT)
  const kind = readSafeString(body, 'kind', SAFE_KIND)
  const lane = readOptionalSafeString(body, 'lane', SAFE_KIND) ?? limits.defaultLane
  const dueAt = readDate(body, 'dueAt')
  const deliverUntil = readDate(body, 'deliverUntil')
  const target = readSafeString(body, 'target', SAFE_KIND)
  const routingKey = readOptionalSafeString(body, 'routingKey', SAFE_TEXT)
  const payload = readPayload(body.payload, limits.maxPayloadBytes)
  const now = Date.now()

  if (dueAt.getTime() > now + limits.maxScheduleAheadMs) {
    throw new ServiceError(400, 'due_at_too_far', 'dueAt is beyond the allowed scheduling window')
  }

  if (deliverUntil.getTime() < dueAt.getTime()) {
    throw new ServiceError(400, 'delivery_before_due', 'deliverUntil must be greater than or equal to dueAt')
  }

  if (deliverUntil.getTime() > dueAt.getTime() + limits.maxDeliveryWindowMs) {
    throw new ServiceError(400, 'delivery_window_too_large', 'deliverUntil is beyond the allowed delivery window')
  }

  return {
    namespace,
    timerKey,
    timerId,
    generation,
    sessionId,
    kind,
    lane,
    dueAt,
    deliverUntil,
    target,
    routingKey: routingKey ?? null,
    payload,
  }
}

export function parseCancelTimerRequest(raw: unknown): CancelTimerCommand {
  const body = requireObject(raw)

  return {
    namespace: readSafeString(body, 'namespace', SAFE_TEXT),
    timerKey: readSafeString(body, 'timerKey', SAFE_TEXT),
    timerId: readSafeString(body, 'timerId', SAFE_TEXT),
    generation: readGeneration(body, 'generation'),
  }
}

export function parseCancelSessionRequest(raw: unknown): CancelSessionCommand {
  const body = requireObject(raw)

  return {
    namespace: readSafeString(body, 'namespace', SAFE_TEXT),
    sessionId: readSafeString(body, 'sessionId', SAFE_TEXT),
  }
}

function requireObject(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ServiceError(400, 'invalid_json_body', 'Request body must be a JSON object')
  }

  return raw as Record<string, unknown>
}

function readSafeString(body: Record<string, unknown>, field: string, pattern: RegExp): string {
  const value = body[field]

  if (typeof value !== 'string' || value.length === 0 || !pattern.test(value)) {
    throw new ServiceError(400, 'invalid_field', `${field} is missing or has an invalid format`, { field })
  }

  return value
}

function readOptionalSafeString(body: Record<string, unknown>, field: string, pattern: RegExp): string | undefined {
  const value = body[field]

  if (value === undefined || value === null) {
    return undefined
  }

  if (typeof value !== 'string' || value.length === 0 || !pattern.test(value)) {
    throw new ServiceError(400, 'invalid_field', `${field} has an invalid format`, { field })
  }

  return value
}

function readGeneration(body: Record<string, unknown>, field: string): number {
  const value = body[field]

  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new ServiceError(400, 'invalid_generation', `${field} must be a non-negative safe integer`)
  }

  return value
}

function readDate(body: Record<string, unknown>, field: string): Date {
  const value = body[field]

  if (typeof value !== 'string') {
    throw new ServiceError(400, 'invalid_date', `${field} must be an ISO date string`, { field })
  }

  const date = new Date(value)

  if (Number.isNaN(date.getTime())) {
    throw new ServiceError(400, 'invalid_date', `${field} must be a valid ISO date string`, { field })
  }

  return date
}

function readPayload(value: unknown, maxPayloadBytes: number): JsonValue {
  const payload = value === undefined ? {} : value
  const serialized = JSON.stringify(payload)

  if (serialized === undefined) {
    throw new ServiceError(400, 'invalid_payload', 'payload must be JSON-serializable')
  }

  if (Buffer.byteLength(serialized, 'utf8') > maxPayloadBytes) {
    throw new ServiceError(413, 'payload_too_large', 'payload exceeds the configured size limit')
  }

  return JSON.parse(serialized) as JsonValue
}
