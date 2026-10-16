-- Tag projects that were created before templates carried trades.
--
-- Migration 011 tagged the built-in *templates*. Projects already made from
-- those templates kept no trades at all, so a company whose only projects
-- predate that migration has an empty trade list, an empty colour picker, and
-- no way to understand why — the feature looks broken rather than unused.
--
-- Every project records the template it came from, and every template task has
-- a stable name, so the mapping is deterministic: match a project's tasks to
-- its template's tasks by name, and apply whatever trade the template now
-- carries.
--
-- Deliberately conservative:
--   * Only projects with a `template_id`. A hand-built project is nobody's
--     guess to make.
--   * Only tasks with no trade already. Anything someone has set by hand wins.
--   * Matched on exact name. A renamed task is left alone rather than guessed
--     at, because the cost of a wrong trade is a chart that lies quietly.

-- The trades themselves, per company, created only where a company actually
-- has a project that needs them. Colours are assigned in palette order, which
-- is what `nextColour` does for new ones.
WITH needed AS (
  SELECT DISTINCT p.company_id, tt.category_name
  FROM projects p
  JOIN template_tasks tt ON tt.template_id = p.template_id
  WHERE p.template_id IS NOT NULL
    AND tt.category_name IS NOT NULL
), ordered AS (
  SELECT company_id, category_name,
         ROW_NUMBER() OVER (PARTITION BY company_id ORDER BY category_name) - 1 AS seq
  FROM needed
)
INSERT INTO categories (company_id, kind, name, colour, sort_order)
SELECT o.company_id, 'trade', o.category_name,
       -- Same ten keys as services/palette.ts, in the same order. Kept in
       -- sync by hand; a wrong key would fall back to slate on the chart
       -- rather than breaking anything.
       (ARRAY['slate','teal','amber','violet','moss','clay','indigo','plum','olive','steel'])
         [(o.seq % 10) + 1],
       o.seq
FROM ordered o
ON CONFLICT (company_id, kind, name) DO NOTHING;

-- Then the tasks themselves.
UPDATE tasks t
SET category_id = c.id
FROM projects p
JOIN template_tasks tt ON tt.template_id = p.template_id
JOIN categories c ON c.company_id = p.company_id
                 AND c.kind = 'trade'
                 AND c.name = tt.category_name
WHERE t.project_id = p.id
  AND t.name = tt.name
  AND t.category_id IS NULL
  AND p.template_id IS NOT NULL;
