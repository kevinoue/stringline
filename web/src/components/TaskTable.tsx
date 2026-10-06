import { useLayoutEffect, useRef, useState } from 'react'
import type { Baseline, Schedule } from '../api/types.js'
import { ROW_HEIGHT } from '../gantt/Gantt.js'

interface Props {
  schedule: Schedule
  baseline: Baseline | null
  order: string[]
  selectedId: string | null
  onSelect(id: string): void
  headerHeight: number
  height: number
  scrollTop: number
  onScroll(top: number): void
}

/** Working days a task has slipped against the baseline, or null if unbaselined. */
function slip(baseline: Baseline | null, taskId: string, finish: string): number | null {
  const b = baseline?.tasks[taskId]
  if (!b) return null
  // Calendar-day difference is only used for the sign and a rough magnitude in
  // this column; the authoritative working-day figure comes from the server's
  // variance calculation shown in the banner.
  const diff = (Date.parse(`${finish}T00:00:00Z`) - Date.parse(`${b.finish}T00:00:00Z`)) / 86_400_000
  return diff === 0 ? 0 : diff
}

export function TaskTable({
  schedule,
  baseline,
  order,
  selectedId,
  onSelect,
  headerHeight,
  height,
  scrollTop,
  onScroll,
}: Props) {
  const tableRef = useRef<HTMLDivElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const [widths, setWidths] = useState<number[]>([210, 38, 82, 108, 40])
  /**
   * The dates duplicate what the bars already show. Once the list is genuinely
   * sized to its content, they are the only remaining thing to give back — so
   * they can be folded away when the chart matters more than the figures.
   */
  const [compact, setCompact] = useState(false)

  /**
   * Size every column to its own widest cell, header included.
   *
   * Guessed widths always carry slack, and slack here is stolen directly from
   * the chart — the task list is the only thing competing with it for room.
   *
   * Measured with a `Range` over each cell's contents rather than
   * `scrollWidth`. `scrollWidth` never reports less than `clientWidth`, so a
   * column wider than its content measures as its own current width: set it,
   * add a pixel of breathing room, measure again, and it ratchets upwards
   * until React gives up with "maximum update depth exceeded". A Range
   * measures the text itself and is indifferent to the box around it.
   */
  useLayoutEffect(() => {
    const table = tableRef.current
    if (!table) return

    const range = document.createRange()
    const textWidth = (el: Element): number => {
      range.selectNodeContents(el)
      return range.getBoundingClientRect().width
    }

    const measured = new Array(compact ? 3 : 5).fill(0) as number[]
    for (const row of table.querySelectorAll<HTMLElement>('.table-header, .table-row')) {
      const cells = row.children as HTMLCollectionOf<HTMLElement>
      for (let i = 0; i < measured.length && i < cells.length; i++) {
        const cell = cells[i]!
        // One range over the whole cell: it covers bare text nodes and element
        // children alike. Summing only the elements missed the date itself in
        // the finish column, which is a text node sitting beside the variance
        // badge — and left the column too narrow to show it.
        let width = textWidth(cell)

        // The name is deliberately clipped with an ellipsis, so add back
        // whatever the clip is currently hiding.
        const clipped = cell.querySelector<HTMLElement>('.name-text')
        if (clipped) {
          width += Math.max(0, textWidth(clipped) - clipped.getBoundingClientRect().width)
        }
        measured[i] = Math.max(measured[i]!, Math.ceil(width))
      }
    }

    // A cap on the name so one absurd title cannot swallow the chart.
    const next = measured.map((w, i) => (i === 0 ? Math.min(420, w + 2) : w + 2))
    setWidths((prev) => (prev.length === next.length && prev.every((w, i) => w === next[i]) ? prev : next))
  }, [order, schedule, compact])

  return (
    <div
      className="table"
      ref={tableRef}
      data-compact={compact ? 'true' : 'false'}
      style={{
        // One variable per column, so the grid template in CSS stays readable.
        ['--col-name' as string]: `${widths[0]}px`,
        ['--col-days' as string]: `${widths[1]}px`,
        ['--col-start' as string]: `${widths[2] ?? 0}px`,
        ['--col-finish' as string]: `${widths[3] ?? 0}px`,
        ['--col-float' as string]: `${(compact ? widths[2] : widths[4]) ?? 0}px`,
      }}
    >
      <div className="table-header" style={{ height: headerHeight }}>
        <span className="col-name">
          Task
          <button
            className="col-toggle"
            onClick={() => setCompact((v) => !v)}
            title={compact ? 'Show start and finish dates' : 'Hide dates and widen the chart'}
            aria-label={compact ? 'Show dates' : 'Hide dates'}
          >
            {compact ? '»' : '«'}
          </button>
        </span>
        <span className="col-num">Days</span>
        {!compact && <span className="col-date">Start</span>}
        {!compact && <span className="col-date">Finish</span>}
        <span className="col-num">Float</span>
      </div>
      <div
        className="table-body"
        style={{ height }}
        onScroll={(e) => onScroll(e.currentTarget.scrollTop)}
        ref={(el) => {
          bodyRef.current = el
          // Follow the chart pane when it is the one being scrolled.
          if (el && el.scrollTop !== scrollTop) el.scrollTop = scrollTop
        }}
      >
        {order.map((id) => {
          const task = schedule.tasks[id]
          if (!task) return null
          const variance = slip(baseline, id, task.earlyFinish)
          return (
            <div
              key={id}
              className={`table-row${selectedId === id ? ' selected' : ''}${task.isCritical ? ' critical' : ''}`}
              style={{ height: ROW_HEIGHT }}
              onClick={() => onSelect(id)}
            >
              <span className="col-name" title={task.name}>
                {task.isMilestone && <span className="milestone-dot" aria-hidden />}
                {/*
                  The name ellipses on its own rather than on the cell, so a
                  long trade name shortens instead of shoving the status pill
                  out of view. Pills carry information the name does not.
                */}
                <span className="name-text">{task.name}</span>
                {task.status === 'complete' && <span className="pill done">done</span>}
                {task.status === 'in-progress' && <span className="pill wip">in progress</span>}
              </span>
              <span className="col-num">{task.durationDays || '—'}</span>
              {!compact && <span className="col-date">{task.earlyStart}</span>}
              {!compact && (
                <span className="col-date">
                  {task.earlyFinish}
                  {variance !== null && variance !== 0 && (
                    <span className={variance > 0 ? 'var late' : 'var early'}>
                      {variance > 0 ? `+${variance}` : variance}
                    </span>
                  )}
                </span>
              )}
              <span className={`col-num${task.totalFloat < 0 ? ' negative' : ''}`}>
                {task.totalFloat}
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}
