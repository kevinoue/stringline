import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Baseline, Category, Dependency, Schedule, ScheduledTask, Step } from '../api/types.js'
import { PALETTE } from './palette.js'
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

  /** Category id per task, for the edge stripe and for focusing. */
  categoryOf: Map<string, string>
  categories: Category[]
  /**
   * The category being focused on, or null for all.
   *
   * Focusing dims everything else rather than hiding it — a foreman wants to
   * see their work *in context*, with what runs before and after it still
   * visible. Hiding the rest would answer a different question.
   */
  focusCategory: string | null
  /**
   * Step rows by id. `order` interleaves step ids among task ids when a task
   * is expanded, so anything found here draws as a step and anything else as
   * a task. Keeping both panes on one flat list of row ids is what keeps them
   * scrolling in lockstep.
   */
  steps: Map<string, Step>
  hasSteps: Set<string>
  expanded: Set<string>
  onToggle(taskId: string): void
  /**
   * Which dimension owns colour. Never both: the chart has one rule — critical
   * is the only saturated colour — and two colour systems competing for
   * attention means neither is readable.
   */
  colourBy: 'critical' | 'category'
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
  categoryOf,
  categories,
  focusCategory,
  colourBy,
  steps,
  hasSteps,
  expanded,
  onToggle,
}: Props) {
  const headerRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  /** Palette key -> actual colours, resolved once rather than per bar. */
  const colourFor = useMemo(() => {
    const byKey = new Map(PALETTE.map((p) => [p.key, p]))
    return new Map(
      categories.map((c) => [c.id, byKey.get(c.colour) ?? byKey.get('slate')!]),
    )
  }, [categories])
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

  /*
   * Where today falls on the scale, or null when it is off the chart.
   *
   * The ISO string comes from the local clock deliberately — "today" is a
   * human's today, not UTC's. Everything downstream of it stays in the
   * timeline's day-index space, so this is the only place a real clock is
   * read.
   */
  const todayX = useMemo(() => {
    const today = new Date()
    const iso = [
      today.getFullYear(),
      String(today.getMonth() + 1).padStart(2, '0'),
      String(today.getDate()).padStart(2, '0'),
    ].join('-')
    const x = timeline.x(iso)
    return x >= 0 && x <= timeline.width ? x : null
  }, [timeline])
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

          {/*
            Row banding, behind everything.
            Drawn here as full-width stripes rather than per row, because the
            rows are virtualised: a band attached to a row would appear and
            disappear as you scrolled, which is far more distracting than no
            banding at all. Parity is taken from the absolute row index so a
            stripe stays with its row.
          */}
          {Array.from({ length: lastRow - firstRow }, (_, i) => firstRow + i)
            .filter((row) => row % 2 === 1)
            .map((row) => (
              <rect
                key={`band-${row}`}
                x={0}
                y={row * ROW_HEIGHT}
                width={timeline.width}
                height={ROW_HEIGHT}
                className="row-band"
              />
            ))}

          {/*
            Vertical rules at the major ticks — the weeks or months the axis
            labels.
            Without them a bar fourteen inches from the date column has nothing
            to be read against, which is the single biggest legibility gap on a
            wide chart. Snapped to a half-pixel: a 1px stroke on a whole
            coordinate straddles two device pixels and renders as a soft 2px
            smear, and a chart full of those is what "not high definition"
            actually looks like.
          */}
          <g className="grid">
            {timeline.ticks().filter((t) => t.major).map((tick) => (
              <line
                key={`grid-${tick.x}`}
                x1={Math.round(tick.x) + 0.5}
                y1={0}
                x2={Math.round(tick.x) + 0.5}
                y2={bodyHeight}
                className="grid-line"
              />
            ))}
          </g>

          {/*
            Today.
            Not the same thing as the data date and must not look like it: the
            data date is when the schedule was last brought current, today is
            today. On a schedule nobody has updated for a month the gap between
            those two lines is the most useful thing on the chart.
          */}
          {todayX !== null && (
            <line
              x1={Math.round(todayX) + 0.5}
              y1={0}
              x2={Math.round(todayX) + 0.5}
              y2={bodyHeight}
              className="today-line"
            />
          )}

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
            const step = steps.get(taskId)
            if (step) {
              return (
                <StepRow
                  key={taskId}
                  step={step}
                  y={rowOf.get(taskId)! * ROW_HEIGHT}
                  timeline={timeline}
                  parentCritical={schedule.tasks[step.taskId]?.isCritical ?? false}
                  onSelect={handleSelect}
                />
              )
            }

            const task = schedule.tasks[taskId]
            if (!task) return null
            const row = rowOf.get(taskId)!
            const y = row * ROW_HEIGHT
            return (
              <TaskRow
                key={taskId}
                task={task}
                categoryColour={colourFor.get(categoryOf.get(taskId) ?? '') ?? null}
                dimmed={focusCategory !== null && categoryOf.get(taskId) !== focusCategory}
                colourBy={colourBy}
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
                expandable={hasSteps.has(taskId)}
                expanded={expanded.has(taskId)}
                onToggle={onToggle}
              />
            )
          })}
        </svg>
      </div>
    </div>
  )
}

