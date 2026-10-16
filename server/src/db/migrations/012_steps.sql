-- Steps: the parts of a task, in order.
--
-- "Winterise the pool" is one bar on the chart, but it is really drain, blow
-- the lines, antifreeze, cover. Those belong to the task, happen in sequence
-- inside it, and should not crowd the chart until someone asks for them.
--
-- A separate table rather than `tasks.parent_id`, and that is the decision
-- everything else rests on. Steps carry no dependencies, so the solver never
-- needs to see one: `tasks` stays flat, the dependency network is unchanged,
-- and not a line of cpm.ts is touched. With a parent column every query
-- feeding the solver would need a filter, and one missed filter puts a step
-- into the critical path.

CREATE TABLE steps (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id       UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,

  -- Whole working days, the same integer-day rule the engine runs on.
  --
  -- Zero is meaningful rather than degenerate: a zero-day step is a checklist
  -- item. It gets a tick and no bar, and takes no time. A task whose steps are
  -- all zero keeps its own duration and gains a tick-list; a task whose steps
  -- have durations has its duration *made of* them.
  duration_days INTEGER NOT NULL DEFAULT 0 CHECK (duration_days >= 0),

  sort_order    INTEGER NOT NULL DEFAULT 0,

  -- Progress, which rolls up to the parent. A step is done when it has an
  -- actual finish; the parent's percentage is its steps weighted by duration,
  -- or counted when they are all zero.
  actual_start  DATE,
  actual_finish DATE,

  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT steps_finish_after_start
    CHECK (actual_finish IS NULL OR actual_start IS NULL OR actual_finish >= actual_start)
);

CREATE INDEX steps_task_idx ON steps (task_id, sort_order);

-- Templates carry steps too, keyed by the task's template key rather than an
-- id — a template outlives the project it came from.
CREATE TABLE template_steps (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id   UUID NOT NULL REFERENCES templates(id) ON DELETE CASCADE,
  task_key      TEXT NOT NULL,
  name          TEXT NOT NULL,
  duration_days INTEGER NOT NULL DEFAULT 0 CHECK (duration_days >= 0),
  sort_order    INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX template_steps_idx ON template_steps (template_id, task_key, sort_order);
