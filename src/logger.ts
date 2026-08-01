import { toErrorMessage } from './utils/errors.js'

export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void
  info(message: string, fields?: Record<string, unknown>): void
  warn(message: string, fields?: Record<string, unknown>): void
  error(message: string, fields?: Record<string, unknown>): void
}

export function createLogger(baseFields: Record<string, unknown>): Logger {
  const write = (level: string, message: string, fields: Record<string, unknown> = {}) => {
    const normalized = normalizeFields(fields)
    const record = {
      time: new Date().toISOString(),
      level,
      message,
      ...baseFields,
      ...normalized,
    }

    const line = JSON.stringify(record)

    if (level === 'error') {
      console.error(line)
      return
    }

    console.log(line)
  }

  return {
    debug: (message, fields) => write('debug', message, fields),
    info: (message, fields) => write('info', message, fields),
    warn: (message, fields) => write('warn', message, fields),
    error: (message, fields) => write('error', message, fields),
  }
}

function normalizeFields(fields: Record<string, unknown>): Record<string, unknown> {
  const normalized: Record<string, unknown> = {}

  for (const [key, value] of Object.entries(fields)) {
    normalized[key] = value instanceof Error ? { message: toErrorMessage(value), stack: value.stack } : value
  }

  return normalized
}
