/**
 * The bridge between stored rows and the pure scheduling engine.
 *
 * The engine takes no database, so this module is the only place that knows
 * both. It loads a project into a `ScheduleInput`, runs `solve()`, writes the
 * computed dates back onto the task rows, and — the part that matters — turns
 * every schedule-affecting write into a sentence explaining what it cost.
 *
 * `applyAndExplain` is the shape every mutating route uses. It measures the
 * project finish before and after, so the impact banner is a real measurement
 * rather than a guess, and records the result in `change_log`.
 */

import type { PoolClient } from 'pg'
import {
  captureBaseline,
  diffAgainstBaseline,
  explainImpact,
  projectCalendars,
  solve,
  toDayIndex,
  type Baseline,
  type ConstraintType,
  type ImpactExplanation,
  type ScheduleInput,
  type ScheduleResult,
} from '../scheduler/index.js'

export interface ScheduleChange {
  result: ScheduleResult
  /** Present whenever an active baseline exists to measure against. */
  impact: ImpactExplanation | null
  /** Working days the project finish moved. Negative means it came in. */
  finishMovedDays: number
  finishBefore: string | null
  finishAfter: string
}

// ── Loading ──────────────────────────────────────────────────────────────────

interface ProjectRow {
  id: string
  company_id: string
  name: string
  calendar_id: string
  start_date: string
  deadline: string | null
  data_date: string | null
  out_of_sequence: 'retained' | 'progress-override'
}

/**
 * Assemble a project's `ScheduleInput`.
 *
 * Date columns are cast to `text` in these queries rather than relying on the
 * driver. `pool.ts` already forces DATE to come back as a string, and the cast
 * makes the same guarantee for the array columns, whose element parser is
 * registered separately and would otherwise still produce `Date` objects.
 */
export async function loadScheduleInput(
  client: PoolClient,
  projectId: string,
): Promise<ScheduleInput> {
  const projectResult = await client.query<ProjectRow>(
    `SELECT id, company_id, name, calendar_id,
            start_date::text AS start_date,
            deadline::text   AS deadline,
            data_date::text  AS data_date,
            out_of_sequence
     FROM projects WHERE id = $1`,
    [projectId],
  )
  const project = projectResult.rows[0]
  if (!project) throw new Error(`Project ${projectId} not found`)

  const calendars = await client.query<{
    id: string
    name: string
    working_weekdays: number[]
    holidays: string[]
    working_exceptions: string[]
  }>(
    `SELECT id, name, working_weekdays,
            holidays::text[]           AS holidays,
            working_exceptions::text[] AS working_exceptions
     FROM calendars WHERE company_id = $1`,
    [project.company_id],
  )

  const tasks = await client.query<{
    id: string
    name: string
    duration_days: number
    calendar_id: string | null
    constraint_type: string
    constraint_date: string | null
    actual_start: string | null
    actual_finish: string | null
    percent_complete: number | null
    remaining_days: number | null
  }>(
    `SELECT id, name, duration_days, calendar_id, constraint_type,
            constraint_date::text AS constraint_date,
            actual_start::text    AS actual_start,
            actual_finish::text   AS actual_finish,
            percent_complete, remaining_days
     FROM tasks WHERE project_id = $1 ORDER BY sort_order, created_at`,
    [projectId],
  )

  const dependencies = await client.query<{
    predecessor_id: string
    successor_id: string
    type: 'FS' | 'SS' | 'FF' | 'SF'
    lag_days: number
  }>(
    `SELECT predecessor_id, successor_id, type, lag_days
     FROM dependencies WHERE project_id = $1`,
    [projectId],
  )

  return {
    projectStart: project.start_date,
    defaultCalendarId: project.calendar_id,
    outOfSequence: project.out_of_sequence,
    ...(project.deadline ? { projectDeadline: project.deadline } : {}),
    ...(project.data_date ? { dataDate: project.data_date } : {}),
    calendars: calendars.rows.map((c) => ({
      id: c.id,
      name: c.name,
      workingWeekdays: c.working_weekdays,
      holidays: c.holidays,
      workingExceptions: c.working_exceptions,
    })),
    tasks: tasks.rows.map((t) => ({
      id: t.id,
      name: t.name,
      durationDays: t.duration_days,
      ...(t.calendar_id ? { calendarId: t.calendar_id } : {}),
      // The column is NOT NULL with a CHECK constraint, so this is always one of
      // the four valid values — never undefined.
      constraintType: t.constraint_type as ConstraintType,
      ...(t.constraint_date ? { constraintDate: t.constraint_date } : {}),
      ...(t.actual_start ? { actualStart: t.actual_start } : {}),
      ...(t.actual_finish ? { actualFinish: t.actual_finish } : {}),
      ...(t.percent_complete !== null ? { percentComplete: t.percent_complete } : {}),
      ...(t.remaining_days !== null ? { remainingDays: t.remaining_days } : {}),
    })),
    dependencies: dependencies.rows.map((d) => ({
      predecessorId: d.predecessor_id,
      successorId: d.successor_id,
      type: d.type,
      lagDays: d.lag_days,
    })),
  }
}

