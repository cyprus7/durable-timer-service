import assert from 'node:assert/strict'
import test from 'node:test'
import { parseScheduleTimerRequest } from '../src/domain/validation.js'

const limits = {
  maxScheduleAheadMs: 24 * 60 * 60 * 1000,
  maxDeliveryWindowMs: 60 * 60 * 1000,
  maxPayloadBytes: 16 * 1024,
  defaultLane: 'realtime',
}

test('parseScheduleTimerRequest accepts a valid timer', () => {
  const now = Date.now()
  const command = parseScheduleTimerRequest(
    {
      namespace: 'example',
      timerKey: 'workflow:8d12:retry',
      timerId: '019abc',
      generation: 42,
      sessionId: 'workflow:8d12',
      kind: 'job.retry',
      dueAt: new Date(now + 1000).toISOString(),
      deliverUntil: new Date(now + 60_000).toISOString(),
      target: 'example-worker',
      routingKey: '8d12',
      payload: { expectedAttempt: 2 },
    },
    limits,
  )

  assert.equal(command.lane, 'realtime')
  assert.equal(command.generation, 42)
  assert.deepEqual(command.payload, { expectedAttempt: 2 })
})

test('parseScheduleTimerRequest rejects too large delivery windows', () => {
  const now = Date.now()

  assert.throws(() =>
    parseScheduleTimerRequest(
      {
        namespace: 'example',
        timerKey: 'workflow:8d12:retry',
        timerId: '019abc',
        generation: 42,
        sessionId: 'workflow:8d12',
        kind: 'job.retry',
        dueAt: new Date(now + 1000).toISOString(),
        deliverUntil: new Date(now + 2 * 60 * 60 * 1000).toISOString(),
        target: 'example-worker',
        payload: {},
      },
      limits,
    ),
  )
})
