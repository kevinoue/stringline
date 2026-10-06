-- Project templates.
--
-- A template is the *shape* of a plan: tasks, durations, and the links between
-- them. It deliberately carries no actuals, no constraints and no dates —
-- those belong to a real project, not to a pattern.
--
-- Tasks are identified inside a template by a stable `key` rather than by a
-- uuid, so dependencies survive being copied and a template stays readable in
-- a diff.

CREATE TABLE templates (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- NULL means a built-in, available to every company.
  company_id  UUID REFERENCES companies(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  description TEXT,
  category    TEXT NOT NULL DEFAULT 'general',
  created_by  UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX templates_company_idx ON templates (company_id);
-- A company cannot have two templates of the same name; built-ins are unique
-- among themselves.
CREATE UNIQUE INDEX templates_unique_name
  ON templates (COALESCE(company_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(name));

CREATE TABLE template_tasks (
  template_id   UUID NOT NULL REFERENCES templates(id) ON DELETE CASCADE,
  key           TEXT NOT NULL,
  name          TEXT NOT NULL,
  duration_days INTEGER NOT NULL DEFAULT 1 CHECK (duration_days >= 0),
  phase_name    TEXT,
  sort_order    INTEGER NOT NULL DEFAULT 0,
  visibility    TEXT NOT NULL DEFAULT 'internal'
                  CHECK (visibility IN ('internal', 'client')),
  PRIMARY KEY (template_id, key)
);

CREATE TABLE template_dependencies (
  template_id     UUID NOT NULL REFERENCES templates(id) ON DELETE CASCADE,
  predecessor_key TEXT NOT NULL,
  successor_key   TEXT NOT NULL,
  type            TEXT NOT NULL DEFAULT 'FS' CHECK (type IN ('FS', 'SS', 'FF', 'SF')),
  lag_days        INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (template_id, predecessor_key, successor_key),
  CONSTRAINT template_dependencies_no_self_link CHECK (predecessor_key <> successor_key),
  FOREIGN KEY (template_id, predecessor_key)
    REFERENCES template_tasks (template_id, key) ON DELETE CASCADE,
  FOREIGN KEY (template_id, successor_key)
    REFERENCES template_tasks (template_id, key) ON DELETE CASCADE
);

-- Where a project came from, so "start from a template" is answerable later.
ALTER TABLE projects ADD COLUMN template_id UUID REFERENCES templates(id) ON DELETE SET NULL;
