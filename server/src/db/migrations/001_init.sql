-- Stringline — initial schema.
--
-- Two tenancy tiers, not PropertyPlex's three: a platform operator, and
-- companies that own projects. A portfolio tier above `companies` is a known
-- future migration, deliberately not built until a customer needs it.
--
-- Dates are DATE, never TIMESTAMP. Scheduling is day-granular, and storing a
-- day as an instant is how timezone bugs get in. See db/pool.ts — the driver is
-- configured to hand DATE back as a plain 'YYYY-MM-DD' string so it maps
-- straight onto the engine's IsoDate without ever becoming a JS Date.

-- ── Platform ────────────────────────────────────────────────────────────────

CREATE TABLE platform_admins (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  name          TEXT NOT NULL,
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Companies ───────────────────────────────────────────────────────────────

CREATE TABLE companies (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name                   TEXT NOT NULL,
  -- Login code. Lowercased on write.
  slug                   TEXT NOT NULL UNIQUE,
  plan                   TEXT NOT NULL DEFAULT 'trial'
                           CHECK (plan IN ('trial', 'solo', 'crew', 'company', 'partner')),
  status                 TEXT NOT NULL DEFAULT 'trial'
                           CHECK (status IN ('trial', 'active', 'past_due', 'suspended', 'cancelled')),
  trial_ends_at          TIMESTAMPTZ,
  -- Only planner seats are billable. Field and client seats are unlimited and
  -- free — that is the whole counter to per-seat pricing, so there is
  -- deliberately no max_users column.
  max_projects           INTEGER NOT NULL DEFAULT 3,
  max_planners           INTEGER NOT NULL DEFAULT 1,
  stripe_customer_id     TEXT,
  stripe_subscription_id TEXT,
  features               JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Users ───────────────────────────────────────────────────────────────────
--
-- `role` carries the billing implication as well as the permission set:
--   owner, planner  → billable planner seats
--   field           → free; sees the work assigned to them
--   client          → free; sees phases, milestones and dates only

CREATE TABLE users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  email         TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  name          TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'field'
                  CHECK (role IN ('owner', 'planner', 'field', 'client')),
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (company_id, email)
);

CREATE INDEX users_company_idx ON users (company_id) WHERE is_active;

CREATE TABLE invites (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  email       TEXT NOT NULL,
  role        TEXT NOT NULL CHECK (role IN ('owner', 'planner', 'field', 'client')),
  token       TEXT NOT NULL UNIQUE,
  expires_at  TIMESTAMPTZ NOT NULL,
  accepted_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Calendars ───────────────────────────────────────────────────────────────

CREATE TABLE calendars (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id         UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name               TEXT NOT NULL,
  -- 0 = Sunday .. 6 = Saturday. Matches CalendarDef.workingWeekdays.
  working_weekdays   SMALLINT[] NOT NULL DEFAULT '{1,2,3,4,5}',
  holidays           DATE[] NOT NULL DEFAULT '{}',
  working_exceptions DATE[] NOT NULL DEFAULT '{}',
  is_default         BOOLEAN NOT NULL DEFAULT FALSE,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX calendars_company_idx ON calendars (company_id);

-- ── Projects ────────────────────────────────────────────────────────────────

CREATE TABLE projects (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id       UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name             TEXT NOT NULL,
  calendar_id      UUID NOT NULL REFERENCES calendars(id),
  start_date       DATE NOT NULL,
  deadline         DATE,
  -- The line between fact and forecast. NULL means a pure plan, no progress applied.
  data_date        DATE,
  out_of_sequence  TEXT NOT NULL DEFAULT 'retained'
                     CHECK (out_of_sequence IN ('retained', 'progress-override')),
  status           TEXT NOT NULL DEFAULT 'active'
                     CHECK (status IN ('active', 'archived')),
  -- Cached solver output at the project level.
  computed_finish  DATE,
  computed_at      TIMESTAMPTZ,
  -- Reserved for MS Project / P6 import. Parsers come later; the columns are
  -- here now so adopting an importer is not a migration.
  external_id      TEXT,
  source_system    TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX projects_company_idx ON projects (company_id) WHERE status = 'active';

-- ── Phases ──────────────────────────────────────────────────────────────────

CREATE TABLE phases (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  -- Phases are the level a client is meant to see, so they default to visible.
  visibility TEXT NOT NULL DEFAULT 'client' CHECK (visibility IN ('internal', 'client')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX phases_project_idx ON phases (project_id);

-- ── Tasks ───────────────────────────────────────────────────────────────────

CREATE TABLE tasks (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id       UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  phase_id         UUID REFERENCES phases(id) ON DELETE SET NULL,
  name             TEXT NOT NULL,
  -- Original duration in working days. 0 marks a milestone.
  duration_days    INTEGER NOT NULL DEFAULT 1 CHECK (duration_days >= 0),
  -- NULL inherits the project's calendar.
  calendar_id      UUID REFERENCES calendars(id),
  constraint_type  TEXT NOT NULL DEFAULT 'ASAP'
                     CHECK (constraint_type IN ('ASAP', 'START_NO_EARLIER_THAN',
                                                'FINISH_NO_LATER_THAN', 'MUST_START_ON')),
  constraint_date  DATE,

  -- Actuals. Facts, which override the plan rather than competing with it.
  actual_start     DATE,
  actual_finish    DATE,
  percent_complete INTEGER CHECK (percent_complete BETWEEN 0 AND 100),
  remaining_days   INTEGER CHECK (remaining_days >= 0),

  sort_order       INTEGER NOT NULL DEFAULT 0,
  -- Individual tasks are internal by default; milestones are what clients see.
  -- The API flips this to 'client' when duration_days = 0 unless told otherwise.
  visibility       TEXT NOT NULL DEFAULT 'internal'
                     CHECK (visibility IN ('internal', 'client')),

  -- Cached solver output. Recomputed on every schedule-affecting write, never
  -- hand-edited. The engine is the only writer.
  computed_early_start  DATE,
  computed_early_finish DATE,
  computed_late_start   DATE,
  computed_late_finish  DATE,
  computed_total_float  INTEGER,
  computed_free_float   INTEGER,
  computed_is_critical  BOOLEAN,
  computed_status       TEXT CHECK (computed_status IN ('not-started', 'in-progress', 'complete')),
  computed_remaining    INTEGER,

  -- Reserved for import round-trips.
  wbs_code         TEXT,
  external_id      TEXT,
  source_system    TEXT,

  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- A constraint other than ASAP is meaningless without its date.
  CONSTRAINT tasks_constraint_needs_date
    CHECK (constraint_type = 'ASAP' OR constraint_date IS NOT NULL),
  CONSTRAINT tasks_finish_after_start
    CHECK (actual_finish IS NULL OR actual_start IS NULL OR actual_finish >= actual_start)
);

CREATE INDEX tasks_project_idx ON tasks (project_id);
CREATE INDEX tasks_phase_idx ON tasks (phase_id);
CREATE INDEX tasks_critical_idx ON tasks (project_id) WHERE computed_is_critical;

-- ── Dependencies ────────────────────────────────────────────────────────────

CREATE TABLE dependencies (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id     UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  predecessor_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  successor_id   UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  type           TEXT NOT NULL DEFAULT 'FS' CHECK (type IN ('FS', 'SS', 'FF', 'SF')),
  -- Working days on the successor's calendar. Negative values are leads.
  lag_days       INTEGER NOT NULL DEFAULT 0,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Self-links are the one cycle cheap enough to reject in the database. Longer
  -- loops need graph traversal and are caught by the engine, which reports the
  -- actual path.
  CONSTRAINT dependencies_no_self_link CHECK (predecessor_id <> successor_id),
  UNIQUE (predecessor_id, successor_id)
);

CREATE INDEX dependencies_project_idx ON dependencies (project_id);
CREATE INDEX dependencies_successor_idx ON dependencies (successor_id);

-- ── Resources ───────────────────────────────────────────────────────────────

CREATE TABLE resources (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  type       TEXT NOT NULL DEFAULT 'crew' CHECK (type IN ('crew', 'person', 'equipment')),
  name       TEXT NOT NULL,
  capacity   NUMERIC(6, 2) NOT NULL DEFAULT 1,
  cost_rate  NUMERIC(12, 2),
  user_id    UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE assignments (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id     UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  resource_id UUID NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
  units       NUMERIC(6, 2) NOT NULL DEFAULT 1,
  UNIQUE (task_id, resource_id)
);

CREATE INDEX assignments_resource_idx ON assignments (resource_id);

-- ── Baselines ───────────────────────────────────────────────────────────────

CREATE TABLE baselines (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id     UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name           TEXT NOT NULL,
  captured_at    DATE NOT NULL,
  captured_by    UUID REFERENCES users(id) ON DELETE SET NULL,
  project_start  DATE NOT NULL,
  project_finish DATE NOT NULL,
  -- Exactly one baseline per project is the plan of record that variance and
  -- the impact banner are measured against.
  is_active      BOOLEAN NOT NULL DEFAULT TRUE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX baselines_one_active_per_project
  ON baselines (project_id) WHERE is_active;

CREATE TABLE baseline_tasks (
  baseline_id   UUID NOT NULL REFERENCES baselines(id) ON DELETE CASCADE,
  task_id       UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  start_date    DATE NOT NULL,
  finish_date   DATE NOT NULL,
  duration_days INTEGER NOT NULL,
  calendar_id   UUID NOT NULL,
  PRIMARY KEY (baseline_id, task_id)
);

-- ── Change log ──────────────────────────────────────────────────────────────
--
-- The most valuable table in the schema for the sales demo: it is what turns
-- "the date moved" into "the date moved because of this, and it cost four days".

CREATE TABLE change_log (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id           UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  task_id              UUID REFERENCES tasks(id) ON DELETE SET NULL,
  actor_id             UUID REFERENCES users(id) ON DELETE SET NULL,
  action               TEXT NOT NULL,
  field                TEXT,
  old_value            TEXT,
  new_value            TEXT,
  -- Working days the project finish moved as a result of this change.
  impact_days          INTEGER NOT NULL DEFAULT 0,
  project_finish_before DATE,
  project_finish_after  DATE,
  -- The rendered sentence, stored so history reads the same as the live banner.
  summary              TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX change_log_project_idx ON change_log (project_id, created_at DESC);
CREATE INDEX change_log_impactful_idx ON change_log (project_id, created_at DESC)
  WHERE impact_days <> 0;

-- ── Usage ───────────────────────────────────────────────────────────────────

CREATE TABLE company_usage (
  company_id  UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  usage_type  TEXT NOT NULL,
  period      TEXT NOT NULL, -- YYYY-MM
  usage_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (company_id, usage_type, period)
);

CREATE TABLE billing_events (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  event_type      TEXT NOT NULL,
  stripe_event_id TEXT UNIQUE,
  data            JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
