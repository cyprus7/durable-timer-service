import assert from 'node:assert/strict'
import test from 'node:test'
import { computeNextAttemptAt } from '../src/utils/time.js'

test('computeNextAttemptAt caps retry by deliverUntil', () => {
  const now = new Date('2026-06-23T18:10:00.000Z')
  const deliverUntil = new Date('2026-06-23T18:10:05.000Z')
  const next = computeNextAttemptAt(10, now, deliverUntil, {
    baseMs: 1000,
    maxMs: 60_000,
    jitterRatio: 0,
  })

  assert.equal(next.toISOString(), deliverUntil.toISOString())
})

test('computeNextAttemptAt applies exponential retry without jitter', () => {
  const now = new Date('2026-06-23T18:10:00.000Z')
  const deliverUntil = new Date('2026-06-23T18:11:00.000Z')
  const next = computeNextAttemptAt(2, now, deliverUntil, {
    baseMs: 1000,
    maxMs: 60_000,
    jitterRatio: 0,
  })

  assert.equal(next.toISOString(), '2026-06-23T18:10:04.000Z')
})
