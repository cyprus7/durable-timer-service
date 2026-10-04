import { readFile } from 'node:fs/promises'
import pg, { type PoolClient } from 'pg'
import type {
  CancelSessionCommand,
  CancelSessionResult,
  CancelTimerCommand,
  CancelTimerResult,
  ClaimedTimer,
  DeliveryErrorInfo,
  JsonValue,
  ReceiptDisposition,
  ScheduleTimerCommand,
  ScheduleTimerResult,
} from '../domain/types.js'
import { createLogger, type Logger } from '../logger.js'
import { ServiceError } from '../utils/errors.js'
import { addMs } from '../utils/time.js'
import type {
  CancelStoreOptions,
  ClaimDueTimersOptions,
  CleanupOptions,
  CleanupResult,
  CompleteTimerOptions,
  RecordFailureOptions,
  ScheduleStoreOptions,
  TimerStore,
} from './timer-store.js'

const { Pool } = pg

interface SlotRow {
  namespace: string
  timer_key: string
  timer_id: string
  generation: string
  session_id: string
  kind: string
  lane: string
  due_at: Date
  deliver_until: Date
  target: string
  routing_key: string | null
  payload: JsonValue
  state: 'scheduled' | 'leased'
  next_attempt_at: Date
  attempt: number
  lease_owner: string | null
  lease_until: Date | null
  scheduled_at: Date
  updated_at: Date
}

interface ReceiptRow {
  disposition: ReceiptDisposition
  generation: string
}

export class PostgresTimerStore implements TimerStore {
  private readonly pool: pg.Pool

  constructor(databaseUrl: string, logger: Pick<Logger, 'error'> = createLogger({ service: 'timer-service' })) {
    this.pool = new Pool({ connectionString: databaseUrl })
    // Pool errors cover idle clients only. Checked-out transaction clients
    // can also emit errors between queries when PostgreSQL disconnects.
    this.pool.on('connect', (client) => {
      client.on('error', (error) => {
        logger.error('timer_postgres_connection_failed', { code: (error as Error & { code?: string }).code ?? 'CONNECTION_LOST' })
      })
    })
    this.pool.on('error', (error) => {
      logger.error('timer_postgres_idle_connection_failed', { code: (error as Error & { code?: string }).code ?? 'CONNECTION_LOST' })
    })
  }

  async ping(): Promise<void> {
    await this.pool.query('SELECT 1')
  }

  async runMigrationFile(path: string): Promise<void> {
    const sql = await readFile(path, 'utf8')
    await this.pool.query(sql)
  }

  async close(): Promise<void> {
    await this.pool.end()
  }

  async scheduleTimer(command: ScheduleTimerCommand, options: ScheduleStoreOptions): Promise<ScheduleTimerResult> {
    return this.withTransaction(async (client) => {
      // Serialize only admission/cancel-session across replicas. Workers remain independent.
      await client.query('SELECT id FROM timer_admission WHERE id = 1 FOR UPDATE')
      const receipt = await findReceipt(client, command.timerId)

      if (receipt) {
        return {
          status: 'finished',
          namespace: command.namespace,
          timerKey: command.timerKey,
          timerId: command.timerId,
          generation: command.generation,
          disposition: receipt.disposition,
        }
      }

      const current = await findSlot(client, command.namespace, command.timerKey)

      if (!current) {
        await admitSchedule(client, command, options, true)
        await insertSlot(client, command, options.now)

        return {
          status: 'scheduled',
          namespace: command.namespace,
          timerKey: command.timerKey,
          timerId: command.timerId,
          generation: command.generation,
        }
      }

      const currentGeneration = Number(current.generation)

      if (command.generation < currentGeneration) {
        return {
          status: 'stale',
          namespace: command.namespace,
          timerKey: command.timerKey,
          timerId: command.timerId,
          generation: command.generation,
          currentGeneration,
        }
      }

      if (command.generation === currentGeneration) {
        if (command.timerId !== current.timer_id) {
          throw new ServiceError(409, 'generation_conflict', 'generation matches an active timer with a different timerId')
        }

        return {
          status: 'idempotent',
          namespace: command.namespace,
          timerKey: command.timerKey,
          timerId: command.timerId,
          generation: command.generation,
        }
      }

      await admitSchedule(client, command, options, current.session_id !== command.sessionId)
      await insertReceipt(client, {
        timerId: current.timer_id,
        namespace: current.namespace,
        timerKey: current.timer_key,
        generation: Number(current.generation),
        disposition: 'superseded',
        now: options.now,
        retentionMs: options.receiptRetentionMs,
      })
      await replaceSlot(client, command, options.now)

      return {
        status: 'superseded',
        namespace: command.namespace,
        timerKey: command.timerKey,
        timerId: command.timerId,
        generation: command.generation,
        currentGeneration,
      }
    })
  }

