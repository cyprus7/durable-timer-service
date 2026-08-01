import { timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AppConfig } from '../config.js'
import type { TimerApplicationService } from '../domain/timer-service.js'
import type { Logger } from '../logger.js'
import type { TimerMetrics } from '../metrics.js'
import type { TimerStore } from '../storage/timer-store.js'
import { isServiceError, ServiceError, toErrorMessage } from '../utils/errors.js'

export interface ApiServerDependencies {
  readonly config: AppConfig
  readonly service: TimerApplicationService
  readonly store: TimerStore
  readonly logger: Logger
  readonly metrics: TimerMetrics
}

export function createApiServer(deps: ApiServerDependencies): Server {
  return createServer((request, response) => {
    void handleRequest(request, response, deps)
  })
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  deps: ApiServerDependencies,
): Promise<void> {
  try {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`)

    if (request.method === 'GET' && url.pathname === '/health/live') {
      sendJson(response, 200, { status: 'ok' })
      return
    }

    if (request.method === 'GET' && url.pathname === '/health/ready') {
      await deps.store.ping()
      sendJson(response, 200, { status: 'ok' })
      return
    }

    if (request.method === 'GET' && url.pathname === '/metrics') {
      sendText(response, 200, deps.metrics.render())
      return
    }

    authorize(request, deps.config)

    if (request.method === 'GET' && url.pathname === '/v1/targets') {
      sendJson(response, 200, { targets: deps.service.listTargets() })
      return
    }

    if (request.method === 'POST' && url.pathname === '/v1/timers') {
      const body = await readJsonBody(request, deps.config.maxPayloadBytes)
      sendJson(response, 200, await deps.service.schedule(body))
      return
    }

    if (request.method === 'POST' && url.pathname === '/v1/timers/cancel') {
      const body = await readJsonBody(request, deps.config.maxPayloadBytes)
      sendJson(response, 200, await deps.service.cancel(body))
      return
    }

    if (request.method === 'POST' && url.pathname === '/v1/timers/cancel-session') {
      const body = await readJsonBody(request, deps.config.maxPayloadBytes)
      sendJson(response, 200, await deps.service.cancelSession(body))
      return
    }

    throw new ServiceError(404, 'not_found', 'Route not found')
  } catch (error) {
    const statusCode = isServiceError(error) ? error.statusCode : 500
    const code = isServiceError(error) ? error.code : 'internal_error'
    const message = isServiceError(error) ? error.message : 'Internal server error'
    const details = isServiceError(error) ? error.details : undefined

    if (statusCode >= 500) {
      deps.logger.error('request_failed', { error })
    }

    sendJson(response, statusCode, { error: { code, message, details } })
  }
}

function authorize(request: IncomingMessage, config: AppConfig): void {
  if (!config.apiToken) {
    return
  }

  const authorization = request.headers.authorization

  if (!authorization?.startsWith('Bearer ')) {
    throw new ServiceError(401, 'unauthorized', 'Missing or invalid bearer token')
  }

  const actual = Buffer.from(authorization.slice('Bearer '.length), 'utf8')
  const expected = Buffer.from(config.apiToken, 'utf8')

  if (actual.byteLength !== expected.byteLength || !timingSafeEqual(actual, expected)) {
    throw new ServiceError(401, 'unauthorized', 'Missing or invalid bearer token')
  }
}

async function readJsonBody(request: IncomingMessage, maxBytes: number): Promise<unknown> {
  const chunks: Buffer[] = []
  let totalBytes = 0

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    totalBytes += buffer.byteLength

    if (totalBytes > maxBytes) {
      throw new ServiceError(413, 'body_too_large', 'Request body exceeds the configured size limit')
    }

    chunks.push(buffer)
  }

  const raw = Buffer.concat(chunks).toString('utf8')

  if (!raw.trim()) {
    throw new ServiceError(400, 'empty_body', 'Request body is required')
  }

  try {
    return JSON.parse(raw) as unknown
  } catch (error) {
    throw new ServiceError(400, 'invalid_json', toErrorMessage(error))
  }
}

function sendJson(response: ServerResponse, statusCode: number, payload: unknown): void {
  response.statusCode = statusCode
  response.setHeader('content-type', 'application/json; charset=utf-8')
  response.end(JSON.stringify(payload))
}

function sendText(response: ServerResponse, statusCode: number, payload: string): void {
  response.statusCode = statusCode
  response.setHeader('content-type', 'text/plain; version=0.0.4; charset=utf-8')
  response.end(payload)
}
