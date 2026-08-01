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

  recordDeliveryStarted(): void {
    this.registry.inc('timer_service_delivery_attempts_total', 'Timer delivery attempts.', {})
    this.registry.incGauge('timer_service_inflight_deliveries', 'Current in-flight timer deliveries.', {}, 1)
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

type MetricType = 'counter' | 'gauge'

interface MetricDefinition {
  readonly type: MetricType
  readonly help: string
}

interface MetricSample {
  readonly name: string
  readonly labels: Labels
  value: number
}

class MetricsRegistry {
  private readonly definitions = new Map<string, MetricDefinition>()
  private readonly samples = new Map<string, MetricSample>()

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

  render(): string {
    const lines: string[] = []

    for (const [name, definition] of [...this.definitions.entries()].sort(([left], [right]) => left.localeCompare(right))) {
      lines.push(`# HELP ${name} ${definition.help}`)
      lines.push(`# TYPE ${name} ${definition.type}`)

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
    const existingDefinition = this.definitions.get(name)

    if (existingDefinition && existingDefinition.type !== type) {
      throw new Error(`Metric ${name} was registered as ${existingDefinition.type}, got ${type}`)
    }

    this.definitions.set(name, { type, help })

    const key = `${name}:${JSON.stringify(sortLabels(labels))}`
    const existing = this.samples.get(key)

    if (existing) {
      return existing
    }

    const sample = { name, labels: sortLabels(labels), value: 0 }
    this.samples.set(key, sample)
    return sample
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