  async cancelTimer(command: CancelTimerCommand, options: CancelStoreOptions): Promise<CancelTimerResult> {
    return this.withTransaction(async (client) => {
      const current = await findSlot(client, command.namespace, command.timerKey)

      if (!current) {
        const receipt = await findReceipt(client, command.timerId)

        if (receipt) {
          return {
            status: 'already_finished',
            namespace: command.namespace,
            timerKey: command.timerKey,
            timerId: command.timerId,
            generation: command.generation,
            disposition: receipt.disposition,
          }
        }

        return {
          status: 'not_found',
          namespace: command.namespace,
          timerKey: command.timerKey,
          timerId: command.timerId,
          generation: command.generation,
        }
      }

      const currentGeneration = Number(current.generation)

      if (command.generation < currentGeneration) {
        return {
          status: 'stale',
          namespace: command.namespace,
          timerKey: command.timerKey,
          timerId: command.timerId,
          generation: command.generation,
          currentGeneration,
        }
      }

      if (command.generation !== currentGeneration || command.timerId !== current.timer_id) {
        return {
          status: 'mismatch',
          namespace: command.namespace,
          timerKey: command.timerKey,
          timerId: command.timerId,
          generation: command.generation,
          currentGeneration,
        }
      }

      await client.query('DELETE FROM timer_slots WHERE namespace = $1 AND timer_key = $2', [
        command.namespace,
        command.timerKey,
      ])
      await insertReceipt(client, {
        timerId: command.timerId,
        namespace: command.namespace,
        timerKey: command.timerKey,
        generation: command.generation,
        disposition: 'cancelled',
        now: options.now,
        retentionMs: options.receiptRetentionMs,
      })

      return {
        status: 'cancelled',
        namespace: command.namespace,
        timerKey: command.timerKey,
        timerId: command.timerId,
        generation: command.generation,
      }
    })
  }

  async cancelSession(command: CancelSessionCommand, options: CancelStoreOptions): Promise<CancelSessionResult> {
    return this.withTransaction(async (client) => {
      await client.query('SELECT id FROM timer_admission WHERE id = 1 FOR UPDATE')
      const limit = options.maxCancelSessionTimers ?? 100_000
      const count = await client.query<{ count: number }>(
        'SELECT count(*)::int AS count FROM (SELECT 1 FROM timer_slots WHERE namespace = $1 AND session_id = $2 LIMIT $3) AS bounded',
        [command.namespace, command.sessionId, limit + 1],
      )
      if (count.rows[0]!.count > limit) {
        throw new ServiceError(413, 'session_too_large', 'Session exceeds MAX_CANCEL_SESSION_TIMERS; cancel individual timers or raise the limit')
      }
      // No payloads enter Node memory. Preserve atomic cancellation and the existing
      // response contract; never silently return a partially cancelled session.
      const deleted = await client.query<{ timer_id: string }>(
        `WITH deleted AS (
          DELETE FROM timer_slots WHERE namespace = $1 AND session_id = $2
          RETURNING timer_id, namespace, timer_key, generation
        ), receipts AS (
          INSERT INTO timer_receipts (timer_id, namespace, timer_key, generation, disposition, finished_at, expires_at)
          SELECT timer_id, namespace, timer_key, generation, 'cancelled', $3::timestamptz, $4::timestamptz FROM deleted
          ON CONFLICT (timer_id) DO NOTHING
        ) SELECT timer_id FROM deleted`,
        [command.namespace, command.sessionId, options.now, addMs(options.now, options.receiptRetentionMs)],
      )

      return {
        namespace: command.namespace,
        sessionId: command.sessionId,
        cancelled: deleted.rowCount ?? 0,
        timerIds: deleted.rows.map((row) => row.timer_id),
      }
    })
  }

