import { useEffect, useState } from 'react'
import { api, ApiError, setToken, SOURCE_URL } from '../api/client.js'
import type { Role } from '../api/types.js'

const ROLE_LABELS: Record<Role, string> = {
  owner: 'an owner',
  planner: 'a planner',
  field: 'field crew',
  client: 'a client',
}

/**
 * Accepting an invite, reached from the link in `?invite=CODE`.
 *
 * The code is validated before the form is shown, so someone arriving with a
 * revoked or expired link is told immediately rather than after they have
 * chosen a password. Accepting signs them straight in — making a person type a
 * password they set two seconds ago is the kind of friction that loses a field
 * crew before they have opened anything.
 */
export function AcceptInvite({ code, onDone }: { code: string; onDone(): void }) {
  const [state, setState] = useState<
    | { phase: 'checking' }
    | { phase: 'invalid'; message: string }
    | { phase: 'ready'; companyName: string; role: Role; email: string }
  >({ phase: 'checking' })

  const [name, setName] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let cancelled = false
    api
      .validateInvite(code)
      .then((r) => {
        if (cancelled) return
        setName(r.name ?? '')
        setState({ phase: 'ready', companyName: r.companyName, role: r.role, email: r.email })
      })
      .catch((e: unknown) => {
        if (cancelled) return
        setState({
          phase: 'invalid',
          message:
            e instanceof ApiError
              ? e.message
              : 'That invite link could not be checked. Try again in a moment.',
        })
      })
    return () => {
      cancelled = true
    }
  }, [code])

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const result = await api.acceptInvite(code, password, name)
      setToken(result.token)
      onDone()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  if (state.phase === 'checking') return <div className="auth" />

  if (state.phase === 'invalid') {
    return (
      <div className="auth">
        <div className="auth-card">
          <h1>That invite is not valid</h1>
          <p className="tagline">{state.message}</p>
          <p className="hint">
            Invites expire after 7 days, and stop working once used or revoked. Ask whoever invited
            you to send a new one.
          </p>
          <button onClick={onDone}>Go to sign in</button>
        </div>
      </div>
    )
  }

  return (
    <div className="auth">
      <form className="auth-card" onSubmit={submit}>
        <h1>Join {state.companyName}</h1>
        <p className="tagline">You have been invited as {ROLE_LABELS[state.role]}.</p>

        <label>
          Your name
          <input value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" />
        </label>
        <label>
          Email
          {/* Fixed: the invite was issued to this address, and letting it be
              edited here would let anyone with a code claim a different one. */}
          <input value={state.email} readOnly disabled autoComplete="username" />
        </label>
        <label>
          Choose a password
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="new-password"
          />
        </label>
        <p className="hint">At least 8 characters.</p>

        {error && <p className="error">{error}</p>}
        <button type="submit" disabled={busy || !password}>
          {busy ? 'Joining…' : 'Join'}
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
