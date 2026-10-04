import assert from 'node:assert/strict'
import test from 'node:test'
import { readConfig } from '../src/config.js'

const baseEnv: NodeJS.ProcessEnv = {
  DATABASE_URL: 'postgres://timer:timer@localhost:5432/timer_service',
}

test('readConfig requires API authentication by default', () => {
  assert.throws(() => readConfig(baseEnv), /API_TOKEN is required/)
})

test('readConfig accepts an API token', () => {
  const config = readConfig({ ...baseEnv, API_TOKEN: 'a-long-random-test-token' })

  assert.equal(config.apiToken, 'a-long-random-test-token')
})

test('readConfig allows an explicit local-only no-auth mode', () => {
  const config = readConfig({ ...baseEnv, ALLOW_INSECURE_NO_AUTH: 'true' })

  assert.equal(config.apiToken, null)
})

test('admission defaults are generous, finite, and configurable', () => {
  const env = { ...baseEnv, API_TOKEN: 'test' }
  const config = readConfig(env)
  assert.equal(config.maxTimerStorageBytes, 10 * 1024 ** 3)
  assert.equal(config.maxTimersPerSession, 100_000)
  assert.equal(config.maxCancelSessionTimers, 100_000)
  assert.equal(config.maxSchedulesPerMinute, 60_000)
  assert.equal(config.allowInsecureHttp, false)
  for (const key of ['MAX_TIMER_STORAGE_BYTES', 'MAX_TIMERS_PER_SESSION', 'MAX_CANCEL_SESSION_TIMERS', 'MAX_SCHEDULES_PER_MINUTE', 'MAX_CONCURRENT_REQUESTS']) {
    assert.throws(() => readConfig({ ...env, [key]: '0' }))
    assert.throws(() => readConfig({ ...env, [key]: 'NaN' }))
  }
  assert.equal(readConfig({ ...env, MAX_TIMERS_PER_SESSION: '250000' }).maxTimersPerSession, 250_000)
  assert.throws(() => readConfig({ ...env, TLS_CERT_FILE: 'cert.pem' }), /together/)
})
