/**
 * The team: who is in a company, and how they get there.
 *
 * Shaped after PropertyPlex's `routes/invites.js`, with one change that matters.
 * PropertyPlex emails an invite code and assumes mail works. Stringline returns
 * **the code and a link** in the API response, so an owner can copy it into a
 * text message. Email, when configured, is an extra channel rather than the
 * channel — otherwise nobody self-hosting this could add a second person.
 *
 * Seat counting is already correct elsewhere: only `owner` and `planner`
 * consume a seat, and field and client seats are free and unlimited. This is
 * the first route that can actually reach that rule.
 */

import bcrypt from 'bcryptjs'
import { randomBytes, randomUUID } from 'node:crypto'
import { Router, type Request, type Response } from 'express'
import { pool, transaction } from '../db/pool.js'
import {
  authenticate,
  generateToken,
  isBillable,
  requireRole,
  type Role,
} from '../middleware/auth.js'
import * as email from '../services/email.js'
import { BCRYPT_ROUNDS } from '../services/provisioning.js'
import { checkPassword, clientIp, record, userAgent } from '../services/security.js'

const router = Router()

const ROLES: Role[] = ['owner', 'planner', 'field', 'client']
const INVITE_DAYS = 7

/**
 * Invite codes are read aloud and typed on phones, so the alphabet drops the
 * characters that get confused: no O/0, no I/1/L. Nine characters from a
 * 31-character alphabet is ~44 bits, which is far past guessable given the
 * route is rate limited and a code dies when used.
 */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'

function inviteCode(): string {
  const bytes = randomBytes(9)
  let out = ''
  for (let i = 0; i < 9; i += 1) {
    out += CODE_ALPHABET[bytes[i]! % CODE_ALPHABET.length]
    if (i === 2 || i === 5) out += '-'
  }
  return out
}

/** Readable but not memorable, for an owner handing someone a temporary password. */
function temporaryPassword(): string {
  return randomBytes(9).toString('base64url').slice(0, 12)
}

function inviteUrl(code: string, slug: string): string {
  return `${email.publicUrl()}/?invite=${encodeURIComponent(code)}&company=${encodeURIComponent(slug)}`
}

// ─── Reading the team ────────────────────────────────────────────────────────

/**
 * Everyone in the company, plus any invites still outstanding.
 *
 * **Not readable by a client.** A client seat is an outside party — the owner
 * of the building, the bank, the architect — and their whole design is that
 * they see milestones and dates and nothing else. Handing them the staff list
 * with everyone's email address is a leak of the customer's data to a third
 * party, and it was doing exactly that: the route authenticated and then
 * trusted anyone who got through.
 *
 * Field crew do see the list, because knowing who else is on the job is the
 * point of it, but without the pending invites — who is being hired is the
 * company's business, not the crew's.
 */
router.get('/', authenticate, requireRole('owner', 'planner', 'field'), async (req, res) => {
  const companyId = req.user!.companyId
  const privileged = req.user!.role === 'owner' || req.user!.role === 'planner'

  const members = await pool.query(
    `SELECT id, name, email, role, is_active, created_at
       FROM users WHERE company_id = $1
      ORDER BY is_active DESC,
               CASE role WHEN 'owner' THEN 0 WHEN 'planner' THEN 1
                         WHEN 'field' THEN 2 ELSE 3 END,
               name`,
    [companyId],
  )

  /*
   * Pending invites carry live invite codes, so this is only ever read by
   * someone who could create one anyway. A field user seeing the list would be
   * handed a working credential for a seat that may be a planner's.
   */
  const invites = privileged
    ? await pool.query(
        `SELECT i.id, i.email, i.name, i.role, i.token, i.expires_at, i.created_at,
                u.name AS invited_by
           FROM invites i
           LEFT JOIN users u ON u.id = i.created_by
          WHERE i.company_id = $1 AND i.accepted_at IS NULL AND i.revoked_at IS NULL
            AND i.expires_at > NOW()
          ORDER BY i.created_at DESC`,
        [companyId],
      )
    : { rows: [] }

  const { rows: company } = await pool.query<{ slug: string }>(
    'SELECT slug FROM companies WHERE id = $1',
    [companyId],
  )
  const slug = company[0]?.slug ?? ''

  res.json({
    // Field crew get names and roles; the addresses belong to the office.
    members: privileged
      ? members.rows
      : members.rows.map(({ email: _email, ...rest }) => rest),
    // Which row is the person asking. The UI uses it to stop offering someone
    // the buttons that would lock them out of their own company — the server
    // refuses those anyway, but an offer that always errors is a worse answer
    // than no offer.
    you: req.user!.id,
    invites: invites.rows.map((i) => ({
      ...i,
      // The link is derived rather than stored, so moving the install to a new
      // domain does not leave old invites pointing at the old one.
      url: inviteUrl(i.token as string, slug),
    })),
    // Lets the UI hide what it cannot do instead of offering a button that fails.
    emailEnabled: email.isEnabled(),
    seatsUsed: members.rows.filter((m) => m.is_active && isBillable(m.role as Role)).length,
  })
})

