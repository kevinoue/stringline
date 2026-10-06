import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Baseline, Dependency, Schedule, ScheduledTask } from '../api/types.js'
import { addDays, createTimeline, weekendBands, type Timeline } from './timeline.js'

export const ROW_HEIGHT = 34
const BAR_HEIGHT = 16
const GHOST_HEIGHT = 5
const HEADER_HEIGHT = 44
/** Rows rendered beyond the viewport, so scrolling never shows a blank band. */
const OVERSCAN = 6

/** Which part of the bar was grabbed. */
export type DragMode = 'move' | 'resize-start' | 'resize-end'

export interface DragResult {
  taskId: string
  mode: DragMode
  /** The date the dragged edge was dropped on. The server decides what it means. */
  targetDate: string
}

/** Width of the resize hit zones at each end of a bar. */
const HANDLE = 7

interface Props {
  schedule: Schedule
  baseline: Baseline | null
  dependencies: Dependency[]
  order: string[]
  /** Pixels per day. Continuous, so the chart zooms rather than stepping. */
  dayWidth: number
  onZoom(next: number, anchorRatio: number): void
  height: number
  selectedId: string | null
  onSelect(taskId: string): void
  onDragEnd(result: DragResult): void
  /** Fired on grab so the parent can fetch the dependency floor for this task. */
  onDragStart(taskId: string): void
  /**
   * Earliest date the dragged task may start, from the server. Everything left
   * of it is shaded during the drag — "you cannot go there" shown, not
   * explained afterwards.
   */
  dragFloor: { taskId: string; earliestStart: string } | null
  /** A hypothetical schedule to overlay while a what-if preview is open. */
  preview: Schedule | null
  /** Vertical scroll is owned by the parent so both panes stay in lockstep. */
  scrollTop: number
  onScrollTop(top: number): void
}