  async claimDueTimers(options: ClaimDueTimersOptions): Promise<readonly ClaimedTimer[]> {
    const result = await this.pool.query<SlotRow>(
      `
        WITH picked AS (
          SELECT namespace, timer_key
          FROM timer_slots
          WHERE due_at <= $1
            AND next_attempt_at <= $1
            AND lane = ANY($2::text[])
            AND (
              state = 'scheduled'
              OR (state = 'leased' AND lease_until IS NOT NULL AND lease_until <= $1)
            )
          ORDER BY next_attempt_at ASC, due_at ASC
          LIMIT $3
          FOR UPDATE SKIP LOCKED
        )
        UPDATE timer_slots AS slot
        SET state = 'leased',
            lease_owner = $4,
            lease_until = $5,
            updated_at = $1
        FROM picked
        WHERE slot.namespace = picked.namespace
          AND slot.timer_key = picked.timer_key
        RETURNING slot.*
      `,
      [options.now, options.lanes, options.limit, options.ownerId, options.leaseUntil],
    )

    return result.rows.map(toClaimedTimer)
  }

  async completeTimer(
    timer: ClaimedTimer,
    disposition: ReceiptDisposition,
    options: CompleteTimerOptions,
  ): Promise<boolean> {
    return this.withTransaction(async (client) => {
      const deleted = await client.query<SlotRow>(
        `
          DELETE FROM timer_slots
          WHERE namespace = $1
            AND timer_key = $2
            AND timer_id = $3
            AND generation = $4
          RETURNING *
        `,
        [timer.namespace, timer.timerKey, timer.timerId, timer.generation],
      )

      if ((deleted.rowCount ?? 0) === 0) {
        return false
      }

      await insertReceipt(client, {
        timerId: timer.timerId,
        namespace: timer.namespace,
        timerKey: timer.timerKey,
        generation: timer.generation,
        disposition,
        now: options.now,
        retentionMs: options.receiptRetentionMs,
      })

      return true
    })
  }

  async recordDeliveryFailure(timer: ClaimedTimer, options: RecordFailureOptions): Promise<boolean> {
    if (options.now.getTime() >= timer.deliverUntil.getTime()) {
      return this.moveTimerToDeadLetter(timer, options.error, options)
    }

    const result = await this.pool.query(
      `
        UPDATE timer_slots
        SET state = 'scheduled',
            lease_owner = NULL,
            lease_until = NULL,
            next_attempt_at = $5,
            attempt = attempt + 1,
            updated_at = $6
        WHERE namespace = $1
          AND timer_key = $2
          AND timer_id = $3
          AND generation = $4
          AND lease_owner = $7
      `,
      [
        timer.namespace,
        timer.timerKey,
        timer.timerId,
        timer.generation,
        options.nextAttemptAt,
        options.now,
        options.ownerId,
      ],
    )

    return (result.rowCount ?? 0) > 0
  }

  async cleanup(options: CleanupOptions): Promise<CleanupResult> {
    return this.withTransaction(async (client) => {
      const overdue = await client.query<SlotRow>(
        `
          WITH picked AS (
            SELECT namespace, timer_key
            FROM timer_slots
            WHERE deliver_until <= $1
            ORDER BY deliver_until ASC
            LIMIT $2
            FOR UPDATE SKIP LOCKED
          )
          DELETE FROM timer_slots AS slot
          USING picked
          WHERE slot.namespace = picked.namespace
            AND slot.timer_key = picked.timer_key
          RETURNING slot.*
        `,
        [options.now, options.limit],
      )

      for (const row of overdue.rows) {
        await insertDeadLetter(client, row, { reason: 'deliver_until_expired' }, options.now, options.deadLetterRetentionMs)
        await insertReceipt(client, {
          timerId: row.timer_id,
          namespace: row.namespace,
          timerKey: row.timer_key,
          generation: Number(row.generation),
          disposition: 'dead_letter',
          now: options.now,
          retentionMs: options.receiptRetentionMs,
        })
      }

      const receipts = await client.query('DELETE FROM timer_receipts WHERE expires_at <= $1', [options.now])
      const deadLetters = await client.query('DELETE FROM timer_dead_letters WHERE expires_at <= $1', [options.now])

      return {
        movedOverdueTimers: overdue.rowCount ?? 0,
        expiredReceipts: receipts.rowCount ?? 0,
        expiredDeadLetters: deadLetters.rowCount ?? 0,
      }
    })
  }