// ─── Invites ─────────────────────────────────────────────────────────────────

router.post('/invites', authenticate, requireRole('owner', 'planner'), async (req, res) => {
  const { email: address, role, name } = req.body ?? {}

  if (!address || !role) {
    res.status(400).json({ error: 'email and role are required' })
    return
  }
  if (!ROLES.includes(role as Role)) {
    res.status(400).json({ error: `role must be one of ${ROLES.join(', ')}` })
    return
  }
  // Only an owner can mint another owner. A planner promoting someone above
  // themselves is a privilege-escalation path, not a convenience.
  if (role === 'owner' && req.user!.role !== 'owner') {
    res.status(403).json({ error: 'Only an owner can invite another owner' })
    return
  }

  const normalised = String(address).toLowerCase().trim()
  const companyId = req.user!.companyId

  const existing = await pool.query(
    'SELECT id FROM users WHERE company_id = $1 AND email = $2',
    [companyId, normalised],
  )
  if (existing.rows.length > 0) {
    res.status(409).json({ error: 'Someone with that email is already on the team' })
    return
  }

  const code = inviteCode()
  try {
    const { rows } = await pool.query(
      `INSERT INTO invites (company_id, email, name, role, token, expires_at, created_by)
       VALUES ($1, $2, $3, $4, $5, NOW() + ($6 || ' days')::interval, $7)
       RETURNING id, email, name, role, token, expires_at, created_at`,
      [companyId, normalised, name ?? null, role, code, String(INVITE_DAYS), req.user!.id],
    )
    const invite = rows[0]!

    const { rows: company } = await pool.query<{ name: string; slug: string }>(
      'SELECT name, slug FROM companies WHERE id = $1',
      [companyId],
    )
    const url = inviteUrl(code, company[0]!.slug)

    // Attempted, not depended on. The code comes back either way, which is what
    // makes this work on an instance with no email configured at all.
    const delivery = await email.sendInvite({
      to: normalised,
      companyName: company[0]!.name,
      companySlug: company[0]!.slug,
      role,
      inviterName: req.user!.name,
      code,
      inviteUrl: url,
    })

    await record({
      companyId,
      actorId: req.user!.id,
      kind: 'invite.created',
      subject: normalised,
      detail: `Invited as ${role}${delivery.sent ? ', emailed' : ', not emailed'}`,
      ip: clientIp(req),
      userAgent: userAgent(req),
    })

    res.status(201).json({
      invite: { ...invite, url, invited_by: req.user!.name },
      emailed: delivery.sent,
      emailError: delivery.sent ? undefined : delivery.reason,
    })
  } catch (error) {
    if ((error as { code?: string }).code === '23505') {
      res.status(409).json({ error: 'That address already has an invite waiting' })
      return
    }
    throw error
  }
})

router.delete('/invites/:id', authenticate, requireRole('owner', 'planner'), async (req, res) => {
  const { rowCount } = await pool.query(
    `UPDATE invites SET revoked_at = NOW()
      WHERE id = $1 AND company_id = $2 AND accepted_at IS NULL AND revoked_at IS NULL`,
    [req.params.id, req.user!.companyId],
  )
  if (rowCount === 0) {
    res.status(404).json({ error: 'No such pending invite' })
    return
  }
  res.status(204).end()
})

