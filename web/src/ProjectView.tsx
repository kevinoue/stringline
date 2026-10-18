import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { api, ApiError, getCachedRole, SOURCE_URL } from './api/client.js'
import type {
  Baseline,
  Dependency,
  Impact,
  ProjectSummary,
  Schedule,
  Category,
  Phase,
  Role,
  ScheduleProject,
  Step,
  TaskDetail,
} from './api/types.js'
import { ImpactBanner } from './components/ImpactBanner.js'
import { SummaryPanel } from './components/SummaryPanel.js'
import { Categories } from './components/Categories.js'
import { Phases } from './components/Phases.js'
import { PrintDialog } from './print/PrintDialog.js'
import { ThemeToggle } from './components/ThemeToggle.js'
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
  const [categories, setCategories] = useState<Category[]>([])
  const [steps, setSteps] = useState<Step[]>([])
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [categoryLabel, setCategoryLabel] = useState('Trade')
  /**
   * Every category the company has, for the task editor's dropdown.
   *
   * Distinct from `categories`, which is only the ones already used on this
   * project — right for the chart's legend and filter, and useless for
   * assigning one, because a trade that is not on the job yet is exactly the
   * one you are trying to pick.
   */
  const [allCategories, setAllCategories] = useState<Category[]>([])
  const [role, setRole] = useState<Role | null>(getCachedRole())
  const [focusCategory, setFocusCategory] = useState<string | null>(null)
  const [colourBy, setColourBy] = useState<'critical' | 'category'>('critical')
  const [managingCategories, setManagingCategories] = useState(false)
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
  const [printing, setPrinting] = useState(false)
  const [nameDraft, setNameDraft] = useState('')
  /** Set by Escape so the blur that follows discards rather than saves. */
  const abandoning = useRef(false)
  const [meta, setMeta] = useState<ScheduleProject | null>(null)
  const [newName, setNewName] = useState('')
  const [newDuration, setNewDuration] = useState('1')

  const load = useCallback(async () => {
    const data = await api.getSchedule(projectId)
    setSchedule(data.schedule)
    setBaseline(data.baseline)
    setDependencies(data.dependencies)
    setDetails(Object.fromEntries(data.details.map((d) => [d.id, d])))
    setPhases(data.phases)
    setCategories(data.categories)
    setSteps(data.steps)
    // The company's word for this dimension — Trade, Department, Crew. Company
    // -scoped, so it rides along rather than being fetched per project.
    api
      .listCategories()
      .then((r) => {
        setCategoryLabel(r.label)
        setAllCategories(r.categories)
      })
      .catch(() => {})
    setMeta(data.project)
    setNameDraft(data.project.name)
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

  const saveName = async (): Promise<void> => {
    // Escape sets this, because blur fires immediately afterwards and would
    // otherwise save the half-typed name: `setNameDraft` has not applied yet
    // when the blur handler reads it, so resetting state alone does nothing.
    if (abandoning.current) {
      abandoning.current = false
      setNameDraft(meta?.name ?? '')
      return
    }
    const next = nameDraft.trim()
    if (!next || next === meta?.name) {
      // Blank is a slip, not an instruction. Put the real name back rather
      // than saving an empty one or leaving the box looking empty.
      setNameDraft(meta?.name ?? '')
      return
    }
    try {
      const r = await api.updateProject(projectId, { name: next })
      setMeta((m) => (m ? { ...m, name: r.project.name } : m))
      setNameDraft(r.project.name)
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e))
      setNameDraft(meta?.name ?? '')
    }
  }

  // The server is the authority on what this user may do. A cached role goes
  // stale the moment an owner changes it, and an absent one used to default to
  // the most restricted role — which hid the controls from the owner.
  useEffect(() => {
    let cancelled = false
    api.me().then((m) => !cancelled && setRole(m.role)).catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  /** Steps by their parent task, in order. */
  const stepsByTask = useMemo(() => {
    const map = new Map<string, Step[]>()
    for (const step of [...steps].sort((a, b) => a.sortOrder - b.sortOrder)) {
      const list = map.get(step.taskId)
      if (list) list.push(step)
      else map.set(step.taskId, [step])
    }
    return map
  }, [steps])

  const stepById = useMemo(() => new Map(steps.map((s) => [s.id, s])), [steps])
  const hasSteps = useMemo(() => new Set(stepsByTask.keys()), [stepsByTask])

  /**
   * The rows both panes draw, task ids with step ids interleaved beneath any
   * expanded task.
   *
   * One flat list rather than a tree, because the table and the chart have to
   * agree on every row's index to stay in lockstep while scrolling — and they
   * already did that for a flat list of tasks.
   */
  const displayOrder = useMemo(() => {
    const rows: string[] = []
    for (const taskId of order) {
      rows.push(taskId)
      if (!expanded.has(taskId)) continue
      for (const step of stepsByTask.get(taskId) ?? []) rows.push(step.id)
    }
    return rows
  }, [order, expanded, stepsByTask])

  // A task that loses its last step must not stay in the expanded set, or it
  // would re-expand to nothing the moment it gained one again.
  useEffect(() => {
    setExpanded((current) => {
      const next = new Set([...current].filter((id) => hasSteps.has(id)))
      return next.size === current.size ? current : next
    })
  }, [hasSteps])

  const toggleExpanded = useCallback((taskId: string) => {
    setExpanded((current) => {
      const next = new Set(current)
      if (next.has(taskId)) next.delete(taskId)
      else next.add(taskId)
      return next
    })
  }, [])

  /** Task id -> category id, for the chart's stripe and focus. */
  const categoryOf = useMemo(
    () =>
      new Map(
        Object.values(details)
          .filter((d) => d.categoryId)
          .map((d) => [d.id, d.categoryId!]),
      ),
    [details],
  )

  // A focused category that no longer exists on this project would dim every
  // bar with nothing left in focus, which reads as the chart having broken.
  useEffect(() => {
    if (focusCategory && !categories.some((c) => c.id === focusCategory)) setFocusCategory(null)
  }, [categories, focusCategory])

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
          // Below whatever is selected. Appending always is wrong when
          // someone is building out a section: they select the task they are
          // working near, add the next one, and find it at the bottom of
          // forty rows.
          ...(selectedId ? { afterTaskId: selectedId } : {}),
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
        {/*
          The project name, and the only place to rename one.
          
          It was missing entirely: nothing in this view said which project you
          were looking at except the summary headline, and renaming was
          possible through the API but nowhere in the app. Editable in place
          because that is where someone looks for it — at the title.
        */}
        <input
          className="project-name"
          value={nameDraft}
          disabled={busy}
          onChange={(e) => setNameDraft(e.target.value)}
          onBlur={() => void saveName()}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur()
            // Escape restores what the server has, so a half-typed name is
            // never saved by looking away.
            if (e.key === 'Escape') {
              abandoning.current = true
              e.currentTarget.blur()
            }
          }}
          title="Click to rename this project"
          aria-label="Project name"
        />
        {/*
          The project start, editable in place. It is the date every
          unconstrained task hangs off, and it used to be write-once — a
          template started on the wrong day could only be deleted and
          started again.
        */}
        <div className="finish">
          <span className="finish-label">Start</span>
          <input
            type="date"
            className="start-date"
            value={schedule.projectStart}
            disabled={busy}
            onChange={(e) => {
              const next = e.target.value
              if (!next || next === schedule.projectStart) return
              void mutate(() => api.reschedule(projectId, { startDate: next }))
            }}
            title="Moves the whole project. Tasks with their own constraint stay put."
          />
          {/*
            The anchor and the first day of work are different things, and
            quietly showing only the anchor made the toolbar look stale after
            dragging the first bar later — the date had not changed, but
            nothing was explaining why nothing happened until later.
          */}
          {schedule.firstWorkStart !== schedule.projectStart && (
            <span
              className="chip muted"
              title="The first task starts later than the project anchor, because something is holding it."
            >
              work starts {schedule.firstWorkStart}
            </span>
          )}
        </div>
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
        {/*
          Focus, not filter. Picking a trade leaves everyone else's bars on
          screen but faded, because "where does my work sit" is answered by the
          work around it — hiding the rest answers a different question.
        */}
        {categories.length > 0 && (
          <select
            className="focus-picker"
            value={focusCategory ?? ''}
            onChange={(e) => setFocusCategory(e.target.value || null)}
            title="Fade everything except one trade"
          >
            <option value="">All {categoryLabel.toLowerCase()}s</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        )}
        {categories.length > 0 && (
          <button
            className="ghost"
            onClick={() => setColourBy((m) => (m === 'critical' ? 'category' : 'critical'))}
            title={
              colourBy === 'critical'
                ? `Colour bars by ${categoryLabel.toLowerCase()} instead of the critical path`
                : 'Go back to colouring the critical path'
            }
          >
            {colourBy === 'critical'
              ? `Colour by ${categoryLabel.toLowerCase()}`
              : 'Colour by critical path'}
          </button>
        )}
        <button className="ghost" onClick={() => setManagingCategories(true)}>
          {categoryLabel}s{categories.length ? ` (${categories.length})` : ''}
        </button>
        <button className="ghost" onClick={() => setPrinting(true)}>
          Print
        </button>
        <ThemeToggle />
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
          order={displayOrder}
          steps={stepById}
          hasSteps={hasSteps}
          expanded={expanded}
          onToggle={toggleExpanded}
          selectedId={selectedId}
          onSelect={setSelectedId}
          headerHeight={HEADER_HEIGHT}
          height={chartHeight}
          scrollTop={scrollTop}
          onScroll={setScrollTop}
          categoryOf={categoryOf}
          focusCategory={focusCategory}
          canReorder={role === null || role === 'owner' || role === 'planner'}
          onReorder={(next) => {
            // Optimistic: the rows move under the pointer, not a beat later.
            // Reordering changes no dates, so there is nothing to be wrong
            // about if the request fails — `load()` puts it back.
            setDetails((current) => {
              const copy = { ...current }
              next.forEach((id, i) => {
                const d = copy[id]
                if (d) copy[id] = { ...d, sortOrder: i * 10 }
              })
              return copy
            })
            void api
              .reorderTasks(projectId, next)
              .catch((e) => setError(e instanceof ApiError ? e.message : String(e)))
              .finally(() => void load())
          }}
        />
        <Gantt
          categoryOf={categoryOf}
          categories={categories}
          focusCategory={focusCategory}
          colourBy={colourBy}
          schedule={schedule}
          baseline={baseline}
          dependencies={dependencies}
          order={displayOrder}
          steps={stepById}
          hasSteps={hasSteps}
          expanded={expanded}
          onToggle={toggleExpanded}
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
        {printing && meta && (
          <PrintDialog
            projectId={projectId}
            projectName={meta.name}
            printTitle={meta.printTitle}
            printSubtitle={meta.printSubtitle}
            schedule={schedule}
            details={details}
            phases={phases}
            categories={categories}
            categoryOf={categoryOf}
            categoryLabel={categoryLabel}
            dependencies={dependencies}
            steps={steps}
            expandedTasks={expanded}
            baseline={baseline}
            summary={summary}
            // The same row order the screen uses, so paper and screen agree.
            order={order.map((id) => schedule.tasks[id]!)}
            onClose={() => {
              setPrinting(false)
              void load()
            }}
          />
        )}
        {managingCategories && (
          <Categories
            onChanged={() => void load()}
            onClose={() => {
              setManagingCategories(false)
              void load()
            }}
          />
        )}
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
            categories={allCategories}
            categoryLabel={categoryLabel}
            steps={stepsByTask.get(selected.id) ?? []}
            // Only owners and planners restructure. A field user ticking a
            // step off is the whole point of the role, and that path is
            // separate.
            // Permissive until the server says otherwise: an unknown role
            // should not hide controls, and the server refuses anything the
            // user may not do anyway.
            canEditSteps={role === null || role === 'owner' || role === 'planner'}
            onAddStep={(name, days) =>
              void mutate(() => api.addStep(projectId, selected.id, name, days))
            }
            onUpdateStep={(stepId, changes) =>
              void mutate(() => api.updateStep(projectId, selected.id, stepId, changes))
            }
            onDeleteStep={(stepId) =>
              void mutate(() => api.deleteStep(projectId, selected.id, stepId))
            }
            onReorderSteps={(order) => {
              // No dates move, so this does not go through `mutate` and its
              // impact banner — only the order inside the task changes.
              void api
                .reorderSteps(projectId, selected.id, order)
                .then(() => load())
                .catch((e) => setError(e instanceof ApiError ? e.message : String(e)))
            }}
            busy={busy}
            onCreateCategory={async (name) => {
              try {
                const made = (await api.createCategory({ name })).category
                // Added locally as well so the select can be set to it at
                // once; `load()` refreshes the project-scoped list the chart
                // uses once the task is actually saved with it.
                setAllCategories((current) => [...current, made])
                return made
              } catch (e) {
                setError(e instanceof ApiError ? e.message : String(e))
                return null
              }
            }}
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
            onDuplicate={() => {
              void mutate(() => api.duplicateTask(projectId, selected.id)).then((ok) => {
                if (ok) setSelectedId(null)
              })
            }}
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
