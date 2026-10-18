import { useEffect, useRef, useState } from 'react'
import { Attachments } from './Attachments.js'
import { Steps } from './Steps.js'
import { PALETTE } from '../gantt/palette.js'
import type {
  Category,
  ConstraintType,
  Dependency,
  Phase,
  Schedule,
  Step,
  ScheduledTask,
  TaskDetail,
} from '../api/types.js'

interface Props {
  task: ScheduledTask
  detail: TaskDetail
  schedule: Schedule
  dependencies: Dependency[]
  phases: Phase[]
  categories: Category[]
  steps: Step[]
  /** Field users tick steps off; only planners restructure them. */
  canEditSteps: boolean
  onAddStep(name: string, durationDays: number): void
  onUpdateStep(stepId: string, changes: Record<string, unknown>): void
  onDeleteStep(stepId: string): void
  onReorderSteps(order: string[]): void
  /** What this company calls the dimension — Trade, Department, Crew. */
  categoryLabel: string
  busy: boolean
  onSave(patch: Record<string, unknown>): void
  /** Create a phase inline and return it, so a task can be filed without leaving. */
  onCreatePhase(name: string): Promise<Phase | null>
  /** Same for a trade — company-wide, but reachable without leaving the task. */
  onCreateCategory(name: string): Promise<Category | null>
  onDelete(): void
  /** Copy this task with its steps and predecessors. */
  onDuplicate(): void
  onAddDependency(predecessorId: string, type: string, lagDays: number): void
  onRemoveDependency(dependencyId: string): void
  onClose(): void
}

const CONSTRAINTS: Array<{ value: ConstraintType; label: string }> = [
  { value: 'ASAP', label: 'As soon as possible' },
  { value: 'START_NO_EARLIER_THAN', label: 'Start no earlier than' },
  { value: 'FINISH_NO_LATER_THAN', label: 'Finish no later than' },
  { value: 'MUST_START_ON', label: 'Must start on' },
]

/**
 * Edit everything behind a bar.
 *
 * Actuals live in their own section, deliberately separated from the plan. They
 * are records of what happened, not scheduling inputs, and the engine treats
 * them as fact that overrides everything else — so the UI should not present
 * them as just more fields to tweak.
 */