// ─── Accepting an invite ─────────────────────────────────────────────────────

/**
 * What an invite code is worth, before anyone types a password.
 *
 * Unauthenticated — the person holding the code has no account yet. It returns
 * the company name and the role so the form can say what is being joined, and
 * nothing else about the company.
 */
router.get('/invites/:code/validate', async (req: Request, res: Response) => {
  const { rows } = await pool.query<{
    email: string
    name: string | null
    role: string
    company_name: string
    slug: string
    expired: boolean
  }>(
    `SELECT i.email, i.name, i.role, c.name AS company_name, c.slug,
            (i.expires_at <= NOW()) AS expired
       FROM invites i JOIN companies c ON c.id = i.company_id
      WHERE i.token = $1 AND i.accepted_at IS NULL AND i.revoked_at IS NULL`,
    [String(req.params.code).toUpperCase().trim()],
  )

  const invite = rows[0]
  if (!invite || invite.expired) {
    res.status(404).json({ valid: false, error: 'That invite is not valid any more' })
    return
  }

  res.json({
    valid: true,
    email: invite.email,
    name: invite.name,
    role: invite.role,
    companyName: invite.company_name,
    slug: invite.slug,
  })
})

router.post('/invites/:code/accept', async (req: Request, res: Response) => {
  const { password, name } = req.body ?? {}
  if (!password) {
    res.status(400).json({ error: 'password is required' })
    return
  }
  const code = String(req.params.code).toUpperCase().trim()

  try {
    const result = await transaction(async (client) => {
      // FOR UPDATE, so two taps on the same link cannot both create a user.
      const { rows } = await client.query<{
        id: string
        company_id: string
        email: string
        name: string | null
        role: Role
        expired: boolean
      }>(
        `SELECT id, company_id, email, name, role, (expires_at <= NOW()) AS expired
           FROM invites
          WHERE token = $1 AND accepted_at IS NULL AND revoked_at IS NULL
          FOR UPDATE`,
        [code],
      )

      const invite = rows[0]
      if (!invite || invite.expired) return { error: 'That invite is not valid any more' as const }

      /*
       * Checked here rather than at the top of the handler, because the policy
       * needs the invite's email and the company code to reject a password
       * built from either — and neither is known until the code resolves.
       *
       * The cost is that a weak password is reported after the lookup instead
       * of before it. The benefit is that the person joining is held to the
       * same rule as the person who invited them, which is the half of the
       * policy that was missing: an invited planner could previously set an
       * eight-character password on an account with full schedule access.
       */
      const { rows: forCompany } = await client.query<{ slug: string }>(
        'SELECT slug FROM companies WHERE id = $1',
        [invite.company_id],
      )
      const verdict = checkPassword(String(password), [
        invite.email.split('@')[0] ?? '',
        forCompany[0]?.slug ?? '',
      ])
      if (!verdict.ok) return { weak: verdict.reason! }

      const hash = await bcrypt.hash(String(password), BCRYPT_ROUNDS)
      const { rows: created } = await client.query<{ id: string; token_version: number }>(
        `INSERT INTO users (company_id, email, password_hash, name, role)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, token_version`,
        [
          invite.company_id,
          invite.email,
          hash,
          String(name ?? invite.name ?? invite.email.split('@')[0]).trim(),
          invite.role,
        ],
      )

      await client.query('UPDATE invites SET accepted_at = NOW() WHERE id = $1', [invite.id])

      const { rows: company } = await client.query<{ slug: string }>(
        'SELECT slug FROM companies WHERE id = $1',
        [invite.company_id],
      )

      return {
        userId: created[0]!.id,
        companyId: invite.company_id,
        tokenVersion: created[0]!.token_version,
        role: invite.role,
        email: invite.email,
        slug: company[0]!.slug,
      }
    })

    if ('weak' in result) {
      res.status(400).json({ error: result.weak })
      return
    }
    if ('error' in result) {
      res.status(404).json({ error: result.error })
      return
    }

    await record({
      companyId: result.companyId,
      userId: result.userId,
      kind: 'invite.accepted',
      subject: result.email,
      detail: `Joined as ${result.role}`,
      ip: clientIp(req),
      userAgent: userAgent(req),
    })

    // Signed in immediately. Making someone type a password they set two
    // seconds ago is the kind of friction that loses a field crew.
    res.status(201).json({
      token: generateToken(result.userId, result.companyId, result.tokenVersion),
      role: result.role,
      slug: result.slug,
    })
  } catch (error) {
    if ((error as { code?: string }).code === '23505') {
      res.status(409).json({ error: 'That email already has an account in this company' })
      return
    }
    throw error
  }
})

