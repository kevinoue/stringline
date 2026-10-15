import { createTimeline, weekendBands, type Timeline } from '../gantt/timeline.js'
import type {
  Baseline,
  Phase,
  ProjectSummary,
  Schedule,
  ScheduledTask,
  TaskDetail,
} from '../api/types.js'
import { geometryFor, PRINT, rowsPerPage, type Orientation, type PaperSize } from './paper.js'

const HEALTH_LABEL: Record<string, string> = {
  'on-track': 'On track',
  ahead: 'Ahead of baseline',
  'behind-baseline': 'Behind baseline',
  'at-risk': 'At risk',
}

export interface PrintOptions {
  paper: PaperSize
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
  baseline,
  summary,
  order,
}: Props) {
  const geometry = geometryFor(options.paper, options.orientation)
  const perPage = rowsPerPage(geometry)

  const tableWidth = PRINT.nameColumn + (options.showDates ? PRINT.dateColumns : 0)
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

  const pages: ScheduledTask[][] = []
  for (let i = 0; i < order.length; i += perPage) pages.push(order.slice(i, i + perPage))
  if (pages.length === 0) pages.push([])

  const phaseName = new Map(phases.map((p) => [p.id, p.name]))
  const printedOn = new Date().toISOString().slice(0, 10)
  const totalSheets = pages.length + (options.showSummary && summary ? 1 : 0)

  const titleBlock = (sheet: number) => (
    <div className="print-titleblock" style={{ height: PRINT.titleBlockHeight }}>
      <div className="print-titleblock-main">
        <h1>{options.title}</h1>
        {options.subtitle && <p className="print-subtitle">{options.subtitle}</p>}
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

      {pages.map((rows, pageIndex) => (
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
              {rows.map((task) => {
                const detail = details[task.id]
                const phase = detail?.phaseId ? phaseName.get(detail.phaseId) : null
                return (
                  <div
                    key={task.id}
                    className={'print-row' + (task.isCritical ? ' critical' : '')}
                    style={{ height: PRINT.rowHeight }}
                  >
                    <span className="print-col-name" title={task.name}>
                      {task.isMilestone && <span className="print-diamond">◆</span>}
                      {task.name}
                      {phase && <span className="print-phase"> · {phase}</span>}
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
              rows={rows}
              baseline={baseline}
              rowHeight={PRINT.rowHeight}
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

function Chart({
  timeline,
  width,
  rows,
  baseline,
  rowHeight,
}: {
  timeline: Timeline
  width: number
  rows: ScheduledTask[]
  baseline: Baseline | null
  rowHeight: number
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

      {rows.map((task, i) => {
        const y = i * rowHeight
        const x = timeline.x(task.earlyStart)
        const w = Math.max(1, timeline.x(task.earlyFinish) + timeline.dayWidth - x)
        const ghost = baseline?.tasks[task.id] ?? null
        const classes = ['print-bar']
        if (task.isCritical) classes.push('critical')
        if (task.status === 'complete') classes.push('complete')

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
              <rect x={x} y={y + 3} width={w} height={barHeight} className={classes.join(' ')} />
            )}
          </g>
        )
      })}
    </svg>
  )
}
