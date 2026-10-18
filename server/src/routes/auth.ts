/**
 * Signup and login.
 *
 * Signup creates a company, its owner, and a default Mon–Fri calendar in one
 * transaction — a company without a calendar cannot schedule anything, so the
 * two are never allowed to exist apart.
 */

import bcrypt from 'bcryptjs'
import { randomBytes } from 'node:crypto'
import { Router, type Request, type Response } from 'express'
import { authenticate, generateToken } from '../middleware/auth.js'
import { resolveCompanyBySlug } from '../middleware/company.js'
import { pool } from '../db/pool.js'
import {
  BCRYPT_ROUNDS,
  isDuplicateSlug,
  provisionCompany,
  ProvisioningError,
} from '../services/provisioning.js'
import * as email from '../services/email.js'
import {
  checkPassword,
  clearLoginFailures,
  clientIp,
  loginThrottle,
  pruneLoginAttempts,
  record,
  recordLoginAttempt,
  userAgent,
} from '../services/security.js'

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

/**
 * A real bcrypt hash of a value nobody knows, compared against when no account
 * matched.
 *
 * Without it, login answers a wrong email in a millisecond and a wrong password
 * in roughly two hundred — the cost of the bcrypt it had to run. That gap is
 * measurable over the network and turns the login form into an oracle for
 * "does this person have an account here", which is the first step of every
 * targeted attack and the thing the identical error message was already trying
 * to prevent.
 *
 * Generated at module load from random bytes, so it is not a constant anyone
 * can recognise and the comparison can never accidentally succeed.
 */
const DECOY_HASH = bcrypt.hashSync(randomBytes(32).toString('hex'), BCRYPT_ROUNDS)

router.post('/login', async (req: Request, res: Response) => {
  // Destructured as `emailField` rather than `email`: the module of that name
  // is imported here, and shadowing it inside the busiest handler in the file
  // is how somebody later calls the wrong thing.
  const { slug, email: emailField, password } = req.body ?? {}
  if (!slug || !emailField || !password) {
    res.status(400).json({ error: 'slug, email and password are required' })
    return
  }

  const address = String(emailField).toLowerCase().trim()
  const ip = clientIp(req)
  const company = await resolveCompanyBySlug(String(slug))

  /*
   * Throttled on the identifier that was *typed*, whether or not it exists.
   *
   * A limit applied only to real accounts is itself an oracle: an attacker
   * sprays addresses, and the ones that start answering "too many attempts"
   * are the ones with accounts. Counting the attempt regardless means a guess
   * at nothing looks exactly like a guess at something.
   */
  const throttle = await loginThrottle(company?.id ?? null, address, ip)
  if (throttle.blocked) {
    await record({
      companyId: company?.id ?? null,
      kind: 'login.blocked',
      subject: address,
      detail: `Blocked after repeated failures; ${throttle.retryAfter}s remaining`,
      ip,
      userAgent: userAgent(req),
    })
    res.setHeader('Retry-After', String(throttle.retryAfter))
    res.status(429).json({
      error: 'Too many failed sign-in attempts. Try again shortly.',
      code: 'LOCKED_OUT',
      retryAfter: throttle.retryAfter,
    })
    return
  }

  const { rows } = company
    ? await pool.query<{
        id: string
        password_hash: string
        is_active: boolean
        role: string
        name: string
        token_version: number
      }>(
        `SELECT id, password_hash, is_active, role, name, token_version
         FROM users WHERE company_id = $1 AND email = $2`,
        [company.id, address],
      )
    : { rows: [] }

  const user = rows[0]

  // Always a bcrypt comparison, even when there is nothing to compare against,
  // so the work done — and therefore the time taken — does not depend on
  // whether the company code or the address was real.
  const matches = await bcrypt.compare(String(password), user?.password_hash ?? DECOY_HASH)

  if (!user || !user.is_active || !matches) {
    await recordLoginAttempt({
      companyId: company?.id ?? null,
      email: address,
      ip,
      succeeded: false,
    })
    await record({
      companyId: company?.id ?? null,
      userId: user?.id ?? null,
      kind: 'login.failed',
      subject: address,
      detail: !company
        ? 'Unknown company code'
        : !user
          ? 'No such account'
          : !user.is_active
            ? 'Account is disabled'
            : 'Wrong password',
      ip,
      userAgent: userAgent(req),
    })
    // One message for every one of those cases. The log knows the difference;
    // the response must not.
    res.status(401).json({ error: 'Invalid credentials' })
    return
  }

  await recordLoginAttempt({ companyId: company!.id, email: address, ip, succeeded: true })
  await clearLoginFailures(company!.id, address)
  await record({
    companyId: company!.id,
    userId: user.id,
    kind: 'login.succeeded',
    subject: address,
    ip,
    userAgent: userAgent(req),
  })

  /*
   * Read the previous sign-in, then stamp this one. Two statements rather than
   * a subquery inside RETURNING, which would return the pre-update values
   * through a snapshot rule that is correct, obscure, and the sort of thing
   * someone tidies into a bug later.
   */
  const previous = await pool.query<{ last_login_at: Date | null; last_login_ip: string | null }>(
    'SELECT last_login_at, last_login_ip FROM users WHERE id = $1',
    [user.id],
  )
  await pool.query('UPDATE users SET last_login_at = NOW(), last_login_ip = $2 WHERE id = $1', [
    user.id,
    ip,
  ])

  void pruneLoginAttempts()

  res.json({
    token: generateToken(user.id, company!.id, user.token_version),
    user: { id: user.id, name: user.name, role: user.role },
    company: { id: company!.id, name: company!.name, slug: company!.slug, plan: company!.plan },
    // Shown once on arrival. The cheapest intrusion detection there is: the
    // person whose account it is knows whether that was them.
    lastLogin: previous.rows[0]?.last_login_at ?? null,
    lastLoginIp: previous.rows[0]?.last_login_ip ?? null,
  })
})

