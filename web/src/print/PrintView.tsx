import { createTimeline, weekendBands, type Timeline } from '../gantt/timeline.js'
import type {
  Baseline,
  Category,
  Dependency,
  Phase,
  Step,
  ProjectSummary,
  Schedule,
  ScheduledTask,
  TaskDetail,
} from '../api/types.js'
import { PALETTE } from '../gantt/palette.js'
import {
  geometryFor,
  nameColumnWidth,
  PRINT,
  rowsPerPage,
  type Orientation,
  type PaperSize,
} from './paper.js'

const HEALTH_LABEL: Record<string, string> = {
  'on-track': 'On track',
  ahead: 'Ahead of baseline',
  'behind-baseline': 'Behind baseline',
  'at-risk': 'At risk',
}

/**
 * How much of a task's steps a printed sheet carries.
 *
 * "expanded" follows what is open on screen, which is what someone means when
 * they expand a task and reach for print. "all" exists so a full set does not
 * require opening fourteen buildings first.
 */
export type StepMode = 'none' | 'expanded' | 'all'

export interface PrintOptions {
  paper: PaperSize
  stepMode: StepMode
  /** The task name beside its bar, as the screen draws it. */
  showLabels: boolean
  /**
   * Print only one category's work, or null for all.
   *
   * This is the sheet you hand a subcontractor: their rows, their dates, and
   * nothing they have to read past. The title block says which filter is on,
   * so a partial schedule can never be mistaken for the whole job.
   */
  onlyCategory: string | null
  orientation: Orientation
  title: string
  subtitle: string
  showDates: boolean
  showSummary: boolean
  showLegend: boolean
}

interface Props {
  options: PrintOptions
  schedule: Schedule
  details: Record<string, TaskDetail>
  phases: Phase[]
  categories: Category[]
  /** Task id -> category id. */
  categoryOf: Map<string, string>
  /** Needed on a filtered sheet, to show what the filtered work is waiting on. */
  dependencies: Dependency[]
  steps: Step[]
  /** Which tasks are open on screen, for `stepMode: 'expanded'`. */
  expandedTasks: Set<string>
  baseline: Baseline | null
  summary: ProjectSummary | null
  /** Screen row order, so paper and screen agree. */
  order: ScheduledTask[]
}

/**
 * The printed schedule.
 *
 * A separate renderer rather than a print stylesheet over the live chart. The
 * screen Gantt carries drag zones, hover affordances, a what-if preview layer
 * and virtualised scrolling — none of which mean anything on paper, and all of
 * which would have to be unpicked by CSS that then breaks whenever the screen
 * version changes. Rendering the same data at page geometry is less code and
 * far less fragile.
 *
 * It shares `createTimeline` with the screen, so a bar lands in the same place
 * relative to its dates in both. That matters: the printout is the thing people
 * argue about in a site meeting, and it has to match what the planner saw.
 */
