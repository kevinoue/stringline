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
import { BCRYPT_ROUNDS } from '../services/provisioning.js'
import { checkPassword, clientIp, record, userAgent } from '../services/security.js'

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

  await record({
    companyId: company.id,
    userId: user.id,
    kind: 'password.reset.requested',
    subject: user.email,
    ip: clientIp(req),
    userAgent: userAgent(req),
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
  const outcome = await transaction(async (client) => {
    // Claimed inside the transaction with FOR UPDATE, so the same link used
    // twice at once resets the password once.
    const { rows } = await client.query<{ id: string; user_id: string; valid: boolean }>(
      `SELECT id, user_id, (used_at IS NULL AND expires_at > NOW()) AS valid
         FROM password_reset_tokens WHERE token_hash = $1 FOR UPDATE`,
      [hashToken(String(token))],
    )
    const claim = rows[0]
    if (!claim || !claim.valid) return { ok: false as const }

    const { rows: who } = await client.query<{
      id: string
      name: string
      email: string
      company_id: string
      company_name: string
      slug: string
    }>(
      `SELECT u.id, u.name, u.email, u.company_id, c.name AS company_name, c.slug
         FROM users u JOIN companies c ON c.id = u.company_id
        WHERE u.id = $1`,
      [claim.user_id],
    )
    const person = who[0]!

    /*
     * The policy check happens here, inside the claim.
     *
     * It needs the account's address and company code to reject a password
     * built from either, and neither is known until the token resolves. A weak
     * password therefore does not consume the link — the transaction rolls
     * back and the user can try again with a better one, which is the
     * behaviour you want when the alternative is "your reset link is now dead
     * because you chose a short password".
     */
    const verdict = checkPassword(String(newPassword), [
      person.email.split('@')[0] ?? '',
      person.slug,
    ])
    if (!verdict.ok) return { ok: false as const, weak: verdict.reason! }

    const hash = await bcrypt.hash(String(newPassword), BCRYPT_ROUNDS)
    await client.query('UPDATE password_reset_tokens SET used_at = NOW() WHERE id = $1', [claim.id])
    await client.query(
      `UPDATE users
          SET password_hash = $2, password_changed_at = NOW(), token_version = token_version + 1
        WHERE id = $1`,
      [claim.user_id, hash],
    )
    return { ok: true as const, person }
  })

  if (!outcome.ok) {
    if ('weak' in outcome && outcome.weak) {
      res.status(400).json({ error: outcome.weak })
      return
    }
    res.status(400).json({ error: 'That reset link has expired or been used already' })
    return
  }

  await record({
    companyId: outcome.person.company_id,
    userId: outcome.person.id,
    kind: 'password.reset.completed',
    subject: outcome.person.email,
    ip: clientIp(req),
    userAgent: userAgent(req),
  })

  // The notice that matters most: if this reset was not theirs, this is how
  // they find out an attacker has taken the account.
  void email.sendSecurityNotice({
    to: outcome.person.email,
    name: outcome.person.name,
    what: 'Your Stringline password was reset',
    detail:
      'Your password was reset using a link sent to this address, and every device has been signed out.',
    companyName: outcome.person.company_name,
    when: new Date(),
    ip: clientIp(req) ?? undefined,
  })

  res.json({ message: 'Password set. You can sign in now — other devices have been signed out.' })
})

export default router
