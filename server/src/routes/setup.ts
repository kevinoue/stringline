/**
 * First-run setup.
 *
 * A fresh self-hosted Stringline has no accounts, so something has to create
 * the first one. WordPress does this with an open install page, and that page
 * is a genuine vulnerability: between `docker compose up` and someone filling
 * the form, whoever reaches the URL first owns the instance. On a public URL
 * that race is not hypothetical.
 *
 * So this follows Jenkins instead — the server prints a setup token to its own
 * log on first boot, and setup requires it. Reading the container log is
 * something only whoever deployed it can do.
 *
 * The token is derived from JWT_SECRET rather than stored or randomly
 * generated, which buys two things: it survives a restart mid-setup (a random
 * per-boot token would strand anyone who hit a hiccup), and it needs no new
 * table. SHA-256 is one-way, so the token leaking does not expose the secret
 * that signs sessions.
 *
 * Every route here stops working the moment a company exists.
 */

import { createHash, timingSafeEqual } from 'node:crypto'
import { Router, type Request, type Response } from 'express'
import { pool, transaction } from '../db/pool.js'
import { generateToken } from '../middleware/auth.js'
import {
  insertCompanyWithOwner,
  isDuplicateSlug,
  ProvisioningError,
  validateNewCompany,
} from '../services/provisioning.js'

const router = Router()

/**
 * Guards the first-company check against a race.
 *
 * Two simultaneous POSTs would otherwise both read zero companies and both
 * create one, leaving a second unexpected owner on the instance. The lock is
 * transaction-scoped, so it releases on commit or rollback without cleanup.
 */
const SETUP_LOCK = 8274

export function setupToken(): string {
  // An explicit value lets an automated install set it up front instead of
  // scraping the log.
  const explicit = process.env.SETUP_TOKEN?.trim()
  if (explicit) return explicit

  const secret = process.env.JWT_SECRET
  if (!secret) {
    // Never a fixed fallback: a default token on an instance with a default
    // secret is an open install page with extra steps.
    throw new Error('JWT_SECRET must be set before setup can run')
  }
  return createHash('sha256')
    .update(`stringline-setup:${secret}`)
    .digest('base64url')
    .slice(0, 16)
}

/** Constant-time, so a wrong token leaks nothing about how wrong it was. */
function tokenMatches(given: unknown): boolean {
  if (typeof given !== 'string') return false
  const expected = Buffer.from(setupToken())
  const offered = Buffer.from(given.trim())
  // timingSafeEqual throws on a length mismatch, which would itself be a
  // timing signal; hashing both to a fixed width removes that.
  const normalise = (b: Buffer): Buffer => createHash('sha256').update(b).digest()
  return timingSafeEqual(normalise(expected), normalise(offered))
}

export async function setupNeeded(): Promise<boolean> {
  const { rows } = await pool.query<{ count: string }>('SELECT COUNT(*)::text AS count FROM companies')
  return rows[0]!.count === '0'
}

/**
 * Whether the app should show its setup screen.
 *
 * Unauthenticated by necessity — there is nobody to authenticate as yet. It
 * reveals only whether this instance has been claimed, which is already
 * obvious to anyone who can try to log in.
 */
router.get('/status', async (_req: Request, res: Response) => {
  try {
    res.json({ needed: await setupNeeded() })
  } catch {
    res.status(503).json({ error: 'Database unavailable' })
  }
})

router.post('/', async (req: Request, res: Response) => {
  const { setupToken: offered, ...company } = req.body ?? {}

  // Checked before the token, so an unclaimed-instance probe cannot be used to
  // test tokens against an instance that is already set up.
  if (!(await setupNeeded())) {
    res.status(409).json({
      error: 'This Stringline is already set up. Sign in instead.',
      code: 'ALREADY_SET_UP',
    })
    return
  }

  // `setupToken()` throws when JWT_SECRET is missing. That is a server
  // misconfiguration, not a bad request, and saying so plainly saves whoever
  // is installing this from debugging their own typing.
  let matched: boolean
  try {
    matched = tokenMatches(offered)
  } catch {
    res.status(500).json({ error: 'JWT_SECRET is not configured on the server' })
    return
  }

  if (!matched) {
    res.status(401).json({
      error: 'That setup code is not right. It is printed in the server log at startup.',
      code: 'BAD_SETUP_TOKEN',
    })
    return
  }

  try {
    const validated = validateNewCompany(company)
    const result = await transaction(async (client) => {
      await client.query('SELECT pg_advisory_xact_lock($1)', [SETUP_LOCK])

      // Re-checked inside the lock. The check above is for a clean error
      // message; this one is for correctness.
      const { rows } = await client.query<{ count: string }>(
        'SELECT COUNT(*)::text AS count FROM companies',
      )
      if (rows[0]!.count !== '0') {
        throw new ProvisioningError(409, 'This Stringline is already set up. Sign in instead.')
      }

      return insertCompanyWithOwner(client, validated)
    })

    console.log(`[setup] company "${validated.companyName}" (${result.slug}) created`)

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
    console.error('[setup]', (error as Error).message)
    res.status(500).json({ error: 'Setup failed' })
  }
})

export default router
