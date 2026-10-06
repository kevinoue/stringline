/**
 * Task attachments — completion proof, permits, sign-offs, photos.
 *
 * Uploads are held in memory only long enough to identify them, then written
 * under a server-chosen name. See `services/files.ts` for what is accepted and
 * why the rules are as narrow as they are.
 */

import { randomUUID } from 'node:crypto'
import { mkdir, unlink, writeFile } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { join } from 'node:path'
import { Router, type Request, type Response } from 'express'
import multer from 'multer'
import { transaction } from '../db/pool.js'
import { authenticate, requirePlanner } from '../middleware/auth.js'
import { requireCompany } from '../middleware/company.js'
import {
  ACCEPTED_EXTENSIONS,
  MAX_UPLOAD_BYTES,
  identify,
  safeDownloadName,
  storedNameFor,
  UploadRejected,
} from '../services/files.js'
import { param } from './util.js'

const router = Router()

/**
 * Auth is applied per route, not with `router.use`.
 *
 * These paths sit at two different prefixes (`/tasks/...` and `/attachments/...`)
 * so the router is mounted at `/` — and router-level middleware there runs for
 * *every* request that passes through, including ones it has no route for.
 * Doing it that way put `/health` behind authentication and broke the deploy
 * check. Per-route is slightly more typing and cannot leak.
 */
const guarded = [authenticate, requireCompany] as const

const UPLOAD_DIR = process.env.UPLOAD_DIR ?? '/data/uploads'

// Memory storage, deliberately: multer's disk storage writes the file before
// anything has looked at it, which means a rejected upload still touched the
// filesystem. Nothing reaches disk here until it has been identified.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
})

/**
 * Multer rejects an oversized file by throwing, which Express turns into a 500
 * and "Internal error" — a message that tells the user nothing and sends them
 * looking for a bug that is not there. Translate it into the real reason.
 */
function uploadFile(req: Request, res: Response, next: () => void): void {
  upload.single('file')(req, res, (error: unknown) => {
    if (error) {
      const code = (error as { code?: string }).code
      if (code === 'LIMIT_FILE_SIZE') {
        res.status(413).json({
          error: `Files must be under ${Math.floor(MAX_UPLOAD_BYTES / 1024 / 1024)} MB.`,
        })
        return
      }
      res.status(400).json({ error: 'That upload could not be read.' })
      return
    }
    next()
  })
}

/**
 * Confirm the task belongs to the caller's company before anything else.
 * Attachments are scoped through the project, so this is the only thing
 * standing between one company's files and another's.
 */
async function ownsTask(
  client: { query: (q: string, v: unknown[]) => Promise<{ rows: unknown[] }> },
  taskId: string,
  companyId: string,
): Promise<{ projectId: string } | null> {
  const { rows } = await client.query(
    `SELECT t.project_id FROM tasks t
     JOIN projects p ON p.id = t.project_id
     WHERE t.id = $1 AND p.company_id = $2`,
    [taskId, companyId],
  )
  const row = rows[0] as { project_id: string } | undefined
  return row ? { projectId: row.project_id } : null
}

router.get('/tasks/:taskId/attachments', ...guarded, async (req: Request, res: Response) => {
  const taskId = param(req, 'taskId')
  const rows = await transaction(async (client) => {
    if (!(await ownsTask(client, taskId, req.company!.id))) return null
    const { rows } = await client.query(
      `SELECT a.id, a.original_name AS "originalName", a.mime_type AS "mimeType",
              a.size_bytes AS "sizeBytes", a.kind, a.note, a.created_at AS "createdAt",
              u.name AS "uploadedBy"
       FROM attachments a
       LEFT JOIN users u ON u.id = a.uploaded_by
       WHERE a.task_id = $1 ORDER BY a.created_at DESC`,
      [taskId],
    )
    return rows
  })
  if (!rows) {
    res.status(404).json({ error: 'Task not found' })
    return
  }
  res.json({ attachments: rows, accepted: ACCEPTED_EXTENSIONS, maxBytes: MAX_UPLOAD_BYTES })
})

