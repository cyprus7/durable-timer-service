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
