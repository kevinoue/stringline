import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { api, ApiError } from '../api/client.js'
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
import { Checklist } from './Checklist.js'
import { PrintView, type PrintOptions, type StepMode } from './PrintView.js'
import {
  fitDayWidth,
  geometryFor,
  isDense,
  PAPER_SIZES,
  rowsPerPage,
  type Orientation,
} from './paper.js'

interface Props {
  projectId: string
  projectName: string
  printTitle: string | null
  printSubtitle: string | null
  schedule: Schedule
  details: Record<string, TaskDetail>
  phases: Phase[]
  categories: Category[]
  categoryOf: Map<string, string>
  categoryLabel: string
  dependencies: Dependency[]
  steps: Step[]
  expandedTasks: Set<string>
  baseline: Baseline | null
  summary: ProjectSummary | null
  order: ScheduledTask[]
  onClose(): void
}

/**
 * Set up a print, then hand off to the browser.
 *
 * No PDF library. `window.print()` plus a `@page` rule gets a vector PDF out of
 * every browser's own Save-as-PDF, which is better output than a server-side
 * renderer would produce and costs nothing to maintain. The chart being SVG is
 * what makes that work — it scales to the sheet without going soft.
 */
export function PrintDialog({
  projectId,
  projectName,
  printTitle,
  printSubtitle,
  schedule,
  details,
  phases,
  categories,
  categoryOf,
  categoryLabel,
  dependencies,
  steps,
  expandedTasks,
  baseline,
  summary,
  order,
  onClose,
}: Props) {
  const [paperId, setPaperId] = useState('tabloid')
  const [orientation, setOrientation] = useState<Orientation>('landscape')
  const [title, setTitle] = useState(printTitle ?? projectName)
  const [subtitle, setSubtitle] = useState(printSubtitle ?? '')
  const [showDates, setShowDates] = useState(true)
  const [showSummary, setShowSummary] = useState(true)
  const [showLegend, setShowLegend] = useState(true)
  const [onlyCategory, setOnlyCategory] = useState<string | null>(null)
  /** Gantt sheet, or a stack of checklists. Two documents, not two views. */
  const [mode, setMode] = useState<'chart' | 'checklist'>('chart')
  const [stepMode, setStepMode] = useState<StepMode>('expanded')
  const [showLabels, setShowLabels] = useState(true)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /** What the server already holds, so a blur with no edit sends nothing. */
  const [persisted, setPersisted] = useState({
    title: printTitle ?? projectName,
    subtitle: printSubtitle ?? '',
  })

  const paper = PAPER_SIZES.find((p) => p.id === paperId)!
  const options: PrintOptions = {
    paper,
    orientation,
    title,
    subtitle,
    showDates,
    showSummary,
    showLegend,
    onlyCategory,
    // A trade's sheet is a work packet, so it carries the detail by default.
    // The whole-schedule sheet follows what is open on screen.
    stepMode: onlyCategory ? 'all' : stepMode,
    showLabels,
  }

  const stepsByTask = (() => {
    const map = new Map<string, Step[]>()
    for (const step of [...steps].sort((a, b) => a.sortOrder - b.sortOrder)) {
      const list = map.get(step.taskId)
      if (list) list.push(step)
      else map.set(step.taskId, [step])
    }
    return map
  })()

  /*
   * Which tasks get a checklist.
   *
   * Only ones with steps — a sheet listing a single line is a waste of paper
   * and of someone's attention. Filtered by trade when one is chosen, which
   * is what makes the packet: every Maintenance task, one page each, handed
   * over as a folder on day one.
   */
  const checklistTasks = order.filter(
    (t) =>
      (stepsByTask.get(t.id)?.length ?? 0) > 0 &&
      (!onlyCategory || categoryOf.get(t.id) === onlyCategory),
  )

  const geometry = geometryFor(paper, orientation)
  const perPage = rowsPerPage(geometry)
  // Has to reflect the filter, or the sheet count on screen is a lie.
  const printedRows = (() => {
    if (!onlyCategory) return order.length
    const mine = new Set(
      order.filter((t) => categoryOf.get(t.id) === onlyCategory).map((t) => t.id),
    )
    // Plus the other trades' work it waits on, which the sheet also carries.
    const waiting = new Set(
      dependencies
        .filter((d) => mine.has(d.successorId) && !mine.has(d.predecessorId))
        .map((d) => d.predecessorId),
    )
    return mine.size + waiting.size
  })()
  const sheets =
    mode === 'checklist'
      ? checklistTasks.length
      : Math.max(1, Math.ceil(printedRows / perPage)) + (showSummary && summary ? 1 : 0)

  // Span, not the padded screen timeline: this is how many days of real project
  // have to fit between the task column and the right margin.
  const totalDays =
    Math.round(
      (Date.parse(schedule.projectFinish) - Date.parse(schedule.projectStart)) / 86_400_000,
    ) + 1
  const dayWidth = fitDayWidth(geometry, totalDays, showDates)

  /**
   * The `@page` rule has to be injected rather than written in the stylesheet,
   * because the sheet size is chosen at runtime and `@page` cannot read a CSS
   * custom property. Replaced on every change and removed on close, so a stale
   * rule cannot outlive the dialog and silently reshape a later print.
   */
  useEffect(() => {
    const style = document.createElement('style')
    style.id = 'stringline-page-rule'
    const longEdge = Math.max(paper.widthIn, paper.heightIn)
    const shortEdge = Math.min(paper.widthIn, paper.heightIn)
    const [w, h] =
      orientation === 'landscape' ? [longEdge, shortEdge] : [shortEdge, longEdge]
    style.textContent = `@page { size: ${w}in ${h}in; margin: 0.5in; }`
    document.head.append(style)
    return () => style.remove()
  }, [paper, orientation])

  /**
   * Save the title block on blur, not only on print.
   *
   * The hint under these fields promises they are kept with the project. If
   * saving happened only on the way to the printer, typing a revision line and
   * then closing the dialog would quietly discard it — and the next print
   * would start from a blank line having just been told it would not.
   *
   * An empty title means "no override", so the project name is used. Sending
   * the project name verbatim would freeze it: renaming the project later
   * would leave the old name on the paper.
   */
  const persistTitleBlock = async (): Promise<void> => {
    if (title === persisted.title && subtitle === persisted.subtitle) return
    try {
      await api.updateProject(projectId, {
        printTitle: title === projectName ? '' : title,
        printSubtitle: subtitle,
      })
      setPersisted({ title, subtitle })
      setSaved(true)
      setTimeout(() => setSaved(false), 1800)
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e))
    }
  }

  const print = async (): Promise<void> => {
    await persistTitleBlock().catch(() => {})
    // A frame for the layout to settle at the new page size before the browser
    // snapshots it. Printing mid-reflow produces a clipped first sheet.
    requestAnimationFrame(() => requestAnimationFrame(() => window.print()))
  }

  return (
    <>
      <div className="modal-backdrop" onClick={onClose}>
        <div className="modal modal-wide print-dialog" onClick={(e) => e.stopPropagation()}>
          <h2>Print</h2>

          {error && <p className="error">{error}</p>}

          {/* The first choice, because it changes what the rest of the dialog
              is for. A chart answers "when does this happen"; a checklist
              answers "what am I doing today and what do I write down". */}
          <div className="print-mode">
            <button
              type="button"
              className={mode === 'chart' ? 'active' : ''}
              onClick={() => setMode('chart')}
            >
              Schedule chart
            </button>
            <button
              type="button"
              className={mode === 'checklist' ? 'active' : ''}
              onClick={() => setMode('checklist')}
            >
              Checklists
            </button>
          </div>
          {mode === 'checklist' && (
            <p className="hint">
              One sheet per task, with its steps as tick-boxes and room to write what was found.
              Each carries a short reference so what comes back can be typed in without matching
              on names.
            </p>
          )}

          <div className="print-options">
            <label>
              Paper
              <select value={paperId} onChange={(e) => setPaperId(e.target.value)}>
                {PAPER_SIZES.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Orientation
              <select
                value={orientation}
                onChange={(e) => setOrientation(e.target.value as Orientation)}
              >
                <option value="landscape">Landscape</option>
                <option value="portrait">Portrait</option>
              </select>
            </label>
          </div>

          <label>
            Title on the printout
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onBlur={() => void persistTitleBlock()}
            />
          </label>
          <label>
            Subtitle
            <input
              value={subtitle}
              onChange={(e) => setSubtitle(e.target.value)}
              onBlur={() => void persistTitleBlock()}
              placeholder="Rev C — issued for construction"
            />
          </label>
          <p className="hint">
            Kept with the project, so the next print starts where this one left off. This changes
            the paper only — to rename the project itself, click its name in the toolbar.
            {saved && <strong> Saved.</strong>}
          </p>

          {categories.length > 0 && (
            <label>
              Print only
              <select
                value={onlyCategory ?? ''}
                onChange={(e) => setOnlyCategory(e.target.value || null)}
              >
                <option value="">The whole schedule</option>
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name} only
                  </option>
                ))}
              </select>
            </label>
          )}
          {onlyCategory && (
            <p className="hint">
              One {categoryLabel.toLowerCase()}&apos;s work, for handing to them — plus whatever
              they are waiting on, in grey, so a date never appears without its reason. The title
              block says the sheet is partial, in case it travels without you.
            </p>
          )}

          {mode === 'chart' && (
            <label>
              Steps
              <select
                value={onlyCategory ? 'all' : stepMode}
                disabled={Boolean(onlyCategory)}
                onChange={(e) => setStepMode(e.target.value as StepMode)}
              >
                <option value="none">Don&apos;t show them</option>
                <option value="expanded">The ones I&apos;ve expanded</option>
                <option value="all">All of them</option>
              </select>
            </label>
          )}
          {mode === 'chart' && onlyCategory && (
            <p className="hint">
              A single {categoryLabel.toLowerCase()}&apos;s sheet always carries every step — it is
              a work packet, and detail is the point of it.
            </p>
          )}

          <div className="print-toggles">
            {mode === 'chart' && (
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={showLabels}
                  onChange={(e) => setShowLabels(e.target.checked)}
                />
                Task names beside the bars
              </label>
            )}
            <label className="checkbox">
              <input
                type="checkbox"
                checked={showDates}
                onChange={(e) => setShowDates(e.target.checked)}
                disabled={mode === 'checklist'}
              />
              Date and float columns
            </label>
            <label className="checkbox">
              <input
                type="checkbox"
                checked={showSummary}
                onChange={(e) => setShowSummary(e.target.checked)}
                disabled={!summary || mode === 'checklist'}
              />
              Summary cover sheet
            </label>
            <label className="checkbox">
              <input
                type="checkbox"
                checked={showLegend}
                onChange={(e) => setShowLegend(e.target.checked)}
                disabled={mode === 'checklist'}
              />
              Legend
            </label>
          </div>

          <p className="hint">
            {mode === 'checklist' ? (
              sheets === 0 ? (
                <>Nothing to print — no task here has steps yet.</>
              ) : (
                <>
                  {sheets} {sheets === 1 ? 'checklist' : 'checklists'}, one task per page
                  {onlyCategory ? ', for that one trade' : ''}
                </>
              )
            ) : (
              <>
                {sheets} {sheets === 1 ? 'sheet' : 'sheets'} · {printedRows} tasks ·{' '}
                {perPage} per sheet · whole project fits the width
            {isDense(dayWidth) && (
              // Not blocked. Someone printing a two-year programme as a
              // one-page overview knows what they are asking for.
              <>
                {' '}
                — <strong>but it will be tight.</strong> Try the week or month axis for
                something more readable.
              </>
            )}
              </>
            )}
          </p>

          <div className="modal-actions">
            <button
              className="ghost"
              onClick={() => {
                // Catches an edit still focused when the button is hit — blur
                // does not always fire before a click on another element.
                void persistTitleBlock().finally(onClose)
              }}
            >
              Close
            </button>
            <button onClick={() => void print()}>Print…</button>
          </div>
        </div>
      </div>

      {/*
        Portalled to <body>, deliberately — not rendered in place.
        The print stylesheet hides `#root` to get the app chrome off the paper,
        and this layout lives inside `#root` like everything else React renders.
        Left there it was hidden along with the app, and the printed PDF came
        out blank. A sibling of `#root` is hidden by nothing.

        Worth knowing: `getComputedStyle` on this element still reported
        `display: block` while it was invisible, because a computed style says
        nothing about a hidden ancestor. The only check that caught it was
        looking at the PDF.
      */}
      {createPortal(
        <div className="print-only">
          {mode === 'checklist' ? (
            <Checklist
              tasks={checklistTasks}
              stepsByTask={stepsByTask}
              details={details}
              schedule={schedule}
              dependencies={dependencies}
              phases={phases}
              categories={categories}
              categoryOf={categoryOf}
              projectTitle={title}
              subtitle={subtitle}
              paper={paper}
              orientation={orientation}
            />
          ) : (
            <PrintView
              options={options}
              schedule={schedule}
              details={details}
              phases={phases}
              categories={categories}
              categoryOf={categoryOf}
              dependencies={dependencies}
              steps={steps}
              expandedTasks={expandedTasks}
              baseline={baseline}
              summary={summary}
              order={order}
            />
          )}
        </div>,
        document.body,
      )}
    </>
  )
}