// ── Persisting ───────────────────────────────────────────────────────────────

/**
 * Write the solver's output onto the task rows in a single statement.
 *
 * `unnest` over parallel arrays keeps this to one round trip regardless of task
 * count — a 10,000-task project is one query, not 10,000. These columns are
 * cache: the engine is their only writer, and nothing reads them to make a
 * scheduling decision.
 */
export async function persistComputed(
  client: PoolClient,
  projectId: string,
  result: ScheduleResult,
): Promise<void> {
  const rows = Object.values(result.tasks)
  if (rows.length > 0) {
    await client.query(
      `UPDATE tasks AS t SET
         computed_early_start  = v.early_start,
         computed_early_finish = v.early_finish,
         computed_late_start   = v.late_start,
         computed_late_finish  = v.late_finish,
         computed_total_float  = v.total_float,
         computed_free_float   = v.free_float,
         computed_is_critical  = v.is_critical,
         computed_status       = v.status,
         computed_remaining    = v.remaining
       FROM unnest(
         $1::uuid[], $2::date[], $3::date[], $4::date[], $5::date[],
         $6::int[], $7::int[], $8::boolean[], $9::text[], $10::int[]
       ) AS v(id, early_start, early_finish, late_start, late_finish,
              total_float, free_float, is_critical, status, remaining)
       WHERE t.id = v.id`,
      [
        rows.map((t) => t.id),
        rows.map((t) => t.earlyStart),
        rows.map((t) => t.earlyFinish),
        rows.map((t) => t.lateStart),
        rows.map((t) => t.lateFinish),
        rows.map((t) => t.totalFloat),
        rows.map((t) => t.freeFloat),
        rows.map((t) => t.isCritical),
        rows.map((t) => t.status),
        rows.map((t) => t.remainingDays),
      ],
    )
  }

  await client.query(
    `UPDATE projects SET computed_finish = $2, computed_at = NOW(), updated_at = NOW()
     WHERE id = $1`,
    [projectId, result.projectFinish],
  )
}

/** Solve a project and cache the result. Returns the fresh schedule. */
export async function resolveProject(
  client: PoolClient,
  projectId: string,
): Promise<ScheduleResult> {
  const result = solve(await loadScheduleInput(client, projectId))
  await persistComputed(client, projectId, result)
  return result
}

// ── Baselines ────────────────────────────────────────────────────────────────

export async function loadActiveBaseline(
  client: PoolClient,
  projectId: string,
): Promise<Baseline | null> {
  const head = await client.query<{
    id: string
    name: string
    captured_at: string
    project_start: string
    project_finish: string
  }>(
    `SELECT id, name, captured_at::text AS captured_at,
            project_start::text AS project_start, project_finish::text AS project_finish
     FROM baselines WHERE project_id = $1 AND is_active`,
    [projectId],
  )
  const row = head.rows[0]
  if (!row) return null

  const tasks = await client.query<{
    task_id: string
    name: string
    start_date: string
    finish_date: string
    duration_days: number
    calendar_id: string
  }>(
    `SELECT task_id, name, start_date::text AS start_date,
            finish_date::text AS finish_date, duration_days, calendar_id
     FROM baseline_tasks WHERE baseline_id = $1`,
    [row.id],
  )

  return {
    name: row.name,
    capturedAt: row.captured_at,
    projectStart: row.project_start,
    projectFinish: row.project_finish,
    tasks: Object.fromEntries(
      tasks.rows.map((t) => [
        t.task_id,
        {
          taskId: t.task_id,
          name: t.name,
          start: t.start_date,
          finish: t.finish_date,
          durationDays: t.duration_days,
          calendarId: t.calendar_id,
        },
      ]),
    ),
  }
}

