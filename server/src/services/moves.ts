/**
 * What a drag on a Gantt bar actually means.
 *
 * This lives on the server because working-day arithmetic needs the project's
 * calendars — weekends, holidays, per-crew shifts — and the browser does not
 * have them. An earlier version guessed in the client and got it wrong the
 * moment a holiday appeared. The client's only job is to say "the user dropped
 * this edge on this date"; everything below decides what that means.
 *
 * The three gestures:
 *   move          slide the whole bar, duration unchanged
 *   resize-start  drag the left edge: start moves, finish stays, duration changes
 *   resize-end    drag the right edge: finish moves, start stays, duration changes
 *
 * And the rule that decides which fields to touch: **work with recorded actuals
 * is edited through its actuals, not through constraints.** Dragging a finished
 * task means "I logged the wrong dates", not "reschedule the plan" — no
 * constraint could move it anyway, because actuals override the plan.
 */

import type { PoolClient } from 'pg'
import { projectCalendars, solve, toDayIndex, fromDayIndex } from '../scheduler/index.js'
import type {
  ConstraintType,
  IsoDate,
  ScheduleInput,
  ScheduleResult,
  TaskInput,
} from '../scheduler/index.js'
import { loadScheduleInput } from './schedule.js'

export type MoveMode = 'move' | 'resize-start' | 'resize-end'

export interface MovePreview {
  allowed: boolean
  reason?: string
  /** The patch to PATCH if the user accepts. */
  patch?: Record<string, unknown>
  description?: string
  /** Other tasks whose dates this move would change. Empty means nothing follows. */
  affected?: string[]
  /**
   * Things that are legal but probably not what the user meant — chiefly a
   * recorded date that would contradict a successor's recorded date.
   */
  warnings?: string[]
  /** Earliest this task could start with its own constraint lifted. */
  earliestStart: IsoDate
  currentFinish: IsoDate
  hypotheticalFinish?: IsoDate
  schedule?: ScheduleResult
}

/**
 * Where this task would land with its own constraint removed — the floor the
 * dependency logic imposes. The UI shades everything left of it during a drag,
 * so "you cannot go there" is visible before the mouse is released rather than
 * being explained afterwards.
 */
export function unconstrainedStart(input: ScheduleInput, taskId: string): IsoDate {
  const relaxed: ScheduleInput = {
    ...input,
    tasks: input.tasks.map((t) =>
      t.id === taskId
        ? // Strip the manual constraint *and* the actuals: this answers "where
          // does the logic put it", which is the question a drag is asking.
          ({
            id: t.id,
            name: t.name,
            durationDays: t.durationDays,
            ...(t.calendarId ? { calendarId: t.calendarId } : {}),
            constraintType: 'ASAP' as const,
          } satisfies TaskInput)
        : t,
    ),
  }
  return solve(relaxed).tasks[taskId]!.earlyStart
}