  private async moveTimerToDeadLetter(
    timer: ClaimedTimer,
    error: DeliveryErrorInfo,
    options: RecordFailureOptions,
  ): Promise<boolean> {
    return this.withTransaction(async (client) => {
      const deleted = await client.query<SlotRow>(
        `
          DELETE FROM timer_slots
          WHERE namespace = $1
            AND timer_key = $2
            AND timer_id = $3
            AND generation = $4
          RETURNING *
        `,
        [timer.namespace, timer.timerKey, timer.timerId, timer.generation],
      )

      const row = deleted.rows[0]

      if (!row) {
        return false
      }

      await insertDeadLetter(client, row, error, options.now, options.deadLetterRetentionMs)
      await insertReceipt(client, {
        timerId: timer.timerId,
        namespace: timer.namespace,
        timerKey: timer.timerKey,
        generation: timer.generation,
        disposition: 'dead_letter',
        now: options.now,
        retentionMs: options.receiptRetentionMs,
      })

      return true
    })
  }

  private async withTransaction<T>(callback: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect()
    let discardClient = false

    try {
      await client.query('BEGIN')
      const result = await callback(client)
      await client.query('COMMIT')
      return result
    } catch (error) {
      try {
        await client.query('ROLLBACK')
      } catch {
        // Preserve the original failure and retire a disconnected connection.
        discardClient = true
      }

      if (isPgUniqueViolation(error)) {
        throw new ServiceError(409, 'timer_id_conflict', 'timerId already exists in another active or finished timer')
      }

      throw error
    } finally {
      client.release(discardClient)
    }
  }
}

async function findReceipt(client: PoolClient, timerId: string): Promise<ReceiptRow | null> {
  const result = await client.query<ReceiptRow>(
    `
      SELECT disposition, generation
      FROM timer_receipts
      WHERE timer_id = $1 AND expires_at > now()
      FOR UPDATE
    `,
    [timerId],
  )

  return result.rows[0] ?? null
}

async function findSlot(client: PoolClient, namespace: string, timerKey: string): Promise<SlotRow | null> {
  const result = await client.query<SlotRow>(
    `
      SELECT *
      FROM timer_slots
      WHERE namespace = $1 AND timer_key = $2
      FOR UPDATE
    `,
    [namespace, timerKey],
  )

  return result.rows[0] ?? null
}

async function insertSlot(client: PoolClient, command: ScheduleTimerCommand, now: Date): Promise<void> {
  await client.query(
    `
      INSERT INTO timer_slots (
        namespace,
        timer_key,
        timer_id,
        generation,
        session_id,
        kind,
        lane,
        due_at,
        deliver_until,
        target,
        routing_key,
        payload,
        state,
        next_attempt_at,
        attempt,
        scheduled_at,
        updated_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'scheduled', $8, 0, $13, $13)
    `,
    [
      command.namespace,
      command.timerKey,
      command.timerId,
      command.generation,
      command.sessionId,
      command.kind,
      command.lane,
      command.dueAt,
      command.deliverUntil,
      command.target,
      command.routingKey,
      command.payload,
      now,
    ],
  )
}

async function replaceSlot(client: PoolClient, command: ScheduleTimerCommand, now: Date): Promise<void> {
  await client.query(
    `
      UPDATE timer_slots
      SET timer_id = $3,
          generation = $4,
          session_id = $5,
          kind = $6,
          lane = $7,
          due_at = $8,
          deliver_until = $9,
          target = $10,
          routing_key = $11,
          payload = $12,
          state = 'scheduled',
          next_attempt_at = $8,
          attempt = 0,
          lease_owner = NULL,
          lease_until = NULL,
          scheduled_at = $13,
          updated_at = $13
      WHERE namespace = $1 AND timer_key = $2
    `,
    [
      command.namespace,
      command.timerKey,
      command.timerId,
      command.generation,
      command.sessionId,
      command.kind,
      command.lane,
      command.dueAt,
      command.deliverUntil,
      command.target,
      command.routingKey,
      command.payload,
      now,
    ],
  )
}

