import { useCallback, useEffect, useState } from 'react'
import { api, ApiError } from '../api/client.js'
import type { Invite, Member, Role, TeamView } from '../api/types.js'

const ROLE_LABELS: Record<Role, string> = {
  owner: 'Owner',
  planner: 'Planner',
  field: 'Field',
  client: 'Client',
}

const ROLE_NOTES: Record<Role, string> = {
  owner: 'Everything, including the team and billing.',
  planner: 'Can build and change schedules.',
  field: 'Reports progress on their own work. Free seat.',
  client: 'Sees milestones and dates only. Free seat.',
}

/**
 * The team screen.
 *
 * The design decision worth knowing: an invite's **code and link are shown
 * here**, not just emailed. Most Stringline instances will have no email
 * configured at all, and an invite flow that depends on mail would make the
 * free-unlimited-seats promise unreachable for exactly the people it is aimed
 * at. Email, when present, is an extra channel.
 */
export function Team({ onClose }: { onClose(): void }) {
  const [view, setView] = useState<TeamView | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const [email, setEmail] = useState('')
  const [name, setName] = useState('')
  const [role, setRole] = useState<Role>('field')

  /** The invite just created, held so its code stays on screen to be copied. */
  const [fresh, setFresh] = useState<{ invite: Invite; emailed: boolean } | null>(null)
  /** A temporary password just issued, for the same reason. */
  const [temporary, setTemporary] = useState<{ who: string; password: string; emailed: boolean } | null>(
    null,
  )
  const [copied, setCopied] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      setView(await api.team())
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e))
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const copy = async (what: string, value: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(what)
      setTimeout(() => setCopied(null), 1800)
    } catch {
      // Clipboard access is denied in plenty of ordinary situations — an
      // insecure origin, a browser setting. The value is on screen either way,
      // so this is not worth an error message.
    }
  }

  const invite = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    if (!email) return
    setBusy(true)
    setError(null)
    try {
      // Spread rather than `name: name || undefined`: the project builds with
      // exactOptionalPropertyTypes, where an explicit undefined is not the same
      // as an absent key.
      const result = await api.invite({ email, role, ...(name ? { name } : {}) })
      setFresh({ invite: result.invite, emailed: result.emailed })
      setEmail('')
      setName('')
      await load()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const revoke = async (i: Invite): Promise<void> => {
    if (!confirm(`Revoke the invite for ${i.email}? Their code stops working immediately.`)) return
    try {
      await api.revokeInvite(i.id)
      if (fresh?.invite.id === i.id) setFresh(null)
      await load()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err))
    }
  }

  const resetFor = async (m: Member): Promise<void> => {
    if (
      !confirm(
        `Reset ${m.name}'s password?\n\nThey will be signed out on every device, and you will get a temporary password to give them.`,
      )
    )
      return
    try {
      const result = await api.resetTeammate(m.id)
      setTemporary({ who: m.name, password: result.temporaryPassword, emailed: result.emailed })
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err))
    }
  }

  const changeRole = async (m: Member, next: Role): Promise<void> => {
    try {
      await api.updateMember(m.id, { role: next })
      await load()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err))
    }
  }

  const setActive = async (m: Member, active: boolean): Promise<void> => {
    if (!active && !confirm(`Disable ${m.name}? They will not be able to sign in.`)) return
    try {
      await api.updateMember(m.id, { isActive: active })
      await load()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err))
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal modal-wide" onClick={(e) => e.stopPropagation()}>
        <h2>Team</h2>

        {error && <p className="error">{error}</p>}

        {view && (
          <p className="hint">
            {view.seatsUsed} {view.seatsUsed === 1 ? 'person' : 'people'} on a paid seat. Field and
            client seats are free and unlimited.
            {!view.emailEnabled && ' This server cannot send email, so invite codes are shown here to pass on yourself.'}
          </p>
        )}

        <h3>People</h3>
        <table className="team-table">
          <tbody>
            {view?.members.map((m) => (
              <tr key={m.id} className={m.is_active ? '' : 'inactive'}>
                <td>
                  <strong>{m.name}</strong>
                  {m.id === view.you && <span className="sub"> — you</span>}
                  <br />
                  <span className="sub">{m.email}</span>
                </td>
                <td>
                  {/* Changing your own role or disabling yourself would leave
                      nobody able to undo it, so neither is offered. The server
                      refuses both as well; this is so the buttons are not
                      there to be clicked in the first place. */}
                  {m.id === view.you ? (
                    <span className="sub">{ROLE_LABELS[m.role]}</span>
                  ) : (
                    <select
                      value={m.role}
                      onChange={(e) => void changeRole(m, e.target.value as Role)}
                      title={ROLE_NOTES[m.role]}
                    >
                      {(Object.keys(ROLE_LABELS) as Role[]).map((r) => (
                        <option key={r} value={r}>
                          {ROLE_LABELS[r]}
                        </option>
                      ))}
                    </select>
                  )}
                </td>
                <td className="right">
                  {m.id === view.you ? (
                    <span className="sub">Use “Change password”</span>
                  ) : (
                    <>
                      <button className="ghost" onClick={() => void resetFor(m)}>
                        Reset password
                      </button>
                      {m.is_active ? (
                        <button className="ghost danger" onClick={() => void setActive(m, false)}>
                          Disable
                        </button>
                      ) : (
                        <button className="ghost" onClick={() => void setActive(m, true)}>
                          Enable
                        </button>
                      )}
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        {temporary && (
          <div className="handout">
            <p className="hint">
              {temporary.emailed
                ? `Emailed to ${temporary.who}. They are signed out everywhere.`
                : `Give this to ${temporary.who}. They are signed out everywhere.`}
            </p>
            <div className="handout-row">
              <code>{temporary.password}</code>
              <button className="ghost" onClick={() => void copy('password', temporary.password)}>
                {copied === 'password' ? 'Copied' : 'Copy'}
              </button>
              <button className="ghost" onClick={() => setTemporary(null)}>
                Done
              </button>
            </div>
          </div>
        )}

        <h3>Invite someone</h3>
        <form className="invite-form" onSubmit={invite}>
          <input
            type="email"
            placeholder="their email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <input
            placeholder="their name (optional)"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <select value={role} onChange={(e) => setRole(e.target.value as Role)}>
            {(Object.keys(ROLE_LABELS) as Role[]).map((r) => (
              <option key={r} value={r}>
                {ROLE_LABELS[r]}
              </option>
            ))}
          </select>
          <button type="submit" disabled={busy || !email}>
            {busy ? 'Inviting…' : 'Invite'}
          </button>
        </form>
        <p className="hint">{ROLE_NOTES[role]}</p>

        {fresh && (
          <div className="handout">
            <p className="hint">
              {fresh.emailed
                ? `Emailed to ${fresh.invite.email}. You can also send the link yourself:`
                : `Send this to ${fresh.invite.email} however you like:`}
            </p>
            <div className="handout-row">
              <code className="grow">{fresh.invite.url}</code>
              <button className="ghost" onClick={() => void copy('link', fresh.invite.url)}>
                {copied === 'link' ? 'Copied' : 'Copy link'}
              </button>
            </div>
            <div className="handout-row">
              <code>{fresh.invite.token}</code>
              <button className="ghost" onClick={() => void copy('code', fresh.invite.token)}>
                {copied === 'code' ? 'Copied' : 'Copy code'}
              </button>
              <button className="ghost" onClick={() => setFresh(null)}>
                Done
              </button>
            </div>
          </div>
        )}

        {view && view.invites.length > 0 && (
          <>
            <h3>Waiting to accept</h3>
            <table className="team-table">
              <tbody>
                {view.invites.map((i) => (
                  <tr key={i.id}>
                    <td>
                      <strong>{i.email}</strong>
                      <br />
                      <span className="sub">
                        {ROLE_LABELS[i.role]}
                        {i.invited_by ? ` · invited by ${i.invited_by}` : ''}
                      </span>
                    </td>
                    <td>
                      <code>{i.token}</code>
                    </td>
                    <td className="right">
                      <button className="ghost" onClick={() => void copy(i.id, i.url)}>
                        {copied === i.id ? 'Copied' : 'Copy link'}
                      </button>
                      <button className="ghost danger" onClick={() => void revoke(i)}>
                        Revoke
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}

        <div className="modal-actions">
          <button onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  )
}
