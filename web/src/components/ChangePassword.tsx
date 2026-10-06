import { useState } from 'react'
import { api, ApiError, setToken } from '../api/client.js'

/**
 * Change your own password.
 *
 * The current password is asked for even though you are already signed in: a
 * session is something you have, the old password is something you know, and
 * without both an unattended laptop is enough to lock someone out of their own
 * account.
 *
 * Succeeding signs out every other device, so the new token that comes back
 * has to be stored or this screen would log itself out too.
 */
export function ChangePassword({ onClose }: { onClose(): void }) {
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)

  const mismatch = confirm.length > 0 && next !== confirm
  const tooShort = next.length > 0 && next.length < 8

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (next !== confirm) {
      setError('The two new passwords do not match.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const result = await api.changePassword(current, next)
      // Every other token is now dead, including the one this page loaded with.
      setToken(result.token)
      setDone(result.message)
      setCurrent('')
      setNext('')
      setConfirm('')
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <form className="modal" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <header className="modal-head">
          <h2>Change password</h2>
          <button type="button" className="ghost" onClick={onClose} aria-label="Close">
            ×
          </button>
        </header>

        {done ? (
          <>
            <p className="done">{done}</p>
            <button type="button" onClick={onClose}>
              Close
            </button>
          </>
        ) : (
          <>
            <label>
              Current password
              <input
                type="password"
                value={current}
                autoComplete="current-password"
                onChange={(e) => setCurrent(e.target.value)}
              />
            </label>
            <label>
              New password
              <input
                type="password"
                value={next}
                autoComplete="new-password"
                onChange={(e) => setNext(e.target.value)}
              />
            </label>
            <label>
              Confirm new password
              <input
                type="password"
                value={confirm}
                autoComplete="new-password"
                onChange={(e) => setConfirm(e.target.value)}
              />
            </label>

            {tooShort && <p className="hint">At least 8 characters.</p>}
            {mismatch && <p className="error">The two new passwords do not match.</p>}
            {error && <p className="error">{error}</p>}
            <p className="hint">This signs you out on every other device.</p>

            <button
              type="submit"
              disabled={busy || !current || next.length < 8 || next !== confirm}
            >
              {busy ? 'Changing…' : 'Change password'}
            </button>
          </>
        )}
      </form>
    </div>
  )
}