export function PrintView({
  options,
  schedule,
  details,
  phases,
  categories,
  categoryOf,
  dependencies,
  steps,
  expandedTasks,
  baseline,
  summary,
  order,
}: Props) {
  const geometry = geometryFor(options.paper, options.orientation)
  const perPage = rowsPerPage(geometry)

  const tableWidth = nameColumnWidth(geometry) + (options.showDates ? PRINT.dateColumns : 0)
  // Breathing room between the last text column and the first date tick, which
  // otherwise print on top of each other.
  const GUTTER = 10
  const chartWidth = geometry.contentWidth - tableWidth

  // No padding, no clamp: every pixel of sheet goes to real project time.
  const span = createTimeline(schedule.projectStart, schedule.projectFinish, 1, {
    pad: false,
    clamp: false,
  })
  const timeline = createTimeline(
    schedule.projectStart,
    schedule.projectFinish,
    chartWidth / Math.max(1, span.totalDays),
    { pad: false, clamp: false },
  )

  const only = options.onlyCategory
  const onlyName = only ? (categories.find((c) => c.id === only)?.name ?? null) : null

  /*
   * A filtered sheet carries the work it is waiting on, as well as its own.
   *
   * Without this it says "starts the 10th" and gives no reason — and on a real
   * job the reason is usually another trade. The hotel closedown has
   * "Winterise plumbing" waiting on both Housekeeping and F&B; a Maintenance
   * sheet that omitted them would be handing someone a date with the cause
   * removed, which is the opposite of what this product is for.
   *
   * Only *direct* predecessors. Following the chain further would drag most of
   * the schedule back onto the page and defeat the filter.
   */
  const mine = new Set(
    only ? order.filter((t) => categoryOf.get(t.id) === only).map((t) => t.id) : [],
  )
  const waitingOn = new Set<string>()
  if (only) {
    for (const d of dependencies) {
      if (mine.has(d.successorId) && !mine.has(d.predecessorId)) waitingOn.add(d.predecessorId)
    }
  }
  const rows = only ? order.filter((t) => mine.has(t.id) || waitingOn.has(t.id)) : order

  /*
   * Steps are woven into the row list, exactly as the screen does it, so the
   * table and the chart stay on one flat sequence of rows. A printed sheet
   * has no scrolling to keep in sync, but the two columns still have to agree
   * line for line.
   */
  const stepsByTask = new Map<string, Step[]>()
  for (const step of [...steps].sort((a, b) => a.sortOrder - b.sortOrder)) {
    const list = stepsByTask.get(step.taskId)
    if (list) list.push(step)
    else stepsByTask.set(step.taskId, [step])
  }

  const showStepsFor = (taskId: string): boolean => {
    if (options.stepMode === 'none') return false
    if (options.stepMode === 'all') return true
    return expandedTasks.has(taskId)
  }

  type PrintRow = { task: ScheduledTask; step: Step | null }
  const allRows: PrintRow[] = []
  for (const task of rows) {
    allRows.push({ task, step: null })
    if (!showStepsFor(task.id)) continue
    for (const step of stepsByTask.get(task.id) ?? []) allRows.push({ task, step })
  }

  const pages: PrintRow[][] = []
  for (let i = 0; i < allRows.length; i += perPage) pages.push(allRows.slice(i, i + perPage))
  if (pages.length === 0) pages.push([])

  // Palette key -> printed colours, for the stripe beside each bar.
  const byKey = new Map(PALETTE.map((p) => [p.key, p]))
  const colourFor = new Map(
    categories.map((c) => [c.id, byKey.get(c.colour) ?? byKey.get('slate')!]),
  )
  const stripes = new Map<string, string>()
  for (const task of rows) {
    const colour = colourFor.get(categoryOf.get(task.id) ?? '')
    if (colour) stripes.set(task.id, colour.stripe)
  }

  const phaseName = new Map(phases.map((p) => [p.id, p.name]))
  const printedOn = new Date().toISOString().slice(0, 10)
  const totalSheets = pages.length + (options.showSummary && summary ? 1 : 0)

  const titleBlock = (sheet: number) => (
    <div className="print-titleblock" style={{ height: PRINT.titleBlockHeight }}>
      <div className="print-titleblock-main">
        <h1>{options.title}</h1>
        {options.subtitle && <p className="print-subtitle">{options.subtitle}</p>}
        {onlyName && (
          <p className="print-filter">
            {onlyName} only — part of a larger schedule
            {waitingOn.size > 0 && ', with the work it waits on shown in grey'}
          </p>
        )}
      </div>
      <dl className="print-titleblock-meta">
        <div>
          <dt>Start</dt>
          <dd>{schedule.projectStart}</dd>
        </div>
        <div>
          <dt>Finish</dt>
          <dd>{schedule.projectFinish}</dd>
        </div>
        {schedule.dataDate && (
          <div>
            <dt>Data date</dt>
            <dd>{schedule.dataDate}</dd>
          </div>
        )}
        <div>
          <dt>Printed</dt>
          <dd>{printedOn}</dd>
        </div>
        <div>
          <dt>Sheet</dt>
          <dd>
            {sheet} of {totalSheets}
          </dd>
        </div>
      </dl>
    </div>
  )

  return (
    <div className="print-root">
      {/*
        A cover sheet for whoever is not going to read a Gantt chart. Every
        figure on it is computed by the same solver that drew the bars, so it
        cannot drift from them.
      */}
      {options.showSummary && summary && (
        <section
          className="print-page"
          style={{ width: geometry.contentWidth, height: geometry.contentHeight }}
        >
          {titleBlock(1)}
          {/* Two columns, because a single measure of prose on a 17-inch sheet
              is mostly white paper. The figures repeat what the prose says,
              which is the point: one is read, the other is checked. */}
          <div className="print-cover">
            <div className="print-summary">
              <h2>{summary.headline}</h2>
              {summary.paragraphs.map((p, i) => (
                <p key={i}>{p}</p>
              ))}
            </div>
            <dl className="print-facts">
              <dt>Status</dt>
              <dd>{HEALTH_LABEL[summary.facts.health]}</dd>
              <dt>Start</dt>
              <dd>{summary.facts.start}</dd>
              <dt>Forecast finish</dt>
              <dd>{summary.facts.finish}</dd>
              {summary.facts.deadline && (
                <>
                  <dt>Deadline</dt>
                  <dd>
                    {summary.facts.deadline}
                    {summary.facts.deadlineFloat !== null && (
                      <span className={summary.facts.deadlineFloat < 0 ? 'over' : 'spare'}>
                        {summary.facts.deadlineFloat < 0
                          ? ` ${-summary.facts.deadlineFloat}d over`
                          : ` ${summary.facts.deadlineFloat}d spare`}
                      </span>
                    )}
                  </dd>
                </>
              )}
              {summary.facts.baselineFinish && (
                <>
                  <dt>Against baseline</dt>
                  <dd>
                    {summary.facts.baselineFinish}
                    {summary.facts.varianceDays !== null && summary.facts.varianceDays !== 0 && (
                      <span className={summary.facts.varianceDays > 0 ? 'over' : 'spare'}>
                        {summary.facts.varianceDays > 0
                          ? ` ${summary.facts.varianceDays}d later`
                          : ` ${-summary.facts.varianceDays}d earlier`}
                      </span>
                    )}
                  </dd>
                </>
              )}
              <dt>Tasks done</dt>
              <dd>
                {summary.facts.tasksComplete} of {summary.facts.tasksTotal}
                {summary.facts.tasksInProgress > 0 &&
                  ` · ${summary.facts.tasksInProgress} under way`}
              </dd>
              <dt>On the critical path</dt>
              <dd>
                {summary.facts.criticalCount} of {summary.facts.tasksTotal}
              </dd>
            </dl>
          </div>
        </section>
      )}

      {pages.map((pageRows, pageIndex) => (
        <section
          key={pageIndex}
          className="print-page"
          style={{ width: geometry.contentWidth, height: geometry.contentHeight }}
        >
          {/* Repeated on every sheet. A second sheet with no dates along the
              top and no idea which job it belongs to is waste paper. */}
          {titleBlock(pageIndex + 1 + (options.showSummary && summary ? 1 : 0))}

          <div
            className="print-grid"
            style={{ gridTemplateColumns: `${tableWidth - GUTTER}px ${GUTTER}px 1fr` }}
          >
            <div className="print-table-head" style={{ height: PRINT.axisHeight }}>
              <span className="print-col-name">Task</span>
              {options.showDates && (
                <>
                  <span className="print-col-date">Start</span>
                  <span className="print-col-date">Finish</span>
                  <span className="print-col-float">Float</span>
                </>
              )}
            </div>
            <div />
            <Axis timeline={timeline} height={PRINT.axisHeight} width={chartWidth} />

            <div className="print-table">
              {pageRows.map(({ task, step }) => {
                if (step) {
                  return (
                    <div
                      key={step.id}
                      className={'print-row print-step' + (step.isCheck ? ' check' : '')}
                      data-category={categoryOf.get(task.id) ?? ''}
                      data-step="true"
                      style={{ height: PRINT.rowHeight }}
                    >
                      <span className="print-col-name" title={step.name}>
                        <span className="print-step-indent" aria-hidden />
                        {/* A box to tick on a zero-day check, an arrow on work
                            that takes time. The distinction matters on paper:
                            one is something to confirm, the other something to
                            schedule a person for. */}
                        <span className="print-step-mark">{step.isCheck ? '☐' : '↳'}</span>
                        {step.name}
                      </span>
                      {options.showDates && (
                        <>
                          <span className="print-col-date">{step.isCheck ? '' : step.start}</span>
                          <span className="print-col-date">{step.isCheck ? '' : step.finish}</span>
                          <span className="print-col-float" />
                        </>
                      )}
                    </div>
                  )
                }

                const detail = details[task.id]
                const phase = detail?.phaseId ? phaseName.get(detail.phaseId) : null
                return (
                  <div
                    key={task.id}
                    className={
                      'print-row' +
                      (task.isCritical ? ' critical' : '') +
                      (waitingOn.has(task.id) ? ' context' : '')
                    }
                    // Carried in the DOM rather than inferred from the row's
                    // text, which shows the phase. Lets a filtered sheet be
                    // checked precisely rather than by reading names.
                    data-category={categoryOf.get(task.id) ?? ''}
                    style={{ height: PRINT.rowHeight }}
                  >
                    <span className="print-col-name" title={task.name}>
                      {task.isMilestone && <span className="print-diamond">◆</span>}
                      {task.name}
                      {waitingOn.has(task.id) ? (
                        // Whose it is matters more than which phase, on a sheet
                        // where the point of the row is that it is not yours.
                        <span className="print-phase">
                          {' '}
                          · {categories.find((c) => c.id === categoryOf.get(task.id))?.name ??
                            'another trade'}
                        </span>
                      ) : (
                        phase && <span className="print-phase"> · {phase}</span>
                      )}
                    </span>
                    {options.showDates && (
                      <>
                        <span className="print-col-date">{task.earlyStart}</span>
                        <span className="print-col-date">{task.earlyFinish}</span>
                        <span className="print-col-float">{task.totalFloat}</span>
                      </>
                    )}
                  </div>
                )
              })}
            </div>

            <div />
            <Chart
              timeline={timeline}
              width={chartWidth}
              rows={pageRows}
              baseline={baseline}
              rowHeight={PRINT.rowHeight}
              stripes={stripes}
              showLabels={options.showLabels}
            />
          </div>

          {options.showLegend && (
            <div className="print-legend" style={{ height: PRINT.legendHeight }}>
              <span>
                <i className="swatch critical" /> Critical path
              </span>
              <span>
                <i className="swatch normal" /> Has float
              </span>
              {baseline && (
                <span>
                  <i className="swatch ghost" /> Baseline
                </span>
              )}
              <span>
                <i className="swatch complete" /> Complete
              </span>
              <span className="print-legend-note">
                Float is in working days. Dates are the current forecast.
              </span>
            </div>
          )}
        </section>
      ))}
    </div>
  )
}

