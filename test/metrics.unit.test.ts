import assert from 'node:assert/strict'
import test from 'node:test'
import { TimerMetrics } from '../src/metrics.js'

test('delivery start lag histogram uses cumulative fixed buckets and clamps early attempts', () => {
  const metrics = new TimerMetrics({ instanceId: 'histogram-test' })
  const dueAt = new Date('2026-01-01T00:00:00.000Z')

  metrics.recordDeliveryStarted(dueAt, dueAt)
  metrics.recordDeliveryStarted(dueAt, new Date(dueAt.getTime() + 10))
  metrics.recordDeliveryStarted(dueAt, new Date(dueAt.getTime() + 25))
  metrics.recordDeliveryStarted(dueAt, new Date(dueAt.getTime() + 30))
  metrics.recordDeliveryStarted(new Date(dueAt.getTime() + 100), dueAt)
  metrics.recordDeliveryStarted(dueAt, new Date(dueAt.getTime() + 1_200_000))

  const text = metrics.render()
  const name = 'timer_service_delivery_start_lag_seconds'
  assert.match(text, new RegExp(`# TYPE ${name} histogram`))
  assert.match(text, new RegExp(`${name}_bucket\\{le="0.01"\\} 3`))
  assert.match(text, new RegExp(`${name}_bucket\\{le="0.025"\\} 4`))
  assert.match(text, new RegExp(`${name}_bucket\\{le="0.05"\\} 5`))
  assert.match(text, new RegExp(`${name}_bucket\\{le="600"\\} 5`))
  assert.match(text, new RegExp(`${name}_bucket\\{le="\\+Inf"\\} 6`))
  assert.match(text, new RegExp(`${name}_count 6`))

  const sum = Number(text.match(new RegExp(`${name}_sum ([^\\n]+)`))?.[1])
  assert.ok(Math.abs(sum - 1200.065) < 1e-9)
  assert.doesNotMatch(text, /timer_service_delivery_start_lag_seconds_(?:bucket|sum|count)\{[^}]*timer_id/)
  assert.match(text, /timer_service_delivery_attempts_total 6/)
})

test('attempt-zero lag excludes recorded retries while retaining all-attempt lag', () => {
  const metrics = new TimerMetrics({ instanceId: 'attempt-zero-test' })
  const dueAt = new Date('2026-01-01T00:00:00.000Z')

  metrics.recordDeliveryStarted(dueAt, new Date(dueAt.getTime() + 50), 0)
  metrics.recordDeliveryStarted(dueAt, new Date(dueAt.getTime() + 5_000), 1)
  metrics.recordDeliveryStarted(dueAt, new Date(dueAt.getTime() + 100), 0)

  const text = metrics.render()
  assert.match(text, /timer_service_delivery_start_lag_seconds_count 3/)
  assert.match(text, /timer_service_delivery_start_lag_attempt_zero_seconds_count 2/)
  assert.match(text, /timer_service_delivery_start_lag_attempt_zero_seconds_bucket\{le="0\.1"\} 2/)
  assert.match(text, /timer_service_delivery_attempts_total 3/)
  const allAttemptsSum = Number(text.match(/timer_service_delivery_start_lag_seconds_sum ([^\n]+)/)?.[1])
  const attemptZeroSum = Number(text.match(/timer_service_delivery_start_lag_attempt_zero_seconds_sum ([^\n]+)/)?.[1])
  assert.ok(Math.abs(allAttemptsSum - 5.15) < 1e-9)
  assert.ok(Math.abs(attemptZeroSum - 0.15) < 1e-9)
})

test('backlog gauges expose a fresh shared snapshot and failed samples', () => {
  const metrics = new TimerMetrics({ instanceId: 'backlog-test' })
  const sampledAt = new Date('2026-01-01T00:00:00.000Z')
  metrics.recordBacklogSnapshot({
    dueTimers: 3,
    oldestDueSeconds: 12.5,
    byLane: [
      { lane: 'realtime', dueTimers: 2, oldestDueSeconds: 12.5 },
      { lane: 'background', dueTimers: 1, oldestDueSeconds: 4 },
      { lane: 'empty', dueTimers: 0, oldestDueSeconds: 0 },
    ],
  }, sampledAt)
  let output = metrics.render()
  assert.match(output, /timer_service_due_backlog_timers 3/)
  assert.match(output, /timer_service_oldest_due_seconds 12\.5/)
  assert.match(output, /timer_service_due_backlog_by_lane_timers\{lane="realtime"\} 2/)
  assert.match(output, /timer_service_due_backlog_by_lane_timers\{lane="background"\} 1/)
  assert.match(output, /timer_service_due_backlog_by_lane_timers\{lane="empty"\} 0/)
  assert.match(output, /timer_service_oldest_due_by_lane_seconds\{lane="background"\} 4/)
  assert.match(output, /timer_service_oldest_due_by_lane_seconds\{lane="empty"\} 0/)
  assert.match(output, /timer_service_backlog_sample_success 1/)
  assert.match(output, /timer_service_backlog_sample_timestamp_seconds 1767225600/)

  metrics.recordBacklogSampleFailure()
  output = metrics.render()
  assert.match(output, /timer_service_backlog_sample_success 0/)
  assert.match(output, /timer_service_backlog_sample_failures_total 1/)
  assert.match(output, /timer_service_backlog_sample_timestamp_seconds 1767225600/)

  metrics.recordBacklogSnapshot({
    dueTimers: 1,
    oldestDueSeconds: 2,
    byLane: [
      { lane: 'realtime', dueTimers: 0, oldestDueSeconds: 0 },
      { lane: 'background', dueTimers: 1, oldestDueSeconds: 2 },
      { lane: 'empty', dueTimers: 0, oldestDueSeconds: 0 },
    ],
  }, new Date(sampledAt.getTime() + 10_000))
  output = metrics.render()
  assert.match(output, /timer_service_due_backlog_timers 1/)
  assert.match(output, /timer_service_due_backlog_by_lane_timers\{lane="realtime"\} 0/)
  assert.match(output, /timer_service_oldest_due_by_lane_seconds\{lane="realtime"\} 0/)
  assert.match(output, /timer_service_backlog_sample_success 1/)
  assert.match(output, /timer_service_backlog_sample_timestamp_seconds 1767225610/)
})
