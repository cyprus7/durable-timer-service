-- A single bounded row coordinates admission across replicas, using database time.
CREATE TABLE IF NOT EXISTS timer_admission (
  id integer PRIMARY KEY CHECK (id = 1),
  window_start timestamptz NOT NULL,
  scheduled bigint NOT NULL DEFAULT 0
);
INSERT INTO timer_admission (id, window_start) VALUES (1, clock_timestamp())
ON CONFLICT (id) DO NOTHING;
