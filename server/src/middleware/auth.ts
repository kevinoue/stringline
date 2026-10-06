/**
 * Authentication and authorisation.
 *
 * Ported from PropertyPlex's `server/src/middleware/auth.js`, with two changes:
 * every database call is now awaited (better-sqlite3 was synchronous, `pg` is
 * not), and there are two token types instead of three — platform and company —
 * because Stringline collapsed the org tier.
 *
 * The shape that carried over unchanged is the important one: the token is
 * proof of identity, but the user record is re-read from the database on every
 * request. A deactivated account stops working immediately rather than when its
 * token happens to expire.
 */

import type { NextFunction, Request, Response } from 'express'
import jwt from 'jsonwebtoken'
import { pool } from '../db/pool.js'

const JWT_SECRET = process.env.JWT_SECRET
if (!JWT_SECRET) {
  console.error('FATAL: JWT_SECRET environment variable is required')
  process.exit(1)
}
const SECRET: string = JWT_SECRET
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN ?? '30d'

export type Role = 'owner' | 'planner' | 'field' | 'client'

/** Roles that consume a paid seat. Field and client seats are free and unlimited. */
export const BILLABLE_ROLES: Role[] = ['owner', 'planner']

export function isBillable(role: Role): boolean {
  return BILLABLE_ROLES.includes(role)
}

export interface AuthedUser {
  id: string
  companyId: string
  email: string
  name: string
  role: Role
}

export interface PlatformAdmin {
  id: string
  email: string
  name: string
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthedUser
      platformAdmin?: PlatformAdmin
      company?: import('./company.js').Company
    }
  }
}

export function generateToken(userId: string, companyId: string, tokenVersion = 0): string {
  return jwt.sign({ userId, companyId, v: tokenVersion }, SECRET, {
    algorithm: 'HS256',
    expiresIn: JWT_EXPIRES_IN,
  } as jwt.SignOptions)
}

export function generatePlatformToken(adminId: string): string {
  return jwt.sign({ adminId, isPlatformAdmin: true }, SECRET, {
    algorithm: 'HS256',
    expiresIn: '24h',
  })
}

function bearer(req: Request): string | null {
  const header = req.headers.authorization
  if (!header || !header.startsWith('Bearer ')) return null
  return header.slice(7)
}

function rejectToken(res: Response, error: unknown): void {
  if (error instanceof jwt.TokenExpiredError) {
    res.status(401).json({ error: 'Token expired' })
    return
  }
  res.status(401).json({ error: 'Invalid token' })
}

interface UserTokenPayload {
  userId: string
  companyId: string
  isPlatformAdmin?: boolean
  /** Session generation. Bumped on password change to kill older tokens. */
  v?: number
}

export async function authenticate(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const token = bearer(req)
  if (!token) {
    res.status(401).json({ error: 'No token provided' })
    return
  }

  let decoded: UserTokenPayload
  try {
    decoded = jwt.verify(token, SECRET, { algorithms: ['HS256'] }) as UserTokenPayload
  } catch (error) {
    rejectToken(res, error)
    return
  }

  if (decoded.isPlatformAdmin) {
    res.status(401).json({ error: 'Use the platform admin endpoints' })
    return
  }

  // Re-read the user rather than trusting the token's copy, so deactivation
  // takes effect on the next request instead of at token expiry.
  const { rows } = await pool.query<{
    id: string
    company_id: string
    email: string
    name: string
    role: Role
    is_active: boolean
    token_version: number
  }>(
    `SELECT id, company_id, email, name, role, is_active, token_version
     FROM users WHERE id = $1`,
    [decoded.userId],
  )

  const user = rows[0]
  if (!user) {
    res.status(401).json({ error: 'User not found' })
    return
  }
  if (!user.is_active) {
    res.status(401).json({ error: 'Account is disabled' })
    return
  }

  // A token from an earlier generation belongs to a session that should no
  // longer exist. Tokens issued before this column existed carry no version and
  // count as generation 0, which is the default — so nobody is signed out
  // merely by deploying this.
  if ((decoded.v ?? 0) !== user.token_version) {
    res.status(401).json({
      error: 'Your password was changed. Please sign in again.',
      code: 'PASSWORD_CHANGED',
    })
    return
  }

  req.user = {
    id: user.id,
    companyId: user.company_id,
    email: user.email,
    name: user.name,
    role: user.role,
  }
  next()
}

export async function authenticatePlatformAdmin(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const token = bearer(req)
  if (!token) {
    res.status(401).json({ error: 'No token provided' })
    return
  }

  let decoded: { adminId: string; isPlatformAdmin?: boolean }
  try {
    decoded = jwt.verify(token, SECRET, { algorithms: ['HS256'] }) as {
      adminId: string
      isPlatformAdmin?: boolean
    }
  } catch (error) {
    rejectToken(res, error)
    return
  }

  if (!decoded.isPlatformAdmin) {
    res.status(403).json({ error: 'Platform admin access required' })
    return
  }

  const { rows } = await pool.query<{
    id: string
    email: string
    name: string
    is_active: boolean
  }>('SELECT id, email, name, is_active FROM platform_admins WHERE id = $1', [decoded.adminId])

  const admin = rows[0]
  if (!admin || !admin.is_active) {
    res.status(401).json({ error: 'Admin not found or disabled' })
    return
  }

  req.platformAdmin = { id: admin.id, email: admin.email, name: admin.name }
  next()
}

/** Restrict a route to specific roles. Must run after `authenticate`. */
export function requireRole(...allowed: Role[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({ error: 'Not authenticated' })
      return
    }
    if (!allowed.includes(req.user.role)) {
      res.status(403).json({ error: 'Insufficient permissions' })
      return
    }
    next()
  }
}

/**
 * Anyone who can change a schedule. Field users report progress on their own
 * work through separate, narrower routes; clients never write at all.
 */
export const requirePlanner = requireRole('owner', 'planner')
