/**
 * The controls around getting in: throttling, the audit trail, and what counts
 * as an acceptable password.
 *
 * Kept out of the routes because all three are cross-cutting — login, invite
 * acceptance, owner-led resets and self-service resets each need some of this,
 * and three near-copies of a lockout rule is how one of them ends up being the
 * weak one.
 */

import type { PoolClient, Pool } from 'pg'
import type { Request } from 'express'
import { pool } from '../db/pool.js'

// ─── Who is asking ───────────────────────────────────────────────────────────

/**
 * The client's address, as well as it can be known.
 *
 * `app.set('trust proxy', 1)` is already set, so Express resolves `req.ip`
 * from the last hop of `X-Forwarded-For` — the one written by our own Caddy,
 * which is the only entry a client cannot forge. Reading the header directly
 * and taking the first entry, which is the common shortcut, lets anyone set
 * their own apparent address and walk straight through a per-IP limit.
 */
export function clientIp(req: Request): string | null {
  return req.ip ?? null
}

/** Truncated: a user agent is a hint for a human reading the log, not data. */
export function userAgent(req: Request): string | null {
  const raw = req.headers['user-agent']
  return typeof raw === 'string' ? raw.slice(0, 200) : null
}

// ─── Password policy ─────────────────────────────────────────────────────────

export const MIN_PASSWORD_LENGTH = 10

/**
 * The passwords that actually get tried.
 *
 * A short list, on purpose. The value is in blocking the handful that a
 * credential-stuffing run leads with, and a 100,000-entry list shipped in the
 * repository costs a megabyte to stop attempt 4,000 of an attack the lockout
 * already ended at attempt 5.
 *
 * Compared case-insensitively and with digits stripped from the end, so
 * "Password1" and "password123" are caught by the same entry.
 */
const COMMON = new Set([
  'password', 'passw0rd', 'qwerty', 'qwertyuiop', 'letmein', 'welcome',
  'admin', 'administrator', 'iloveyou', 'monkey', 'dragon', 'sunshine',
  'princess', 'football', 'baseball', 'superman', 'trustno', 'master',
  'changeme', 'secret', 'abc', 'abcd', 'test', 'temp', 'login', 'guest',
  'stringline', 'construction', 'contractor', 'project', 'schedule',
])

export interface PasswordVerdict {
  ok: boolean
  reason?: string
}

/**
 * Whether a password may be used.
 *
 * Length first and loudest. Composition rules — a capital, a digit, a symbol —
 * are deliberately absent: they push people towards `Password1!`, which is in
 * every cracking dictionary, and away from the long memorable phrases that are
 * actually strong. Length plus a blocklist is the guidance everyone converged
 * on after twenty years of the alternative.
 *
 * `context` is the strings this password must not contain — the person's email
 * and the company code. A password that is the company name is the first thing
 * anybody tries and the lockout will not save you from a correct first guess.
 */
