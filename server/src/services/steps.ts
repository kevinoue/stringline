/**
 * Steps — the parts of a task, in order.
 *
 * Steps never reach the solver. They have no dependencies and no constraints,
 * so everything about them is derived from the task they belong to: their
 * dates follow its start, their durations make up its duration, and their
 * progress rolls up into its percentage.
 *
 * That containment is the whole design. The scheduling engine is the one place
 * where a silent wrong answer poisons everything above it, and this feature
 * does not go near it.
 */

import type { PoolClient } from 'pg'
import type { WorkCalendar } from '../scheduler/calendar.js'
import { fromDayIndex, toDayIndex } from '../scheduler/dates.js'

export interface StepRow {
  id: string
  task_id: string
  name: string
  duration_days: number
  sort_order: number
  actual_start: string | null
  actual_finish: string | null
}

export interface SequencedStep {
  id: string
  taskId: string
  name: string
  durationDays: number
  sortOrder: number
  /** First working day. Equal to `finish` for a zero-day checklist item. */
  start: string
  /** Last working day, inclusive — what a bar's right edge shows. */
  finish: string
  /** True for a zero-day step: a tick, not a bar. */
  isCheck: boolean
  status: 'not-started' | 'in-progress' | 'complete'
  actualStart: string | null
  actualFinish: string | null
}

/**
 * Lay a task's steps out along its own calendar, starting where it starts.
 *
 * Sequential by construction — step n begins where step n−1 left off. A
 * zero-day step consumes nothing and sits at the cursor, so a checklist of
 * them all lands on the task's first day rather than marching across it.
 */
export function sequenceSteps(
  calendar: WorkCalendar,
  taskStart: string,
  steps: StepRow[],
): SequencedStep[] {
  let cursor = calendar.snapForward(toDayIndex(taskStart))

  return steps.map((step) => {
    const start = cursor
    // Inclusive finish: a one-day step starts and finishes on the same day.
    // Deriving it as start + duration would report every step a day long.
    const finish = step.duration_days === 0 ? start : calendar.addWorkingDays(start, step.duration_days - 1)
    if (step.duration_days > 0) cursor = calendar.addWorkingDays(finish, 1)

    return {
      id: step.id,
      taskId: step.task_id,
      name: step.name,
      durationDays: step.duration_days,
      sortOrder: step.sort_order,
      start: fromDayIndex(start),
      finish: fromDayIndex(finish),
      isCheck: step.duration_days === 0,
      status: step.actual_finish ? 'complete' : step.actual_start ? 'in-progress' : 'not-started',
      actualStart: step.actual_start,
      actualFinish: step.actual_finish,
    }
  })
}

/**
 * What a task's duration becomes once it has steps.
 *
 * `null` means "leave the task's own duration alone", which is the answer
 * whenever the steps are all zero-day checks. A checklist describes how the
 * work is done, not how long it takes — and overwriting a two-day task with
 * zero because someone added four tick-boxes would be a nasty surprise.
 */
export function derivedDuration(steps: Array<{ duration_days: number }>): number | null {
  const total = steps.reduce((sum, s) => sum + s.duration_days, 0)
  return total > 0 ? total : null
}

/**
 * How far through a task its steps have got.
 *
 * Weighted by duration, so a five-day step counts for more than a one-day one.
 * When every step is a zero-day check they weigh the same, and it falls back
 * to counting — which is what a tick-list means.
 */
export function rolledUpProgress(
  steps: Array<{ duration_days: number; actual_start: string | null; actual_finish: string | null }>,
): number | null {
  if (steps.length === 0) return null

  const weighted = steps.some((s) => s.duration_days > 0)
  const weight = (s: { duration_days: number }): number => (weighted ? s.duration_days : 1)

  const total = steps.reduce((sum, s) => sum + weight(s), 0)
  if (total === 0) return null

  const done = steps.reduce((sum, s) => {
    if (s.actual_finish) return sum + weight(s)
    // A started step counts half. Precise enough to be useful, vague enough
    // not to pretend we know more than "someone is on it".
    if (s.actual_start) return sum + weight(s) / 2
    return sum
  }, 0)

  return Math.round((done / total) * 100)
}

/**
 * Push a task's derived figures back onto the task row.
 *
 * Stored rather than computed on read, so templates, baselines and the solver
 * keep seeing an ordinary task with an ordinary duration and know nothing
 * about steps.
 *
 * Note the asymmetry with `derivedDuration` returning null: duration is only
 * ever written when the steps actually add up to something. A task whose
 * steps are later all zeroed keeps whatever duration they last gave it, which
 * is the last thing anyone actually said about how long it takes.
 */
export async function syncTaskFromSteps(client: PoolClient, taskId: string): Promise<void> {
  const { rows: steps } = await client.query<{
    duration_days: number
    actual_start: string | null
    actual_finish: string | null
  }>(
    `SELECT duration_days, actual_start::text AS actual_start, actual_finish::text AS actual_finish
       FROM steps WHERE task_id = $1 ORDER BY sort_order`,
    [taskId],
  )

  if (steps.length === 0) {
    // The last step is gone: the task is an ordinary task again, and its
    // actuals are its own to set.
    await client.query('UPDATE tasks SET updated_at = NOW() WHERE id = $1', [taskId])
    return
  }

  const duration = derivedDuration(steps)
  const percent = rolledUpProgress(steps)

  // Actuals roll up too: a task is under way once any step is, and finished
  // only when every step is. Anything looser lets a task report itself
  // complete with work still listed inside it.
  const starts = steps.map((s) => s.actual_start).filter((d): d is string => d !== null).sort()
  const finishes = steps.map((s) => s.actual_finish).filter((d): d is string => d !== null).sort()
  const allDone = finishes.length === steps.length

  await client.query(
    `UPDATE tasks
        SET duration_days    = COALESCE($2, duration_days),
            percent_complete = $3,
            actual_start     = $4,
            actual_finish    = $5,
            updated_at       = NOW()
      WHERE id = $1`,
    [
      taskId,
      duration,
      percent,
      starts[0] ?? null,
      allDone ? finishes[finishes.length - 1] : null,
    ],
  )
}

/** Every step on a project, ready to be sequenced against solved task dates. */
export async function loadProjectSteps(
  client: PoolClient,
  projectId: string,
): Promise<Map<string, StepRow[]>> {
  const { rows } = await client.query<StepRow>(
    `SELECT s.id, s.task_id, s.name, s.duration_days, s.sort_order,
            s.actual_start::text  AS actual_start,
            s.actual_finish::text AS actual_finish
       FROM steps s JOIN tasks t ON t.id = s.task_id
      WHERE t.project_id = $1
      ORDER BY s.task_id, s.sort_order`,
    [projectId],
  )

  const byTask = new Map<string, StepRow[]>()
  for (const row of rows) {
    const list = byTask.get(row.task_id)
    if (list) list.push(row)
    else byTask.set(row.task_id, [row])
  }
  return byTask
}
