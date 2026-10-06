/**
 * Project templates — saving the shape of a plan, and starting from one.
 *
 * A template carries tasks, durations and the links between them. It carries
 * **no dates, no actuals and no constraints**: those are facts about one real
 * project, and copying them into the next one is how a "template" quietly
 * becomes a stale duplicate of last year's job.
 *
 * Tasks are keyed by a slug inside the template rather than by uuid, so the
 * dependency list survives copying and a template stays legible.
 */

import type { PoolClient } from 'pg'

export interface TemplateSummary {
  id: string
  name: string
  description: string | null
  category: string
  builtIn: boolean
  taskCount: number
  workingDays: number
}

export async function listTemplates(
  client: PoolClient,
  companyId: string,
): Promise<TemplateSummary[]> {
  const { rows } = await client.query<{
    id: string
    name: string
    description: string | null
    category: string
    company_id: string | null
    task_count: string
    working_days: string | null
  }>(
    `SELECT t.id, t.name, t.description, t.category, t.company_id,
            COUNT(tt.key)               AS task_count,
            SUM(tt.duration_days)       AS working_days
     FROM templates t
     LEFT JOIN template_tasks tt ON tt.template_id = t.id
     WHERE t.company_id IS NULL OR t.company_id = $1
     GROUP BY t.id
     ORDER BY (t.company_id IS NULL) DESC, t.category, t.name`,
    [companyId],
  )
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    description: r.description,
    category: r.category,
    builtIn: r.company_id === null,
    taskCount: Number(r.task_count),
    workingDays: Number(r.working_days ?? 0),
  }))
}

/**
 * Freeze a project's structure as a reusable template.
 *
 * Durations come from the *original* planned duration, not from how long the
 * work actually took — a template should carry the estimate the team plans
 * with, and letting one bad job rewrite it is how estimates drift.
 */
export async function saveProjectAsTemplate(
  client: PoolClient,
  projectId: string,
  companyId: string,
  userId: string,
  name: string,
  description: string | null,
  category: string,
): Promise<string> {
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO templates (company_id, name, description, category, created_by)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [companyId, name, description, category, userId],
  )
  const templateId = inserted.rows[0]!.id

  // Keys are derived from the task id so they are unique and stable; the name
  // is not safe to key on, because duplicates are legal and common.
  await client.query(
    `INSERT INTO template_tasks (template_id, key, name, duration_days, phase_name, sort_order, visibility)
     SELECT $1, 't_' || REPLACE(t.id::text, '-', ''), t.name, t.duration_days,
            p.name, t.sort_order, t.visibility
     FROM tasks t
     LEFT JOIN phases p ON p.id = t.phase_id
     WHERE t.project_id = $2`,
    [templateId, projectId],
  )

  await client.query(
    `INSERT INTO template_dependencies (template_id, predecessor_key, successor_key, type, lag_days)
     SELECT $1,
            't_' || REPLACE(d.predecessor_id::text, '-', ''),
            't_' || REPLACE(d.successor_id::text, '-', ''),
            d.type, d.lag_days
     FROM dependencies d
     WHERE d.project_id = $2`,
    [templateId, projectId],
  )

  return templateId
}

export interface InstantiateResult {
  projectId: string
  taskCount: number
}

/**
 * Create a project from a template.
 *
 * Phases named in the template are recreated as real phases, so the structure
 * survives the copy rather than flattening into a task list.
 */
export async function createProjectFromTemplate(
  client: PoolClient,
  templateId: string,
  companyId: string,
  name: string,
  startDate: string,
  deadline: string | null,
): Promise<InstantiateResult | null> {
  const template = await client.query<{ id: string }>(
    `SELECT id FROM templates WHERE id = $1 AND (company_id IS NULL OR company_id = $2)`,
    [templateId, companyId],
  )
  if (template.rows.length === 0) return null

  const calendar = await client.query<{ id: string }>(
    `SELECT id FROM calendars WHERE company_id = $1 ORDER BY is_default DESC LIMIT 1`,
    [companyId],
  )
  if (calendar.rows.length === 0) return null

  const project = await client.query<{ id: string }>(
    `INSERT INTO projects (company_id, name, calendar_id, start_date, deadline, template_id)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [companyId, name, calendar.rows[0]!.id, startDate, deadline, templateId],
  )
  const projectId = project.rows[0]!.id

  const templateTasks = await client.query<{
    key: string
    name: string
    duration_days: number
    phase_name: string | null
    sort_order: number
    visibility: string
  }>(
    `SELECT key, name, duration_days, phase_name, sort_order, visibility
     FROM template_tasks WHERE template_id = $1 ORDER BY sort_order`,
    [templateId],
  )

  // Recreate phases first, preserving the order they appear in the template.
  const phaseIds = new Map<string, string>()
  const phaseNames: string[] = []
  for (const t of templateTasks.rows) {
    if (t.phase_name && !phaseNames.includes(t.phase_name)) phaseNames.push(t.phase_name)
  }
  for (const [index, phaseName] of phaseNames.entries()) {
    const row = await client.query<{ id: string }>(
      `INSERT INTO phases (project_id, name, sort_order) VALUES ($1, $2, $3) RETURNING id`,
      [projectId, phaseName, index * 10],
    )
    phaseIds.set(phaseName, row.rows[0]!.id)
  }

  // Inserted one at a time, deliberately. A bulk insert would be faster, but
  // Postgres does not guarantee that `RETURNING` comes back in the order the
  // rows went in, so pairing new ids to template keys by position would be
  // relying on undefined behaviour — and a mispaired key silently builds the
  // dependency graph between the wrong tasks. Templates run to a few dozen
  // rows once, so the round trips cost nothing worth having that risk for.
  const keyToId = new Map<string, string>()
  for (const t of templateTasks.rows) {
    const row = await client.query<{ id: string }>(
      `INSERT INTO tasks (project_id, phase_id, name, duration_days, sort_order, visibility)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [
        projectId,
        t.phase_name ? phaseIds.get(t.phase_name)! : null,
        t.name,
        t.duration_days,
        t.sort_order,
        t.visibility,
      ],
    )
    keyToId.set(t.key, row.rows[0]!.id)
  }

  const links = await client.query<{
    predecessor_key: string
    successor_key: string
    type: string
    lag_days: number
  }>(
    `SELECT predecessor_key, successor_key, type, lag_days
     FROM template_dependencies WHERE template_id = $1`,
    [templateId],
  )
  const usable = links.rows.filter(
    (l) => keyToId.has(l.predecessor_key) && keyToId.has(l.successor_key),
  )
  if (usable.length > 0) {
    await client.query(
      `INSERT INTO dependencies (project_id, predecessor_id, successor_id, type, lag_days)
       SELECT $1, v.pred, v.succ, v.type, v.lag
       FROM unnest($2::uuid[], $3::uuid[], $4::text[], $5::int[]) AS v(pred, succ, type, lag)`,
      [
        projectId,
        usable.map((l) => keyToId.get(l.predecessor_key)!),
        usable.map((l) => keyToId.get(l.successor_key)!),
        usable.map((l) => l.type),
        usable.map((l) => l.lag_days),
      ],
    )
  }

  return { projectId, taskCount: templateTasks.rows.length }
}

export async function deleteTemplate(
  client: PoolClient,
  templateId: string,
  companyId: string,
): Promise<boolean> {
  // Built-ins have a NULL company_id, so this can never delete one.
  const { rowCount } = await client.query(
    'DELETE FROM templates WHERE id = $1 AND company_id = $2',
    [templateId, companyId],
  )
  return (rowCount ?? 0) > 0
}
