import { useEffect, useState } from 'react'
import { api, ApiError, SOURCE_URL } from '../api/client.js'

/**
 * Setting a new password from a reset link (`?reset=TOKEN`).
 *
 * Validated before the form appears. A 15-minute expiry means an expired link
 * is a normal occurrence rather than an edge case, and finding out *after*
 * choosing a password is a small, avoidable insult.
 */
export function ResetPassword({ token, onDone }: { token: string; onDone(): void }) {
  const [valid, setValid] = useState<boolean | null>(null)
  const [password, setPassword] = useState('')
  const [done, setDone] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let cancelled = false
    api
      .validateReset(token)
      .then((r) => !cancelled && setValid(r.valid))
      .catch(() => !cancelled && setValid(false))
    return () => {
      cancelled = true
    }
  }, [token])

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await api.resetPassword(token, password)
      setDone(true)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  if (valid === null) return <div className="auth" />

  if (done) {
    return (
      <div className="auth">
        <div className="auth-card">
          <h1>Password set</h1>
          <p className="tagline">Other devices have been signed out.</p>
          <button onClick={onDone}>Sign in</button>
        </div>
      </div>
    )
  }

  if (!valid) {
    return (
      <div className="auth">
        <div className="auth-card">
          <h1>That link has expired</h1>
          <p className="tagline">Reset links last 15 minutes and work only once.</p>
          <button onClick={onDone}>Back to sign in</button>
        </div>
      </div>
    )
  }

  return (
    <div className="auth">
      <form className="auth-card" onSubmit={submit}>
        <h1>Choose a new password</h1>
        <label>
          New password
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="new-password"
          />
        </label>
        <p className="hint">At least 8 characters. This signs you out everywhere else.</p>
        {error && <p className="error">{error}</p>}
        <button type="submit" disabled={busy || !password}>
          {busy ? 'Setting…' : 'Set password'}
        </button>
        <p className="source-note">
          Free and open source under the{' '}
          <a href="https://www.gnu.org/licenses/agpl-3.0.html" target="_blank" rel="noreferrer">
            AGPL-3.0
          </a>
          . <a href={SOURCE_URL} target="_blank" rel="noreferrer">Get the source</a>.
        </p>
      </form>
    </div>
  )
}

/**
 * The "forgot password" step, folded into the login card.
 *
 * Only rendered when the server says it can send email. An instance with no
 * mail configured hides this entirely rather than offering a button that
 * cheerfully reports success and does nothing — the user would sit waiting for
 * an email that was never going to arrive. On those instances an owner resets
 * the password instead, which is what the copy says.
 */
export function ForgotPassword({ slug, onBack }: { slug: string; onBack(): void }) {
  const [email, setEmail] = useState('')
  const [code, setCode] = useState(slug)
  const [sent, setSent] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const r = await api.forgotPassword(code, email)
      setSent(r.message)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="auth">
      <form className="auth-card" onSubmit={submit}>
        <h1>Reset your password</h1>
        {sent ? (
          <>
            {/* Deliberately vague — a precise answer would tell a stranger
                which addresses have accounts here. */}
            <p className="tagline">{sent}</p>
            <button type="button" onClick={onBack}>
              Back to sign in
            </button>
          </>
        ) : (
          <>
            <label>
              Company code
              <input value={code} onChange={(e) => setCode(e.target.value)} autoComplete="organization" />
            </label>
            <label>
              Email
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="username"
              />
            </label>
            {error && <p className="error">{error}</p>}
            <button type="submit" disabled={busy || !email || !code}>
              {busy ? 'Sending…' : 'Send a reset link'}
            </button>
            <button type="button" className="ghost" onClick={onBack}>
              Back to sign in
            </button>
          </>
        )}
      </form>
    </div>
  )
}
