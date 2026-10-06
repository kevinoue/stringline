/**
 * Self-service password reset.
 *
 * Ported from PropertyPlex's `routes/password-reset.js`, with three changes.
 *
 * It takes a **company code as well as an email**, because Stringline's users
 * table is unique on (company_id, email) — the same address can legitimately
 * belong to two companies, and PropertyPlex's email-only lookup would have had
 * to pick one.
 *
 * Completing a reset **bumps `token_version`**, so every other session dies.
 * PropertyPlex's version left them alive, which means a reset prompted by a
 * lost phone left that phone signed in — the one scenario the feature exists
 * for.
 *
 * And the whole thing **requires email**, so it reports that plainly rather
 * than silently succeeding at nothing. An owner-led reset covers instances with
 * no mail configured; see `routes/team.ts`.
 */

import bcrypt from 'bcryptjs'
import { createHash, randomBytes } from 'node:crypto'
import { Router, type Request, type Response } from 'express'
import rateLimit from 'express-rate-limit'
import { pool, transaction } from '../db/pool.js'
import { resolveCompanyBySlug } from '../middleware/company.js'
import * as email from '../services/email.js'
import { BCRYPT_ROUNDS, MIN_PASSWORD_LENGTH } from '../services/provisioning.js'

const router = Router()

const EXPIRES_MINUTES = 15
/** Per account, per hour. The IP-level limit is applied where this mounts. */
const MAX_REQUESTS_PER_HOUR = 3

/**
 * Per-IP, on the two routes that matter. Applied here rather than at the mount
 * point because `/auth` already carries a limiter — stacking two on the same
 * request makes the effective budget whichever is smaller, decided by import
 * order, which is not a thing anyone should have to reason about.
 *
 * An hour rather than fifteen minutes: this route sends mail, so an
 * unthrottled one lets a stranger use this server to flood someone's inbox.
 */
const resetLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: Number(process.env.RESET_RATE_LIMIT ?? 20),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts. Please wait a while.' },
})

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

/**
 * Whether the UI should offer "forgot password" at all.
 *
 * Offering a button that cannot work and reports success is worse than not
 * offering it: the user waits for an email that was never going to arrive.
 */
router.get('/status', (_req: Request, res: Response) => {
  res.json({ enabled: email.isEnabled() })
})

router.post('/forgot-password', resetLimiter, async (req: Request, res: Response) => {
  const { slug, email: address } = req.body ?? {}

  // Identical whatever happens, so this cannot be used to discover which
  // addresses have accounts. The one exception is email being unconfigured,
  // which is a property of the server rather than of any account.
  const vague = { message: 'If that account exists, a reset link is on its way.' }

  if (!email.isEnabled()) {
    res.status(503).json({
      error: 'This Stringline cannot send email. Ask an owner to reset your password.',
      code: 'EMAIL_DISABLED',
    })
    return
  }

  if (!slug || !address) {
    res.json(vague)
    return
  }

  const company = await resolveCompanyBySlug(String(slug))
  if (!company) {
    res.json(vague)
    return
  }

  const { rows } = await pool.query<{ id: string; name: string; email: string }>(
    `SELECT id, name, email FROM users
      WHERE company_id = $1 AND email = $2 AND is_active`,
    [company.id, String(address).toLowerCase().trim()],
  )
  const user = rows[0]
  if (!user) {
    res.json(vague)
    return
  }

  // Per-account throttle, on top of the per-IP limiter. Without it, one address
  // can be mailbombed from a rotating set of addresses.
  const { rows: recent } = await pool.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM password_reset_tokens
      WHERE user_id = $1 AND created_at > NOW() - INTERVAL '1 hour'`,
    [user.id],
  )
  if (Number(recent[0]!.count) >= MAX_REQUESTS_PER_HOUR) {
    console.warn(`[reset] throttled: ${user.id} has asked ${recent[0]!.count} times this hour`)
    res.json(vague)
    return
  }

  const token = randomBytes(32).toString('hex')

  await transaction(async (client) => {
    // Any earlier link stops working. Two live reset links for one account is
    // one more than anybody needs.
    await client.query(
      'UPDATE password_reset_tokens SET used_at = NOW() WHERE user_id = $1 AND used_at IS NULL',
      [user.id],
    )
    await client.query(
      `INSERT INTO password_reset_tokens (user_id, token_hash, expires_at)
       VALUES ($1, $2, NOW() + ($3 || ' minutes')::interval)`,
      [user.id, hashToken(token), String(EXPIRES_MINUTES)],
    )
  })

  await email.sendPasswordReset({
    to: user.email,
    name: user.name,
    resetUrl: `${email.publicUrl()}/?reset=${token}`,
    expiresMinutes: EXPIRES_MINUTES,
  })

  res.json(vague)
})

/** Checked before the form is shown, so an expired link says so up front. */
router.get('/reset-password/validate', async (req: Request, res: Response) => {
  const token = req.query.token
  if (typeof token !== 'string' || token.length === 0) {
    res.json({ valid: false })
    return
  }

  const { rows } = await pool.query<{ valid: boolean }>(
    `SELECT (used_at IS NULL AND expires_at > NOW()) AS valid
       FROM password_reset_tokens WHERE token_hash = $1`,
    [hashToken(token)],
  )
  res.json({ valid: rows[0]?.valid === true })
})

router.post('/reset-password', resetLimiter, async (req: Request, res: Response) => {
  const { token, newPassword } = req.body ?? {}
  if (!token || !newPassword) {
    res.status(400).json({ error: 'token and newPassword are required' })
    return
  }
  if (String(newPassword).length < MIN_PASSWORD_LENGTH) {
    res.status(400).json({ error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters` })
    return
  }

  const hash = await bcrypt.hash(String(newPassword), BCRYPT_ROUNDS)

  const outcome = await transaction(async (client) => {
    // Claimed inside the transaction with FOR UPDATE, so the same link used
    // twice at once resets the password once.
    const { rows } = await client.query<{ id: string; user_id: string; valid: boolean }>(
      `SELECT id, user_id, (used_at IS NULL AND expires_at > NOW()) AS valid
         FROM password_reset_tokens WHERE token_hash = $1 FOR UPDATE`,
      [hashToken(String(token))],
    )
    const record = rows[0]
    if (!record || !record.valid) return { ok: false as const }

    await client.query('UPDATE password_reset_tokens SET used_at = NOW() WHERE id = $1', [record.id])
    await client.query(
      `UPDATE users
          SET password_hash = $2, password_changed_at = NOW(), token_version = token_version + 1
        WHERE id = $1`,
      [record.user_id, hash],
    )
    return { ok: true as const }
  })

  if (!outcome.ok) {
    res.status(400).json({ error: 'That reset link has expired or been used already' })
    return
  }

  res.json({ message: 'Password set. You can sign in now — other devices have been signed out.' })
})

export default router