export function Gantt({
  schedule,
  baseline,
  dependencies,
  order,
  dayWidth,
  onZoom,
  height,
  selectedId,
  onSelect,
  onDragEnd,
  onDragStart,
  dragFloor,
  preview,
  scrollTop,
  onScrollTop,
}: Props) {
  const headerRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const [drag, setDrag] = useState<{ taskId: string; mode: DragMode; dx: number } | null>(null)
  /**
   * A pointerup after a drag still fires a click, which would select the row and
   * throw the editor open. Moving a bar and opening a form are different
   * intentions, so a real drag suppresses the click that follows it.
   */
  const draggedRef = useRef(false)

  const timeline = useMemo(() => {
    const dates = Object.values(schedule.tasks).flatMap((t) => [t.earlyStart, t.earlyFinish])
    if (baseline) {
      for (const b of Object.values(baseline.tasks)) dates.push(b.start, b.finish)
    }
    if (preview) {
      for (const t of Object.values(preview.tasks)) dates.push(t.earlyStart, t.earlyFinish)
    }
    const start = dates.length ? dates.reduce((a, b) => (a < b ? a : b)) : schedule.projectStart
    const end = dates.length ? dates.reduce((a, b) => (a > b ? a : b)) : schedule.projectFinish
    return createTimeline(start, end, dayWidth)
  }, [schedule, baseline, preview, dayWidth])

  const bodyHeight = order.length * ROW_HEIGHT
  const firstRow = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN)
  const lastRow = Math.min(order.length, Math.ceil((scrollTop + height) / ROW_HEIGHT) + OVERSCAN)
  const visible = order.slice(firstRow, lastRow)

  const rowOf = useMemo(() => {
    const map = new Map<string, number>()
    order.forEach((id, i) => map.set(id, i))
    return map
  }, [order])

  const startDrag = useCallback(
    (event: React.PointerEvent, taskId: string, mode: DragMode, anchorDate: string) => {
      event.preventDefault()
      event.stopPropagation()
      const originX = event.clientX
      draggedRef.current = false
      onDragStart(taskId)

      // Deliberately no setPointerCapture. The window listeners below already
      // track the pointer everywhere, and capturing on an SVG node that React
      // re-renders on every move is a needless way for the gesture to die
      // halfway through.
      const move = (e: PointerEvent) => {
        const dx = e.clientX - originX
        // A few pixels of slop, so a slightly shaky click is still a click.
        if (Math.abs(dx) > 3) draggedRef.current = true
        setDrag({ taskId, mode, dx })
      }
      const up = (e: PointerEvent) => {
        window.removeEventListener('pointermove', move)
        window.removeEventListener('pointerup', up)
        setDrag(null)
        const days = Math.round((e.clientX - originX) / timeline.dayWidth)
        if (days === 0) return
        // Report the date the edge landed on. Turning that into a duration or a
        // constraint needs the project calendar, which only the server has.
        onDragEnd({ taskId, mode, targetDate: addDays(anchorDate, days) })
      }
      window.addEventListener('pointermove', move)
      window.addEventListener('pointerup', up)
    },
    [timeline.dayWidth, onDragEnd, onDragStart],
  )

  /**
   * Wheel over the chart zooms, about the pointer, so the date under the cursor
   * stays put. Shift + wheel pans through time instead.
   *
   * Zoom is the plain gesture rather than a modified one because the chart is a
   * map: reaching for the wheel over it means "show me more or less", not
   * "scroll the page". Row scrolling still works over the task list, which is
   * kept in lockstep, and through the scrollbar.
   *
   * Attached natively with `{ passive: false }`. React registers wheel handlers
   * as passive, so `preventDefault` inside `onWheel` is ignored and the
   * browser's own page zoom fires on top of ours.
   */
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const handler = (event: WheelEvent) => {
      // A trackpad's sideways swipe is a horizontal delta; let it pan.
      if (Math.abs(event.deltaX) > Math.abs(event.deltaY)) return
      event.preventDefault()
      if (event.shiftKey) {
        el.scrollLeft += event.deltaY
        return
      }
      const rect = el.getBoundingClientRect()
      const pointerX = event.clientX - rect.left + el.scrollLeft
      onZoom(dayWidth * Math.exp(-event.deltaY * 0.0022), pointerX / Math.max(1, el.scrollWidth))
    }
    el.addEventListener('wheel', handler, { passive: false })
    return () => el.removeEventListener('wheel', handler)
  }, [dayWidth, onZoom])

  /** Swallow the click that follows a real drag; let a genuine click through. */
  const handleSelect = useCallback(
    (id: string) => {
      if (draggedRef.current) {
        draggedRef.current = false
        return
      }
      onSelect(id)
    },
    [onSelect],
  )

  const bands = useMemo(() => weekendBands(timeline), [timeline])
  const arrows = useMemo(
    () => buildArrows(schedule, dependencies, rowOf, timeline),
    [schedule, dependencies, rowOf, timeline],
  )

  return (
    <div className="gantt">
      <div className="gantt-header" ref={headerRef} style={{ height: HEADER_HEIGHT }}>
        <svg width={timeline.width} height={HEADER_HEIGHT} style={{ display: 'block' }}>
          {timeline.ticks().map((tick) => (
            <g key={tick.x}>
              <line
                x1={tick.x}
                y1={HEADER_HEIGHT - 10}
                x2={tick.x}
                y2={HEADER_HEIGHT}
                className={tick.major ? 'tick-major' : 'tick-minor'}
              />
              <text x={tick.x + 3} y={HEADER_HEIGHT - 16} className={tick.major ? 'tick-label-major' : 'tick-label'}>
                {tick.label}
              </text>
            </g>
          ))}
        </svg>
      </div>

      <div
        className="gantt-scroll"
        style={{ height }}
        ref={(el) => {
          scrollRef.current = el
          // Follow the table pane when it is the one being scrolled.
          if (el && el.scrollTop !== scrollTop) el.scrollTop = scrollTop
        }}
        onScroll={(e) => {
          const el = e.currentTarget
          onScrollTop(el.scrollTop)
          // The axis lives in a separate element so it can stay pinned while
          // the body scrolls vertically. That means its horizontal position has
          // to be driven manually, or every date label lies.
          if (headerRef.current) headerRef.current.scrollLeft = el.scrollLeft
        }}
      >
        <svg width={timeline.width} height={bodyHeight} style={{ display: 'block' }}>
          {bands.map((band) => (
            <rect
              key={band.x}
              x={band.x}
              y={0}
              width={band.width}
              height={bodyHeight}
              className="weekend"
            />
          ))}

          {/* The data date: everything left of it is fact, right of it forecast. */}
          {schedule.dataDate && (
            <line
              x1={timeline.x(schedule.dataDate)}
              y1={0}
              x2={timeline.x(schedule.dataDate)}
              y2={bodyHeight}
              className="data-date"
            />
          )}

          <g className="arrows">
            {arrows.map((arrow) => (
              <path key={arrow.key} d={arrow.d} className={arrow.critical ? 'arrow critical' : 'arrow'} />
            ))}
          </g>

          {visible.map((taskId) => {
            const task = schedule.tasks[taskId]
            if (!task) return null
            const row = rowOf.get(taskId)!
            const y = row * ROW_HEIGHT
            return (
              <TaskRow
                key={taskId}
                task={task}
                previewTask={preview?.tasks[taskId] ?? null}
                baselineTask={baseline?.tasks[taskId] ?? null}
                y={y}
                timeline={timeline}
                selected={selectedId === taskId}
                dragDx={drag?.taskId === taskId ? drag.dx : 0}
                dragMode={drag?.taskId === taskId ? drag.mode : null}
                floorDate={
                  drag?.taskId === taskId && dragFloor?.taskId === taskId
                    ? dragFloor.earliestStart
                    : null
                }
                onSelect={handleSelect}
                onPointerDown={startDrag}
              />
            )
          })}
        </svg>
      </div>
    </div>
  )
}

