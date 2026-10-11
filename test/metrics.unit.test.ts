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

test('backlog gauges expose a fresh shared snapshot and failed samples', () => {
  const metrics = new TimerMetrics({ instanceId: 'backlog-test' })
  const sampledAt = new Date('2026-01-01T00:00:00.000Z')
  metrics.recordBacklogSnapshot({ dueTimers: 3, oldestDueSeconds: 12.5 }, sampledAt)
  let output = metrics.render()
  assert.match(output, /timer_service_due_backlog_timers 3/)
  assert.match(output, /timer_service_oldest_due_seconds 12\.5/)
  assert.match(output, /timer_service_backlog_sample_success 1/)
  assert.match(output, /timer_service_backlog_sample_timestamp_seconds 1767225600/)

  metrics.recordBacklogSampleFailure()
  output = metrics.render()
  assert.match(output, /timer_service_backlog_sample_success 0/)
  assert.match(output, /timer_service_backlog_sample_failures_total 1/)
  assert.match(output, /timer_service_backlog_sample_timestamp_seconds 1767225600/)
})
