/**
 * Stringline scheduling engine.
 *
 * Pure and I/O-free by design: no database, no HTTP, no clock. Everything it
 * needs arrives in `ScheduleInput` and everything it knows comes back in
 * `ScheduleResult`. That is what makes it exhaustively testable, and this is
 * the one module in the product where a silent wrong answer would poison
 * everything built on top of it.
 */

export { solve, projectCalendars } from './cpm.js'
export { captureBaseline, diffAgainstBaseline } from './baseline.js'
export { explainImpact } from './impact.js'
export { WorkCalendar, STANDARD_WEEK, buildCalendars } from './calendar.js'
export { DependencyGraph } from './graph.js'
export { toDayIndex, fromDayIndex } from './dates.js'

export { ScheduleError } from './types.js'
export type {
  CalendarDef,
  ConstraintType,
  DayIndex,
  DependencyInput,
  DependencyType,
  IsoDate,
  OutOfSequenceMode,
  ScheduleErrorCode,
  ScheduleInput,
  ScheduleResult,
  ScheduledTask,
  TaskInput,
  TaskStatus,
} from './types.js'
export type { Baseline, BaselineTask, ScheduleVariance, TaskVariance } from './baseline.js'
export type { ImpactDriver, ImpactExplanation } from './impact.js'