// ─── Managing members ────────────────────────────────────────────────────────

/**
 * Reset a teammate's password, as an owner.
 *
 * The route that works with no email configured at all, which is why it exists:
 * it returns a temporary password for the owner to pass on by whatever means
 * they already use. When email *is* configured it is also sent, so the owner
 * need not relay it.
 */
router.post('/members/:id/reset-password', authenticate, requireRole('owner'), async (req, res) => {
  const { rows } = await pool.query<{ id: string; name: string; email: string }>(
    'SELECT id, name, email FROM users WHERE id = $1 AND company_id = $2',
    [req.params.id, req.user!.companyId],
  )
  const member = rows[0]
  if (!member) {
    res.status(404).json({ error: 'No such person on this team' })
    return
  }

  const temporary = temporaryPassword()
  const hash = await bcrypt.hash(temporary, BCRYPT_ROUNDS)

  // Bumping token_version signs out every device that person is on. A reset
  // whose point is often "they lost the phone" must not leave the phone
  // signed in.
  await pool.query(
    `UPDATE users
        SET password_hash = $2, password_changed_at = NOW(), token_version = token_version + 1
      WHERE id = $1`,
    [member.id, hash],
  )

  const { rows: company } = await pool.query<{ name: string; slug: string }>(
    'SELECT name, slug FROM companies WHERE id = $1',
    [req.user!.companyId],
  )

  const delivery = await email.sendTemporaryPassword({
    to: member.email,
    name: member.name,
    companyName: company[0]!.name,
    companySlug: company[0]!.slug,
    temporaryPassword: temporary,
  })

  await record({
    companyId: req.user!.companyId,
    userId: member.id,
    actorId: req.user!.id,
    kind: 'password.reset.by_owner',
    subject: member.email,
    detail: `${req.user!.name} reset this password${delivery.sent ? ' and emailed it' : ''}`,
    ip: clientIp(req),
    userAgent: userAgent(req),
  })

  res.json({
    temporaryPassword: temporary,
    emailed: delivery.sent,
    message: delivery.sent
      ? `Sent to ${member.email}. They have been signed out everywhere.`
      : `Give this to ${member.name}. They have been signed out everywhere.`,
  })
})