/**
 * Who am I.
 *
 * The UI needs the signed-in role to decide what to offer — a field user
 * should not be shown buttons that will answer 403. It was being cached in
 * the browser at sign-in, which failed in two ways: a session that predated
 * the cache had no role and fell back to the most restricted one, silently
 * hiding features from an owner; and a role changed by an owner stayed stale
 * until the user signed out.
 *
 * Asking is cheap and cannot go stale. Never a security boundary — every
 * route checks the role server-side, from the token, on every request.
 */
router.get('/me', authenticate, (req: Request, res: Response) => {
  res.json({
    id: req.user!.id,
    name: req.user!.name,
    email: req.user!.email,
    role: req.user!.role,
    companyId: req.user!.companyId,
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
  if (String(newPassword) === String(currentPassword)) {
    res.status(400).json({ error: 'The new password must be different' })
    return
  }

  // The same policy every other password goes through — length, the handful of
  // passwords an attacker leads with, and nothing derived from the address or
  // the company code.
  const company = await pool.query<{ name: string; slug: string }>(
    'SELECT name, slug FROM companies WHERE id = $1',
    [req.user!.companyId],
  )
  const verdict = checkPassword(String(newPassword), [
    req.user!.email.split('@')[0] ?? '',
    company.rows[0]?.slug ?? '',
  ])
  if (!verdict.ok) {
    res.status(400).json({ error: verdict.reason })
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

  await record({
    companyId: req.user!.companyId,
    userId: req.user!.id,
    actorId: req.user!.id,
    kind: 'password.changed',
    subject: req.user!.email,
    ip: clientIp(req),
    userAgent: userAgent(req),
  })

  /*
   * Tell them it happened, to the address on the account.
   *
   * Deliberately not awaited. The password has already changed; a mail server
   * having a slow minute must not turn a successful change into a spinner or
   * an error, and the user would have no idea which of the two actually
   * happened.
   */
  void email.sendSecurityNotice({
    to: req.user!.email,
    name: req.user!.name,
    what: 'Your Stringline password was changed',
    detail: 'The password on your account was changed, and every other device has been signed out.',
    companyName: company.rows[0]?.name ?? 'your company',
    when: new Date(),
    ip: clientIp(req) ?? undefined,
  })

  // Carries the new generation, so it is the one session the bump does not kill.
  res.json({
    token: generateToken(req.user!.id, req.user!.companyId, updated.rows[0]!.token_version),
    message: 'Password changed. Other devices have been signed out.',
  })
})

/**
 * End every session, including this one.
 *
 * The control somebody needs when they have just realised they signed in on a
 * machine they should not have, or a laptop went missing. Bumping the
 * generation counter is the whole mechanism — there is no session table to
 * clear, which is exactly why that counter exists.
 *
 * No password required, unlike changing one. The worst a stolen token can do
 * here is sign itself out.
 */
router.post('/sign-out-everywhere', authenticate, async (req: Request, res: Response) => {
  await pool.query('UPDATE users SET token_version = token_version + 1 WHERE id = $1', [
    req.user!.id,
  ])
  await record({
    companyId: req.user!.companyId,
    userId: req.user!.id,
    actorId: req.user!.id,
    kind: 'sessions.ended',
    subject: req.user!.email,
    detail: 'Signed out of every device',
    ip: clientIp(req),
    userAgent: userAgent(req),
  })
  res.json({ message: 'Signed out everywhere. Sign in again to carry on.' })
})

export default router