function Axis({
  timeline,
  height,
  width,
}: {
  timeline: Timeline
  height: number
  width: number
}) {
  // Thinned to what will actually be legible: at a tight fit every tick would
  // overprint its neighbour into a grey smear.
  const ticks = timeline.ticks()
  const minGap = 26
  const kept: typeof ticks = []
  let lastX = -Infinity
  for (const tick of ticks) {
    if (tick.x - lastX < minGap) continue
    kept.push(tick)
    lastX = tick.x
  }

  return (
    <svg className="print-axis" width={width} height={height}>
      {kept.map((tick, i) => (
        <g key={i}>
          <line x1={tick.x} y1={height - 8} x2={tick.x} y2={height} className="print-tick" />
          <text x={tick.x + 2} y={height - 11} className={tick.major ? 'print-tick-major' : ''}>
            {tick.label}
          </text>
        </g>
      ))}
      <line x1={0} y1={height - 0.5} x2={width} y2={height - 0.5} className="print-axis-rule" />
    </svg>
  )
}

/**
 * Roughly how wide a label will be, in px.
 *
 * An estimate rather than a measurement: measuring text means laying it out,
 * and this runs for every bar on every sheet. 0.52em per character is close
 * enough for deciding whether a label fits, which is all it is used for.
 */
function labelWidth(text: string, fontPx: number): number {
  return text.length * fontPx * 0.52
}

