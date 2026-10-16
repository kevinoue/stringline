import { useCallback, useEffect, useState } from 'react'
import { api, ApiError } from '../api/client.js'
import type { Category } from '../api/types.js'

interface Swatch {
  key: string
  label: string
  hex: string
  stripe: string
}

/**
 * Managing the trades, departments or crews a task can belong to.
 *
 * Company-scoped, which is the thing to remember when reading this: it is not
 * per-project like phases. Renaming "Electrical" here renames it on every job,
 * and that is the point — a colour should mean the same thing on every chart
 * the company looks at.
 *
 * Colours come from a fixed palette rather than a picker. Partly so they stay
 * printable and distinguishable, and partly because the palette has no red in
 * it: the critical path owns red, and a user-chosen red for "Fire systems"
 * would quietly break the one rule the chart has.
 */
export function Categories({
  onChanged,
  onClose,
}: {
  onChanged(): void
  onClose(): void
}) {
  const [categories, setCategories] = useState<Category[]>([])
  const [palette, setPalette] = useState<Swatch[]>([])
  const [label, setLabel] = useState('Trade')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  /** Chosen colour for the one being added, or null to let the server pick. */
  const [newColour, setNewColour] = useState<string | null>(null)
  const [editingLabel, setEditingLabel] = useState(false)
  const [draftLabel, setDraftLabel] = useState('')

  const load = useCallback(async () => {
    try {
      const r = await api.listCategories()
      setCategories(r.categories)
      setPalette(r.palette)
      setLabel(r.label)
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e))
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const run = async (work: () => Promise<unknown>): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await work()
      await load()
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
    await run(() =>
      api.createCategory({
        name: name.trim(),
        // Spread rather than an explicit undefined — the project builds with
        // exactOptionalPropertyTypes.
        ...(description.trim() ? { description: description.trim() } : {}),
      }),
    )
    setName('')
    setDescription('')
  }

  const rename = async (c: Category): Promise<void> => {
    const next = prompt(`Rename “${c.name}”`, c.name)?.trim()
    if (!next || next === c.name) return
    await run(() => api.updateCategory(c.id, { name: next }))
  }

  const describe = async (c: Category): Promise<void> => {
    const next = prompt(`What does “${c.name}” cover?`, c.description ?? '')
    if (next === null) return
    await run(() => api.updateCategory(c.id, { description: next.trim() }))
  }

  const remove = async (c: Category): Promise<void> => {
    const n = c.taskCount ?? 0
    const message = n
      ? `Delete “${c.name}”?\n\nIts ${n} ${n === 1 ? 'task stays' : 'tasks stay'} in their projects, just untagged.`
      : `Delete “${c.name}”?`
    if (!confirm(message)) return
    await run(() => api.deleteCategory(c.id))
  }

  const saveLabel = async (): Promise<void> => {
    const next = draftLabel.trim()
    setEditingLabel(false)
    if (!next || next === label) return
    await run(() => api.setCategoryLabel(next))
  }

  const plural = label.toLowerCase() + 's'

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal modal-wide" onClick={(e) => e.stopPropagation()}>
        <h2>{plural.charAt(0).toUpperCase() + plural.slice(1)}</h2>

        <p className="hint">
          Who a task belongs to, as opposed to when it happens — that is what phases are for. The
          same {label.toLowerCase()} can appear in several phases.{' '}
          {editingLabel ? (
            <span className="label-edit">
              <input
                value={draftLabel}
                onChange={(e) => setDraftLabel(e.target.value)}
                onBlur={() => void saveLabel()}
                onKeyDown={(e) => e.key === 'Enter' && void saveLabel()}
                autoFocus
                maxLength={24}
              />
            </span>
          ) : (
            <button
              className="linkish"
              onClick={() => {
                setDraftLabel(label)
                setEditingLabel(true)
              }}
            >
              Call them something else
            </button>
          )}
        </p>

        {error && <p className="error">{error}</p>}

        {categories.length === 0 ? (
          <p className="hint">
            None yet. Add one below, or start a project from a template — the built-in ones
            arrive already tagged. Each gets a colour you can change here, and the chart can be
            coloured and filtered by it.
          </p>
        ) : (
          <table className="team-table">
            <tbody>
              {categories.map((c) => (
                <tr key={c.id}>
                  <td className="swatch-cell">
                    {/*
                      The palette inline rather than behind a picker. There are
                      ten, they all fit, and choosing one is a single click
                      instead of opening something.
                    */}
                    <div className="swatches">
                      {palette.map((p) => (
                        <button
                          key={p.key}
                          className={'swatch-btn' + (p.key === c.colour ? ' chosen' : '')}
                          style={{ background: p.hex }}
                          title={p.label}
                          aria-label={`${p.label} for ${c.name}`}
                          disabled={busy}
                          onClick={() => void run(() => api.updateCategory(c.id, { colour: p.key }))}
                        />
                      ))}
                    </div>
                  </td>
                  <td>
                    <strong>{c.name}</strong>
                    <br />
                    <span className="sub">
                      {c.description ? `${c.description} · ` : ''}
                      {c.taskCount ?? 0} {c.taskCount === 1 ? 'task' : 'tasks'}
                    </span>
                  </td>
                  <td className="right">
                    <button className="ghost" disabled={busy} onClick={() => void rename(c)}>
                      Rename
                    </button>
                    <button className="ghost" disabled={busy} onClick={() => void describe(c)}>
                      Describe
                    </button>
                    <button className="ghost danger" disabled={busy} onClick={() => void remove(c)}>
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <h3>Add a {label.toLowerCase()}</h3>
        <form className="invite-form" onSubmit={add}>
          <input placeholder="e.g. Electrical" value={name} onChange={(e) => setName(e.target.value)} />
          <input
            placeholder="what it covers (optional)"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
          <button type="submit" disabled={busy || !name.trim()}>
            Add
          </button>
        </form>

        {/*
          A colour chooser on the add form, not only on rows that already
          exist. The old copy said one "is chosen for you, and can be changed
          above" — true once there was a list, and a lie when the list was
          empty, which is exactly when someone is reading it.
        */}
        <div className="add-colour">
          <span className="sub">Colour</span>
          <div className="swatches">
            {palette.map((p) => (
              <button
                key={p.key}
                type="button"
                className={'swatch-btn' + (p.key === newColour ? ' chosen' : '')}
                style={{ background: p.hex }}
                title={p.label}
                aria-label={`Use ${p.label}`}
                disabled={busy}
                onClick={() => setNewColour(p.key === newColour ? null : p.key)}
              />
            ))}
          </div>
          <span className="sub">
            {newColour
              ? palette.find((p) => p.key === newColour)?.label
              : 'or leave it and the next free colour is used'}
          </span>
        </div>

        <div className="modal-actions">
          <button onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  )
}
