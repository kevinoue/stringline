import { useEffect, useState } from 'react'
import { Attachments } from './Attachments.js'
import type {
  ConstraintType,
  Dependency,
  Phase,
  Schedule,
  ScheduledTask,
  TaskDetail,
} from '../api/types.js'

interface Props {
  task: ScheduledTask
  detail: TaskDetail
  schedule: Schedule
  dependencies: Dependency[]
  phases: Phase[]
  busy: boolean
  onSave(patch: Record<string, unknown>): void
  /** Create a phase inline and return it, so a task can be filed without leaving. */
  onCreatePhase(name: string): Promise<Phase | null>
  onDelete(): void
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
  busy,
  onSave,
  onCreatePhase,
  onDelete,
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
    setNewPred('')
  }, [detail.id])

  const predecessors = dependencies.filter((d) => d.successorId === task.id)
  const linkedIds = new Set([task.id, ...predecessors.map((d) => d.predecessorId)])
  const candidates = Object.values(schedule.tasks)
    .filter((t) => !linkedIds.has(t.id))
    .sort((a, b) => a.earlyStart.localeCompare(b.earlyStart))

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
    }
    onSave(patch)
  }

  return (
    <aside className="panel">
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
          />
        </label>

        {/* Phases arrived with templates and could never be set by hand, so a
            blank project could not have them at all. They are also what lets
            the chart roll up into a handful of bars on a small screen. */}
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
          <button type="submit" disabled={busy}>
            Save changes
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

        <div className="add-link">
          <select value={newPred} onChange={(e) => setNewPred(e.target.value)}>
            <option value="">Add a predecessor…</option>
            {candidates.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
          <select value={newType} onChange={(e) => setNewType(e.target.value)}>
            {['FS', 'SS', 'FF', 'SF'].map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
          <input
            type="number"
            value={newLag}
            onChange={(e) => setNewLag(e.target.value)}
            title="Lag in working days; negative overlaps"
          />
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
      </section>

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