export async function previewMove(
  client: PoolClient,
  projectId: string,
  taskId: string,
  mode: MoveMode,
  targetDate: IsoDate,
): Promise<MovePreview | null> {
  const input = await loadScheduleInput(client, projectId)
  const task = input.tasks.find((t) => t.id === taskId)
  if (!task) return null

  const current = solve(input)
  const scheduled = current.tasks[taskId]!
  const calendars = projectCalendars(input)
  const calendar = calendars.get(task.calendarId ?? input.defaultCalendarId)!
  const earliestStart = unconstrainedStart(input, taskId)

  const base = { earliestStart, currentFinish: current.projectFinish }
  const refuse = (reason: string): MovePreview => ({ allowed: false, reason, ...base })

  /** Working-day span between two inclusive dates, on this task's calendar. */
  const span = (from: IsoDate, to: IsoDate): number =>
    calendar.countWorkingDays(
      calendar.snapForward(toDayIndex(from)),
      calendar.snapForward(toDayIndex(to)),
    ) + 1

  const snapFwd = (d: IsoDate): IsoDate => fromDayIndex(calendar.snapForward(toDayIndex(d)))
  const snapBack = (d: IsoDate): IsoDate => fromDayIndex(calendar.snapBack(toDayIndex(d)))

  const isComplete = Boolean(task.actualFinish)
  const isStarted = Boolean(task.actualStart) && !isComplete
  const isMilestone = task.durationDays === 0

  let patch: Record<string, unknown>
  let description: string

  if (isMilestone && mode !== 'move') {
    return refuse(`“${task.name}” is a milestone — it has no duration to resize.`)
  }

  // ── Completed work: the drag edits the record, not the plan ───────────────
  if (isComplete) {
    const actualStart = task.actualStart ?? scheduled.earlyStart
    if (mode === 'resize-start') {
      const newStart = snapFwd(targetDate)
      if (newStart > task.actualFinish!) {
        return refuse(`“${task.name}” cannot have started after it finished.`)
      }
      patch = { actualStart: newStart }
      description = `correct the actual start of “${task.name}” to ${newStart}`
    } else if (mode === 'resize-end') {
      const newFinish = snapBack(targetDate)
      if (newFinish < actualStart) {
        return refuse(`“${task.name}” cannot have finished before it started.`)
      }
      patch = { actualFinish: newFinish, durationDays: span(actualStart, newFinish) }
      description = `correct the actual finish of “${task.name}” to ${newFinish}`
    } else {
      const newStart = snapFwd(targetDate)
      const length = span(actualStart, task.actualFinish!)
      const newFinish = fromDayIndex(
        calendar.addWorkingDays(calendar.snapForward(toDayIndex(newStart)), length - 1),
      )
      patch = { actualStart: newStart, actualFinish: newFinish }
      description = `move the recorded dates of “${task.name}” to ${newStart} – ${newFinish}`
    }
  }
  // ── Work under way: start is recorded, the remainder is forecast ──────────
  else if (isStarted) {
    if (mode === 'resize-end') {
      const newFinish = snapBack(targetDate)
      const resumeDay = input.dataDate
        ? Math.max(toDayIndex(input.dataDate), toDayIndex(task.actualStart!))
        : toDayIndex(task.actualStart!)
      const resume = calendar.snapForward(resumeDay)
      const remaining = calendar.countWorkingDays(resume, calendar.snapForward(toDayIndex(newFinish))) + 1
      if (remaining < 0) {
        return refuse(`“${task.name}” cannot be forecast to finish before the data date.`)
      }
      patch = { remainingDays: remaining }
      description = `set “${task.name}” to ${remaining} working ${remaining === 1 ? 'day' : 'days'} remaining`
    } else {
      const newStart = snapFwd(targetDate)
      patch = { actualStart: newStart }
      description = `correct the actual start of “${task.name}” to ${newStart}`
    }
  }
  // ── Not started: the plan is still a plan ─────────────────────────────────
  else {
    if (mode === 'resize-end') {
      const newFinish = snapBack(targetDate)
      if (newFinish < scheduled.earlyStart) {
        return refuse(`“${task.name}” must be at least one working day long.`)
      }
      patch = { durationDays: span(scheduled.earlyStart, newFinish) }
      description = `set “${task.name}” to ${patch.durationDays} working days`
    } else {
      const newStart = snapFwd(targetDate)

      if (newStart < earliestStart) {
        // The logic will not allow it, so refuse rather than writing a
        // constraint the solver would silently ignore.
        const blocker = drivingPredecessorName(input, current, taskId)
        return refuse(
          blocker
            ? `“${task.name}” cannot start before ${earliestStart} — it is waiting on “${blocker}”.`
            : `“${task.name}” cannot start before ${earliestStart}, the project start.`,
        )
      }

      const duration =
        mode === 'resize-start'
          ? span(newStart, scheduled.earlyFinish)
          : task.durationDays

      if (mode === 'resize-start' && newStart > scheduled.earlyFinish) {
        return refuse(`“${task.name}” must be at least one working day long.`)
      }

      // Landing exactly on the logic date means "no manual constraint", which
      // keeps the schedule free to move when predecessors do.
      const atFloor = newStart === earliestStart
      patch = {
        constraintType: atFloor ? 'ASAP' : 'START_NO_EARLIER_THAN',
        constraintDate: atFloor ? null : newStart,
        ...(mode === 'resize-start' ? { durationDays: duration } : {}),
      }
      description = atFloor
        ? `release “${task.name}” to start as soon as its predecessors allow`
        : mode === 'resize-start'
          ? `start “${task.name}” on ${newStart} (${duration} working days)`
          : `move “${task.name}” to start ${newStart}`
    }
  }

  // Solve the hypothetical so the banner reports a measured consequence rather
  // than a guess.
  const hypothetical = solve(applyPatch(input, taskId, patch))

  // Which *other* tasks actually move. "Nothing follows this" is a materially
  // different outcome from "the slack absorbed it", and conflating the two is
  // how a drag ends up looking broken: the bar lands somewhere odd, nothing
  // else shifts, and the banner cheerfully reports no impact.
  const affected = Object.values(hypothetical.tasks)
    .filter((t) => t.id !== taskId && t.earlyStart !== current.tasks[t.id]?.earlyStart)
    .map((t) => t.name)

  const warnings: string[] = []
  const movedTask = hypothetical.tasks[taskId]!

  if (isComplete || isStarted) {
    // Editing a record, not a plan. Successors that are themselves recorded
    // will not budge, and the user should know that before committing.
    const pinnedSuccessors = input.dependencies
      .filter((d) => d.predecessorId === taskId)
      .map((d) => input.tasks.find((t) => t.id === d.successorId))
      .filter((t): t is TaskInput => Boolean(t && (t.actualStart || t.actualFinish)))

    if (pinnedSuccessors.length > 0 && affected.length === 0) {
      const names = pinnedSuccessors.map((t) => `“${t.name}”`).join(', ')
      warnings.push(
        `Nothing else moves: ${names} ${pinnedSuccessors.length === 1 ? 'has' : 'have'} its own ` +
          `recorded dates, and recorded dates are facts rather than forecasts.`,
      )
    }

    // A recorded finish that lands after a successor's recorded start is not
    // illegal — it happened, or it was typed wrong — but it is worth saying.
    for (const t of pinnedSuccessors) {
      if (t.actualStart && movedTask.earlyFinish > t.actualStart) {
        warnings.push(
          `“${t.name}” is recorded as starting ${t.actualStart}, before this would finish ` +
            `(${movedTask.earlyFinish}).`,
        )
      }
    }
  } else if (affected.length === 0) {
    warnings.push('Nothing else moves — no task depends on this one.')
  }

  return {
    allowed: true,
    patch,
    description,
    affected,
    warnings,
    ...base,
    hypotheticalFinish: hypothetical.projectFinish,
    schedule: hypothetical,
  }
}

