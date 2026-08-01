import { hostname } from 'node:os'
import { DAY_MS, HOUR_MS, MINUTE_MS } from './utils/time.js'

export interface AppConfig {
  readonly port: number
  readonly databaseUrl: string
  readonly autoMigrate: boolean
  readonly apiToken: string | null
  readonly workerEnabled: boolean
  readonly instanceId: string
  readonly targets: ReadonlyMap<string, string>
  readonly lanes: readonly string[]
  readonly claimBatchSize: number
  readonly leaseMs: number
  readonly pollIntervalMs: number
  readonly cleanupIntervalMs: number
  readonly httpClientTimeoutMs: number
  readonly maxCallbackResponseBytes: number
  readonly retryBaseMs: number
  readonly retryMaxMs: number
  readonly retryJitterRatio: number
  readonly receiptRetentionMs: number
  readonly deadLetterRetentionMs: number
  readonly maxScheduleAheadMs: number
  readonly maxDeliveryWindowMs: number
  readonly maxPayloadBytes: number
  readonly defaultLane: string
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const databaseUrl = readRequiredString(env, 'DATABASE_URL')
  const lanes = readStringList(env.TIMER_LANES, ['realtime'])
  const apiToken = readOptionalString(env.API_TOKEN)

  if (!apiToken && !readBoolean(env.ALLOW_INSECURE_NO_AUTH, false)) {
    throw new Error('API_TOKEN is required unless ALLOW_INSECURE_NO_AUTH=true')
  }

  return {
    port: readInteger(env.PORT, 8080),
    databaseUrl,
    autoMigrate: readBoolean(env.AUTO_MIGRATE, false),
    apiToken,
    workerEnabled: readBoolean(env.WORKER_ENABLED, true),
    instanceId: readOptionalString(env.INSTANCE_ID) ?? `${hostname()}:${process.pid}`,
    targets: parseTargets(env.TIMER_TARGETS),
    lanes,
    claimBatchSize: readInteger(env.CLAIM_BATCH_SIZE, 25),
    leaseMs: readInteger(env.LEASE_MS, 20_000),
    pollIntervalMs: readInteger(env.POLL_INTERVAL_MS, 250),
    cleanupIntervalMs: readInteger(env.CLEANUP_INTERVAL_MS, MINUTE_MS),
    httpClientTimeoutMs: readInteger(env.HTTP_CLIENT_TIMEOUT_MS, 5_000),
    maxCallbackResponseBytes: readInteger(env.MAX_CALLBACK_RESPONSE_BYTES, 64 * 1024),
    retryBaseMs: readInteger(env.RETRY_BASE_MS, 1_000),
    retryMaxMs: readInteger(env.RETRY_MAX_MS, MINUTE_MS),
    retryJitterRatio: readNumber(env.RETRY_JITTER_RATIO, 0.2),
    receiptRetentionMs: readInteger(env.RECEIPT_RETENTION_MS, DAY_MS),
    deadLetterRetentionMs: readInteger(env.DEAD_LETTER_RETENTION_MS, 7 * DAY_MS),
    maxScheduleAheadMs: readInteger(env.MAX_SCHEDULE_AHEAD_MS, DAY_MS),
    maxDeliveryWindowMs: readInteger(env.MAX_DELIVERY_WINDOW_MS, HOUR_MS),
    maxPayloadBytes: readInteger(env.MAX_PAYLOAD_BYTES, 16 * 1024),
    defaultLane: lanes[0] ?? 'realtime',
  }
}

function readRequiredString(env: NodeJS.ProcessEnv, key: string): string {
  const value = readOptionalString(env[key])

  if (!value) {
    throw new Error(`${key} is required`)
  }

  return value
}

function readOptionalString(value: string | undefined): string | null {
  const trimmed = value?.trim()

  return trimmed ? trimmed : null
}

function readInteger(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback
  }

  const parsed = Number(value)

  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid positive integer: ${value}`)
  }

  return parsed
}

function readNumber(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback
  }

  const parsed = Number(value)

  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`Invalid non-negative number: ${value}`)
  }

  return parsed
}

function readBoolean(value: string | undefined, fallback: boolean): boolean {
  if (!value) {
    return fallback
  }

  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase())
}

function readStringList(value: string | undefined, fallback: readonly string[]): readonly string[] {
  const items = value
    ?.split(',')
    .map((item) => item.trim())
    .filter(Boolean)

  return items && items.length > 0 ? items : fallback
}

function parseTargets(raw: string | undefined): ReadonlyMap<string, string> {
  const value = raw?.trim()
  const targets = new Map<string, string>()

  if (!value) {
    return targets
  }

  if (value.startsWith('{')) {
    const parsed = JSON.parse(value) as Record<string, unknown>

    for (const [name, url] of Object.entries(parsed)) {
      if (typeof url !== 'string') {
        throw new Error(`Invalid target URL for ${name}`)
      }

      addTarget(targets, name, url)
    }

    return targets
  }

  for (const pair of value.split(',')) {
    const separator = pair.indexOf('=')

    if (separator <= 0) {
      throw new Error(`Invalid TIMER_TARGETS pair: ${pair}`)
    }

    addTarget(targets, pair.slice(0, separator).trim(), pair.slice(separator + 1).trim())
  }

  return targets
}

function addTarget(targets: Map<string, string>, name: string, url: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(name)) {
    throw new Error(`Invalid target name: ${name}`)
  }

  const parsed = new URL(url)

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error(`Invalid target protocol for ${name}`)
  }

  targets.set(name, parsed.toString())
}