export function TaskPanel({
  task,
  detail,
  schedule,
  dependencies,
  phases,
  categories,
  steps,
  canEditSteps,
  onAddStep,
  onUpdateStep,
  onDeleteStep,
  onReorderSteps,
  categoryLabel,
  busy,
  onSave,
  onCreatePhase,
  onCreateCategory,
  onDelete,
  onDuplicate,
  onAddDependency,
  onRemoveDependency,
  onClose,
}: Props) {
  const [name, setName] = useState(detail.name)
  const [duration, setDuration] = useState(String(detail.durationDays))
  const [constraintType, setConstraintType] = useState<ConstraintType>(detail.constraintType)
  const [constraintDate, setConstraintDate] = useState(detail.constraintDate ?? '')
  const [actualStart, setActualStart] = useState(detail.actualStart ?? '')
  const [actualFinish, setActualFinish] = useState(detail.actualFinish ?? '')
  const [percent, setPercent] = useState(
    detail.percentComplete === null ? '' : String(detail.percentComplete),
  )
  const [phaseId, setPhaseId] = useState<string | null>(detail.phaseId)
  const [categoryId, setCategoryId] = useState<string | null>(detail.categoryId)
  const [newPred, setNewPred] = useState('')
  const [newType, setNewType] = useState('FS')
  const [newLag, setNewLag] = useState('0')

  /**
   * Re-seed only when a *different* task is selected.
   *
   * Keying this on the whole `detail` object meant every background refresh —
   * and every save triggers one — rebuilt the form from the server and threw
   * away whatever the user had typed since. Keying on the id means switching
   * rows reloads the form, while a refresh of the row you are already editing
   * leaves your work alone.
   */
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    setName(detail.name)
    setDuration(String(detail.durationDays))
    setConstraintType(detail.constraintType)
    setConstraintDate(detail.constraintDate ?? '')
    setActualStart(detail.actualStart ?? '')
    setActualFinish(detail.actualFinish ?? '')
    setPercent(detail.percentComplete === null ? '' : String(detail.percentComplete))
    setPhaseId(detail.phaseId)
    setCategoryId(detail.categoryId)
    setNewPred('')
  }, [detail.id])

  const predecessors = dependencies.filter((d) => d.successorId === task.id)
  const linkedIds = new Set([task.id, ...predecessors.map((d) => d.predecessorId)])
  const candidates = Object.values(schedule.tasks)
    .filter((t) => !linkedIds.has(t.id))
    .sort((a, b) => a.earlyStart.localeCompare(b.earlyStart))

  /** The selected trade's colour, so the swatch beside the dropdown matches the chart. */
  const chosenColour = (() => {
    const key = categories.find((c) => c.id === categoryId)?.colour
    return key ? PALETTE.find((p) => p.key === key) ?? null : null
  })()

  /** Whether the steps determine the duration, or are just a tick-list. */
  const stepsDrive = steps.some((s) => s.durationDays > 0)

  const save = (event: React.FormEvent) => {
    event.preventDefault()
    const patch: Record<string, unknown> = {
      name,
      durationDays: Number(duration),
      constraintType,
      // Clearing the type must clear the date too, or the database check
      // rejects the row.
      constraintDate: constraintType === 'ASAP' ? null : constraintDate || null,
      actualStart: actualStart || null,
      actualFinish: actualFinish || null,
      percentComplete: percent === '' ? null : Number(percent),
      phaseId,
      categoryId,
    }
    onSave(patch)
  }

  return (
    <aside className="panel">
      <PanelGrip />
      <header className="panel-head">
        <h2>Edit task</h2>
        <button className="ghost" onClick={onClose} aria-label="Close">
          ×
        </button>
      </header>

      <form onSubmit={save} className="panel-body">
        <label>
          Name
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </label>

        <label>
          Duration (working days) — 0 makes it a milestone
          <input
            type="number"
            min={0}
            value={duration}
            onChange={(e) => setDuration(e.target.value)}
            // Once steps add up to something, the duration *is* their sum.
            // Letting it be typed here would be a number that silently
            // reverts the next time any step changes.
            disabled={stepsDrive}
          />
        </label>
        {stepsDrive && (
          <p className="hint">
            Made up of {steps.length} steps. Change a step&apos;s days to change this.
          </p>
        )}

        {/* Phases arrived with templates and could never be set by hand, so a
            blank project could not have them at all. They are also what lets
            the chart roll up into a handful of bars on a small screen. */}
        {/* Who owns it, next to when it happens. The two are the axes a
            schedule is read along, and they belong together. */}
        <label>
          {categoryLabel}
          <select
            value={categoryId ?? ''}
            onChange={(e) => {
              if (e.target.value === '__new__') {
                const name = prompt(`Name the new ${categoryLabel.toLowerCase()}`)?.trim()
                if (!name) return
                void onCreateCategory(name).then((made) => made && setCategoryId(made.id))
                return
              }
              setCategoryId(e.target.value || null)
            }}
          >
            <option value="">None</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
            <option value="__new__">New {categoryLabel.toLowerCase()}…</option>
          </select>
        </label>
        <p className="hint">
          {/* Where the list comes from was not obvious, and it is genuinely
              unobvious: these are company-wide while phases are per-project.
              The swatch is here so the link between a trade and its colour is
              visible at the point you assign one — the picker lives behind a
              toolbar button, which nobody found. */}
          {chosenColour && (
            <i
              className="trade-dot"
              style={{ background: chosenColour.hex }}
              title={`${chosenColour.label} — change it from ${categoryLabel}s in the toolbar`}
            />
          )}
          {categoryLabel}s are shared across every project. Add, rename and recolour them from{' '}
          <strong>{categoryLabel}s</strong> in the toolbar.
        </p>

        <label>
          Phase
          <select
            value={phaseId ?? ''}
            onChange={(e) => {
              if (e.target.value === '__new__') {
                const name = prompt('Name the new phase')?.trim()
                if (!name) return
                void onCreatePhase(name).then((made) => made && setPhaseId(made.id))
                return
              }
              setPhaseId(e.target.value || null)
            }}
          >
            <option value="">No phase</option>
            {phases.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
            <option value="__new__">New phase…</option>
          </select>
        </label>

        <label>
          Constraint
          <select
            value={constraintType}
            onChange={(e) => setConstraintType(e.target.value as ConstraintType)}
          >
            {CONSTRAINTS.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </select>
        </label>
        {constraintType !== 'ASAP' && (
          <label>
            Constraint date
            <input
              type="date"
              value={constraintDate}
              onChange={(e) => setConstraintDate(e.target.value)}
            />
          </label>
        )}

        <fieldset className="actuals">
          <legend>Actuals — what really happened</legend>
          <p className="hint">
            These override the plan. Once a task has an actual start, the schedule forecasts
            the rest from the data date rather than the original dates.
          </p>
          <label>
            Actual start
            <input
              type="date"
              value={actualStart}
              onChange={(e) => setActualStart(e.target.value)}
            />
          </label>
          <label>
            Actual finish
            <input
              type="date"
              value={actualFinish}
              onChange={(e) => setActualFinish(e.target.value)}
            />
          </label>
          <label>
            Percent complete
            <input
              type="number"
              min={0}
              max={100}
              value={percent}
              placeholder="not reported"
              onChange={(e) => setPercent(e.target.value)}
            />
          </label>
        </fieldset>

        <div className="panel-actions">
          <button type="submit" className="primary" disabled={busy}>
            Save changes
          </button>
          {/* Copies the steps and predecessors, not the successors or any
              recorded actuals. The main use is splitting one task that a
              template lumped together — a copy to edit beats an empty task. */}
          {/* Outlined, not ghost. Ghost is for navigation and dismissal;
              this one creates a task. Bare, it read as a label sitting
              between two buttons. */}
          <button
            type="button"
            onClick={onDuplicate}
            disabled={busy}
            title="Copy this task, its steps and what it waits on"
          >
            Duplicate
          </button>
          <button type="button" className="danger" onClick={onDelete} disabled={busy}>
            Delete
          </button>
        </div>
      </form>

      <section className="panel-body">
        <h3>Predecessors</h3>
        {predecessors.length === 0 && <p className="hint">Nothing has to finish first.</p>}
        <ul className="links">
          {predecessors.map((d) => {
            const pred = schedule.tasks[d.predecessorId]
            return (
              <li key={d.id}>
                <span>
                  {pred?.name ?? 'Unknown'} <em>{d.type}</em>
                  {d.lagDays !== 0 && ` ${d.lagDays > 0 ? '+' : ''}${d.lagDays}d`}
                </span>
                <button
                  className="ghost"
                  onClick={() => onRemoveDependency(d.id)}
                  disabled={busy}
                  aria-label="Remove link"
                >
                  ×
                </button>
              </li>
            )
          })}
        </ul>

        {/*
          Two rows: what it waits on, then how.

          The dropdown holds real task names — "Winterize the Summer House
          plumbing" — so on one line beside the Link button it could not shrink
          (a grid child's minimum is its content) and pushed Link off the edge,
          leaving the whole panel scrolling sideways to reach the thing that
          commits the change. Full width on its own line, controls underneath.
        */}
        <div className="add-link">
          <select
            className="add-link-what"
            value={newPred}
            onChange={(e) => setNewPred(e.target.value)}
            aria-label="Predecessor"
          >
            <option value="">Add a predecessor…</option>
            {candidates.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
          <div className="add-link-how">
            <select
              value={newType}
              onChange={(e) => setNewType(e.target.value)}
              aria-label="Link type"
              title="Finish-to-start, start-to-start, finish-to-finish, start-to-finish"
            >
              {['FS', 'SS', 'FF', 'SF'].map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
            {/* Labelled now there is room for it. "58px of number box" next to
                a dropdown of initialisms was unguessable. */}
            <label>
              Lag
              <input
                type="number"
                value={newLag}
                onChange={(e) => setNewLag(e.target.value)}
                title="Lag in working days; negative overlaps"
              />
            </label>
            <button
              type="button"
              disabled={!newPred || busy}
              onClick={() => {
                onAddDependency(newPred, newType, Number(newLag) || 0)
                setNewPred('')
                setNewLag('0')
              }}
            >
              Link
            </button>
          </div>
        </div>
      </section>

      {/* What the work is made of, between the plan above and the files
          below. Changing a step's days changes the task's duration, which is
          why these route through the same mutation path as a date move. */}
      <Steps
        steps={steps}
        busy={busy}
        canEdit={canEditSteps}
        onAdd={onAddStep}
        onUpdate={onUpdateStep}
        onDelete={onDeleteStep}
        onReorder={onReorderSteps}
      />

      <Attachments taskId={task.id} />

      <footer className="panel-foot">
        <dl>
          <dt>Scheduled</dt>
          <dd>
            {task.earlyStart} → {task.earlyFinish}
          </dd>
          <dt>Total float</dt>
          <dd className={task.totalFloat < 0 ? 'negative' : ''}>{task.totalFloat}d</dd>
          <dt>Status</dt>
          <dd>{task.status}</dd>
        </dl>
      </footer>
    </aside>
  )
}

/**
 * Drag the panel's edge to resize it.
 *
 * Writes `--panel-w` on `<html>` rather than lifting the width into React
 * state: a pointermove handler that re-renders the editor — and through it the
 * chart beside it — drops frames on a 200-task project, and the width is
 * presentation rather than data. The CSS clamps it, so a wild drag cannot
 * leave the panel 3px wide or swallow the chart.
 *
 * Double-click resets, because a resize with no way back is a trap.
 */
function PanelGrip() {
  const dragging = useRef(false)

  useEffect(() => {
    // Restore whatever it was last set to. Done here rather than at startup so
    // a session that never opens the editor never touches the variable.
    const saved = localStorage.getItem(PANEL_WIDTH_KEY)
    if (saved) document.documentElement.style.setProperty('--panel-w', saved)
  }, [])

  const begin = (event: React.PointerEvent) => {
    event.preventDefault()
    dragging.current = true
    document.body.classList.add('resizing')

    const move = (e: PointerEvent) => {
      if (!dragging.current) return
      // Measured from the right edge of the window, which is where the panel
      // is anchored. Using a delta from the grab point instead drifts as soon
      // as the clamp bites.
      const width = Math.round(window.innerWidth - e.clientX)
      document.documentElement.style.setProperty('--panel-w', `${width}px`)
    }
    const end = () => {
      dragging.current = false
      document.body.classList.remove('resizing')
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', end)
      const now = document.documentElement.style.getPropertyValue('--panel-w')
      if (now) localStorage.setItem(PANEL_WIDTH_KEY, now)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', end)
  }

  return (
    <button
      className="panel-grip"
      aria-label="Resize the editor"
      title="Drag to resize · double-click to reset"
      onPointerDown={begin}
      onDoubleClick={() => {
        document.documentElement.style.removeProperty('--panel-w')
        localStorage.removeItem(PANEL_WIDTH_KEY)
      }}
    />
  )
}

const PANEL_WIDTH_KEY = 'stringline.panelWidth'