/** Overlay a patch onto the solver's input, mapping API names to engine names. */
function applyPatch(
  input: ScheduleInput,
  taskId: string,
  patch: Record<string, unknown>,
): ScheduleInput {
  return {
    ...input,
    tasks: input.tasks.map((t) => {
      if (t.id !== taskId) return t
      const next: TaskInput = { ...t }
      if ('durationDays' in patch) next.durationDays = Number(patch.durationDays)
      if ('constraintType' in patch) {
        const type = patch.constraintType as ConstraintType | undefined
        if (type) next.constraintType = type
        else delete next.constraintType
        const date = patch.constraintDate as string | null
        if (date) next.constraintDate = date
        else delete next.constraintDate
      }
      for (const key of ['actualStart', 'actualFinish'] as const) {
        if (key in patch) {
          const value = patch[key] as string | null
          if (value) next[key] = value
          else delete next[key]
        }
      }
      if ('remainingDays' in patch) next.remainingDays = Number(patch.remainingDays)
      return next
    }),
  }
}

function drivingPredecessorName(
  input: ScheduleInput,
  current: ScheduleResult,
  taskId: string,
): string | null {
  const predecessors = input.dependencies
    .filter((d) => d.successorId === taskId)
    .map((d) => current.tasks[d.predecessorId])
    .filter(Boolean)
  if (predecessors.length === 0) return null
  return predecessors.reduce((latest, t) => (t!.earlyFinish > latest!.earlyFinish ? t : latest))!.name
}
