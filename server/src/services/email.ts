/**
 * Transactional email, optional by design.
 *
 * Ported from PropertyPlex's `services/email.js`, with two deliberate changes.
 *
 * It calls Resend's HTTP API with `fetch` rather than pulling in the `resend`
 * package — one POST to one endpoint is not worth a dependency, and Stringline
 * is meant to be easy to self-host.
 *
 * More importantly, **email being absent is a supported configuration, not a
 * broken one.** Without `RESEND_API_KEY` every send is logged and skipped, and
 * the features that cannot work without it hide themselves rather than
 * offering a button that fails. Owners can always reset a teammate's password
 * directly; only self-service "forgot password" genuinely needs mail. That
 * matters because the person installing this from GitHub has no Resend account,
 * and demanding one to add a second user would be the wrong default.
 */

const RESEND_ENDPOINT = 'https://api.resend.com/emails'

function apiKey(): string | undefined {
  return process.env.RESEND_API_KEY?.trim() || undefined
}

/** Whether email can actually be sent. Routes branch on this. */
export function isEnabled(): boolean {
  return apiKey() !== undefined
}

function fromAddress(): string {
  return process.env.RESEND_FROM_EMAIL?.trim() || 'onboarding@resend.dev'
}

/** Where links in emails point. */
export function publicUrl(): string {
  return (process.env.PUBLIC_URL?.trim() || 'https://kevinoue.com/stringline').replace(/\/+$/, '')
}

export interface SendResult {
  sent: boolean
  reason?: string
}

export async function send(options: {
  to: string
  subject: string
  html: string
  text: string
  fromName?: string
}): Promise<SendResult> {
  const key = apiKey()
  if (!key) {
    console.log(`[email] disabled — not sending "${options.subject}" to ${options.to}`)
    return { sent: false, reason: 'Email is not configured on this server' }
  }

  try {
    const from = options.fromName ? `${options.fromName} <${fromAddress()}>` : fromAddress()
    const response = await fetch(RESEND_ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from,
        to: [options.to],
        subject: options.subject,
        html: options.html,
        text: options.text,
      }),
      // Without this a hung connection holds the request open until the client
      // gives up, and the user sees a spinner rather than an error.
      signal: AbortSignal.timeout(15_000),
    })

    if (!response.ok) {
      const body = await response.text()
      console.error(`[email] Resend rejected "${options.subject}": ${response.status} ${body.slice(0, 200)}`)
      return { sent: false, reason: `Email provider returned ${response.status}` }
    }

    console.log(`[email] sent "${options.subject}" to ${options.to}`)
    return { sent: true }
  } catch (error) {
    console.error('[email] send failed:', (error as Error).message)
    return { sent: false, reason: (error as Error).message }
  }
}

/**
 * Escape anything interpolated into an HTML email.
 *
 * Company and user names are attacker-controlled on a multi-tenant instance,
 * and an unescaped one would let an invite email carry markup into whatever
 * client renders it.
 */