async function insertReceipt(
  client: PoolClient,
  input: {
    readonly timerId: string
    readonly namespace: string
    readonly timerKey: string
    readonly generation: number
    readonly disposition: ReceiptDisposition
    readonly now: Date
    readonly retentionMs: number
  },
): Promise<void> {
  await client.query(
    `
      INSERT INTO timer_receipts (
        timer_id,
        namespace,
        timer_key,
        generation,
        disposition,
        finished_at,
        expires_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (timer_id) DO NOTHING
    `,
    [
      input.timerId,
      input.namespace,
      input.timerKey,
      input.generation,
      input.disposition,
      input.now,
      addMs(input.now, input.retentionMs),
    ],
  )
}

async function insertDeadLetter(
  client: PoolClient,
  row: SlotRow,
  error: DeliveryErrorInfo | { readonly reason: string },
  now: Date,
  retentionMs: number,
): Promise<void> {
  await client.query(
    `
      INSERT INTO timer_dead_letters (
        timer_id,
        namespace,
        timer_key,
        generation,
        session_id,
        kind,
        lane,
        due_at,
        deliver_until,
        target,
        routing_key,
        payload,
        attempt,
        last_error,
        failed_at,
        expires_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
    `,
    [
      row.timer_id,
      row.namespace,
      row.timer_key,
      Number(row.generation),
      row.session_id,
      row.kind,
      row.lane,
      row.due_at,
      row.deliver_until,
      row.target,
      row.routing_key,
      row.payload,
      row.attempt,
      error,
      now,
      addMs(now, retentionMs),
    ],
  )
}

function toClaimedTimer(row: SlotRow): ClaimedTimer {
  return {
    namespace: row.namespace,
    timerKey: row.timer_key,
    timerId: row.timer_id,
    generation: Number(row.generation),
    sessionId: row.session_id,
    kind: row.kind,
    lane: row.lane,
    dueAt: row.due_at,
    deliverUntil: row.deliver_until,
    target: row.target,
    routingKey: row.routing_key,
    payload: row.payload,
    attempt: row.attempt,
    leaseOwner: row.lease_owner ?? '',
    leaseUntil: row.lease_until ?? row.updated_at,
    scheduledAt: row.scheduled_at,
    updatedAt: row.updated_at,
  }
}

function isPgUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === '23505'
}

async function admitSchedule(client: PoolClient, command: ScheduleTimerCommand, options: ScheduleStoreOptions, addsToSession: boolean): Promise<void> {
  const storage = await client.query<{ bytes: string }>(
    "SELECT (pg_total_relation_size('timer_slots') + pg_total_relation_size('timer_receipts') + pg_total_relation_size('timer_dead_letters'))::text AS bytes",
  )
  if (Number(storage.rows[0]!.bytes) >= (options.maxTimerStorageBytes ?? 10 * 1024 ** 3)) {
    throw new ServiceError(429, 'storage_capacity', 'Timer storage admission threshold reached')
  }
  if (addsToSession) {
    const limit = options.maxTimersPerSession ?? 100_000
    const count = await client.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM (SELECT 1 FROM timer_slots WHERE namespace = $1 AND session_id = $2 LIMIT $3) AS bounded',
      [command.namespace, command.sessionId, limit],
    )
    if (count.rows[0]!.count >= limit) throw new ServiceError(429, 'session_capacity', 'Session timer capacity reached')
  }
  // DB time avoids skew between replicas. The locked singleton cannot grow with
  // attacker-controlled namespace/session values. Failed transactions consume no quota.
  const rate = await client.query(
    `UPDATE timer_admission SET
      scheduled = CASE WHEN window_start <= clock_timestamp() - interval '1 minute' THEN 1 ELSE scheduled + 1 END,
      window_start = CASE WHEN window_start <= clock_timestamp() - interval '1 minute' THEN clock_timestamp() ELSE window_start END
    WHERE id = 1 AND (window_start <= clock_timestamp() - interval '1 minute' OR scheduled < $1)
    RETURNING id`,
    [options.maxSchedulesPerMinute ?? 60_000],
  )
  if (!rate.rowCount) throw new ServiceError(429, 'schedule_rate', 'Scheduling rate limit reached')
}