function Chart({
  timeline,
  width,
  rows,
  baseline,
  rowHeight,
  stripes,
  showLabels,
}: {
  timeline: Timeline
  width: number
  rows: Array<{ task: ScheduledTask; step: Step | null }>
  baseline: Baseline | null
  rowHeight: number
  /** Task id -> stripe colour, already resolved from the palette. */
  stripes: Map<string, string>
  showLabels: boolean
}) {
  const height = rows.length * rowHeight
  const barHeight = rowHeight - 7
  // Already keyed by task id, same as the screen chart reads it.
  const bands = weekendBands(timeline)

  return (
    <svg className="print-chart" width={width} height={height}>
      {/* Weekends, so the chart reads as working time rather than calendar
          days. Dropped automatically at month granularity, where they would
          be sub-pixel stripes. */}
      {bands.map((band, i) => (
        <rect
          key={i}
          x={band.x}
          y={0}
          width={band.width}
          height={height}
          className="print-weekend"
        />
      ))}

      {/*
        Vertical rules at the labelled ticks.
        On paper this matters more than on screen: there is no pointer to hover
        for a date, so the only way to read when a bar starts is to carry the
        eye up to the axis. Across a seventeen-inch sheet that is not a
        reasonable thing to ask, and a printed Gantt without gridlines is the
        usual reason people end up annotating one by hand with a ruler.
      */}
      {timeline
        .ticks()
        .filter((t) => t.major)
        .map((tick) => (
          <line
            key={`grid-${tick.x}`}
            x1={tick.x}
            y1={0}
            x2={tick.x}
            y2={height}
            className="print-grid-line"
          />
        ))}

      {rows.map(({ task, step }, i) => {
        const y = i * rowHeight

        // A step's bar: slighter than its task's, and a tick rather than a bar
        // when it takes no time.
        if (step) {
          const sx = timeline.x(step.start)
          const sw = Math.max(1, timeline.x(step.finish) + timeline.dayWidth - sx)
          return (
            <g key={step.id}>
              <rect x={0} y={y} width={width} height={rowHeight} className="print-row-band light" />
              {step.isCheck ? (
                <circle cx={sx + 2} cy={y + rowHeight / 2} r={2} className="print-step-check" />
              ) : (
                <rect x={sx} y={y + 6} width={sw} height={rowHeight - 12} className="print-step-bar" />
              )}
            </g>
          )
        }

        const x = timeline.x(task.earlyStart)
        const w = Math.max(1, timeline.x(task.earlyFinish) + timeline.dayWidth - x)
        const ghost = baseline?.tasks[task.id] ?? null
        const classes = ['print-bar']
        if (task.isCritical) classes.push('critical')
        if (task.status === 'complete') classes.push('complete')

        /*
         * The task name beside its bar.
         *
         * Worth more on paper than on screen: on a seventeen-inch sheet,
         * tracking from a bar back across fourteen inches to the name column
         * is genuinely hard, and every serious Gantt printout puts the name
         * at the bar.
         *
         * Placed after the bar when there is room, before it when there is
         * room on that side instead, and dropped when there is neither.
         * A label that runs off the sheet or over the next bar is worse than
         * no label — it prints as a smear and the sheet looks broken.
         */
        const LABEL_PX = 7
        const needed = labelWidth(task.name, LABEL_PX) + 6
        const fitsAfter = x + w + needed < width
        const fitsBefore = x - needed > 0
        const label = !showLabels || task.isMilestone
          ? null
          : fitsAfter
            ? { x: x + w + 3, anchor: 'start' as const }
            : fitsBefore
              ? { x: x - 3, anchor: 'end' as const }
              : null

        return (
          <g key={task.id}>
            {i % 2 === 1 && (
              <rect x={0} y={y} width={width} height={rowHeight} className="print-row-band" />
            )}

            {ghost && (
              <rect
                x={timeline.x(ghost.start)}
                y={y + barHeight + 2}
                width={Math.max(1, timeline.x(ghost.finish) + timeline.dayWidth - timeline.x(ghost.start))}
                height={3}
                className="print-ghost"
              />
            )}

            {task.isMilestone ? (
              <path
                d={`M ${x} ${y + rowHeight / 2 - 4} l 4 4 l -4 4 l -4 -4 Z`}
                className={task.isCritical ? 'print-milestone critical' : 'print-milestone'}
              />
            ) : (
              <>
                <rect x={x} y={y + 3} width={w} height={barHeight} className={classes.join(' ')} />
                {/* Which trade owns it. Printed as a solid edge rather than a
                    fill, so the critical path keeps its monopoly on colour
                    even on paper. */}
                {stripes.get(task.id) && (
                  <rect
                    x={x}
                    y={y + 3}
                    width={2}
                    height={barHeight}
                    style={{ fill: stripes.get(task.id)! }}
                  />
                )}
              </>
            )}

            {label && (
              <text
                x={label.x}
                y={y + rowHeight / 2 + 2.5}
                textAnchor={label.anchor}
                className={task.isCritical ? 'print-bar-label critical' : 'print-bar-label'}
              >
                {task.name}
              </text>
            )}
          </g>
        )
      })}
    </svg>
  )
}
