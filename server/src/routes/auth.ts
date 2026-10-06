/**
 * Signup and login.
 *
 * Signup creates a company, its owner, and a default Mon–Fri calendar in one
 * transaction — a company without a calendar cannot schedule anything, so the
 * two are never allowed to exist apart.
 */

import bcrypt from 'bcryptjs'
import { Router, type Request, type Response } from 'express'
import { transaction } from '../db/pool.js'
import { authenticate, generateToken } from '../middleware/auth.js'
import { resolveCompanyBySlug } from '../middleware/company.js'
import { pool } from '../db/pool.js'

const router = Router()

const BCRYPT_ROUNDS = 12
const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/

router.post('/signup', async (req: Request, res: Response) => {
  const { companyName, slug, email, password, name } = req.body ?? {}

  if (!companyName || !slug || !email || !password || !name) {
    res.status(400).json({ error: 'companyName, slug, email, password and name are required' })
    return
  }
  const normalisedSlug = String(slug).toLowerCase().trim()
  if (!SLUG_PATTERN.test(normalisedSlug)) {
    res.status(400).json({
      error: 'Company code must be 3–40 characters, lowercase letters, numbers and hyphens',
    })
    return
  }
  if (String(password).length < 8) {
    res.status(400).json({ error: 'Password must be at least 8 characters' })
    return
  }

  const normalisedEmail = String(email).toLowerCase().trim()

  try {
    const result = await transaction(async (client) => {
      // Stringline is free: no trial, no expiry, no plan to upgrade to. The
      // column defaults carry plan='free' and status='active'.
      const company = await client.query<{ id: string }>(
        `INSERT INTO companies (name, slug) VALUES ($1, $2) RETURNING id`,
        [companyName, normalisedSlug],
      )
      const companyId = company.rows[0]!.id

      // Every company needs a calendar before it can hold a project.
      await client.query(
        `INSERT INTO calendars (company_id, name, working_weekdays, is_default)
         VALUES ($1, 'Standard week (Mon–Fri)', '{1,2,3,4,5}', TRUE)`,
        [companyId],
      )

      const hash = await bcrypt.hash(String(password), BCRYPT_ROUNDS)
      const user = await client.query<{ id: string }>(
        `INSERT INTO users (company_id, email, password_hash, name, role)
         VALUES ($1, $2, $3, $4, 'owner') RETURNING id`,
        [companyId, normalisedEmail, hash, name],
      )

      return { companyId, userId: user.rows[0]!.id }
    })

    res.status(201).json({
      token: generateToken(result.userId, result.companyId),
      companyId: result.companyId,
      slug: normalisedSlug,
    })
  } catch (error) {
    const message = (error as { code?: string; message: string })
    if (message.code === '23505') {
      res.status(409).json({ error: 'That company code is already taken' })
      return
    }
    console.error('[signup]', message.message)
    res.status(500).json({ error: 'Signup failed' })
  }
})

router.post('/login', async (req: Request, res: Response) => {
  const { slug, email, password } = req.body ?? {}
  if (!slug || !email || !password) {
    res.status(400).json({ error: 'slug, email and password are required' })
    return
  }

  const company = await resolveCompanyBySlug(String(slug))
  if (!company) {
    // Deliberately identical to a bad password: revealing which company codes
    // exist would let anyone enumerate the customer list.
    res.status(401).json({ error: 'Invalid credentials' })
    return
  }

  const { rows } = await pool.query<{
    id: string
    password_hash: string
    is_active: boolean
    role: string
    name: string
    token_version: number
  }>(
    `SELECT id, password_hash, is_active, role, name, token_version
     FROM users WHERE company_id = $1 AND email = $2`,
    [company.id, String(email).toLowerCase().trim()],
  )

  const user = rows[0]
  if (!user || !user.is_active || !(await bcrypt.compare(String(password), user.password_hash))) {
    res.status(401).json({ error: 'Invalid credentials' })
    return
  }

  res.json({
    token: generateToken(user.id, company.id, user.token_version),
    user: { id: user.id, name: user.name, role: user.role },
    company: { id: company.id, name: company.name, slug: company.slug, plan: company.plan },
  })
})

/**
 * Change your own password.
 *
 * The current password is required even though the request is already
 * authenticated. A token is something you have; the old password is something
 * you know, and without it a stolen or borrowed session could lock the real
 * owner out of their own account permanently.
 *
 * Succeeding invalidates every other session, so the reply carries a fresh
 * token for the one making the change.
 */
router.post('/change-password', authenticate, async (req: Request, res: Response) => {
  const { currentPassword, newPassword } = req.body ?? {}
  if (!currentPassword || !newPassword) {
    res.status(400).json({ error: 'currentPassword and newPassword are required' })
    return
  }
  if (String(newPassword).length < 8) {
    res.status(400).json({ error: 'New password must be at least 8 characters' })
    return
  }
  if (String(newPassword) === String(currentPassword)) {
    res.status(400).json({ error: 'The new password must be different' })
    return
  }

  const { rows } = await pool.query<{ password_hash: string }>(
    'SELECT password_hash FROM users WHERE id = $1',
    [req.user!.id],
  )
  const user = rows[0]
  if (!user || !(await bcrypt.compare(String(currentPassword), user.password_hash))) {
    res.status(401).json({ error: 'Current password is incorrect' })
    return
  }

  const hash = await bcrypt.hash(String(newPassword), BCRYPT_ROUNDS)
  const updated = await pool.query<{ token_version: number }>(
    `UPDATE users
        SET password_hash = $2,
            password_changed_at = NOW(),
            token_version = token_version + 1
      WHERE id = $1
      RETURNING token_version`,
    [req.user!.id, hash],
  )

  // Carries the new generation, so it is the one session the bump does not kill.
  res.json({
    token: generateToken(req.user!.id, req.user!.companyId, updated.rows[0]!.token_version),
    message: 'Password changed. Other devices have been signed out.',
  })
})

export default router
