import { useState } from 'react'
import { api, ApiError, setToken, SOURCE_URL } from '../api/client.js'

/**
 * First-run setup for a self-hosted Stringline.
 *
 * Shown instead of the login when the instance has no accounts. The setup code
 * is printed in the server log rather than shown here — if the page simply let
 * anyone claim the instance, whoever found the URL first would own it. Asking
 * for something only the person who deployed it can read is the whole point.
 */
export function Setup({ onDone }: { onDone(): void }) {
  const [setupToken, setSetupToken] = useState('')
  const [companyName, setCompanyName] = useState('')
  const [slug, setSlug] = useState('')
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  /**
   * Suggest a company code from the company name, but only while the user has
   * not typed their own. Overwriting a deliberate choice because they went back
   * to fix a typo in the name is the kind of thing that makes a form feel
   * hostile.
   */
  const [slugTouched, setSlugTouched] = useState(false)
  const suggest = (value: string): void => {
    setCompanyName(value)
    if (slugTouched) return
    setSlug(
      value
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 40),
    )
  }

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const result = await api.setup({ setupToken, companyName, slug, email, password, name })
      setToken(result.token)
      onDone()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="auth">
      <form className="auth-card auth-card-wide" onSubmit={submit}>
        <h1>Set up Stringline</h1>
        <p className="tagline">Nobody has claimed this instance yet.</p>

        <label>
          Setup code
          <input
            value={setupToken}
            onChange={(e) => setSetupToken(e.target.value)}
            placeholder="printed in the server log"
            autoComplete="off"
          />
        </label>
        <p className="hint">
          Find it in the server log at startup:
          <br />
          <code>docker compose logs api</code>
        </p>

        <hr />

        <label>
          Company name
          <input value={companyName} onChange={(e) => suggest(e.target.value)} />
        </label>
        <label>
          Company code
          <input
            value={slug}
            onChange={(e) => {
              setSlugTouched(true)
              setSlug(e.target.value.toLowerCase())
            }}
            autoComplete="organization"
          />
        </label>
        <p className="hint">Everyone signs in with this. Lowercase letters, numbers and hyphens.</p>

        <hr />

        <label>
          Your name
          <input value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" />
        </label>
        <label>
          Your email
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="username"
          />
        </label>
        <label>
          Password
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="new-password"
          />
        </label>
        <p className="hint">At least 8 characters. You will be the owner.</p>

        {error && <p className="error">{error}</p>}
        <button type="submit" disabled={busy}>
          {busy ? 'Setting up…' : 'Create my company'}
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
