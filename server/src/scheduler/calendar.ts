/**
 * Working-day calendars.
 *
 * A calendar answers one question — "is this day workable?" — and everything
 * else is built on top of it. Rather than walking day by day (which makes a
 * 5-year schedule with thousands of tasks quadratic), each calendar precomputes
 * two lookup tables over the project horizon:
 *
 *   `ordinal[i]`   working days strictly before day `i`
 *   `byOrdinal[n]` the day index of the n-th working day
 *
 * That reduces `addWorkingDays` and `countWorkingDays` to array indexing.
 */

import { fromDayIndex, toDayIndex, weekdayOf } from './dates.js'
import { ScheduleError, type CalendarDef, type DayIndex } from './types.js'

/** Days of slack added before the horizon start, so leads and SNET can look back. */
const HORIZON_PAD_BEFORE = 400

export class WorkCalendar {
  readonly id: string
  readonly name: string

  private readonly first: DayIndex
  private readonly last: DayIndex
  /** `working[i - first]` — is day `i` a working day? */
  private readonly working: Uint8Array
  /** `ordinal[i - first]` — count of working days strictly before day `i`. */
  private readonly ordinal: Int32Array
  /** Day index of the n-th working day (n is 0-based). */
  private readonly byOrdinal: Int32Array

  constructor(def: CalendarDef, horizonStart: DayIndex, horizonEnd: DayIndex) {
    this.id = def.id
    this.name = def.name

    const weekdays = new Set(def.workingWeekdays)
    if (weekdays.size === 0) {
      throw new ScheduleError(
        'EMPTY_CALENDAR',
        `Calendar "${def.id}" has no working weekdays; no task on it could ever finish`,
      )
    }

    const holidays = new Set((def.holidays ?? []).map(toDayIndex))
    const exceptions = new Set((def.workingExceptions ?? []).map(toDayIndex))

    this.first = horizonStart - HORIZON_PAD_BEFORE
    this.last = horizonEnd
    const span = this.last - this.first + 1

    this.working = new Uint8Array(span)
    this.ordinal = new Int32Array(span)

    let count = 0
    for (let offset = 0; offset < span; offset++) {
      const day = this.first + offset
      this.ordinal[offset] = count
      // Explicit working exceptions beat both holidays and the weekly pattern.
      const isWorking = exceptions.has(day) || (weekdays.has(weekdayOf(day)) && !holidays.has(day))
      if (isWorking) {
        this.working[offset] = 1
        count++
      }
    }

    this.byOrdinal = new Int32Array(count)
    let n = 0
    for (let offset = 0; offset < span; offset++) {
      if (this.working[offset] === 1) this.byOrdinal[n++] = this.first + offset
    }

    if (count === 0) {
      throw new ScheduleError(
        'EMPTY_CALENDAR',
        `Calendar "${def.id}" has no working days anywhere in the project horizon`,
      )
    }
  }

  isWorking(day: DayIndex): boolean {
    this.assertInHorizon(day)
    return this.working[day - this.first] === 1
  }

  /** The n-th working day at or after `day`. `snapForward(d, 0)` snaps `d` itself. */
  snapForward(day: DayIndex): DayIndex {
    this.assertInHorizon(day)
    // `ordinal` counts working days strictly before `day`, so it already points at
    // the next working day at or after `day`.
    return this.workingDayAt(this.ordinal[day - this.first]!)
  }

  /** The nearest working day at or before `day`. */
  snapBack(day: DayIndex): DayIndex {
    this.assertInHorizon(day)
    const offset = day - this.first
    const beforeCount = this.ordinal[offset]!
    // If `day` itself works it is ordinal `beforeCount`; otherwise take the one prior.
    const index = this.working[offset] === 1 ? beforeCount : beforeCount - 1
    if (index < 0) {
      throw new ScheduleError(
        'HORIZON_EXCEEDED',
        `No working day on or before ${fromDayIndex(day)} in calendar "${this.id}"`,
      )
    }
    return this.workingDayAt(index)
  }

  /**
   * Position of `day` on this calendar's working-day axis.
   * `day` must itself be a working day — callers snap first, deliberately, so
   * that the direction of the snap is always an explicit decision.
   */
  ordinalOf(day: DayIndex): number {
    this.assertInHorizon(day)
    const offset = day - this.first
    if (this.working[offset] !== 1) {
      throw new ScheduleError(
        'INVALID_DATE',
        `${fromDayIndex(day)} is not a working day in calendar "${this.id}"; snap it first`,
      )
    }
    return this.ordinal[offset]!
  }

  /** Move `n` working days from `day` (which must be a working day). Negative moves back. */
  addWorkingDays(day: DayIndex, n: number): DayIndex {
    return this.workingDayAt(this.ordinalOf(day) + n)
  }

  /**
   * Working days from `from` to `to`, both working days.
   * Half-open: same day is `0`, the next working day is `1`.
   */
  countWorkingDays(from: DayIndex, to: DayIndex): number {
    return this.ordinalOf(to) - this.ordinalOf(from)
  }

  private workingDayAt(index: number): DayIndex {
    if (index < 0 || index >= this.byOrdinal.length) {
      throw new ScheduleError(
        'HORIZON_EXCEEDED',
        `Calendar "${this.id}" ran past its precomputed horizon. The schedule likely ` +
          `extends further than the project start suggests, or a lag is implausibly large.`,
      )
    }
    return this.byOrdinal[index]!
  }

  private assertInHorizon(day: DayIndex): void {
    if (day < this.first || day > this.last) {
      throw new ScheduleError(
        'HORIZON_EXCEEDED',
        `${fromDayIndex(day)} is outside calendar "${this.id}"'s horizon ` +
          `(${fromDayIndex(this.first)}..${fromDayIndex(this.last)})`,
      )
    }
  }
}

/** Mon–Fri, no holidays. The default when a project does not define its own. */
export const STANDARD_WEEK: Omit<CalendarDef, 'id' | 'name'> = {
  workingWeekdays: [1, 2, 3, 4, 5],
}

export function buildCalendars(
  defs: CalendarDef[],
  horizonStart: DayIndex,
  horizonEnd: DayIndex,
): Map<string, WorkCalendar> {
  const map = new Map<string, WorkCalendar>()
  for (const def of defs) {
    if (map.has(def.id)) {
      throw new ScheduleError('UNKNOWN_CALENDAR', `Duplicate calendar id "${def.id}"`)
    }
    map.set(def.id, new WorkCalendar(def, horizonStart, horizonEnd))
  }
  return map
}
