import type { ClaimedTimer, TimerDisposition } from '../domain/types.js'
import type { CallbackRegistry } from './callback-registry.js'

type TerminalTimerDisposition = Extract<TimerDisposition, 'applied' | 'obsolete' | 'already_applied'>

export type CallbackDeliveryResult =
  | { readonly kind: 'terminal'; readonly disposition: TerminalTimerDisposition }
  | {
      readonly kind: 'retry'
      readonly reason: string
      readonly statusCode?: number
      readonly disposition?: TimerDisposition
      readonly message?: string
      readonly responseBody?: string
    }

const TERMINAL = new Set<TimerDisposition>(['applied', 'obsolete', 'already_applied'])
const ALLOWED = new Set<TimerDisposition>(['applied', 'obsolete', 'already_applied', 'retry', 'rejected'])

export class HttpCallbackClient {
  constructor(
    private readonly registry: CallbackRegistry,
    private readonly timeoutMs: number,
    private readonly maxResponseBytes = 64 * 1024,
  ) {}

  async deliver(timer: ClaimedTimer): Promise<CallbackDeliveryResult> {
    const url = this.registry.resolve(timer.target)

    if (!url) {
      return { kind: 'retry', reason: 'unknown_target', message: `Unknown target ${timer.target}` }
    }

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs)

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-timer-id': timer.timerId,
          'x-timer-key': timer.timerKey,
          'x-timer-generation': String(timer.generation),
          'x-timer-attempt': String(timer.attempt + 1),
        },
        body: JSON.stringify(toCallbackPayload(timer)),
        signal: controller.signal,
      })

      const responseBody = await readBoundedResponseBody(response, this.maxResponseBytes)

      if (responseBody.exceeded) {
        return {
          kind: 'retry',
          reason: 'response_too_large',
          statusCode: response.status,
          responseBody: truncate(responseBody.value),
        }
      }

      if (!response.ok) {
        return {
          kind: 'retry',
          reason: 'http_error',
          statusCode: response.status,
          responseBody: truncate(responseBody.value),
        }
      }

      const disposition = parseDisposition(responseBody.value)

      if (!disposition) {
        return {
          kind: 'retry',
          reason: 'invalid_response',
          statusCode: response.status,
          responseBody: truncate(responseBody.value),
        }
      }

      if (isTerminalDisposition(disposition)) {
        return { kind: 'terminal', disposition }
      }

      return {
        kind: 'retry',
        reason: 'consumer_requested_retry',
        statusCode: response.status,
        disposition,
        responseBody: truncate(responseBody.value),
      }
    } catch (error) {
      return {
        kind: 'retry',
        reason: 'network_error',
        message: error instanceof Error ? error.message : String(error),
      }
    } finally {
      clearTimeout(timeout)
    }
  }
}

async function readBoundedResponseBody(
  response: Response,
  maxBytes: number,
): Promise<{ readonly value: string; readonly exceeded: boolean }> {
  if (!response.body) {
    return { value: '', exceeded: false }
  }

  const reader = response.body.getReader()
  const chunks: Buffer[] = []
  let totalBytes = 0

  try {
    while (true) {
      const { value, done } = await reader.read()

      if (done) {
        return { value: Buffer.concat(chunks).toString('utf8'), exceeded: false }
      }

      const chunk = Buffer.from(value)
      const remainingBytes = maxBytes - totalBytes

      if (chunk.byteLength > remainingBytes) {
        if (remainingBytes > 0) {
          chunks.push(chunk.subarray(0, remainingBytes))
        }

        await reader.cancel('Callback response exceeded the configured size limit')
        return { value: Buffer.concat(chunks).toString('utf8'), exceeded: true }
      }

      chunks.push(chunk)
      totalBytes += chunk.byteLength
    }
  } finally {
    reader.releaseLock()
  }
}

function isTerminalDisposition(disposition: TimerDisposition): disposition is TerminalTimerDisposition {
  return TERMINAL.has(disposition)
}

function toCallbackPayload(timer: ClaimedTimer): Record<string, unknown> {
  return {
    namespace: timer.namespace,
    timerKey: timer.timerKey,
    timerId: timer.timerId,
    generation: timer.generation,
    sessionId: timer.sessionId,
    kind: timer.kind,
    lane: timer.lane,
    dueAt: timer.dueAt.toISOString(),
    target: timer.target,
    routingKey: timer.routingKey,
    payload: timer.payload,
    attempt: timer.attempt + 1,
  }
}

function parseDisposition(responseBody: string): TimerDisposition | null {
  try {
    const parsed = JSON.parse(responseBody) as { disposition?: unknown }

    if (typeof parsed.disposition === 'string' && ALLOWED.has(parsed.disposition as TimerDisposition)) {
      return parsed.disposition as TimerDisposition
    }

    return null
  } catch {
    return null
  }
}

function truncate(value: string): string {
  return value.length > 1024 ? `${value.slice(0, 1024)}...` : value
}