/**
 * A step's bar, drawn inside its parent's span.
 *
 * Deliberately slighter than a task bar: a step is part of a task, not a peer
 * of one, and drawing them the same height makes an expanded task look like
 * five tasks. A zero-day step gets a mark rather than a bar, because it takes
 * no time and a bar would say otherwise.
 */
function StepRow({
  step,
  y,
  timeline,
  parentCritical,
  onSelect,
}: {
  step: Step
  y: number
  timeline: Timeline
  parentCritical: boolean
  onSelect(id: string): void
}) {
  const x = timeline.x(step.start)
  const height = 8
  const barY = y + (ROW_HEIGHT - height) / 2

  const classes = ['step-bar']
  if (parentCritical) classes.push('critical')
  if (step.status === 'complete') classes.push('complete')

  return (
    <g className="row step" onClick={() => onSelect(step.taskId)} data-step={step.id}>
      <rect x={0} y={y} width={timeline.width} height={ROW_HEIGHT} className="row-bg" />
      {step.isCheck ? (
        <circle
          cx={x + 3}
          cy={y + ROW_HEIGHT / 2}
          r={3}
          className={step.status === 'complete' ? 'step-check done' : 'step-check'}
        />
      ) : (
        <rect
          x={x}
          y={barY}
          width={Math.max(2, timeline.x(step.finish) + timeline.dayWidth - x)}
          height={height}
          rx={2}
          className={classes.join(' ')}
        />
      )}
      <text x={x + 10} y={y + ROW_HEIGHT / 2 + 3} className="step-label">
        {step.name}
      </text>
    </g>
  )
}

interface RowProps {
  task: ScheduledTask
  categoryColour: { hex: string; stripe: string } | null
  dimmed: boolean
  colourBy: 'critical' | 'category'
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
  /** Whether this task has steps to show, and whether they are showing. */
  expandable: boolean
  expanded: boolean
  onToggle(taskId: string): void
}

function TaskRow({
  task,
  categoryColour,
  dimmed,
  colourBy,
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
  expandable,
  expanded,
  onToggle,
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
  /*
   * Faded, not hidden. Focusing on one trade should still show what runs
   * before and after it — that context is most of the answer to "where do I
   * fit", and hiding the rest answers a different question.
   *
   * Critical work fades less far. If the trade you are looking at is waiting
   * on something on the critical path, that is the most important thing on
   * the screen, and at 18% it had disappeared. A middle opacity rather than
   * full colour, because on a late project most tasks are critical and
   * exempting them outright would un-fade half the chart.
   */
  if (dimmed) classes.push(task.isCritical ? 'dimmed-critical' : 'dimmed')

  /*
   * In category mode the fill is overridden inline, because the colour is data
   * rather than a stylesheet decision. Completed work keeps its grey either
   * way: it is finished, and colouring it by trade would draw the eye to work
   * nobody needs to look at.
   */
  const categoryFill =
    colourBy === 'category' && categoryColour && task.status !== 'complete'
      ? categoryColour.hex
      : undefined

  return (
    <g
      className={'row' + (expandable ? ' expandable' : '')}
      onClick={() => onSelect(task.id)}
      // Double-click, not single: a single click selects the task and opens
      // the editor, and a bar is also the drag target. Expanding on single
      // click would fire every time someone grabbed one.
      onDoubleClick={expandable ? () => onToggle(task.id) : undefined}
      data-task={task.id}
      data-expanded={expandable ? expanded : undefined}
    >
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
            style={categoryFill ? { cursor: 'grab', fill: categoryFill } : { cursor: 'grab' }}
          />

          {/*
            The category stripe, always on whichever colour mode is active.
            Two pixels at the leading edge: enough to scan a column of bars and
            see which trade owns what, too small to compete with the critical
            path for attention.
          */}
          {categoryColour && !task.isMilestone && (
            <rect
              x={x}
              y={barY}
              width={2.5}
              height={BAR_HEIGHT}
              className={
                'bar-stripe' + (dimmed ? (task.isCritical ? ' dimmed-critical' : ' dimmed') : '')
              }
              style={{ fill: categoryColour.stripe }}
              pointerEvents="none"
            />
          )}
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