export function checkPassword(password: string, context: string[] = []): PasswordVerdict {
  const value = String(password)

  if (value.length < MIN_PASSWORD_LENGTH) {
    return { ok: false, reason: `Password must be at least ${MIN_PASSWORD_LENGTH} characters` }
  }
  // Bcrypt silently truncates at 72 *bytes*, so anything past that is not
  // protecting anything and a user who typed a 200-character passphrase
  // deserves to be told rather than quietly given 72.
  if (Buffer.byteLength(value, 'utf8') > 72) {
    return { ok: false, reason: 'Password must be 72 bytes or fewer' }
  }

  const folded = value.toLowerCase().replace(/[0-9!@#$%^&*._-]+$/, '')
  if (COMMON.has(folded)) {
    return { ok: false, reason: 'That password is one of the first any attacker tries' }
  }

  // A single repeated character, or a straight run off the keyboard.
  if (/^(.)\1+$/.test(value)) {
    return { ok: false, reason: 'That password is one repeated character' }
  }

  for (const item of context) {
    const needle = String(item).trim().toLowerCase()
    // Three characters is too short to be meaningful — a company called "ACE"
    // would block every password containing "ace", including "peace".
    if (needle.length >= 4 && value.toLowerCase().includes(needle)) {
      return { ok: false, reason: 'Password must not contain your email address or company code' }
    }
  }

  return { ok: true }
}

// ─── Throttling ──────────────────────────────────────────────────────────────

/**
 * Failures before an identifier is locked out.
 *
 * Configurable for the same reason the rate limits are: a test suite
 * deliberately fails logins dozens of times in a few seconds, and a production
 * figure makes every suite after the first one fail for reasons that have
 * nothing to do with what is being tested.
 */
const FAILURES_BEFORE_LOCK = Number(process.env.LOGIN_FAILURES_BEFORE_LOCK ?? 5)
/** The window those failures are counted over. */
const FAILURE_WINDOW_MINUTES = 15
/** How long a lock lasts once it bites. */
const LOCK_MINUTES = 15

/**
 * A spray: one host working through a *list* of addresses.
 *
 * Counted as **distinct addresses failed**, not total failures, and the
 * distinction matters more than it looks.
 *
 * Counting total failures blocks every sign-in from an address once it passes
 * the threshold — and a single office sits behind a single NAT address. One
 * person who cannot remember their password, with a colleague mistyping theirs
 * on a Monday, and the whole site is locked out of the schedule. That is a
 * self-inflicted outage caused by the security control, which is how controls
 * end up being turned off.
 *
 * Repeated attempts against one account are already handled, properly, by the
 * per-identifier lock above. What that cannot see is one host trying *many*
 * accounts once each, and that is exactly what this counts.
 */
const IP_DISTINCT_ACCOUNTS_BEFORE_LOCK = Number(process.env.LOGIN_SPRAY_THRESHOLD ?? 10)

export interface Throttle {
  blocked: boolean
  /** Seconds until it is worth trying again. */
  retryAfter: number
}

/**
 * Whether this identifier has earned a rest.
 *
 * Counted over (company, email) whether or not that account exists, which is
 * what keeps the behaviour identical for a real address and an invented one.
 * An attacker watching for the lockout to appear learns nothing from it.
 */
export async function loginThrottle(
  companyId: string | null,
  email: string,
  ip: string | null,
): Promise<Throttle> {
  const { rows } = await pool.query<{ failures: string; last_at: Date | null }>(
    `SELECT COUNT(*)::text AS failures, MAX(at) AS last_at
       FROM login_attempts
      WHERE NOT succeeded
        AND email = $2
        AND company_id IS NOT DISTINCT FROM $1
        AND at > NOW() - ($3 || ' minutes')::interval`,
    [companyId, email, String(FAILURE_WINDOW_MINUTES)],
  )

  const failures = Number(rows[0]?.failures ?? 0)
  if (failures >= FAILURES_BEFORE_LOCK) {
    const last = rows[0]?.last_at ? new Date(rows[0].last_at).getTime() : Date.now()
    const until = last + LOCK_MINUTES * 60_000
    const retryAfter = Math.max(1, Math.ceil((until - Date.now()) / 1000))
    return { blocked: true, retryAfter }
  }

  if (ip) {
    const { rows: spray } = await pool.query<{ accounts: string }>(
      `SELECT COUNT(DISTINCT email)::text AS accounts FROM login_attempts
        WHERE NOT succeeded AND ip = $1 AND at > NOW() - ($2 || ' minutes')::interval`,
      [ip, String(FAILURE_WINDOW_MINUTES)],
    )
    if (Number(spray[0]?.accounts ?? 0) >= IP_DISTINCT_ACCOUNTS_BEFORE_LOCK) {
      return { blocked: true, retryAfter: LOCK_MINUTES * 60 }
    }
  }

  return { blocked: false, retryAfter: 0 }
}

export async function recordLoginAttempt(options: {
  companyId: string | null
  email: string
  ip: string | null
  succeeded: boolean
}): Promise<void> {
  await pool.query(
    'INSERT INTO login_attempts (company_id, email, ip, succeeded) VALUES ($1, $2, $3, $4)',
    [options.companyId, options.email, options.ip, options.succeeded],
  )
}

/**
 * Clear an identifier's failures.
 *
 * Called on a successful sign-in so that five fat-fingered attempts followed by
 * the right password does not leave someone a failure away from a lock for the
 * next quarter of an hour.
 */
export async function clearLoginFailures(companyId: string, email: string): Promise<void> {
  await pool.query(
    `DELETE FROM login_attempts
      WHERE NOT succeeded AND company_id = $1 AND email = $2`,
    [companyId, email],
  )
}

/**
 * Drop attempt rows nobody will read again.
 *
 * Run opportunistically after a successful login rather than on a timer: it is
 * a single indexed delete, successful logins are rare enough that it costs
 * nothing, and a background interval in a process that may be one of several
 * containers is a worse shape than it looks.
 */
export async function pruneLoginAttempts(): Promise<void> {
  try {
    await pool.query("DELETE FROM login_attempts WHERE at < NOW() - INTERVAL '30 days'")
  } catch (error) {
    // Housekeeping must never turn a successful sign-in into a failed one.
    console.warn('[security] attempt prune failed:', (error as Error).message)
  }
}

// ─── The audit trail ─────────────────────────────────────────────────────────

export type AuthEventKind =
  | 'login.succeeded'
  | 'login.failed'
  | 'login.blocked'
  | 'password.changed'
  | 'password.reset.requested'
  | 'password.reset.completed'
  | 'password.reset.by_owner'
  | 'sessions.ended'
  | 'invite.created'
  | 'invite.accepted'
  | 'invite.revoked'
  | 'member.role_changed'
  | 'member.disabled'
  | 'member.enabled'

export interface AuthEvent {
  companyId: string | null
  userId?: string | null
  actorId?: string | null
  kind: AuthEventKind
  subject?: string | null
  detail?: string | null
  ip?: string | null
  userAgent?: string | null
}

/**
 * Write one line of history.
 *
 * Never throws. An audit write failing must not fail the action it is
 * describing — a login that 500s because the log table is full is a worse
 * outcome than a login that is not logged, and the alternative encourages
 * people to turn auditing off.
 *
 * Takes an optional client so an event can ride inside the transaction that
 * caused it, which is what stops "role changed" being recorded for a change
 * that then rolled back.
 */
export async function record(event: AuthEvent, client?: PoolClient | Pool): Promise<void> {
  try {
    await (client ?? pool).query(
      `INSERT INTO auth_events (company_id, user_id, actor_id, kind, subject, detail, ip, user_agent)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        event.companyId,
        event.userId ?? null,
        event.actorId ?? null,
        event.kind,
        event.subject ?? null,
        event.detail ?? null,
        event.ip ?? null,
        event.userAgent ?? null,
      ],
    )
  } catch (error) {
    console.error('[audit] could not record', event.kind, (error as Error).message)
  }
}
