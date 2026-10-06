/**
 * Signup and login.
 *
 * Signup creates a company, its owner, and a default Mon–Fri calendar in one
 * transaction — a company without a calendar cannot schedule anything, so the
 * two are never allowed to exist apart.
 */

import bcrypt from 'bcryptjs'
import { Router, type Request, type Response } from 'express'
import { authenticate, generateToken } from '../middleware/auth.js'
import { resolveCompanyBySlug } from '../middleware/company.js'
import { pool } from '../db/pool.js'
import {
  BCRYPT_ROUNDS,
  isDuplicateSlug,
  MIN_PASSWORD_LENGTH,
  provisionCompany,
  ProvisioningError,
} from '../services/provisioning.js'

const router = Router()

/**
 * Creating a company and its owner is shared with `/setup`, which the
 * first-run installer calls. The two differ in who may call them, not in what
 * they build — see `services/provisioning.ts`.
 */
router.post('/signup', async (req: Request, res: Response) => {
  try {
    const result = await provisionCompany(req.body ?? {})
    res.status(201).json({
      token: generateToken(result.userId, result.companyId, result.tokenVersion),
      companyId: result.companyId,
      slug: result.slug,
    })
  } catch (error) {
    if (error instanceof ProvisioningError) {
      res.status(error.status).json({ error: error.message })
      return
    }
    if (isDuplicateSlug(error)) {
      res.status(409).json({ error: 'That company code is already taken' })
      return
    }
    console.error('[signup]', (error as Error).message)
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
  if (String(newPassword).length < MIN_PASSWORD_LENGTH) {
    res.status(400).json({ error: `New password must be at least ${MIN_PASSWORD_LENGTH} characters` })
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