interface RowProps {
  task: ScheduledTask
  previewTask: ScheduledTask | null
  baselineTask: Baseline['tasks'][string] | null
  y: number
  timeline: Timeline
  selected: boolean
  dragDx: number
  dragMode: DragMode | null
  /** Earliest start the dependency logic allows, or null when not dragging this row. */
  floorDate: string | null
  onSelect(id: string): void
  onPointerDown(
    event: React.PointerEvent,
    id: string,
    mode: DragMode,
    anchorDate: string,
  ): void
}

function TaskRow({
  task,
  previewTask,
  baselineTask,
  y,
  timeline,
  selected,
  dragDx,
  dragMode,
  floorDate,
  onSelect,
  onPointerDown,
}: RowProps) {
  const barY = y + (ROW_HEIGHT - BAR_HEIGHT) / 2
  const baseX = timeline.x(task.earlyStart)
  // The finish is inclusive, so the bar has to cover that whole day.
  const baseWidth = Math.max(
    timeline.dayWidth * 0.6,
    timeline.x(task.earlyFinish) + timeline.dayWidth - baseX,
  )

  // A resize moves one edge; a move slides both. Reflecting that live is what
  // makes the two gestures feel different rather than merely behave differently.
  const dragging = dragMode !== null
  const MIN = timeline.dayWidth * 0.6
  let x = baseX
  let width = baseWidth
  if (dragMode === 'move') {
    x = baseX + dragDx
  } else if (dragMode === 'resize-start') {
    x = Math.min(baseX + dragDx, baseX + baseWidth - MIN)
    width = Math.max(MIN, baseWidth - (x - baseX))
  } else if (dragMode === 'resize-end') {
    width = Math.max(MIN, baseWidth + dragDx)
  }

  const floorX = floorDate === null ? null : timeline.x(floorDate)
  // Resizing the right edge cannot violate the start floor, so it is never
  // blocked by a predecessor.
  const blocked =
    dragging && dragMode !== 'resize-end' && floorX !== null && x < floorX - 0.5

  const classes = ['bar']
  if (task.isCritical) classes.push('critical')
  if (task.status === 'complete') classes.push('complete')
  if (task.status === 'in-progress') classes.push('in-progress')
  if (selected) classes.push('selected')
  if (blocked) classes.push('blocked')

  return (
    <g className="row" onClick={() => onSelect(task.id)} data-task={task.id}>
      <rect x={0} y={y} width={timeline.width} height={ROW_HEIGHT} className="row-bg" />

      {/*
        Ghost baseline, drawn behind and below the live bar. This is the whole
        point of the product: slippage is visible at a glance, without opening
        a variance report.
      */}
      {baselineTask && (
        <rect
          x={timeline.x(baselineTask.start)}
          y={barY + BAR_HEIGHT + 1}
          width={Math.max(
            2,
            timeline.x(baselineTask.finish) + timeline.dayWidth - timeline.x(baselineTask.start),
          )}
          height={GHOST_HEIGHT}
          className="ghost"
        />
      )}

      {/* Where the bar would land under the open what-if preview. */}
      {previewTask && previewTask.earlyStart !== task.earlyStart && (
        <rect
          x={timeline.x(previewTask.earlyStart)}
          y={barY}
          width={Math.max(
            timeline.dayWidth * 0.6,
            timeline.x(previewTask.earlyFinish) + timeline.dayWidth - timeline.x(previewTask.earlyStart),
          )}
          height={BAR_HEIGHT}
          rx={3}
          className="bar preview"
        />
      )}

      {/*
        Everything left of the dependency floor, shaded while this bar is being
        dragged. Feedback during the gesture beats an explanation after it.
      */}
      {floorX !== null && dragging && floorX > 0 && (
        <g pointerEvents="none">
          <rect x={0} y={y + 2} width={floorX} height={ROW_HEIGHT - 4} className="blocked-zone" />
          {/* The limit itself, so the edge of the forbidden region is legible
              rather than a faint wash the eye slides over. */}
          <line x1={floorX} y1={y + 2} x2={floorX} y2={y + ROW_HEIGHT - 2} className="floor-line" />
        </g>
      )}

      {task.isMilestone ? (
        <g
          transform={`translate(${x}, ${y + ROW_HEIGHT / 2})`}
          onPointerDown={(e) => onPointerDown(e, task.id, 'move', task.earlyStart)}
          style={{ cursor: 'grab' }}
        >
          <rect
            x={-7}
            y={-7}
            width={14}
            height={14}
            transform="rotate(45)"
            className={
              (task.isCritical ? 'milestone critical' : 'milestone') + (blocked ? ' blocked' : '')
            }
          />
        </g>
      ) : (
        <g>
          <rect
            x={x}
            y={barY}
            width={width}
            height={BAR_HEIGHT}
            rx={3}
            className={classes.join(' ')}
            onPointerDown={(e) => onPointerDown(e, task.id, 'move', task.earlyStart)}
            style={{ cursor: 'grab' }}
          />
          {/*
            Resize handles sit on top of the bar at each end. They are invisible
            but wide enough to hit, and they stop propagation so grabbing an edge
            starts a resize rather than a move.
          */}
          <rect
            x={x}
            y={barY}
            width={Math.min(HANDLE, Math.max(3, width / 3))}
            height={BAR_HEIGHT}
            className="handle"
            onPointerDown={(e) => onPointerDown(e, task.id, 'resize-start', task.earlyStart)}
            style={{ cursor: 'ew-resize' }}
          />
          <rect
            x={x + width - Math.min(HANDLE, Math.max(3, width / 3))}
            y={barY}
            width={Math.min(HANDLE, Math.max(3, width / 3))}
            height={BAR_HEIGHT}
            className="handle"
            onPointerDown={(e) => onPointerDown(e, task.id, 'resize-end', task.earlyFinish)}
            style={{ cursor: 'ew-resize' }}
          />
        </g>
      )}

      {/* Progress fill on a started task. */}
      {task.status === 'in-progress' && task.durationDays > 0 && (
        <rect
          x={x}
          y={barY}
          width={
            Math.max(0, width * (1 - task.remainingDays / Math.max(1, task.durationDays)))
          }
          height={BAR_HEIGHT}
          rx={3}
          className="bar-progress"
          pointerEvents="none"
        />
      )}

      {/*
        The name, on the bar. A chart of anonymous rectangles forces everyone to
        read across to the table to know what they are looking at.
      */}
      <text
        x={(task.isMilestone ? x + 10 : x + width + 6)}
        y={y + ROW_HEIGHT / 2}
        className={'bar-label' + (task.isCritical ? ' critical' : '')}
        dominantBaseline="central"
        pointerEvents="none"
      >
        {task.name}
      </text>

      {task.totalFloat > 0 && !task.isMilestone && (
        <line
          x1={x + width}
          y1={y + ROW_HEIGHT / 2}
          x2={timeline.x(task.lateFinish) + timeline.dayWidth}
          y2={y + ROW_HEIGHT / 2}
          className="float-line"
          pointerEvents="none"
        />
      )}
    </g>
  )
}

