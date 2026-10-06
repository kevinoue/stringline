import { useCallback, useEffect, useState } from 'react'
import { api, ApiError, clearToken, getToken, setToken, SOURCE_URL } from './api/client.js'
import type { Project, Template } from './api/types.js'
import { ChangePassword } from './components/ChangePassword.js'
import { ProjectView } from './ProjectView.js'

export function App() {
  const [authed, setAuthed] = useState(() => getToken() !== null)
  const [projectId, setProjectId] = useState<string | null>(null)

  if (!authed) return <Login onDone={() => setAuthed(true)} />
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
        <button className="ghost" onClick={() => setChangingPassword(true)}>
          Change password
        </button>
        <button className="ghost" onClick={onSignOut}>
          Sign out
        </button>
      </header>

      {changingPassword && <ChangePassword onClose={() => setChangingPassword(false)} />}

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
