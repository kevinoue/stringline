/**
 * The date ↔ pixel scale.
 *
 * Same UTC discipline as the server: a date is an integer day index, never a
 * local `Date`. The Gantt is the one place where an off-by-one-day bug is
 * invisible in code review and glaring on screen, so the conversion lives here
 * and nowhere else.
 */

const MS_PER_DAY = 86_400_000

export type DayIndex = number

export function toDayIndex(iso: string): DayIndex {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number]
  return Date.UTC(y, m - 1, d) / MS_PER_DAY
}

export function fromDayIndex(day: DayIndex): string {
  return new Date(day * MS_PER_DAY).toISOString().slice(0, 10)
}

export function weekdayOf(day: DayIndex): number {
  return new Date(day * MS_PER_DAY).getUTCDay()
}

export function addDays(iso: string, days: number): string {
  return fromDayIndex(toDayIndex(iso) + days)
}

/**
 * Zoom is a continuous pixels-per-day value, not three fixed steps. The named
 * presets are just shortcuts onto that scale, and the axis picks its own
 * granularity from whatever width it is handed — so there is no zoom level at
 * which the labels stop making sense.
 */
export type Zoom = 'day' | 'week' | 'month'

export const ZOOM_WIDTH: Record<Zoom, number> = {
  day: 30,
  week: 11,
  month: 4,
}

export const MIN_DAY_WIDTH = 1.6
export const MAX_DAY_WIDTH = 64

export function clampDayWidth(w: number): number {
  return Math.min(MAX_DAY_WIDTH, Math.max(MIN_DAY_WIDTH, w))
}

/** Which tick granularity suits this scale. */
function granularityFor(dayWidth: number): Zoom {
  if (dayWidth >= 17) return 'day'
  if (dayWidth >= 5.5) return 'week'
  return 'month'
}

export interface Timeline {
  origin: DayIndex
  dayWidth: number
  /** Derived from `dayWidth`, not chosen by the caller. */
  zoom: Zoom
  totalDays: number
  width: number
  /** Left edge of the given day. */
  x(iso: string): number
  /** Pixel position back to a date — used while dragging. */
  dateAt(x: number): string
  ticks(): Tick[]
}

export interface Tick {
  x: number
  label: string
  major: boolean
}

const MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
]

/**
 * Build a scale spanning `start`..`end` with padding either side, so a bar can
 * be dragged past the current extents without the chart ending mid-gesture.
 */
export function createTimeline(start: string, end: string, rawDayWidth: number): Timeline {
  const dayWidth = clampDayWidth(rawDayWidth)
  const zoom = granularityFor(dayWidth)
  const padBefore = zoom === 'day' ? 3 : zoom === 'week' ? 7 : 14
  const padAfter = zoom === 'day' ? 10 : zoom === 'week' ? 21 : 60

  const origin = toDayIndex(start) - padBefore
  const last = toDayIndex(end) + padAfter
  const totalDays = Math.max(1, last - origin + 1)

  return {
    origin,
    dayWidth,
    zoom,
    totalDays,
    width: totalDays * dayWidth,
    x: (iso: string) => (toDayIndex(iso) - origin) * dayWidth,
    dateAt: (x: number) => fromDayIndex(origin + Math.round(x / dayWidth)),
    ticks: () => buildTicks(origin, totalDays, dayWidth, zoom),
  }
}

function buildTicks(origin: DayIndex, totalDays: number, dayWidth: number, zoom: Zoom): Tick[] {
  const ticks: Tick[] = []

  for (let offset = 0; offset < totalDays; offset++) {
    const day = origin + offset
    const date = new Date(day * MS_PER_DAY)
    const x = offset * dayWidth
    const dom = date.getUTCDate()
    const weekday = date.getUTCDay()

    if (zoom === 'day') {
      // Every day gets a tick; Mondays and the 1st are emphasised.
      ticks.push({
        x,
        label: dom === 1 ? `${MONTHS[date.getUTCMonth()]} ${dom}` : String(dom),
        major: weekday === 1 || dom === 1,
      })
    } else if (zoom === 'week') {
      if (weekday === 1) {
        ticks.push({ x, label: `${MONTHS[date.getUTCMonth()]} ${dom}`, major: dom <= 7 })
      }
    } else if (dom === 1) {
      ticks.push({
        x,
        label: `${MONTHS[date.getUTCMonth()]} ${String(date.getUTCFullYear()).slice(2)}`,
        major: date.getUTCMonth() === 0,
      })
    }
  }
  return ticks
}

/**
 * Weekend bands, so the chart reads as working time rather than raw calendar
 * days. Purely visual — the server's calendar is the authority on what a
 * working day actually is, and it may differ per task.
 */
export function weekendBands(timeline: Timeline): Array<{ x: number; width: number }> {
  if (timeline.zoom === 'month') return []
  const bands: Array<{ x: number; width: number }> = []
  for (let offset = 0; offset < timeline.totalDays; offset++) {
    const weekday = weekdayOf(timeline.origin + offset)
    if (weekday === 0 || weekday === 6) {
      bands.push({ x: offset * timeline.dayWidth, width: timeline.dayWidth })
    }
  }
  return bands
}