router.post(
  '/tasks/:taskId/attachments',
  ...guarded,
  requirePlanner,
  uploadFile,
  async (req: Request, res: Response) => {
    const taskId = param(req, 'taskId')
    const file = req.file
    if (!file) {
      res.status(400).json({ error: 'No file was uploaded.' })
      return
    }

    let identified
    try {
      identified = identify(file.originalname, file.buffer.subarray(0, 64), file.size)
    } catch (error) {
      if (error instanceof UploadRejected) {
        res.status(422).json({ error: error.message })
        return
      }
      throw error
    }

    const id = randomUUID()
    const storedName = storedNameFor(id, identified.extension)

    try {
      const saved = await transaction(async (client) => {
        const owned = await ownsTask(client, taskId, req.company!.id)
        if (!owned) return null

        await mkdir(UPLOAD_DIR, { recursive: true })
        await writeFile(join(UPLOAD_DIR, storedName), file.buffer, { flag: 'wx' })

        const { rows } = await client.query(
          `INSERT INTO attachments
             (id, task_id, project_id, original_name, stored_name, mime_type, size_bytes, kind, note, uploaded_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
           RETURNING id, original_name AS "originalName", mime_type AS "mimeType",
                     size_bytes AS "sizeBytes", kind, note, created_at AS "createdAt"`,
          [
            id, taskId, owned.projectId, file.originalname, storedName,
            identified.mime, file.size,
            (req.body?.kind as string) ?? 'document',
            (req.body?.note as string) || null,
            req.user!.id,
          ],
        )
        return rows[0]
      })

      if (!saved) {
        res.status(404).json({ error: 'Task not found' })
        return
      }
      res.status(201).json({ attachment: saved })
    } catch (error) {
      // If the row failed after the bytes landed, do not leave an orphan behind.
      await unlink(join(UPLOAD_DIR, storedName)).catch(() => {})
      console.error('[attachment-upload]', (error as Error).message)
      res.status(500).json({ error: 'Upload failed' })
    }
  },
)

router.get('/attachments/:attachmentId', ...guarded, async (req: Request, res: Response) => {
  const attachmentId = param(req, 'attachmentId')
  const row = await transaction(async (client) => {
    const { rows } = await client.query<{
      stored_name: string
      original_name: string
      mime_type: string
      size_bytes: string
    }>(
      `SELECT a.stored_name, a.original_name, a.mime_type, a.size_bytes
       FROM attachments a
       JOIN projects p ON p.id = a.project_id
       WHERE a.id = $1 AND p.company_id = $2`,
      [attachmentId, req.company!.id],
    )
    return rows[0] ?? null
  })

  if (!row) {
    res.status(404).json({ error: 'Not found' })
    return
  }

  // Only a short image allowlist renders in place; everything else downloads.
  // Even those get a policy that forbids scripts and a nosniff header, so the
  // browser cannot be persuaded to treat the bytes as anything else.
  const inlineTypes = ['image/png', 'image/jpeg', 'image/gif', 'image/webp']
  const inline = inlineTypes.includes(row.mime_type)

  res.setHeader('Content-Type', row.mime_type)
  res.setHeader('Content-Length', row.size_bytes)
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self'; sandbox")
  res.setHeader(
    'Content-Disposition',
    `${inline ? 'inline' : 'attachment'}; filename="${safeDownloadName(row.original_name)}"`,
  )

  const stream = createReadStream(join(UPLOAD_DIR, row.stored_name))
  stream.on('error', () => {
    if (!res.headersSent) res.status(404).json({ error: 'File missing from storage' })
    else res.end()
  })
  stream.pipe(res)
})

router.delete('/attachments/:attachmentId', ...guarded, requirePlanner, async (req: Request, res: Response) => {
  const attachmentId = param(req, 'attachmentId')
  const removed = await transaction(async (client) => {
    const { rows } = await client.query<{ stored_name: string }>(
      `DELETE FROM attachments a
       USING projects p
       WHERE a.id = $1 AND p.id = a.project_id AND p.company_id = $2
       RETURNING a.stored_name`,
      [attachmentId, req.company!.id],
    )
    return rows[0]?.stored_name ?? null
  })

  if (!removed) {
    res.status(404).json({ error: 'Not found' })
    return
  }
  // The row is gone either way; a leftover file is tidiness, not correctness.
  await unlink(join(UPLOAD_DIR, removed)).catch(() => {})
  res.status(204).end()
})

export default router
