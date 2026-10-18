import { useState } from 'react'
import type { Step } from '../api/types.js'

/**
 * The steps inside a task, edited from the task panel.
 *
 * Two kinds in one list, distinguished only by duration. A step with days is
 * part of how long the task takes and gets a bar; a step at zero days is a
 * tick-box that takes no time. Mixing them is allowed and useful — "drain the
 * lines (1d)" alongside "confirm the valve is shut (check)".
 *
 * Changing a duration here moves the schedule, which is why the caller routes
 * these through the same mutation path as everything else that shifts dates.
 */
export function Steps({
  steps,
  busy,
  canEdit,
  onAdd,
  onUpdate,
  onDelete,
  onReorder,
}: {
  steps: Step[]
  busy: boolean
  /** Field users tick steps off; only planners restructure them. */
  canEdit: boolean
  onAdd(name: string, durationDays: number): void
  onUpdate(stepId: string, changes: { name?: string; durationDays?: number; actualStart?: string | null; actualFinish?: string | null }): void
  onDelete(stepId: string): void
  onReorder(order: string[]): void
}) {
  const [name, setName] = useState('')
  const [days, setDays] = useState('0')

  const add = (e: React.FormEvent): void => {
    e.preventDefault()
    if (!name.trim()) return
    onAdd(name.trim(), Number(days) || 0)
    setName('')
    setDays('0')
  }

  const move = (index: number, delta: number): void => {
    const next = [...steps]
    const target = index + delta
    if (target < 0 || target >= next.length) return
    ;[next[index], next[target]] = [next[target]!, next[index]!]
    onReorder(next.map((s) => s.id))
  }

  const total = steps.reduce((sum, s) => sum + s.durationDays, 0)

  return (
    <div className="steps">
      <h3>
        Steps
        {steps.length > 0 && (
          <span className="sub">
            {' '}
            {total > 0
              ? `${total} day${total === 1 ? '' : 's'}, making up this task`
              : 'a tick-list — no time of its own'}
          </span>
        )}
      </h3>

      {steps.length === 0 ? (
        <p className="hint">
          Break this task into parts. Give a step days and it becomes part of how long the task
          takes; leave it at zero and it is a tick-box.
        </p>
      ) : (
        <ul className="step-list">
          {steps.map((step, i) => (
            <li key={step.id} className={step.status === 'complete' ? 'done' : ''}>
              <button
                className="step-tick"
                aria-label={step.status === 'complete' ? `Undo ${step.name}` : `Mark ${step.name} done`}
                disabled={busy}
                onClick={() =>
                  // Ticking records what happened; it never restructures, so
                  // a field user may do it.
                  onUpdate(step.id, {
                    actualFinish:
                      step.status === 'complete' ? null : new Date().toISOString().slice(0, 10),
                    ...(step.status === 'complete'
                      ? {}
                      : { actualStart: step.actualStart ?? new Date().toISOString().slice(0, 10) }),
                  })
                }
              >
                {step.status === 'complete' ? '☑' : '☐'}
              </button>

              <span className="step-name" title={step.name}>
                {step.name}
              </span>

              {/*
                Duration only — the dates are already on the row in the task
                list and under the bar in the chart. Carrying them here too
                crushed the name to "Set …" in a panel this narrow, and the
                name is the part you are reading.
              */}
              <span
                className={step.isCheck ? 'step-days check' : 'step-days'}
                title={step.isCheck ? 'A tick-box — takes no time' : `${step.start} → ${step.finish}`}
              >
                {step.isCheck ? 'check' : `${step.durationDays}d`}
              </span>

              {canEdit && (
                <span className="step-actions">
                  <button
                    className="ghost"
                    disabled={busy || i === 0}
                    aria-label={`Move ${step.name} up`}
                    onClick={() => move(i, -1)}
                  >
                    ↑
                  </button>
                  <button
                    className="ghost"
                    disabled={busy || i === steps.length - 1}
                    aria-label={`Move ${step.name} down`}
                    onClick={() => move(i, 1)}
                  >
                    ↓
                  </button>
                  <button
                    className="ghost"
                    disabled={busy}
                    onClick={() => {
                      const next = prompt(`Days for “${step.name}” (0 for a tick-box)`, String(step.durationDays))
                      if (next === null) return
                      const d = Number(next)
                      if (!Number.isInteger(d) || d < 0) return
                      onUpdate(step.id, { durationDays: d })
                    }}
                  >
                    Days
                  </button>
                  <button
                    className="ghost danger"
                    disabled={busy}
                    aria-label={`Delete ${step.name}`}
                    onClick={() => {
                      if (step.durationDays > 0
                        ? confirm(`Delete “${step.name}”? The task gets ${step.durationDays} day${step.durationDays === 1 ? '' : 's'} shorter.`)
                        : confirm(`Delete “${step.name}”?`)) onDelete(step.id)
                    }}
                  >
                    ×
                  </button>
                </span>
              )}
            </li>
          ))}
        </ul>
      )}

      {/* Same two-row shape as the predecessor form, for the same reason: the
          name field wants the full width, and "Add" must never be the control
          that falls off the edge. */}
      {canEdit && (
        <form className="step-add" onSubmit={add}>
          <input
            placeholder="e.g. Blow out the lines"
            value={name}
            onChange={(e) => setName(e.target.value)}
            aria-label="Step name"
          />
          <div className="step-add-how">
            <label>
              Days
              <input
                type="number"
                min={0}
                value={days}
                onChange={(e) => setDays(e.target.value)}
                title="Working days. Zero makes it a tick-box."
              />
            </label>
            <button type="submit" disabled={busy || !name.trim()}>
              Add
            </button>
          </div>
        </form>
      )}
    </div>
  )
}