interface Arrow {
  key: string
  d: string
  critical: boolean
}

/**
 * Orthogonal dependency arrows, drawn from the real link list.
 *
 * Each relationship type attaches at different ends: FS leaves the
 * predecessor's finish and arrives at the successor's start, SS joins the two
 * starts, and so on. Getting this from stored links rather than inferring it
 * from dates matters — dates that happen to line up are not a dependency, and
 * an arrow that says otherwise is worse than no arrow.
 */
function buildArrows(
  schedule: Schedule,
  dependencies: Dependency[],
  rowOf: Map<string, number>,
  timeline: Timeline,
): Arrow[] {
  const arrows: Arrow[] = []

  for (const dep of dependencies) {
    const from = schedule.tasks[dep.predecessorId]
    const to = schedule.tasks[dep.successorId]
    if (!from || !to) continue

    const fromRow = rowOf.get(from.id)
    const toRow = rowOf.get(to.id)
    if (fromRow === undefined || toRow === undefined) continue

    const leavesFinish = dep.type === 'FS' || dep.type === 'FF'
    const entersStart = dep.type === 'FS' || dep.type === 'SS'

    const x1 = leavesFinish
      ? timeline.x(from.earlyFinish) + timeline.dayWidth
      : timeline.x(from.earlyStart)
    const x2 = entersStart
      ? timeline.x(to.earlyStart)
      : timeline.x(to.earlyFinish) + timeline.dayWidth

    const y1 = fromRow * ROW_HEIGHT + ROW_HEIGHT / 2
    const y2 = toRow * ROW_HEIGHT + ROW_HEIGHT / 2

    // Route around rather than straight through when the successor sits to the
    // left of its predecessor, which negative lag and SF links both produce.
    const d =
      x2 >= x1
        ? `M ${x1} ${y1} H ${x1 + Math.max(8, (x2 - x1) / 2)} V ${y2} H ${x2}`
        : `M ${x1} ${y1} H ${x1 + 8} V ${(y1 + y2) / 2} H ${x2 - 8} V ${y2} H ${x2}`

    arrows.push({
      key: `${dep.predecessorId}-${dep.successorId}`,
      d,
      critical: from.isCritical && to.isCritical,
    })
  }
  return arrows
}
