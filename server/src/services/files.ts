/**
 * What is allowed to be uploaded, and how it is allowed to come back out.
 *
 * File upload is the easiest way to put a hole in a web application, so the
 * rules here are deliberately narrow:
 *
 *   1. **The declared type is not evidence.** A browser sends whatever
 *      `Content-Type` it likes and a filename can say anything. Every upload is
 *      identified by its leading bytes and rejected if they disagree with the
 *      extension.
 *   2. **SVG is not an image for these purposes.** It is a document that can
 *      contain `<script>`, so serving one inline from our own origin is stored
 *      XSS against every user who opens it. Blocked outright.
 *   3. **Everything downloads except a short image allowlist**, and even those
 *      are served with a content security policy that forbids scripts, plus
 *      `nosniff` so the browser cannot be talked into reinterpreting them.
 *   4. **The client never names a file on disk.** Storage names are generated
 *      here; the original is kept for display only.
 */

export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024 // 25 MB

interface FileType {
  ext: string[]
  mime: string
  /** Returns true if the buffer's leading bytes match this type. */
  sniff(head: Buffer): boolean
  /** Safe to render in the browser rather than download. */
  inline: boolean
}

const startsWith = (head: Buffer, bytes: number[]) =>
  bytes.every((b, i) => head[i] === b)

const ascii = (head: Buffer, text: string, offset = 0) =>
  head.subarray(offset, offset + text.length).toString('latin1') === text

const TYPES: FileType[] = [
  { ext: ['pdf'], mime: 'application/pdf', inline: false, sniff: (h) => ascii(h, '%PDF-') },
  { ext: ['png'], mime: 'image/png', inline: true,
    sniff: (h) => startsWith(h, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) },
  { ext: ['jpg', 'jpeg'], mime: 'image/jpeg', inline: true,
    sniff: (h) => startsWith(h, [0xff, 0xd8, 0xff]) },
  { ext: ['gif'], mime: 'image/gif', inline: true,
    sniff: (h) => ascii(h, 'GIF87a') || ascii(h, 'GIF89a') },
  { ext: ['webp'], mime: 'image/webp', inline: true,
    sniff: (h) => ascii(h, 'RIFF') && ascii(h, 'WEBP', 8) },
  { ext: ['heic', 'heif'], mime: 'image/heic', inline: false,
    sniff: (h) => ascii(h, 'ftyp', 4) && /hei[cf]|mif1|msf1/.test(h.subarray(8, 12).toString('latin1')) },
  // Modern Office formats are zip containers; the zip signature is as far as a
  // cheap sniff can go, and the extension decides which of them it claims to be.
  { ext: ['docx'], mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    inline: false, sniff: (h) => startsWith(h, [0x50, 0x4b, 0x03, 0x04]) },
  { ext: ['xlsx'], mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    inline: false, sniff: (h) => startsWith(h, [0x50, 0x4b, 0x03, 0x04]) },
  // Legacy Office is an OLE compound document.
  { ext: ['doc'], mime: 'application/msword', inline: false,
    sniff: (h) => startsWith(h, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]) },
  { ext: ['xls'], mime: 'application/vnd.ms-excel', inline: false,
    sniff: (h) => startsWith(h, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]) },
  // Text has no signature, so it is validated by content instead.
  { ext: ['txt', 'csv'], mime: 'text/plain', inline: false, sniff: () => true },
]

export const ACCEPTED_EXTENSIONS = [...new Set(TYPES.flatMap((t) => t.ext))].sort()

export interface IdentifiedFile {
  mime: string
  inline: boolean
  extension: string
}

export class UploadRejected extends Error {}

/**
 * Decide what a file actually is, from its bytes and its extension.
 * Throws `UploadRejected` with a readable reason rather than returning null,
 * because every caller wants to relay the reason to the user.
 */
export function identify(originalName: string, head: Buffer, size: number): IdentifiedFile {
  if (size <= 0) throw new UploadRejected('That file is empty.')
  if (size > MAX_UPLOAD_BYTES) {
    throw new UploadRejected(`Files must be under ${Math.floor(MAX_UPLOAD_BYTES / 1024 / 1024)} MB.`)
  }

  const extension = (originalName.split('.').pop() ?? '').toLowerCase()
  if (!extension || extension === originalName.toLowerCase()) {
    throw new UploadRejected('That file has no extension, so its type cannot be confirmed.')
  }

  const candidate = TYPES.find((t) => t.ext.includes(extension))
  if (!candidate) {
    throw new UploadRejected(
      `“.${extension}” files are not accepted. Allowed: ${ACCEPTED_EXTENSIONS.join(', ')}.`,
    )
  }

  if (!candidate.sniff(head)) {
    // The extension and the contents disagree. Either the file is corrupt or
    // somebody is trying to smuggle one type in as another.
    throw new UploadRejected(
      `That file does not look like a ${extension.toUpperCase()} inside. It was not saved.`,
    )
  }

  // Plain text is the one type with no signature, so check it reads as text.
  if (candidate.mime === 'text/plain' && head.subarray(0, 512).includes(0)) {
    throw new UploadRejected('That file is not plain text.')
  }

  return { mime: candidate.mime, inline: candidate.inline, extension }
}

/**
 * A storage name the client had no part in choosing.
 *
 * The original filename is never used to build a path — it is the exact place
 * a `../../` traversal arrives, and sanitising it correctly for every platform
 * is harder than simply not using it.
 */
export function storedNameFor(id: string, extension: string): string {
  return `${id}.${extension.replace(/[^a-z0-9]/gi, '')}`
}

/** Strip anything that could confuse a Content-Disposition header. */
export function safeDownloadName(originalName: string): string {
  return (
    originalName
      .replace(/[\r\n"\\]/g, '')
      .replace(/[/\\]/g, '_')
      .slice(0, 180) || 'download'
  )
}

/**
 * Where uploads live. Read here rather than in each route, so the routes and
 * the cleanup below cannot disagree about it.
 */
export const UPLOAD_DIR = process.env.UPLOAD_DIR ?? '/data/uploads'

/**
 * Remove stored files whose rows have gone.
 *
 * `attachments` cascades from both `tasks` and `projects`, which means deleting
 * a task takes its attachment rows with it and leaves the files behind forever.
 * That is how a live instance ended up with thirteen files and four rows.
 *
 * It matters more than tidiness for two reasons: on a real job these are
 * completion photographs rather than test fixtures, so the directory only ever
 * grows; and a restore brings back files the application has no way to see or
 * reach.
 *
 * Deliberately best-effort. The database is the record of what exists, so a
 * failed unlink must never fail the request that deleted the row — the worst
 * case is the leak we already had.
 */
export async function removeStoredFiles(storedNames: string[]): Promise<void> {
  const { unlink } = await import('node:fs/promises')
  const { join } = await import('node:path')
  await Promise.all(
    storedNames.map((name) =>
      unlink(join(UPLOAD_DIR, name)).catch((error: NodeJS.ErrnoException) => {
        // ENOENT is unremarkable: the row outlived the file, which is the
        // harmless direction of the same inconsistency.
        if (error.code !== 'ENOENT') {
          console.warn(`[files] could not remove ${name}: ${error.message}`)
        }
      }),
    ),
  )
}
