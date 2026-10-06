/**
 * Company scoping — the isolation boundary.
 *
 * Ported from PropertyPlex's `middleware/tenant.js`. The trial grace-period
 * handling carried over intact because it is genuinely good: an expired trial
 * gets seven days of warning headers before it starts refusing requests, so
 * nobody loses access to a live job site mid-week without notice.
 *
 * What changed: three tiers collapsed to two, `max_users` became
 * `max_planners` (field and client seats are free and unlimited), and every
 * query is awaited.
 */

import type { NextFunction, Request, Response } from 'express'
import { pool } from '../db/pool.js'
import { isBillable, type Role } from './auth.js'

/**
 * Stringline is free — there are no paid plans and nothing expires. The trial
 * machinery below is kept because a self-hosted instance may still want to cap
 * itself, but nothing in the shipped product sets a trial.
 */
const GRACE_PERIOD_MS = 7 * 24 * 60 * 60 * 1000

export interface Company {
  id: string
  name: string
  slug: string
  plan: string
  status: string
  trialEndsAt: Date | null
  maxProjects: number
  maxPlanners: number
  features: Record<string, unknown>
}

interface CompanyRow {
  id: string
  name: string
  slug: string
  plan: string
  status: string
  trial_ends_at: Date | null
  max_projects: number
  max_planners: number
  features: Record<string, unknown>
}

function toCompany(row: CompanyRow): Company {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    plan: row.plan,
    status: row.status,
    trialEndsAt: row.trial_ends_at,
    maxProjects: row.max_projects,
    maxPlanners: row.max_planners,
    features: row.features ?? {},
  }
}

const SELECT_COMPANY = `
  SELECT id, name, slug, plan, status, trial_ends_at, max_projects, max_planners, features
  FROM companies
`

/** Resolve a company by its login code. Used during login. */
export async function resolveCompanyBySlug(slug: string): Promise<Company | null> {
  if (!slug) return null
  const { rows } = await pool.query<CompanyRow>(
    `${SELECT_COMPANY} WHERE slug = $1 AND status <> 'cancelled'`,
    [slug.toLowerCase().trim()],
  )
  return rows[0] ? toCompany(rows[0]) : null
}

export async function resolveCompanyById(id: string): Promise<Company | null> {
  const { rows } = await pool.query<CompanyRow>(`${SELECT_COMPANY} WHERE id = $1`, [id])
  return rows[0] ? toCompany(rows[0]) : null
}

/** Attach `req.company`. Must run after `authenticate`. */
export async function requireCompany(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const companyId = req.user?.companyId
  if (!companyId) {
    res.status(403).json({ error: 'No company context. Please log in again.' })
    return
  }

  const company = await resolveCompanyById(companyId)
  if (!company) {
    res.status(403).json({ error: 'Company not found' })
    return
  }
  if (company.status === 'suspended') {
    res.status(403).json({ error: 'Account suspended. Please contact support.' })
    return
  }
  if (company.status === 'cancelled') {
    res.status(403).json({ error: 'Account cancelled.' })
    return
  }

  if (company.status === 'trial' && company.trialEndsAt) {
    const expiry = company.trialEndsAt.getTime()
    if (Date.now() > expiry + GRACE_PERIOD_MS) {
      res.status(403).json({
        error: 'Trial expired. Please subscribe to continue.',
        code: 'TRIAL_EXPIRED',
      })
      return
    }
    if (Date.now() > expiry) {
      // Inside the grace period: warn loudly, but never lock someone out of a
      // live job site without notice.
      res.set('X-Trial-Status', 'grace-period')
      res.set('X-Trial-Expired-At', company.trialEndsAt.toISOString())
    }
  }

  req.company = company
  next()
}

export type LimitType = 'projects' | 'planners'

/** Enforce a plan limit before creating something that counts against it. */
export function checkCompanyLimit(limit: LimitType) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const company = req.company
    if (!company) {
      res.status(403).json({ error: 'No company context' })
      return
    }

    if (limit === 'projects') {
      const { rows } = await pool.query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM projects WHERE company_id = $1 AND status = 'active'`,
        [company.id],
      )
      if (Number(rows[0]!.count) >= company.maxProjects) {
        res.status(403).json({
          error: `Project limit reached (${company.maxProjects}). Upgrade your plan to add more.`,
          code: 'LIMIT_REACHED',
        })
        return
      }
    }

    if (limit === 'planners') {
      // Only billable seats count. Adding field crew or clients is always free,
      // which is the point — it is what keeps work from escaping the tool.
      const role = (req.body as { role?: Role } | undefined)?.role
      if (role && !isBillable(role)) {
        next()
        return
      }
      const { rows } = await pool.query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM users
         WHERE company_id = $1 AND is_active AND role IN ('owner', 'planner')`,
        [company.id],
      )
      if (Number(rows[0]!.count) >= company.maxPlanners) {
        res.status(403).json({
          error: `Planner seat limit reached (${company.maxPlanners}). Field and client seats remain free and unlimited.`,
          code: 'LIMIT_REACHED',
        })
        return
      }
    }

    next()
  }
}

/** Fire-and-forget usage counter, keyed by month. */
export async function trackUsage(companyId: string, usageType: string): Promise<void> {
  const period = new Date().toISOString().slice(0, 7)
  try {
    await pool.query(
      `INSERT INTO company_usage (company_id, usage_type, period, usage_count)
       VALUES ($1, $2, $3, 1)
       ON CONFLICT (company_id, usage_type, period)
       DO UPDATE SET usage_count = company_usage.usage_count + 1`,
      [companyId, usageType, period],
    )
  } catch (error) {
    console.error('[usage] tracking failed:', (error as Error).message)
  }
}