function esc(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** Shared chrome, so the templates below stay about their content. */
function layout(heading: string, body: string): string {
  return `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 560px; margin: 0 auto; padding: 24px; color: #1a1a1a;">
      <h2 style="margin: 0 0 16px; font-size: 20px; letter-spacing: -0.02em;">${esc(heading)}</h2>
      ${body}
      <div style="margin-top: 28px; padding-top: 16px; border-top: 1px solid #e5e5e5; font-size: 12px; color: #777;">
        <p style="margin: 4px 0;">Stringline — a schedule you can work to.</p>
      </div>
    </div>
  `
}

function codeBlock(label: string, value: string): string {
  return `
    <div style="background: #f6f6f6; border: 1px solid #e5e5e5; border-radius: 8px; padding: 18px; margin: 18px 0; text-align: center;">
      <p style="margin: 0 0 6px; font-size: 13px; color: #666;">${esc(label)}</p>
      <p style="margin: 0; font-size: 24px; font-weight: 700; letter-spacing: 3px;">${esc(value)}</p>
    </div>
  `
}

export async function sendPasswordReset(options: {
  to: string
  name: string
  resetUrl: string
  expiresMinutes: number
}): Promise<SendResult> {
  const url = esc(options.resetUrl)
  return send({
    to: options.to,
    subject: 'Reset your Stringline password',
    text:
      `Hi ${options.name},\n\n` +
      `Open this link to set a new password:\n${options.resetUrl}\n\n` +
      `It expires in ${options.expiresMinutes} minutes. If you did not ask for this, ignore this email — nothing has changed.`,
    html: layout(
      'Reset your password',
      `<p>Hi ${esc(options.name)},</p>
       <p>Open this link to set a new password:</p>
       <div style="text-align: center; margin: 24px 0;">
         <a href="${url}" style="background: #1a1a1a; color: #fff; text-decoration: none; padding: 12px 28px; border-radius: 6px; font-weight: 600; display: inline-block;">Set a new password</a>
       </div>
       <p style="color: #666; font-size: 14px;">This link expires in ${options.expiresMinutes} minutes, and signs you out everywhere once used. If you did not ask for this, ignore this email — nothing has changed.</p>
       <p style="color: #999; font-size: 12px;">If the button does not work: <a href="${url}" style="color: #1a1a1a;">${url}</a></p>`,
    ),
  })
}

export async function sendInvite(options: {
  to: string
  companyName: string
  companySlug: string
  role: string
  inviterName: string
  code: string
  inviteUrl: string
}): Promise<SendResult> {
  const url = esc(options.inviteUrl)
  return send({
    to: options.to,
    fromName: `${options.companyName} via Stringline`,
    subject: `${options.inviterName} invited you to ${options.companyName} on Stringline`,
    text:
      `${options.inviterName} invited you to join ${options.companyName} on Stringline as ${options.role}.\n\n` +
      `Open this link to set your password:\n${options.inviteUrl}\n\n` +
      `Or sign in with company code "${options.companySlug}" and invite code ${options.code}.\n\n` +
      `This invite expires in 7 days.`,
    html: layout(
      `Join ${options.companyName}`,
      `<p>${esc(options.inviterName)} invited you to join <strong>${esc(options.companyName)}</strong> on Stringline as <strong>${esc(options.role)}</strong>.</p>
       <div style="text-align: center; margin: 24px 0;">
         <a href="${url}" style="background: #1a1a1a; color: #fff; text-decoration: none; padding: 12px 28px; border-radius: 6px; font-weight: 600; display: inline-block;">Accept the invite</a>
       </div>
       ${codeBlock('Or enter this invite code', options.code)}
       <p style="color: #666; font-size: 14px;">Company code: <strong>${esc(options.companySlug)}</strong></p>
       <p style="color: #999; font-size: 12px;">This invite expires in 7 days.</p>`,
    ),
  })
}

export async function sendTemporaryPassword(options: {
  to: string
  name: string
  companyName: string
  companySlug: string
  temporaryPassword: string
}): Promise<SendResult> {
  return send({
    to: options.to,
    fromName: `${options.companyName} via Stringline`,
    subject: 'Your Stringline password was reset',
    text:
      `Hi ${options.name},\n\n` +
      `An owner of ${options.companyName} reset your password. Sign in with:\n\n` +
      `Company code: ${options.companySlug}\nEmail: ${options.to}\nTemporary password: ${options.temporaryPassword}\n\n` +
      `Change it once you are in.`,
    html: layout(
      'Your password was reset',
      `<p>Hi ${esc(options.name)},</p>
       <p>An owner of <strong>${esc(options.companyName)}</strong> reset your password.</p>
       ${codeBlock('Temporary password', options.temporaryPassword)}
       <p style="color: #666; font-size: 14px;">Company code: <strong>${esc(options.companySlug)}</strong><br>Email: ${esc(options.to)}</p>
       <p style="color: #666; font-size: 14px;">Change it from the app once you are signed in.</p>`,
    ),
  })
}

// Said once at boot, so the configuration is visible in the log rather than
// discovered when a reset email never arrives.
console.log(
  isEnabled()
    ? '[email] Resend configured'
    : '[email] RESEND_API_KEY not set — email disabled, owner-led password resets still work',
)
