/**
 * Baselines: what you said would happen, frozen, so that what actually happened
 * can be measured against it.
 *
 * A baseline is the schedule's stringline: the line the work is meant to
 * follow, and the thing that makes drift visible the moment it appears. Every
 * Gantt tool can draw a schedule; the ones teams abandon are the ones where the
 * plan quietly becomes fiction because nothing ever compares it to reality. A
 * baseline is cheap to capture and is the only thing that makes slippage
 * visible.
 *
 * Variance is always measured in **working days**, never calendar days. A task
 * that finishes Monday instead of Friday slipped one day, not three.
 */

import type { WorkCalendar } from './calendar.js'
import { projectCalendars } from './cpm.js'
import { toDayIndex } from './dates.js'
import type { IsoDate, ScheduleInput, ScheduleResult, TaskStatus } from './types.js'

export interface BaselineTask {
  taskId: string
  name: string
  start: IsoDate
  /** Inclusive. */
  finish: IsoDate
  durationDays: number
  calendarId: string
}

export interface Baseline {
  name: string
  capturedAt: IsoDate
  projectStart: IsoDate
  projectFinish: IsoDate
  tasks: Record<string, BaselineTask>
}

export interface TaskVariance {
  taskId: string
  name: string
  baselineStart: IsoDate | null
  baselineFinish: IsoDate | null
  currentStart: IsoDate | null
  currentFinish: IsoDate | null
  /** Positive means later than baseline. */
  startVarianceDays: number
  finishVarianceDays: number
  durationVarianceDays: number
  /** Added since the baseline was captured. */
  isNew: boolean
  /** Present in the baseline but no longer in the schedule. */
  isRemoved: boolean
  isCritical: boolean
  totalFloat: number
  /** `null` for a task that has been removed since the baseline. */
  status: TaskStatus | null
}

export interface ScheduleVariance {
  baselineName: string
  baselineProjectFinish: IsoDate
  currentProjectFinish: IsoDate
  /** Positive means the project finishes later than baselined. */
  projectFinishVarianceDays: number
  /** Every task whose dates, duration, or existence changed. */
  changed: TaskVariance[]
  /** Subset of `changed` that finishes later than baselined, worst first. */
  slipped: TaskVariance[]
  /** Subset of `changed` that finishes earlier than baselined, best first. */
  gained: TaskVariance[]
}

/** Freeze the current schedule as the plan of record. */
export function captureBaseline(
  name: string,
  capturedAt: IsoDate,
  result: ScheduleResult,
  input: ScheduleInput,
): Baseline {
  const calendarOf = new Map(input.tasks.map((t) => [t.id, t.calendarId ?? input.defaultCalendarId]))
  const tasks: Record<string, BaselineTask> = {}

  for (const task of Object.values(result.tasks)) {
    tasks[task.id] = {
      taskId: task.id,
      name: task.name,
      start: task.earlyStart,
      finish: task.earlyFinish,
      durationDays: task.durationDays,
      calendarId: calendarOf.get(task.id) ?? input.defaultCalendarId,
    }
  }

  return {
    name,
    capturedAt,
    projectStart: result.projectStart,
    projectFinish: result.projectFinish,
    tasks,
  }
}

/** Compare a live schedule against a captured baseline. */
export function diffAgainstBaseline(
  baseline: Baseline,
  result: ScheduleResult,
  input: ScheduleInput,
): ScheduleVariance {
  const calendars = projectCalendars(input)
  const defaultCalendar = calendars.get(input.defaultCalendarId)
  if (!defaultCalendar) {
    throw new Error(`defaultCalendarId "${input.defaultCalendarId}" is not among the calendars`)
  }

  const changed: TaskVariance[] = []
  const seen = new Set<string>()

  for (const task of Object.values(result.tasks)) {
    seen.add(task.id)
    const before = baseline.tasks[task.id]
    const calendar =
      calendars.get(before?.calendarId ?? input.defaultCalendarId) ?? defaultCalendar

    if (!before) {
      changed.push({
        taskId: task.id,
        name: task.name,
        baselineStart: null,
        baselineFinish: null,
        currentStart: task.earlyStart,
        currentFinish: task.earlyFinish,
        startVarianceDays: 0,
        finishVarianceDays: 0,
        durationVarianceDays: task.durationDays,
        isNew: true,
        isRemoved: false,
        isCritical: task.isCritical,
        totalFloat: task.totalFloat,
        status: task.status,
      })
      continue
    }

    const startVariance = workingDaysBetween(calendar, before.start, task.earlyStart)
    const finishVariance = workingDaysBetween(calendar, before.finish, task.earlyFinish)
    const durationVariance = task.durationDays - before.durationDays

    if (startVariance === 0 && finishVariance === 0 && durationVariance === 0) continue

    changed.push({
      taskId: task.id,
      name: task.name,
      baselineStart: before.start,
      baselineFinish: before.finish,
      currentStart: task.earlyStart,
      currentFinish: task.earlyFinish,
      startVarianceDays: startVariance,
      finishVarianceDays: finishVariance,
      durationVarianceDays: durationVariance,
      isNew: false,
      isRemoved: false,
      isCritical: task.isCritical,
      totalFloat: task.totalFloat,
      status: task.status,
    })
  }

  for (const before of Object.values(baseline.tasks)) {
    if (seen.has(before.taskId)) continue
    changed.push({
      taskId: before.taskId,
      name: before.name,
      baselineStart: before.start,
      baselineFinish: before.finish,
      currentStart: null,
      currentFinish: null,
      startVarianceDays: 0,
      finishVarianceDays: 0,
      durationVarianceDays: -before.durationDays,
      isNew: false,
      isRemoved: true,
      isCritical: false,
      totalFloat: 0,
      status: null,
    })
  }

  const projectFinishVariance = workingDaysBetween(
    defaultCalendar,
    baseline.projectFinish,
    result.projectFinish,
  )

  return {
    baselineName: baseline.name,
    baselineProjectFinish: baseline.projectFinish,
    currentProjectFinish: result.projectFinish,
    projectFinishVarianceDays: projectFinishVariance,
    changed,
    slipped: changed
      .filter((t) => t.finishVarianceDays > 0)
      .sort((a, b) => b.finishVarianceDays - a.finishVarianceDays),
    gained: changed
      .filter((t) => t.finishVarianceDays < 0)
      .sort((a, b) => a.finishVarianceDays - b.finishVarianceDays),
  }
}

/**
 * Working days from `from` to `to`, signed. Dates are snapped onto the calendar
 * first, because a baseline may have been captured under a calendar that has
 * since gained a holiday.
 */
function workingDaysBetween(calendar: WorkCalendar, from: IsoDate, to: IsoDate): number {
  const a = calendar.snapForward(toDayIndex(from))
  const b = calendar.snapForward(toDayIndex(to))
  return calendar.countWorkingDays(a, b)
}
