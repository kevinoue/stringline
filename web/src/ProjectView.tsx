import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { api, ApiError, SOURCE_URL } from './api/client.js'
import type {
  Baseline,
  Dependency,
  Impact,
  ProjectSummary,
  Schedule,
  Phase,
  TaskDetail,
} from './api/types.js'
import { ImpactBanner } from './components/ImpactBanner.js'
import { SummaryPanel } from './components/SummaryPanel.js'
import { Phases } from './components/Phases.js'
import { TaskPanel } from './components/TaskPanel.js'
import { TaskTable } from './components/TaskTable.js'
import { Gantt, type DragResult } from './gantt/Gantt.js'
import { clampDayWidth, MAX_DAY_WIDTH, MIN_DAY_WIDTH, ZOOM_WIDTH, type Zoom } from './gantt/timeline.js'

const HEADER_HEIGHT = 44
/** Used only until the split pane has been measured. */
const FALLBACK_CHART_HEIGHT = 520

interface PendingWhatIf {
  taskId: string
  description: string
  patch: Record<string, unknown>
  schedule: Schedule
  currentFinish: string
  hypotheticalFinish: string
  affected: string[]
  warnings: string[]
}

export function ProjectView({ projectId, onBack }: { projectId: string; onBack(): void }) {
  const [schedule, setSchedule] = useState<Schedule | null>(null)
  const [baseline, setBaseline] = useState<Baseline | null>(null)
  const [dependencies, setDependencies] = useState<Dependency[]>([])
  const [details, setDetails] = useState<Record<string, TaskDetail>>({})
  const [phases, setPhases] = useState<Phase[]>([])
  const [summary, setSummary] = useState<ProjectSummary | null>(null)
  const [summaryOpen, setSummaryOpen] = useState(true)
  const [dayWidth, setDayWidth] = useState<number>(ZOOM_WIDTH.day)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [impact, setImpact] = useState<{ impact: Impact | null; moved: number } | null>(null)
  const [pending, setPending] = useState<PendingWhatIf | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [adding, setAdding] = useState(false)
  const [managingPhases, setManagingPhases] = useState(false)
  const [newName, setNewName] = useState('')
  const [newDuration, setNewDuration] = useState('1')

  const load = useCallback(async () => {
    const data = await api.getSchedule(projectId)
    setSchedule(data.schedule)
    setBaseline(data.baseline)
    setDependencies(data.dependencies)
    setDetails(Object.fromEntries(data.details.map((d) => [d.id, d])))
    setPhases(data.phases)
    // Recomputed on every load, so it is never stale relative to the chart
    // beside it. A summary that disagrees with the bars is worse than none.
    api.summary(projectId).then(setSummary).catch(() => setSummary(null))
  }, [projectId])

  useEffect(() => {
    load().catch((e: unknown) => setError((e as Error).message))
  }, [load])

  /**
   * Row order is the plan's own order, not the dates.
   *
   * Sorting by start date means the list reshuffles every time anything moves —
   * push the first task out a fortnight and unrelated rows leap to the top,
   * which reads as "it reordered my project" rather than "the schedule
   * shifted". Rows should hold still; only the bars should move.
   */
  const order = useMemo(() => {
    if (!schedule) return []
    return Object.values(schedule.tasks)
      .map((t) => ({ t, sort: details[t.id]?.sortOrder ?? 0 }))
      .sort((a, b) =>
        a.sort !== b.sort
          ? a.sort - b.sort
          : a.t.earlyStart === b.t.earlyStart
            ? a.t.earlyFinish.localeCompare(b.t.earlyFinish)
            : a.t.earlyStart.localeCompare(b.t.earlyStart),
      )
      .map((x) => x.t.id)
  }, [schedule, details])

  /** Every mutating call funnels through here so results are handled once. */
  const mutate = useCallback(
    async (fn: () => Promise<{ schedule: Schedule; impact: Impact | null; finishMovedDays: number }>) => {
      setBusy(true)
      setError(null)
      setNotice(null)
      try {
        const result = await fn()
        setImpact({ impact: result.impact, moved: result.finishMovedDays })
        await load()
        return true
      } catch (e) {
        setError(e instanceof ApiError ? e.message : String(e))
        return false
      } finally {
        setBusy(false)
      }
    },
    [load],
  )

  /**
   * The chart fills whatever vertical space is left after the toolbar, summary
   * and banners. Measured rather than computed, because those elements appear
   * and disappear and a hardcoded offset would be wrong most of the time.
   */
  const splitRef = useRef<HTMLDivElement>(null)
  const [chartHeight, setChartHeight] = useState(FALLBACK_CHART_HEIGHT)
  useLayoutEffect(() => {
    const el = splitRef.current
    if (!el) return
    const observer = new ResizeObserver(([entry]) => {
      const h = Math.round((entry?.contentRect.height ?? 0) - HEADER_HEIGHT)
      if (h > 120) setChartHeight(h)
    })
    observer.observe(el)
    return () => observer.disconnect()
  })

  const [dragFloor, setDragFloor] = useState<{ taskId: string; earliestStart: string } | null>(null)

  /**
   * Zoom about a point, keeping the date under it steady. Zooming that jumps
   * you somewhere else in the schedule is worse than not zooming at all.
   */
  const zoomTo = useCallback((next: number, anchorRatio: number) => {
    const clamped = clampDayWidth(next)
    setDayWidth(clamped)
    requestAnimationFrame(() => {
      const el = document.querySelector<HTMLDivElement>('.gantt-scroll')
      if (!el) return
      el.scrollLeft = Math.max(0, anchorRatio * el.scrollWidth - el.clientWidth / 2)
    })
  }, [])

  /**
   * On grab, ask the server where the dependency logic would let this task
   * start. The chart shades everything left of it for the duration of the
   * gesture, so an impossible move is visible while dragging rather than
   * explained after dropping.
   */
  const onDragStart = useCallback(
    (taskId: string) => {
      setDragFloor(null)
      api
        .taskFloor(projectId, taskId)
        .then((r) => setDragFloor({ taskId, earliestStart: r.earliestStart }))
        .catch(() => {})
    },
    [projectId],
  )

  /**
   * A drop never writes. The server works out what the gesture means — a
   * constraint, a duration, or a correction to recorded actuals — and solves
   * the hypothetical. The planner sees the consequence, then commits it.
   */
  const onDragEnd = useCallback(
    async ({ taskId, mode, targetDate }: DragResult) => {
      setError(null)
      setNotice(null)
      try {
        const result = await api.previewMove(projectId, taskId, mode, targetDate)
        if (!result.allowed) {
          setNotice(result.reason ?? 'That move is not possible.')
          return
        }
        setPending({
          taskId,
          description: result.description ?? 'apply this change',
          patch: result.patch ?? {},
          schedule: result.schedule!,
          currentFinish: result.currentFinish,
          hypotheticalFinish: result.hypotheticalFinish!,
          affected: result.affected ?? [],
          warnings: result.warnings ?? [],
        })
      } catch (e) {
        setError(e instanceof ApiError ? e.message : String(e))
      } finally {
        setDragFloor(null)
      }
    },
    [projectId],
  )

  const applyPending = useCallback(async () => {
    if (!pending) return
    // Send exactly what the preview solved, not a freshly derived patch — the
    // two drifting apart is how "apply does nothing" happens.
    const ok = await mutate(() => api.updateTask(projectId, pending.taskId, pending.patch))
    if (ok) setPending(null)
  }, [pending, projectId, mutate])

  const addTask = useCallback(
    async (event: React.FormEvent) => {
      event.preventDefault()
      if (!newName.trim()) return
      const ok = await mutate(() =>
        api.createTask(projectId, {
          name: newName.trim(),
          durationDays: Number(newDuration) || 0,
        }),
      )
      if (ok) {
        setNewName('')
        setNewDuration('1')
        setAdding(false)
      }
    },
    [newName, newDuration, projectId, mutate],
  )

  if (error && !schedule) {
    return (
      <div className="page">
        <p className="error">{error}</p>
        <button onClick={onBack}>Back</button>
      </div>
    )
  }
  if (!schedule) return <div className="page">Loading…</div>

  const selected = selectedId ? schedule.tasks[selectedId] : null
  const selectedDetail = selectedId ? details[selectedId] : null

  return (
    <div className="project">
      <header className="toolbar">
        <button className="ghost" onClick={onBack}>
          ← Projects
        </button>
        <div className="finish">
          <span className="finish-label">Completion</span>
          <strong>{schedule.projectFinish}</strong>
          {schedule.deadlineFloat !== null && (
            <span className={schedule.deadlineFloat < 0 ? 'chip bad' : 'chip good'}>
              {schedule.deadlineFloat < 0
                ? `${-schedule.deadlineFloat}d late`
                : `${schedule.deadlineFloat}d spare`}
            </span>
          )}
        </div>
        <div className="spacer" />
        <button onClick={() => setAdding((v) => !v)}>+ Task</button>
        <button className="ghost" onClick={() => setManagingPhases(true)}>
          Phases{phases.length ? ` (${phases.length})` : ''}
        </button>
        <div className="zooms">
          <button
            onClick={() => setDayWidth((w) => clampDayWidth(w / 1.4))}
            disabled={dayWidth <= MIN_DAY_WIDTH + 0.01}
            title="Zoom out (⌘/Ctrl + scroll on the chart)"
            aria-label="Zoom out"
          >
            −
          </button>
          {(['day', 'week', 'month'] as Zoom[]).map((z) => (
            <button
              key={z}
              className={Math.abs(dayWidth - ZOOM_WIDTH[z]) < 0.01 ? 'active' : ''}
              onClick={() => setDayWidth(ZOOM_WIDTH[z])}
            >
              {z}
            </button>
          ))}
          <button
            onClick={() => setDayWidth((w) => clampDayWidth(w * 1.4))}
            disabled={dayWidth >= MAX_DAY_WIDTH - 0.01}
            title="Zoom in (⌘/Ctrl + scroll on the chart)"
            aria-label="Zoom in"
          >
            +
          </button>
        </div>
        <button
          onClick={() => void mutate(async () => {
            await api.captureBaseline(projectId, 'Baseline')
            return { schedule, impact: null, finishMovedDays: 0 }
          })}
          disabled={busy}
        >
          {baseline ? 'Re-baseline' : 'Capture baseline'}
        </button>
        <button
          onClick={async () => {
            const name = prompt('Save this project as a template called:')
            if (!name) return
            setBusy(true)
            setError(null)
            try {
              await api.saveAsTemplate(projectId, name, '', 'general')
              setNotice(`Saved as the template “${name}”. It will appear when you create a project.`)
            } catch (e) {
              setError(e instanceof ApiError ? e.message : String(e))
            } finally {
              setBusy(false)
            }
          }}
          disabled={busy}
        >
          Save as template
        </button>
      </header>

      <SummaryPanel
        summary={summary}
        open={summaryOpen}
        onToggle={() => setSummaryOpen((v) => !v)}
      />

      {adding && (
        <form className="new-task" onSubmit={addTask}>
          <input
            autoFocus
            placeholder="Task name"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
          />
          <input
            type="number"
            min={0}
            value={newDuration}
            onChange={(e) => setNewDuration(e.target.value)}
            title="Working days; 0 makes it a milestone"
          />
          <button type="submit" disabled={busy}>
            Add
          </button>
          <button type="button" className="ghost" onClick={() => setAdding(false)}>
            Cancel
          </button>
          <span className="hint">Link it to a predecessor by selecting it in the list.</span>
        </form>
      )}

      {impact && (
        <ImpactBanner
          impact={impact.impact}
          finishMovedDays={impact.moved}
          onDismiss={() => setImpact(null)}
        />
      )}
      {/*
        A refusal is not an impact. The impact banner reports what a change
        cost; this reports that a change could not happen and why. Sharing a
        class made them indistinguishable to anything reading the page.
      */}
      {notice && (
        <div className="notice" role="status">
          <span className="notice-text">{notice}</span>
          <button className="impact-close" onClick={() => setNotice(null)} aria-label="Dismiss">
            ×
          </button>
        </div>
      )}
      {error && <div className="impact impact-bad">{error}</div>}

      {pending && (
        <div className="whatif" role="dialog" aria-label="What-if preview">
          <div>
            <strong>What-if:</strong> {pending.description}.
            {pending.hypotheticalFinish === pending.currentFinish ? (
              <span className="whatif-outcome neutral">
                {' '}Completion holds at {pending.currentFinish} — there is float to absorb it.
              </span>
            ) : (
              <span
                className={
                  pending.hypotheticalFinish > pending.currentFinish
                    ? 'whatif-outcome bad'
                    : 'whatif-outcome good'
                }
              >
                {' '}Completion moves {pending.currentFinish} → {pending.hypotheticalFinish}.
              </span>
            )}
            {/*
              "Nothing follows this" and "the float absorbed it" look identical
              on the chart and mean completely different things. Say which.
            */}
            {pending.affected.length > 0 && (
              <div className="whatif-detail">
                {pending.affected.length === 1
                  ? `${pending.affected[0]} moves with it.`
                  : `${pending.affected.length} tasks move with it: ${pending.affected
                      .slice(0, 3)
                      .join(', ')}${pending.affected.length > 3 ? '…' : ''}`}
              </div>
            )}
            {pending.warnings.map((w, i) => (
              <div key={i} className="whatif-warning">
                {w}
              </div>
            ))}
          </div>
          <div className="whatif-actions">
            <button onClick={applyPending} disabled={busy}>
              Apply
            </button>
            <button className="ghost" onClick={() => setPending(null)} disabled={busy}>
              Discard
            </button>
          </div>
        </div>
      )}

      <div className="split" ref={splitRef}>
        <TaskTable
          schedule={schedule}
          baseline={baseline}
          order={order}
          selectedId={selectedId}
          onSelect={setSelectedId}
          headerHeight={HEADER_HEIGHT}
          height={chartHeight}
          scrollTop={scrollTop}
          onScroll={setScrollTop}
        />
        <Gantt
          schedule={schedule}
          baseline={baseline}
          dependencies={dependencies}
          order={order}
          dayWidth={dayWidth}
          onZoom={zoomTo}
          height={chartHeight}
          selectedId={selectedId}
          onSelect={setSelectedId}
          onDragEnd={onDragEnd}
          onDragStart={onDragStart}
          dragFloor={dragFloor}
          preview={pending?.schedule ?? null}
          scrollTop={scrollTop}
          onScrollTop={setScrollTop}
        />
        {managingPhases && (
          <Phases
            projectId={projectId}
            phases={phases}
            details={details}
            onChanged={() => void load()}
            onClose={() => setManagingPhases(false)}
          />
        )}
        {selected && selectedDetail && (
          <TaskPanel
            task={selected}
            detail={selectedDetail}
            schedule={schedule}
            dependencies={dependencies}
            phases={phases}
            busy={busy}
            onCreatePhase={async (name) => {
              try {
                const made = (await api.createPhase(projectId, name)).phase
                // Added locally as well as refetched, so the select can be set
                // to it immediately rather than after a round trip.
                setPhases((current) => [...current, made])
                return made
              } catch (e) {
                setError(e instanceof ApiError ? e.message : String(e))
                return null
              }
            }}
            onClose={() => setSelectedId(null)}
            onSave={(patch) =>
              void mutate(() => api.updateTask(projectId, selected.id, patch)).then((ok) => {
                if (ok) setSelectedId(null)
              })
            }
            onDelete={() => {
              if (confirm(`Delete “${selected.name}”? Its links go with it.`)) {
                void mutate(() => api.deleteTask(projectId, selected.id)).then(() =>
                  setSelectedId(null),
                )
              }
            }}
            onAddDependency={(predecessorId, type, lagDays) =>
              void mutate(() =>
                api.createDependency(projectId, {
                  predecessorId,
                  successorId: selected.id,
                  type,
                  lagDays,
                }),
              )
            }
            onRemoveDependency={(dependencyId) =>
              void mutate(() => api.deleteDependency(projectId, dependencyId))
            }
          />
        )}
      </div>

      <footer className="legend">
        <span><i className="swatch critical" /> Critical path</span>
        <span><i className="swatch normal" /> Has float</span>
        <span><i className="swatch ghost" /> Baseline</span>
        <span><i className="swatch complete" /> Complete</span>
        {selected && (
          <span className="selection">
            {selected.name}: float {selected.totalFloat}d, free float {selected.freeFloat}d
          </span>
        )}
        <a className="source-link" href={SOURCE_URL} target="_blank" rel="noreferrer">
          Source
        </a>
      </footer>
    </div>
  )
}
