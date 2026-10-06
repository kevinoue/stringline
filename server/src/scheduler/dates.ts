/**
 * Conversion between ISO date strings and integer day indices.
 *
 * All arithmetic is done in UTC. A `DayIndex` is the number of days since
 * 1970-01-01. Because every date is snapped to UTC midnight, day arithmetic is
 * plain integer addition — no DST, no local-timezone drift.
 */

import { ScheduleError, type DayIndex, type IsoDate } from './types.js'

const MS_PER_DAY = 86_400_000
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/

/** `2026-03-02` → integer day index. Throws `INVALID_DATE` on anything else. */
export function toDayIndex(iso: IsoDate): DayIndex {
  const match = ISO_DATE.exec(iso)
  if (!match) {
    throw new ScheduleError('INVALID_DATE', `Expected a YYYY-MM-DD date, got "${iso}"`)
  }
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])

  const ms = Date.UTC(year, month - 1, day)
  const roundTrip = new Date(ms)
  // Catches impossible dates that Date.UTC silently rolls over, e.g. 2026-02-30.
  if (
    roundTrip.getUTCFullYear() !== year ||
    roundTrip.getUTCMonth() !== month - 1 ||
    roundTrip.getUTCDate() !== day
  ) {
    throw new ScheduleError('INVALID_DATE', `"${iso}" is not a real calendar date`)
  }
  return ms / MS_PER_DAY
}

/** Integer day index → `2026-03-02`. */
export function fromDayIndex(day: DayIndex): IsoDate {
  return new Date(day * MS_PER_DAY).toISOString().slice(0, 10)
}

/** `0` = Sunday through `6` = Saturday. */
export function weekdayOf(day: DayIndex): number {
  return new Date(day * MS_PER_DAY).getUTCDay()
}
