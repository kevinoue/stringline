import { useCallback, useEffect, useState } from 'react'
import { api, ApiError, clearToken, getToken, setToken, SOURCE_URL } from './api/client.js'
import type { Project, Template } from './api/types.js'
import { AcceptInvite } from './components/AcceptInvite.js'
import { ChangePassword } from './components/ChangePassword.js'
import { ForgotPassword, ResetPassword } from './components/ResetPassword.js'
import { Setup } from './components/Setup.js'
import { Team } from './components/Team.js'
import { ProjectView } from './ProjectView.js'

/**
 * Invite and reset links arrive as query parameters rather than paths, because
 * Stringline is served under a configurable base (`/stringline/` today, a bare
 * domain later) and a query string survives that move without the link format
 * having to know where the app is mounted.
 *
 * The parameter is stripped from the address bar once read, so a reset token
 * does not sit in browser history or get pasted into a bug report along with
 * the URL.
 */
function takeUrlParam(key: string): string | null {
  const params = new URLSearchParams(window.location.search)
  const value = params.get(key)
  if (value === null) return null
  params.delete(key)
  const query = params.toString()
  window.history.replaceState(
    {},
    '',
    window.location.pathname + (query ? `?${query}` : '') + window.location.hash,
  )
  return value
}

export function App() {
  const [authed, setAuthed] = useState(() => getToken() !== null)
  const [projectId, setProjectId] = useState<string | null>(null)

  /**
   * Whether this instance still needs its first account.
   *
   * `null` means we have not heard back yet. Showing the login during that gap
   * and then swapping it for the setup screen would make a fresh install look
   * broken for a moment, so nothing auth-related renders until we know. Only
   * asked when there is no token — someone already signed in cannot need setup.
   */
  const [setupNeeded, setSetupNeeded] = useState<boolean | null>(authed ? false : null)

  // Read once, on the first render, before anything can navigate.
  const [inviteCode, setInviteCode] = useState(() => takeUrlParam('invite'))
  const [resetToken, setResetToken] = useState(() => takeUrlParam('reset'))

  useEffect(() => {
    if (setupNeeded !== null) return
    let cancelled = false
    api
      .setupStatus()
      .then((r) => {
        if (!cancelled) setSetupNeeded(r.needed)
      })
      // A failure here must not strand the user on a spinner. Fall through to
      // the login, which will report whatever is actually wrong.
      .catch(() => {
        if (!cancelled) setSetupNeeded(false)
      })
    return () => {
      cancelled = true
    }
  }, [setupNeeded])

  // Both of these take precedence over everything else, including an existing
  // session: someone following an invite link on a shared laptop means to join
  // as themselves, not to land in whoever was signed in last.
  if (resetToken) return <ResetPassword token={resetToken} onDone={() => setResetToken(null)} />
  if (inviteCode) {
    return (
      <AcceptInvite
        code={inviteCode}
        onDone={() => {
          setInviteCode(null)
          setAuthed(true)
        }}
      />
    )
  }

  if (!authed) {
    if (setupNeeded === null) return <div className="auth" />
    if (setupNeeded) return <Setup onDone={() => setAuthed(true)} />
    return <Login onDone={() => setAuthed(true)} />
  }
  if (projectId) return <ProjectView projectId={projectId} onBack={() => setProjectId(null)} />
  return (
    <ProjectList
      onOpen={setProjectId}
      onSignOut={() => {
        clearToken()
        setAuthed(false)
      }}
    />
  )
}

