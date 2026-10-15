/**
 * Paper geometry, and fitting a schedule onto it.
 *
 * Everything here is in CSS pixels at 96 per inch, which is what `@page` and
 * the browser's print pipeline work in. Keeping one unit end to end avoids the
 * classic printing bug where the preview is right and the paper is not.
 *
 * The chart is SVG, so scaling it costs nothing in quality — a bar at 2px per
 * day prints as crisply as one at 40. That is why fitting to the sheet is the
 * right default rather than a compromise.
 */

/** CSS reference pixels per inch. Fixed by spec, not by the display. */
const PX_PER_INCH = 96

export interface PaperSize {
  id: string
  label: string
  /** Inches, portrait. Landscape swaps them. */
  widthIn: number
  heightIn: number
}

export const PAPER_SIZES: PaperSize[] = [
  { id: 'letter', label: 'Letter — 8.5 × 11 in', widthIn: 8.5, heightIn: 11 },
  { id: 'legal', label: 'Legal — 8.5 × 14 in', widthIn: 8.5, heightIn: 14 },
  { id: 'tabloid', label: 'Tabloid — 11 × 17 in', widthIn: 11, heightIn: 17 },
  { id: 'a4', label: 'A4 — 210 × 297 mm', widthIn: 8.27, heightIn: 11.69 },
  { id: 'a3', label: 'A3 — 297 × 420 mm', widthIn: 11.69, heightIn: 16.54 },
]

export type Orientation = 'landscape' | 'portrait'

/** Half an inch all round. Comfortably inside every printer's unprintable edge. */
export const MARGIN_IN = 0.5

export interface PageGeometry {
  /** Full sheet, for the `@page size` rule. */
  pageWidth: number
  pageHeight: number
  /** Inside the margins — what the content actually gets. */
  contentWidth: number
  contentHeight: number
}

export function geometryFor(size: PaperSize, orientation: Orientation): PageGeometry {
  const longEdge = Math.max(size.widthIn, size.heightIn)
  const shortEdge = Math.min(size.widthIn, size.heightIn)
  const wIn = orientation === 'landscape' ? longEdge : shortEdge
  const hIn = orientation === 'landscape' ? shortEdge : longEdge
  const margin = MARGIN_IN * 2 * PX_PER_INCH

  return {
    pageWidth: wIn * PX_PER_INCH,
    pageHeight: hIn * PX_PER_INCH,
    contentWidth: wIn * PX_PER_INCH - margin,
    contentHeight: hIn * PX_PER_INCH - margin,
  }
}

/** Fixed print metrics, in px. Smaller than on screen — paper has more DPI than a monitor. */
export const PRINT = {
  rowHeight: 18,
  axisHeight: 30,
  titleBlockHeight: 58,
  legendHeight: 22,
  /** The task-name column on the printed sheet. */
  nameColumn: 190,
  /** Date columns beside the name, when they are shown. */
  dateColumns: 150,
  fontSize: 9,
} as const

/**
 * How many task rows fit on one sheet.
 *
 * The title block and the date axis repeat on every sheet, so their height
 * comes off every page rather than just the first. A schedule whose rows run
 * onto a second sheet is useless if that sheet has no dates along the top.
 */
export function rowsPerPage(geometry: PageGeometry): number {
  const chrome = PRINT.titleBlockHeight + PRINT.axisHeight + PRINT.legendHeight
  return Math.max(1, Math.floor((geometry.contentHeight - chrome) / PRINT.rowHeight))
}

/**
 * Pixels per day that make the whole project span the sheet.
 *
 * Returns the exact fit with no clamping: unlike the screen, there is no
 * minimum below which the chart stops being useful, because a printed sheet is
 * read at arm's length and the bars are vector. A two-year job at 0.4px/day is
 * still a legible shape even when individual days are not.
 */
export function fitDayWidth(
  geometry: PageGeometry,
  totalDays: number,
  showDateColumns: boolean,
): number {
  const table = PRINT.nameColumn + (showDateColumns ? PRINT.dateColumns : 0)
  const forChart = geometry.contentWidth - table
  // One day minimum of span, so a single-day project does not divide by zero.
  return forChart / Math.max(1, totalDays)
}

/**
 * Whether a fit is tight enough that the result will be hard to read.
 *
 * Not an error — someone printing a two-year programme as a one-page overview
 * knows what they are asking for. It is a prompt to consider the week or month
 * axis, which is almost always what they actually wanted.
 */
export function isDense(dayWidth: number): boolean {
  return dayWidth < 1.2
}
