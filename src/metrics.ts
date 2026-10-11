const DELIVERY_START_LAG_BUCKETS_SECONDS = [
  0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300, 600,
] as const

export class TimerMetrics {
  private readonly registry = new MetricsRegistry()
  private readonly startedAt = Date.now()

  constructor(private readonly labels: { readonly instanceId: string }) {}

  recordSchedule(status: string): void {
    this.registry.inc('timer_service_schedules_total', 'Timer schedule requests by result status.', { status })
  }

  recordCancel(status: string): void {
    this.registry.inc('timer_service_cancels_total', 'Timer cancel requests by result status.', { status })
  }

  recordCancelSession(cancelled: number): void {
    this.registry.inc('timer_service_cancel_sessions_total', 'Timer cancel-session requests.', {})
    this.registry.inc('timer_service_cancelled_session_timers_total', 'Timers cancelled by cancel-session requests.', {}, cancelled)
  }

  recordClaimCycle(result: 'claimed' | 'empty' | 'error'): void {
    this.registry.inc('timer_service_claim_cycles_total', 'Timer worker claim loop cycles by result.', { result })
  }

  recordClaimedTimers(count: number, lanes: readonly string[]): void {
    this.registry.set('timer_service_last_claimed_batch_size', 'Last timer worker claimed batch size.', {}, count)

    for (const lane of lanes) {
      this.registry.inc('timer_service_claimed_timers_total', 'Timers claimed by worker lane.', { lane })
    }
  }

  recordDeliveryStarted(dueAt: Date, startedAt = new Date(), attempt?: number): void {
    this.registry.inc('timer_service_delivery_attempts_total', 'Timer delivery attempts.', {})
    this.registry.incGauge('timer_service_inflight_deliveries', 'Current in-flight timer deliveries.', {}, 1)
    const lagSeconds = Math.max(0, startedAt.getTime() - dueAt.getTime()) / 1000
    this.registry.observe(
      'timer_service_delivery_start_lag_seconds',
      'Seconds between timer due time and the start of a delivery attempt.',
      {},
      lagSeconds,
      DELIVERY_START_LAG_BUCKETS_SECONDS,
    )
    if (attempt === 0) {
      this.registry.observe(
        'timer_service_delivery_start_lag_attempt_zero_seconds',
        'Seconds between timer due time and a delivery start with no recorded failures.',
        {},
        lagSeconds,
        DELIVERY_START_LAG_BUCKETS_SECONDS,
      )
    }
  }

  recordDeliveryTerminal(disposition: string): void {
    this.registry.inc('timer_service_deliveries_total', 'Timer deliveries by terminal disposition.', {
      result: 'terminal',
      disposition,
    })
  }

  recordDeliveryRetry(reason: string): void {
    this.registry.inc('timer_service_deliveries_total', 'Timer deliveries by terminal disposition or retry reason.', {
      result: 'retry',
      reason,
    })
  }

  recordDeliveryDeadLetter(reason: string): void {
    this.registry.inc('timer_service_deliveries_total', 'Timer deliveries by terminal disposition or retry reason.', {
      result: 'dead_letter',
      reason,
    })
  }

  recordDeliveryFinished(): void {
    this.registry.incGauge('timer_service_inflight_deliveries', 'Current in-flight timer deliveries.', {}, -1)
  }

  recordDeliveryTaskFailure(): void {
    this.registry.inc('timer_service_delivery_task_failures_total', 'Timer delivery tasks rejected by an unexpected error.', {})
  }

  recordBacklogSnapshot(input: {
    readonly dueTimers: number
    readonly oldestDueSeconds: number
    readonly byLane?: readonly {
      readonly lane: string
      readonly dueTimers: number
      readonly oldestDueSeconds: number
    }[]
  }, sampledAt: Date): void {
    this.registry.set('timer_service_due_backlog_timers', 'Due timers eligible for a new claim in this instance\'s lanes.', {}, input.dueTimers)
    this.registry.set('timer_service_oldest_due_seconds', 'Age in seconds of the oldest due timer eligible for a new claim.', {}, input.oldestDueSeconds)
    for (const lane of input.byLane ?? []) {
      this.registry.set('timer_service_due_backlog_by_lane_timers', 'Due timers eligible for a new claim in this lane.', { lane: lane.lane }, lane.dueTimers)
      this.registry.set('timer_service_oldest_due_by_lane_seconds', 'Age in seconds of the oldest due timer eligible for a new claim in this lane.', { lane: lane.lane }, lane.oldestDueSeconds)
    }
    this.registry.set('timer_service_backlog_sample_success', 'Whether the most recent backlog sample succeeded.', {}, 1)
    this.registry.set('timer_service_backlog_sample_timestamp_seconds', 'Unix time of the most recent successful backlog sample.', {}, sampledAt.getTime() / 1000)
  }

  recordBacklogSampleFailure(): void {
    this.registry.set('timer_service_backlog_sample_success', 'Whether the most recent backlog sample succeeded.', {}, 0)
    this.registry.inc('timer_service_backlog_sample_failures_total', 'Failed backlog samples.', {})
  }

  recordCleanup(input: {
    readonly movedOverdueTimers: number
    readonly expiredReceipts: number
    readonly expiredDeadLetters: number
  }): void {
    this.registry.inc('timer_service_cleanup_items_total', 'Timer cleanup items by kind.', {
      kind: 'moved_overdue_timers',
    }, input.movedOverdueTimers)
    this.registry.inc('timer_service_cleanup_items_total', 'Timer cleanup items by kind.', {
      kind: 'expired_receipts',
    }, input.expiredReceipts)
    this.registry.inc('timer_service_cleanup_items_total', 'Timer cleanup items by kind.', {
      kind: 'expired_dead_letters',
    }, input.expiredDeadLetters)
  }

