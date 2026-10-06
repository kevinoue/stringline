import { useCallback, useEffect, useRef, useState } from 'react'
import { api, ApiError } from '../api/client.js'
import type { Attachment } from '../api/types.js'

const KINDS: Array<{ value: Attachment['kind']; label: string }> = [
  { value: 'proof', label: 'Completion proof' },
  { value: 'document', label: 'Document' },
  { value: 'photo', label: 'Photo' },
]

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/**
 * Files attached to a task — completion proof, permits, sign-offs, photos.
 *
 * Downloads go through a plain link rather than fetch-and-blob, so the browser
 * handles saving and the server's Content-Disposition is what decides whether
 * something renders or downloads. Deciding that in the client would put the
 * choice on the wrong side of the trust boundary.
 */
export function Attachments({ taskId }: { taskId: string }) {
  const [items, setItems] = useState<Attachment[]>([])
  const [accepted, setAccepted] = useState<string[]>([])
  const [kind, setKind] = useState<Attachment['kind']>('proof')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const load = useCallback(async () => {
    try {
      const data = await api.listAttachments(taskId)
      setItems(data.attachments)
      setAccepted(data.accepted)
    } catch {
      setItems([])
    }
  }, [taskId])

  useEffect(() => {
    void load()
  }, [load])

  const onPick = async (file: File | undefined) => {
    if (!file) return
    setBusy(true)
    setError(null)
    try {
      await api.uploadAttachment(taskId, file, kind)
      await load()
      if (inputRef.current) inputRef.current.value = ''
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="panel-body attachments">
      <h3>Files</h3>

      <div className="attach-add">
        <select value={kind} onChange={(e) => setKind(e.target.value as Attachment['kind'])}>
          {KINDS.map((k) => (
            <option key={k.value} value={k.value}>
              {k.label}
            </option>
          ))}
        </select>
        <input
          ref={inputRef}
          type="file"
          disabled={busy}
          accept={accepted.map((e) => `.${e}`).join(',')}
          onChange={(e) => void onPick(e.target.files?.[0])}
        />
      </div>
      {accepted.length > 0 && (
        <p className="hint">PDF, Word, Excel, images and text. Up to 25 MB.</p>
      )}
      {error && <p className="error">{error}</p>}

      {items.length === 0 && <p className="hint">No files attached yet.</p>}
      <ul className="attach-list">
        {items.map((a) => (
          <li key={a.id}>
            <a href={api.attachmentUrl(a.id)} target="_blank" rel="noreferrer" title={a.originalName}>
              <span className={`attach-kind ${a.kind}`}>{a.kind === 'proof' ? '✓' : a.kind === 'photo' ? '▣' : '▤'}</span>
              <span className="attach-name">{a.originalName}</span>
            </a>
            <span className="attach-size">{humanSize(a.sizeBytes)}</span>
            <button
              className="ghost"
              aria-label={`Remove ${a.originalName}`}
              title={`Remove ${a.originalName}`}
              disabled={busy}
              onClick={async () => {
                if (!confirm(`Remove “${a.originalName}”?`)) return
                setBusy(true)
                try {
                  await api.deleteAttachment(a.id)
                  await load()
                } catch (e) {
                  setError(e instanceof ApiError ? e.message : String(e))
                } finally {
                  setBusy(false)
                }
              }}
            >
              ×
            </button>
          </li>
        ))}
      </ul>
    </section>
  )
}
