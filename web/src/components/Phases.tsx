import { useState } from 'react'
import { api, ApiError } from '../api/client.js'
import type { Phase, TaskDetail } from '../api/types.js'

/**
 * Managing a project's phases.
 *
 * Phases are grouping, not scheduling — none of this moves a date, which is why
 * nothing here produces an impact banner. The order matters because it is the
 * order the chart rolls up into on a small screen, where six phase bars are
 * legible and twenty-two task bars are not.
 */
export function Phases({
  projectId,
  phases,
  details,
  onChanged,
  onClose,
}: {
  projectId: string
  phases: Phase[]
  details: Record<string, TaskDetail>
  onChanged(): void
  onClose(): void
}) {
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  /** How many tasks each phase holds — the number that makes deleting honest. */
  const counts = Object.values(details).reduce<Record<string, number>>((acc, d) => {
    if (d.phaseId) acc[d.phaseId] = (acc[d.phaseId] ?? 0) + 1
    return acc
  }, {})
  const unassigned = Object.values(details).filter((d) => !d.phaseId).length

  const run = async (work: () => Promise<unknown>): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await work()
      onChanged()
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const add = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    if (!name.trim()) return
    await run(() => api.createPhase(projectId, name.trim()))
    setName('')
  }

  const rename = async (p: Phase): Promise<void> => {
    const next = prompt('Rename the phase', p.name)?.trim()
    if (!next || next === p.name) return
    await run(() => api.updatePhase(projectId, p.id, { name: next }))
  }

  const remove = async (p: Phase): Promise<void> => {
    const n = counts[p.id] ?? 0
    // Say what happens to the work. "Delete this phase?" invites the fear that
    // the tasks go with it, which they never do.
    const message = n
      ? `Delete “${p.name}”?\n\nIts ${n} ${n === 1 ? 'task stays' : 'tasks stay'} in the project, just without a phase.`
      : `Delete “${p.name}”?`
    if (!confirm(message)) return
    await run(() => api.deletePhase(projectId, p.id))
  }

  const move = async (index: number, delta: number): Promise<void> => {
    const next = [...phases]
    const target = index + delta
    if (target < 0 || target >= next.length) return
    ;[next[index], next[target]] = [next[target]!, next[index]!]
    await run(() => api.reorderPhases(projectId, next.map((p) => p.id)))
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal modal-wide" onClick={(e) => e.stopPropagation()}>
        <h2>Phases</h2>
        <p className="hint">
          Stages of the job, used to group tasks. On a phone the chart draws one bar per phase
          instead of one per task, so a project stays readable in the hand.
        </p>

        {error && <p className="error">{error}</p>}

        {phases.length === 0 ? (
          <p className="hint">No phases yet. Projects started from a template come with them.</p>
        ) : (
          <table className="team-table">
            <tbody>
              {phases.map((p, i) => (
                <tr key={p.id}>
                  <td>
                    <strong>{p.name}</strong>
                    <br />
                    <span className="sub">
                      {counts[p.id] ?? 0} {counts[p.id] === 1 ? 'task' : 'tasks'}
                    </span>
                  </td>
                  <td className="right">
                    <button
                      className="ghost"
                      disabled={busy || i === 0}
                      onClick={() => void move(i, -1)}
                      aria-label={`Move ${p.name} up`}
                    >
                      ↑
                    </button>
                    <button
                      className="ghost"
                      disabled={busy || i === phases.length - 1}
                      onClick={() => void move(i, 1)}
                      aria-label={`Move ${p.name} down`}
                    >
                      ↓
                    </button>
                    <button className="ghost" disabled={busy} onClick={() => void rename(p)}>
                      Rename
                    </button>
                    <button
                      className="ghost danger"
                      disabled={busy}
                      onClick={() => void remove(p)}
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {unassigned > 0 && phases.length > 0 && (
          <p className="hint">
            {unassigned} {unassigned === 1 ? 'task is' : 'tasks are'} not in any phase. Assign them
            from the task editor.
          </p>
        )}

        <h3>Add a phase</h3>
        <form className="invite-form" onSubmit={add}>
          <input
            placeholder="e.g. Sitework"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <button type="submit" disabled={busy || !name.trim()}>
            Add
          </button>
        </form>

        <div className="modal-actions">
          <button onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  )
}
