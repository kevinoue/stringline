import { useState } from 'react'
import { api, ApiError, clearToken, setToken } from '../api/client.js'

/**
 * Kept in step with `MIN_PASSWORD_LENGTH` on the server by hand.
 *
 * Only ever the *earlier* of the two checks — the server is the one that
 * decides, and this exists so the form can say so before the round trip
 * rather than after. If they drift, the worst case is a rejection the user
 * could have been warned about, never an accepted password that should not
 * have been.
 */
const MIN_PASSWORD = 10

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
  const tooShort = next.length > 0 && next.length < MIN_PASSWORD

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

            {tooShort && (
              <p className="hint">
                At least {MIN_PASSWORD} characters. A short phrase you will remember beats a
                short password you will not — and it must not contain your email address or
                company code.
              </p>
            )}
            {mismatch && <p className="error">The two new passwords do not match.</p>}
            {error && <p className="error">{error}</p>}
            <p className="hint">This signs you out on every other device.</p>

            <button
              type="submit"
              className="primary"
              disabled={busy || !current || next.length < MIN_PASSWORD || next !== confirm}
            >
              {busy ? 'Changing…' : 'Change password'}
            </button>

            {/*
              Separate from changing the password, and deliberately reachable
              without one.

              The situation it is for is "I signed in on a machine I should
              not have" or "I have left my laptop somewhere" — at which point
              demanding the current password is friction in front of the one
              action that limits the damage. The worst a stolen session can do
              with this is sign itself out.
            */}
            <hr />
            <p className="hint">
              Signed in somewhere you should not be? This ends every session, including this
              one, without changing your password.
            </p>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                if (!confirmDialog('Sign out of every device, including this one?')) return
                setBusy(true)
                api
                  .signOutEverywhere()
                  .then(() => {
                    clearToken()
                    location.reload()
                  })
                  .catch((e) => {
                    setError(e instanceof ApiError ? e.message : String(e))
                    setBusy(false)
                  })
              }}
            >
              Sign out everywhere
            </button>
          </>
        )}
      </form>
    </div>
  )
}

// Named so the call above reads as a question rather than as a global.
const confirmDialog = (message: string): boolean => confirm(message)
