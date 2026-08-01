CREATE TABLE IF NOT EXISTS timer_slots (
  namespace text NOT NULL,
  timer_key text NOT NULL,
  timer_id text NOT NULL,
  generation bigint NOT NULL,
  session_id text NOT NULL,
  kind text NOT NULL,
  lane text NOT NULL,
  due_at timestamptz NOT NULL,
  deliver_until timestamptz NOT NULL,
  target text NOT NULL,
  routing_key text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  state text NOT NULL DEFAULT 'scheduled',
  next_attempt_at timestamptz NOT NULL,
  attempt integer NOT NULL DEFAULT 0,
  lease_owner text,
  lease_until timestamptz,
  scheduled_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (namespace, timer_key),
  UNIQUE (timer_id),
  CONSTRAINT timer_slots_generation_nonnegative CHECK (generation >= 0),
  CONSTRAINT timer_slots_attempt_nonnegative CHECK (attempt >= 0),
  CONSTRAINT timer_slots_state_valid CHECK (state IN ('scheduled', 'leased')),
  CONSTRAINT timer_slots_due_within_window CHECK (due_at <= scheduled_at + interval '24 hours'),
  CONSTRAINT timer_slots_delivery_after_due CHECK (deliver_until >= due_at),
  CONSTRAINT timer_slots_delivery_window CHECK (deliver_until <= due_at + interval '1 hour'),
  CONSTRAINT timer_slots_payload_size CHECK (octet_length(payload::text) <= 16384)
);

CREATE INDEX IF NOT EXISTS timer_slots_claim_scheduled_idx
  ON timer_slots (lane, next_attempt_at, due_at)
  WHERE state = 'scheduled';

CREATE INDEX IF NOT EXISTS timer_slots_expired_lease_idx
  ON timer_slots (lease_until)
  WHERE state = 'leased';

CREATE INDEX IF NOT EXISTS timer_slots_session_idx
  ON timer_slots (namespace, session_id);

CREATE TABLE IF NOT EXISTS timer_receipts (
  timer_id text PRIMARY KEY,
  namespace text NOT NULL,
  timer_key text NOT NULL,
  generation bigint NOT NULL,
  disposition text NOT NULL,
  finished_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  CONSTRAINT timer_receipts_generation_nonnegative CHECK (generation >= 0),
  CONSTRAINT timer_receipts_disposition_valid CHECK (
    disposition IN (
      'applied',
      'obsolete',
      'already_applied',
      'cancelled',
      'superseded',
      'dead_letter'
    )
  )
);

CREATE INDEX IF NOT EXISTS timer_receipts_expires_idx
  ON timer_receipts (expires_at);

CREATE TABLE IF NOT EXISTS timer_dead_letters (
  id bigserial PRIMARY KEY,
  timer_id text NOT NULL,
  namespace text NOT NULL,
  timer_key text NOT NULL,
  generation bigint NOT NULL,
  session_id text NOT NULL,
  kind text NOT NULL,
  lane text NOT NULL,
  due_at timestamptz NOT NULL,
  deliver_until timestamptz NOT NULL,
  target text NOT NULL,
  routing_key text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  attempt integer NOT NULL,
  last_error jsonb NOT NULL,
  failed_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  CONSTRAINT timer_dead_letters_generation_nonnegative CHECK (generation >= 0),
  CONSTRAINT timer_dead_letters_attempt_nonnegative CHECK (attempt >= 0)
);

CREATE INDEX IF NOT EXISTS timer_dead_letters_expires_idx
  ON timer_dead_letters (expires_at);

CREATE INDEX IF NOT EXISTS timer_dead_letters_timer_id_idx
  ON timer_dead_letters (timer_id);