  render(): string {
    this.registry.set('timer_service_up', 'Timer service process is up.', this.baseLabels(), 1)
    this.registry.set(
      'timer_service_uptime_seconds',
      'Timer service process uptime in seconds.',
      this.baseLabels(),
      (Date.now() - this.startedAt) / 1000,
    )

    return this.registry.render()
  }

  private baseLabels(): Labels {
    return { instance_id: this.labels.instanceId }
  }
}

type Labels = Readonly<Record<string, string | number | boolean>>

type MetricType = 'counter' | 'gauge' | 'histogram'

interface MetricDefinition {
  readonly type: MetricType
  readonly help: string
}

interface MetricSample {
  readonly name: string
  readonly labels: Labels
  value: number
}

interface HistogramSample {
  readonly name: string
  readonly labels: Labels
  readonly buckets: readonly number[]
  readonly bucketCounts: number[]
  sum: number
  count: number
}

class MetricsRegistry {
  private readonly definitions = new Map<string, MetricDefinition>()
  private readonly samples = new Map<string, MetricSample>()
  private readonly histograms = new Map<string, HistogramSample>()

  inc(name: string, help: string, labels: Labels, value = 1): void {
    if (value === 0) {
      return
    }

    const sample = this.getSample(name, 'counter', help, labels)
    sample.value += value
  }

  set(name: string, help: string, labels: Labels, value: number): void {
    const sample = this.getSample(name, 'gauge', help, labels)
    sample.value = value
  }

  incGauge(name: string, help: string, labels: Labels, value: number): void {
    const sample = this.getSample(name, 'gauge', help, labels)
    sample.value += value
  }

  observe(name: string, help: string, labels: Labels, value: number, buckets: readonly number[]): void {
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`Invalid histogram observation for ${name}: ${value}`)
    }

    this.register(name, 'histogram', help)
    const sortedLabels = sortLabels(labels)
    const key = `${name}:${JSON.stringify(sortedLabels)}`
    let sample = this.histograms.get(key)
    if (!sample) {
      sample = {
        name,
        labels: sortedLabels,
        buckets,
        bucketCounts: buckets.map(() => 0),
        sum: 0,
        count: 0,
      }
      this.histograms.set(key, sample)
    }

    sample.sum += value
    sample.count += 1
    for (let index = 0; index < buckets.length; index += 1) {
      if (value <= buckets[index]!) {
        sample.bucketCounts[index] = sample.bucketCounts[index]! + 1
      }
    }
  }

  render(): string {
    const lines: string[] = []

    for (const [name, definition] of [...this.definitions.entries()].sort(([left], [right]) => left.localeCompare(right))) {
      lines.push(`# HELP ${name} ${definition.help}`)
      lines.push(`# TYPE ${name} ${definition.type}`)

      if (definition.type === 'histogram') {
        const histograms = [...this.histograms.values()]
          .filter((sample) => sample.name === name)
          .sort((left, right) => formatLabels(left.labels).localeCompare(formatLabels(right.labels)))

        for (const sample of histograms) {
          for (let index = 0; index < sample.buckets.length; index += 1) {
            lines.push(`${name}_bucket${formatLabels({ ...sample.labels, le: sample.buckets[index]! })} ${sample.bucketCounts[index]}`)
          }
          lines.push(`${name}_bucket${formatLabels({ ...sample.labels, le: '+Inf' })} ${sample.count}`)
          lines.push(`${name}_sum${formatLabels(sample.labels)} ${sample.sum}`)
          lines.push(`${name}_count${formatLabels(sample.labels)} ${sample.count}`)
        }
        continue
      }

      const samples = [...this.samples.values()]
        .filter((sample) => sample.name === name)
        .sort((left, right) => formatLabels(left.labels).localeCompare(formatLabels(right.labels)))

      for (const sample of samples) {
        lines.push(`${name}${formatLabels(sample.labels)} ${sample.value}`)
      }
    }

    lines.push('')
    return lines.join('\n')
  }

  private getSample(name: string, type: MetricType, help: string, labels: Labels): MetricSample {
    this.register(name, type, help)
    const key = `${name}:${JSON.stringify(sortLabels(labels))}`
    const existing = this.samples.get(key)

    if (existing) {
      return existing
    }

    const sample = { name, labels: sortLabels(labels), value: 0 }
    this.samples.set(key, sample)
    return sample
  }

  private register(name: string, type: MetricType, help: string): void {
    const existingDefinition = this.definitions.get(name)

    if (existingDefinition && existingDefinition.type !== type) {
      throw new Error(`Metric ${name} was registered as ${existingDefinition.type}, got ${type}`)
    }

    this.definitions.set(name, { type, help })
  }
}

function sortLabels(labels: Labels): Labels {
  return Object.fromEntries(Object.entries(labels).sort(([left], [right]) => left.localeCompare(right)))
}

function formatLabels(labels: Labels): string {
  const entries = Object.entries(labels)

  if (entries.length === 0) {
    return ''
  }

  return `{${entries.map(([key, value]) => `${key}="${escapeLabelValue(String(value))}"`).join(',')}}`
}

function escapeLabelValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"')
}
