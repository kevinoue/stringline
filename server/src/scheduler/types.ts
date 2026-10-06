/**
 * Core scheduling types.
 *
 * Time model: everything internal is a `DayIndex` — an integer count of days
 * since the Unix epoch, computed in UTC. Calendar dates only exist at the
 * boundary, as `IsoDate` strings. This keeps the solver free of timezone
 * arithmetic, which is where day-granular schedulers usually go wrong.
 */

/** Days since 1970-01-01, UTC. Integer. */
export type DayIndex = number

/** Calendar date, `YYYY-MM-DD`. */
export type IsoDate = string

/**
 * Dependency relationship types.
 * - `FS` finish-to-start: successor starts after predecessor finishes (the default)
 * - `SS` start-to-start:  successor starts after predecessor starts
 * - `FF` finish-to-finish: successor finishes after predecessor finishes
 * - `SF` start-to-finish: successor finishes after predecessor starts (rare)
 */
export type DependencyType = 'FS' | 'SS' | 'FF' | 'SF'

/**
 * Scheduling constraints on an individual task.
 * - `ASAP` as soon as predecessors allow (the default)
 * - `START_NO_EARLIER_THAN` soft floor on the start date
 * - `FINISH_NO_LATER_THAN` soft ceiling on the finish date; consumes float
 * - `MUST_START_ON` hard pin to a specific date
 */
export type ConstraintType =
  | 'ASAP'
  | 'START_NO_EARLIER_THAN'
  | 'FINISH_NO_LATER_THAN'
  | 'MUST_START_ON'

export interface CalendarDef {
  id: string
  name: string
  /** Working weekdays, `0` = Sunday through `6` = Saturday. */
  workingWeekdays: number[]
  /** Dates that are never working days, regardless of weekday. */
  holidays?: IsoDate[]
  /** Dates forced to be working days, overriding both weekday and holiday. */
  workingExceptions?: IsoDate[]
}

/** Where a task sits relative to the data date. Derived, never supplied. */
export type TaskStatus = 'not-started' | 'in-progress' | 'complete'

export interface TaskInput {
  id: string
  name: string
  /**
   * Original duration in *working days*. `0` marks a milestone (occupies no time).
   * Once a task is under way this is the plan of record, not the forecast —
   * `remainingDays` drives the forecast.
   */
  durationDays: number
  /** Falls back to the schedule's `defaultCalendarId`. */
  calendarId?: string
  constraintType?: ConstraintType
  /** Required when `constraintType` is anything other than `ASAP`. */
  constraintDate?: IsoDate

  // ── Actuals ────────────────────────────────────────────────────────────────
  // Facts about what happened. They override the plan rather than competing
  // with it: a task that started Tuesday started Tuesday, whatever CPM wanted.

  /** The day work actually began. Its presence means the task is under way. */
  actualStart?: IsoDate
  /** The day work actually finished. Its presence means the task is done. */
  actualFinish?: IsoDate
  /** `0`–`100`. Used to derive `remainingDays` when that is not given directly. */
  percentComplete?: number
  /**
   * Working days of work left. Takes precedence over `percentComplete`.
   * When neither is supplied for a started task, the engine assumes progress
   * has tracked the plan and infers the remainder from elapsed time.
   */
  remainingDays?: number
}

export interface DependencyInput {
  predecessorId: string
  successorId: string
  type: DependencyType
  /**
   * Lag in working days, measured on the **successor's** calendar.
   * Negative values are leads (overlap).
   */
  lagDays?: number
}

/**
 * What to do when a task started before its predecessor finished — which
 * happens constantly on real sites.
 *
 * - `retained` keeps the logic: the remaining work still waits for the
 *   predecessor. Conservative, and P6's default.
 * - `progress-override` lets reality win: work already under way carries on
 *   regardless of the unfinished predecessor.
 */
export type OutOfSequenceMode = 'retained' | 'progress-override'

export interface ScheduleInput {
  /** Nothing is scheduled before this date. */
  projectStart: IsoDate
  defaultCalendarId: string
  calendars: CalendarDef[]
  tasks: TaskInput[]
  dependencies: DependencyInput[]
  /**
   * The line between fact and forecast. On or before it, actuals rule; after
   * it, CPM forecasts. Remaining work on started tasks resumes here, not at the
   * task's original start — which is what stops a stalled task from silently
   * reporting that it finished on time.
   *
   * Omit for a pure plan with no progress applied.
   */
  dataDate?: IsoDate
  /** Defaults to `retained`. */
  outOfSequence?: OutOfSequenceMode
  /**
   * Optional contractual completion date. When set, the backward pass runs
   * from here instead of from the computed finish, so an at-risk schedule
   * shows negative float rather than looking healthy.
   */
  projectDeadline?: IsoDate
}

export interface ScheduledTask {
  id: string
  name: string
  durationDays: number
  isMilestone: boolean
  /** Derived from the actuals and the data date. */
  status: TaskStatus
  /** Working days of work still to do. `0` once complete. */
  remainingDays: number
  /**
   * `false` when these dates are recorded fact, `true` when they are CPM's
   * forecast. A partly-complete task is `true`: its start is fact, its finish
   * is not.
   */
  isForecast: boolean
  earlyStart: IsoDate
  /** Inclusive: the last working day of the task. Equals `earlyStart` for milestones. */
  earlyFinish: IsoDate
  lateStart: IsoDate
  /** Inclusive. */
  lateFinish: IsoDate
  /** Working days this task can slip without moving the project finish. */
  totalFloat: number
  /** Working days this task can slip without moving any successor. */
  freeFloat: number
  isCritical: boolean
}

export interface ScheduleResult {
  projectStart: IsoDate
  /** Echoed back when supplied, so consumers can draw the fact/forecast line. */
  dataDate: IsoDate | null
  projectFinish: IsoDate
  /** Working days from project start to finish, on the default calendar. */
  durationWorkingDays: number
  tasks: Record<string, ScheduledTask>
  /** Task ids along the critical path, in topological order. */
  criticalPath: string[]
  /**
   * Negative when a `projectDeadline` is set and cannot be met.
   * Zero or positive means the deadline is achievable.
   */
  deadlineFloat: number | null
}

export type ScheduleErrorCode =
  | 'CYCLE'
  | 'UNKNOWN_TASK'
  | 'UNKNOWN_CALENDAR'
  | 'DUPLICATE_TASK'
  | 'INVALID_DURATION'
  | 'INVALID_DATE'
  | 'EMPTY_CALENDAR'
  | 'MISSING_CONSTRAINT_DATE'
  | 'HORIZON_EXCEEDED'
  | 'INVALID_PROGRESS'
  | 'INCONSISTENT_ACTUALS'

/**
 * Every rejection from the solver is one of these. It never throws a bare
 * `Error`, and it never returns a silently wrong schedule.
 */
export class ScheduleError extends Error {
  readonly code: ScheduleErrorCode
  /** For `CYCLE`, the task ids forming the loop, first id repeated at the end. */
  readonly detail: string[]

  constructor(code: ScheduleErrorCode, message: string, detail: string[] = []) {
    super(message)
    this.name = 'ScheduleError'
    this.code = code
    this.detail = detail
  }
}