function Login({ onDone }: { onDone(): void }) {
  const [slug, setSlug] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [forgot, setForgot] = useState(false)

  /**
   * Whether this server can send mail. Self-service reset is the one feature
   * that genuinely cannot work without it, so the link is hidden rather than
   * shown and then failing. Starts false so it never flashes in and out.
   */
  const [canEmail, setCanEmail] = useState(false)
  useEffect(() => {
    let cancelled = false
    api
      .emailStatus()
      .then((r) => !cancelled && setCanEmail(r.enabled))
      .catch(() => !cancelled && setCanEmail(false))
    return () => {
      cancelled = true
    }
  }, [])

  if (forgot) return <ForgotPassword slug={slug} onBack={() => setForgot(false)} />

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const result = await api.login(slug, email, password)
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
      <form className="auth-card" onSubmit={submit}>
        <h1>Stringline</h1>
        <p className="tagline">A schedule you can work to.</p>
        <label>
          Company code
          <input value={slug} onChange={(e) => setSlug(e.target.value)} autoComplete="organization" />
        </label>
        <label>
          Email
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" />
        </label>
        <label>
          Password
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
          />
        </label>
        {error && <p className="error">{error}</p>}
        <button type="submit" disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
        {canEmail && (
          <button type="button" className="linkish" onClick={() => setForgot(true)}>
            Forgot your password?
          </button>
        )}
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

function ProjectList({
  onOpen,
  onSignOut,
}: {
  onOpen(id: string): void
  onSignOut(): void
}) {
  const [projects, setProjects] = useState<Project[]>([])
  const [templates, setTemplates] = useState<Template[]>([])
  const [error, setError] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [start, setStart] = useState(new Date().toISOString().slice(0, 10))
  // null means "blank project"; anything else starts from that template.
  const [templateId, setTemplateId] = useState<string>('')
  const [busy, setBusy] = useState(false)
  const [changingPassword, setChangingPassword] = useState(false)
  const [showingTeam, setShowingTeam] = useState(false)

  const load = useCallback(async () => {
    try {
      setProjects((await api.listProjects()).projects)
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        onSignOut()
        return
      }
      setError((e as Error).message)
    }
  }, [onSignOut])

  useEffect(() => {
    void load()
    api.listTemplates().then((r) => setTemplates(r.templates)).catch(() => setTemplates([]))
  }, [load])

  const create = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!name) return
    setBusy(true)
    setError(null)
    try {
      if (templateId) {
        const made = await api.createFromTemplate(templateId, name, start)
        setName('')
        await load()
        // Straight into it — the point of a template is that there is already
        // something to look at.
        onOpen(made.projectId)
        return
      }
      await api.createProject(name, start)
      setName('')
      await load()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const byCategory = templates.reduce<Record<string, Template[]>>((acc, t) => {
    ;(acc[t.category] ??= []).push(t)
    return acc
  }, {})
  const chosen = templates.find((t) => t.id === templateId) ?? null

  return (
    <div className="page">
      <header className="toolbar">
        <h1 className="brand">Stringline</h1>
        <div className="spacer" />
        <button className="ghost" onClick={() => setShowingTeam(true)}>
          Team
        </button>
        <button className="ghost" onClick={() => setChangingPassword(true)}>
          Change password
        </button>
        <button className="ghost" onClick={onSignOut}>
          Sign out
        </button>
      </header>

      {changingPassword && <ChangePassword onClose={() => setChangingPassword(false)} />}
      {showingTeam && <Team onClose={() => setShowingTeam(false)} />}

      {error && <p className="error">{error}</p>}

      <form className="new-project" onSubmit={create}>
        <input placeholder="New project name" value={name} onChange={(e) => setName(e.target.value)} />
        <input type="date" value={start} onChange={(e) => setStart(e.target.value)} />
        <select value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
          <option value="">Blank project</option>
          {Object.entries(byCategory).map(([category, list]) => (
            <optgroup key={category} label={category}>
              {list.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                  {t.builtIn ? '' : ' (yours)'}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
        <button type="submit" disabled={busy}>
          {templateId ? 'Create from template' : 'Create'}
        </button>
      </form>
      {chosen && (
        <p className="template-hint">
          <strong>{chosen.name}</strong>
          {chosen.description ? ` — ${chosen.description}` : ''}{' '}
          <span className="sub">
            {chosen.taskCount} tasks, about {chosen.workingDays} working days of effort.
          </span>
        </p>
      )}

      <ul className="projects">
        {projects.map((p) => (
          <li key={p.id}>
            {/*
              The card and the delete control are siblings, not nested. A button
              inside a button is invalid markup and the inner one stops working
              in some browsers.
            */}
            <button className="project-card" onClick={() => onOpen(p.id)}>
              <strong>{p.name}</strong>
              <span>
                {p.start_date} → {p.computed_finish ?? 'not yet scheduled'}
              </span>
            </button>
            <button
              className="project-delete"
              title={`Delete ${p.name}`}
              aria-label={`Delete ${p.name}`}
              disabled={busy}
              onClick={async () => {
                if (!confirm(`Delete “${p.name}”?\n\nIt will be removed from your projects.`)) return
                setBusy(true)
                setError(null)
                try {
                  await api.archiveProject(p.id)
                  await load()
                } catch (err) {
                  setError(err instanceof ApiError ? err.message : String(err))
                } finally {
                  setBusy(false)
                }
              }}
            >
              ×
            </button>
          </li>
        ))}
        {projects.length === 0 && <li className="empty">No projects yet.</li>}
      </ul>
    </div>
  )
}