/** Freeze the current schedule as the plan of record, retiring any previous one. */
export async function storeBaseline(
  client: PoolClient,
  projectId: string,
  name: string,
  capturedBy: string | null,
): Promise<Baseline> {
  const input = await loadScheduleInput(client, projectId)
  const result = solve(input)
  const today = new Date().toISOString().slice(0, 10)
  const baseline = captureBaseline(name, today, result, input)

  // Only one baseline is the plan of record; a partial unique index enforces it,
  // so the old one has to be retired in the same transaction.
  await client.query(
    `UPDATE baselines SET is_active = FALSE WHERE project_id = $1 AND is_active`,
    [projectId],
  )

  const inserted = await client.query<{ id: string }>(
    `INSERT INTO baselines (project_id, name, captured_at, captured_by, project_start, project_finish, is_active)
     VALUES ($1, $2, $3, $4, $5, $6, TRUE) RETURNING id`,
    [projectId, name, today, capturedBy, baseline.projectStart, baseline.projectFinish],
  )
  const baselineId = inserted.rows[0]!.id

  const tasks = Object.values(baseline.tasks)
  if (tasks.length > 0) {
    await client.query(
      `INSERT INTO baseline_tasks (baseline_id, task_id, name, start_date, finish_date, duration_days, calendar_id)
       SELECT $1, v.task_id, v.name, v.start_date, v.finish_date, v.duration_days, v.calendar_id
       FROM unnest($2::uuid[], $3::text[], $4::date[], $5::date[], $6::int[], $7::uuid[])
         AS v(task_id, name, start_date, finish_date, duration_days, calendar_id)`,
      [
        baselineId,
        tasks.map((t) => t.taskId),
        tasks.map((t) => t.name),
        tasks.map((t) => t.start),
        tasks.map((t) => t.finish),
        tasks.map((t) => t.durationDays),
        tasks.map((t) => t.calendarId),
      ],
    )
  }

  await persistComputed(client, projectId, result)
  return baseline
}

// ── The mutation wrapper every schedule-affecting route uses ─────────────────

export interface ChangeContext {
  projectId: string
  actorId: string | null
  action: string
  field?: string
  oldValue?: string | null
  newValue?: string | null
  taskId?: string | null
}

/**
 * Run a mutation, re-solve, and explain what it cost.
 *
 * The finish date is measured before and after rather than inferred, so the
 * banner reports what actually happened. When an active baseline exists the
 * explanation names the root cause; without one it still reports the movement,
 * because "your change moved the finish four days" is worth saying even before
 * anyone has baselined anything.
 */
export async function applyAndExplain(
  client: PoolClient,
  context: ChangeContext,
  mutate: () => Promise<void>,
): Promise<ScheduleChange> {
  const before = await client.query<{ computed_finish: string | null }>(
    'SELECT computed_finish::text AS computed_finish FROM projects WHERE id = $1',
    [context.projectId],
  )
  const finishBefore = before.rows[0]?.computed_finish ?? null

  await mutate()

  const input = await loadScheduleInput(client, context.projectId)
  const result = solve(input)
  await persistComputed(client, context.projectId, result)

  const baseline = await loadActiveBaseline(client, context.projectId)
  let impact: ImpactExplanation | null = null
  if (baseline) {
    impact = explainImpact(diffAgainstBaseline(baseline, result, input), input)
  }

  const finishMovedDays = finishBefore
    ? workingDaysBetween(input, finishBefore, result.projectFinish)
    : 0

  await client.query(
    `INSERT INTO change_log
       (project_id, task_id, actor_id, action, field, old_value, new_value,
        impact_days, project_finish_before, project_finish_after, summary)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      context.projectId,
      context.taskId ?? null,
      context.actorId,
      context.action,
      context.field ?? null,
      context.oldValue ?? null,
      context.newValue ?? null,
      finishMovedDays,
      finishBefore,
      result.projectFinish,
      impact?.summary ?? null,
    ],
  )

  return {
    result,
    impact,
    finishMovedDays,
    finishBefore,
    finishAfter: result.projectFinish,
  }
}

/**
 * Working days between two dates on the project's default calendar. Reuses the
 * engine's calendar rather than counting days here, so a weekend never shows up
 * as slippage.
 */
function workingDaysBetween(input: ScheduleInput, from: string, to: string): number {
  const calendar = projectCalendars(input).get(input.defaultCalendarId)
  if (!calendar) return 0
  return calendar.countWorkingDays(
    calendar.snapForward(toDayIndex(from)),
    calendar.snapForward(toDayIndex(to)),
  )
}
