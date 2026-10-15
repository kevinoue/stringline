-- Categories: who a task belongs to.
--
-- Phases answer *when* in the job. This answers *who* — the trade on a
-- construction site, the department in a hotel. They cut across each other:
-- the same sparky appears in first fix and again in finishes, and the same
-- maintenance team appears in wind-down and again at handover.
--
-- Company-scoped rather than project-scoped, which is the real difference from
-- phases. Phases are the stages of one job. Your trades are your trades across
-- every job, so they are defined once.

CREATE TABLE categories (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,

  -- Which axis this belongs to. Everything is 'trade' today. A second axis —
  -- area, level, wing — is rows with kind='area' plus one nullable column on
  -- tasks, rather than a second table and a migration of this one.
  kind        TEXT NOT NULL DEFAULT 'trade' CHECK (kind IN ('trade', 'area')),

  name        TEXT NOT NULL,
  description TEXT,

  -- A key into a fixed palette, never a free hex value. That keeps colours
  -- printable, keeps them distinguishable to the roughly 8% of men with
  -- colour-vision deficiency, and stops anyone choosing pale yellow on white.
  --
  -- The palette has no red in it: the critical path owns red, and a feature
  -- that quietly breaks the chart's one rule is not worth having.
  colour      TEXT NOT NULL DEFAULT 'slate',

  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (company_id, kind, name)
);

CREATE INDEX categories_company_idx ON categories (company_id, kind);

-- SET NULL, the same rule phases follow: deleting a label must never delete
-- the work that carries it.
ALTER TABLE tasks ADD COLUMN category_id UUID REFERENCES categories(id) ON DELETE SET NULL;

CREATE INDEX tasks_category_idx ON tasks (category_id) WHERE category_id IS NOT NULL;

-- Templates carry a name rather than an id, exactly as they do for phases —
-- a template belongs to no company until it is used, and built-in templates
-- belong to none at all.
ALTER TABLE template_tasks ADD COLUMN category_name TEXT;

-- What this dimension is called in the UI. A hotel says "Department", a
-- contractor says "Trade", and neither word works in the other's world. The
-- machinery is the same, so the word is configurable rather than argued over.
ALTER TABLE companies ADD COLUMN category_label TEXT NOT NULL DEFAULT 'Trade';
