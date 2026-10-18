/**
 * Transactional email: what gets sent, and what it says.
 *
 * *How* it leaves the building is `services/mailer.ts` — an ordinary mailbox
 * over SMTP (a Gmail or iCloud account with an app password), Resend, or
 * nothing at all. This module picks the words.
 *
 * **Email being absent is a supported configuration, not a broken one.** With
 * nothing configured every send is logged and skipped, and the features that
 * genuinely need mail hide themselves rather than offering a button that
 * reports success and does nothing. Owners can always reset a teammate's
 * password directly; only self-service "forgot password" truly requires it.
 * That matters because the person installing this from GitHub has no mail
 * provider, and demanding one before they can add a second person would be the
 * wrong default.
 */

import { provider, smtpConfig, transporter } from './mailer.js'

const RESEND_ENDPOINT = 'https://api.resend.com/emails'

function apiKey(): string | undefined {
  return process.env.RESEND_API_KEY?.trim() || undefined
}

/** Whether email can actually be sent. Routes branch on this. */
export function isEnabled(): boolean {
  return provider() !== 'none'
}

function fromAddress(): string {
  const smtp = smtpConfig()
  if (smtp) return smtp.from
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
  switch (provider()) {
    case 'smtp':
      return sendOverSmtp(options)
    case 'resend':
      return sendOverResend(options)
    default:
      console.log(`[email] disabled — not sending "${options.subject}" to ${options.to}`)
      return { sent: false, reason: 'Email is not configured on this server' }
  }
}

async function sendOverSmtp(options: {
  to: string
  subject: string
  html: string
  text: string
  fromName?: string
}): Promise<SendResult> {
  try {
    const info = await transporter()!.sendMail({
      from: options.fromName ? { name: options.fromName, address: fromAddress() } : fromAddress(),
      to: options.to,
      subject: options.subject,
      text: options.text,
      html: options.html,
    })

    /*
     * A 250 from the server is acceptance, not delivery — and nodemailer
     * reports per-recipient rejections in the result rather than throwing.
     * There is one recipient here, so anything in `rejected` means this went
     * nowhere, and reporting it as sent would be a lie the user acts on.
     */
    if (info.rejected?.length) {
      console.error(`[email] rejected by the server: ${info.rejected.join(', ')}`)
      return { sent: false, reason: `The mail server rejected ${options.to}` }
    }

    console.log(`[email] sent "${options.subject}" to ${options.to} (${info.messageId})`)
    return { sent: true }
  } catch (error) {
    const message = (error as Error).message
    console.error('[email] SMTP send failed:', message)
    return { sent: false, reason: smtpHint(message) }
  }
}

/**
 * Turn an SMTP failure into something actionable.
 *
 * The raw errors are notoriously unhelpful — "535 5.7.8 Username and Password
 * not accepted" sends people off to change their Google password, which is not
 * the problem and does not fix it.
 */
function smtpHint(message: string): string {
  if (/535|5\.7\.8|auth|credential/i.test(message)) {
    return 'The mail server rejected the credentials. SMTP_PASS must be an app password, not the account password.'
  }
  if (/ETIMEDOUT|ECONNREFUSED|timeout/i.test(message)) {
    return 'Could not reach the mail server. Check SMTP_HOST and SMTP_PORT — 465 and 587 are not interchangeable.'
  }
  if (/self.signed|certificate|unable to verify/i.test(message)) {
    return 'The mail server TLS certificate could not be verified.'
  }
  // What a stripped STARTTLS looks like from here: the upgrade was demanded,
  // the server did not deliver one, and the TLS handshake ran into plaintext.
  // Worth naming, because the raw OpenSSL text sends people to the wrong place
  // entirely — and because the answer is never "turn off TLS checking".
  if (/wrong version number|STARTTLS|does not support/i.test(message)) {
    return 'The mail server would not start TLS. Mail was not sent, rather than sent in the clear — check SMTP_PORT (465 or 587).'
  }
  if (/limit|quota|rate/i.test(message)) {
    return 'The mail provider is rate limiting this account. A personal mailbox has a daily send limit.'
  }
  return message
}

async function sendOverResend(options: {
  to: string
  subject: string
  html: string
  text: string
  fromName?: string
}): Promise<SendResult> {
  const key = apiKey()!
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

/**
 * A security notice, to the person it happened to.
 *
 * Sent after the fact and never blocking: the password has already changed by
 * the time this goes out, and a mail server having a bad minute must not turn
 * a successful password change into an error the user sees.
 *
 * This is the control that catches an account takeover. Everything else is
 * about stopping an attacker getting in; this is the one that tells somebody
 * when one did.
 */
export async function sendSecurityNotice(options: {
  to: string
  name: string
  what: string
  detail: string
  companyName: string
  when: Date
  ip?: string | undefined
}): Promise<SendResult> {
  const stamp = `${options.when.toISOString().replace('T', ' ').slice(0, 16)} UTC`
  const where = options.ip ? `\nFrom: ${options.ip}` : ''
  return send({
    to: options.to,
    fromName: `${options.companyName} via Stringline`,
    subject: `Security: ${options.what}`,
    text:
      `Hi ${options.name},\n\n` +
      `${options.detail}\n\n` +
      `When: ${stamp}${where}\n\n` +
      `If this was you, there is nothing to do. If it was not, tell an owner of ${options.companyName} ` +
      `straight away — your password should be changed and your sessions ended.`,
    html: layout(
      options.what,
      `<p>Hi ${esc(options.name)},</p>
       <p>${esc(options.detail)}</p>
       <table style="margin: 18px 0; font-size: 14px; color: #444;">
         <tr><td style="padding: 2px 12px 2px 0; color: #777;">When</td><td>${esc(stamp)}</td></tr>
         ${options.ip ? `<tr><td style="padding: 2px 12px 2px 0; color: #777;">From</td><td>${esc(options.ip)}</td></tr>` : ''}
       </table>
       <p style="color: #666; font-size: 14px;">If this was you, there is nothing to do. If it was not, tell an owner of
       <strong>${esc(options.companyName)}</strong> straight away — your password should be changed and your sessions ended.</p>`,
    ),
  })
}

// Said once at boot, so the configuration is visible in the log rather than
// discovered when a reset email never arrives.
const bootConfig = (() => {
  try {
    return smtpConfig()
  } catch (error) {
    // A half-written configuration is a mistake worth shouting about, but not
    // worth refusing to boot over — the app works without mail.
    console.error(`[email] ${(error as Error).message}`)
    return null
  }
})()
console.log(
  bootConfig
    ? `[email] SMTP: ${bootConfig.user} via ${bootConfig.host}:${bootConfig.port}${bootConfig.secure ? ' (TLS)' : ' (STARTTLS)'}`
    : isEnabled()
      ? '[email] Resend configured'
      : '[email] no mail configured — email disabled, owner-led password resets still work',
)