router.patch('/members/:id', authenticate, requireRole('owner'), async (req, res) => {
  const { role, isActive } = req.body ?? {}

  if (role !== undefined && !ROLES.includes(role as Role)) {
    res.status(400).json({ error: `role must be one of ${ROLES.join(', ')}` })
    return
  }
  if (req.params.id === req.user!.id) {
    // Both of these lock the company's only owner out of their own data, with
    // nobody left who can undo it.
    res.status(400).json({ error: 'You cannot change your own role or disable yourself' })
    return
  }

  const result = await transaction(async (client) => {
    const { rows } = await client.query<{ role: Role }>(
      'SELECT role FROM users WHERE id = $1 AND company_id = $2 FOR UPDATE',
      [req.params.id, req.user!.companyId],
    )
    if (rows.length === 0) return { error: 'No such person on this team' as const }

    // A company with no active owner cannot be administered by anyone.
    const losingAnOwner =
      rows[0]!.role === 'owner' && ((role !== undefined && role !== 'owner') || isActive === false)
    if (losingAnOwner) {
      const { rows: owners } = await client.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM users
          WHERE company_id = $1 AND role = 'owner' AND is_active AND id <> $2`,
        [req.user!.companyId, req.params.id],
      )
      if (owners[0]!.count === '0') {
        return { error: 'That would leave the company with no owner' as const }
      }
    }

    const { rows: updated } = await client.query(
      `UPDATE users
          SET role = COALESCE($3, role),
              is_active = COALESCE($4, is_active),
              -- Any change to standing invalidates existing sessions, so a
              -- demoted or disabled user does not keep their old access until
              -- their token happens to expire.
              token_version = token_version + 1
        WHERE id = $1 AND company_id = $2
        RETURNING id, name, email, role, is_active`,
      [req.params.id, req.user!.companyId, role ?? null, isActive ?? null],
    )
    return { member: updated[0]! }
  })

  if ('error' in result) {
    res.status(result.error.startsWith('No such') ? 404 : 400).json({ error: result.error })
    return
  }

  const member = result.member as { id: string; name: string; email: string; role: Role; is_active: boolean }
  const kind =
    isActive === false ? 'member.disabled' : isActive === true ? 'member.enabled' : 'member.role_changed'

  await record({
    companyId: req.user!.companyId,
    userId: member.id,
    actorId: req.user!.id,
    kind,
    subject: member.email,
    detail:
      kind === 'member.role_changed'
        ? `${req.user!.name} changed the role to ${member.role}`
        : `${req.user!.name} ${kind === 'member.disabled' ? 'disabled' : 're-enabled'} this account`,
    ip: clientIp(req),
    userAgent: userAgent(req),
  })

  /*
   * Tell them. A change of standing signs them out, and an account that stops
   * working with no explanation is indistinguishable from a broken app —
   * people file a bug instead of asking the owner why.
   */
  const { rows: companyRow } = await pool.query<{ name: string }>(
    'SELECT name FROM companies WHERE id = $1',
    [req.user!.companyId],
  )
  void email.sendSecurityNotice({
    to: member.email,
    name: member.name,
    what:
      kind === 'member.disabled'
        ? 'Your Stringline access was turned off'
        : kind === 'member.enabled'
          ? 'Your Stringline access was restored'
          : 'Your Stringline role was changed',
    detail:
      kind === 'member.role_changed'
        ? `${req.user!.name} changed your role to ${member.role}. You have been signed out and will need to sign in again.`
        : kind === 'member.disabled'
          ? `${req.user!.name} turned off your access to this company.`
          : `${req.user!.name} restored your access. You can sign in again.`,
    companyName: companyRow[0]?.name ?? 'your company',
    when: new Date(),
    ip: clientIp(req) ?? undefined,
  })

  res.json({ member })
})

/**
 * The security log.
 *
 * Owners only, and the reason is not squeamishness — it carries IP addresses
 * and every failed sign-in, which is a record of where the team was and when.
 * Useful to the person accountable for the company, nobody else's business.
 *
 * This is the artefact that matters after an incident. Everything else in this
 * file is about preventing one; without this, nobody can answer what happened.
 */
router.get('/security-log', authenticate, requireRole('owner'), async (req, res) => {
  const limit = Math.min(Number(req.query.limit ?? 100), 500)

  const { rows } = await pool.query(
    `SELECT e.id, e.kind, e.subject, e.detail, e.ip, e.user_agent, e.at,
            actor.name AS actor_name,
            subject_user.name AS subject_name
       FROM auth_events e
       LEFT JOIN users actor ON actor.id = e.actor_id
       LEFT JOIN users subject_user ON subject_user.id = e.user_id
      WHERE e.company_id = $1
      ORDER BY e.at DESC
      LIMIT $2`,
    [req.user!.companyId, limit],
  )

  /*
   * Failures in the last day, counted separately.
   *
   * A log is only read when somebody already suspects something. This is the
   * number that makes them suspect it, so the UI can surface it without
   * anybody going looking.
   */
  const { rows: recent } = await pool.query<{ failed: string; blocked: string }>(
    `SELECT
       COUNT(*) FILTER (WHERE kind = 'login.failed')::text  AS failed,
       COUNT(*) FILTER (WHERE kind = 'login.blocked')::text AS blocked
     FROM auth_events
     WHERE company_id = $1 AND at > NOW() - INTERVAL '24 hours'`,
    [req.user!.companyId],
  )

  res.json({
    events: rows,
    failedLast24h: Number(recent[0]?.failed ?? 0),
    blockedLast24h: Number(recent[0]?.blocked ?? 0),
  })
})

export default router
