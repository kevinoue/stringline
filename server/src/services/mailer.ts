/**
 * How mail actually leaves the building.
 *
 * Three transports, chosen by what is configured rather than by a mode flag
 * nobody remembers to set:
 *
 *   * **SMTP** — a Gmail, iCloud or any other mailbox, using an app password.
 *     This is the one to reach for. It needs no account with anybody, no
 *     domain, and no DNS, which matters because Stringline is meant to be
 *     self-hostable by somebody who just wants to add their foreman.
 *   * **Resend** — kept, because an instance already using it should not have
 *     to migrate to take an update.
 *   * **None** — the supported default. Every send is logged and skipped, and
 *     the features that genuinely need mail hide themselves rather than
 *     offering a button that reports success and does nothing.
 *
 * ── On using a personal mailbox ─────────────────────────────────────────────
 *
 * It works, and for a handful of invites a month it is the right call. Three
 * things are true about it that are not true of a transactional provider, and
 * all three are acceptable at this size:
 *
 *   1. **The password is an app password, never the account password.** Both
 *      Google and Apple require two-factor to be on before they will issue one,
 *      and the resulting credential is scoped to mail and revocable on its own.
 *      An account password in this file would be a catastrophe; an app password
 *      is a bad afternoon.
 *   2. **Gmail rewrites the From header** to the authenticated address unless
 *      the alias is verified in Gmail's settings, so `SMTP_FROM` defaults to
 *      `SMTP_USER` rather than pretending otherwise.
 *   3. **There are daily limits** — on the order of 500 recipients a day for a
 *      consumer Gmail account, lower for iCloud. Far past what invites and
 *      password resets need, and the error is reported rather than swallowed if
 *      it is ever hit.
 */

import nodemailer, { type Transporter } from 'nodemailer'

export type Provider = 'smtp' | 'resend' | 'none'

/**
 * The presets, so the common cases are one variable instead of four.
 *
 * Ports and secure-flags are not interchangeable: 465 is TLS from the first
 * byte, 587 opens in the clear and upgrades with STARTTLS. Getting this pair
 * wrong produces a hang rather than an error, which is a miserable thing to
 * debug, so it is encoded here instead of left to whoever writes the env file.
 */
const PRESETS: Record<string, { host: string; port: number; secure: boolean; note: string }> = {
  gmail: {
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    note: 'Google account → Security → 2-Step Verification → App passwords',
  },
  icloud: {
    host: 'smtp.mail.me.com',
    port: 587,
    secure: false,
    note: 'appleid.apple.com → Sign-In and Security → App-Specific Passwords',
  },
  fastmail: {
    host: 'smtp.fastmail.com',
    port: 465,
    secure: true,
    note: 'Fastmail → Settings → Privacy & Security → App passwords',
  },
}

export interface SmtpConfig {
  host: string
  port: number
  secure: boolean
  user: string
  pass: string
  from: string
  preset: string | null
}

function env(name: string): string | undefined {
  return process.env[name]?.trim() || undefined
}

/**
 * Read the SMTP configuration, or `null` if it is not set up.
 *
 * Deliberately strict about partial configuration: a host with no password is
 * someone halfway through setting this up, and silently falling back to "email
 * disabled" would leave them watching for mail that was never going to be
 * attempted. It throws, loudly, at boot.
 */
export function smtpConfig(): SmtpConfig | null {
  const presetName = env('SMTP_PRESET')?.toLowerCase()
  const preset = presetName ? PRESETS[presetName] : undefined
  if (presetName && !preset) {
    throw new Error(
      `SMTP_PRESET="${presetName}" is not one of ${Object.keys(PRESETS).join(', ')} — ` +
        'or set SMTP_HOST and SMTP_PORT directly',
    )
  }

  const host = env('SMTP_HOST') ?? preset?.host
  const user = env('SMTP_USER')
  const pass = env('SMTP_PASS')

  if (!host && !user && !pass) return null

  const missing = [
    !host && 'SMTP_HOST (or SMTP_PRESET)',
    !user && 'SMTP_USER',
    !pass && 'SMTP_PASS',
  ].filter(Boolean)
  if (missing.length > 0) {
    throw new Error(`SMTP is half-configured — missing ${missing.join(', ')}`)
  }

  const port = Number(env('SMTP_PORT') ?? preset?.port ?? 587)
  // `secure` means "TLS from the first byte", which is 465 and nothing else.
  // Inferred from the port rather than taken on trust, because the pair being
  // wrong hangs instead of failing.
  const secure = env('SMTP_SECURE') ? env('SMTP_SECURE') === 'true' : port === 465

  return {
    host: host!,
    port,
    secure,
    user: user!,
    pass: pass!,
    // Gmail rewrites a From it does not own, so the account address is the
    // honest default.
    from: env('SMTP_FROM') ?? user!,
    preset: presetName ?? null,
  }
}

let cached: Transporter | null = null

export function transporter(): Transporter | null {
  if (cached) return cached
  const config = smtpConfig()
  if (!config) return null

  cached = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: { user: config.user, pass: config.pass },
    // Pooled: a burst of invites should not open a connection each, and Gmail
    // is unfriendly about that.
    pool: true,
    maxConnections: 2,
    /*
     * Refuse to send at all without TLS.
     *
     * `secure: false` on port 587 means "start in the clear and upgrade with
     * STARTTLS" — but by default nodemailer only upgrades *if the server
     * advertises it*, and carries on in plaintext if it does not. A network
     * attacker who strips the STARTTLS capability from the greeting therefore
     * gets the app password and every invite in the clear, and nothing
     * anywhere reports a problem.
     *
     * With this, a server that cannot do TLS produces an error instead of a
     * silent downgrade. On port 465 it is already TLS from the first byte and
     * this changes nothing.
     */
    requireTLS: true,
    tls: {
      /*
       * Non-negotiable.
       *
       * nodemailer will happily continue on an unverifiable certificate if you
       * ask it to, and every "my SMTP doesn't work" answer on the internet
       * suggests exactly that. On port 587 the session starts in the clear and
       * upgrades, so a stripped or spoofed STARTTLS with verification off
       * hands the app password to whoever is in the middle.
       */
      rejectUnauthorized: true,
      minVersion: 'TLSv1.2',
    },
    connectionTimeout: 15_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  })
  return cached
}

export function provider(): Provider {
  if (smtpConfig()) return 'smtp'
  if (env('RESEND_API_KEY')) return 'resend'
  return 'none'
}

/**
 * Prove the credentials at boot rather than at the moment somebody needs a
 * password reset.
 *
 * Never throws: a mail server that is briefly unreachable must not stop the
 * app from starting. It reports, and the next send tries again.
 */
export async function verify(): Promise<{ ok: boolean; detail: string }> {
  const config = smtpConfig()
  if (!config) return { ok: false, detail: 'not configured' }

  try {
    await transporter()!.verify()
    return { ok: true, detail: `${config.user} via ${config.host}:${config.port}` }
  } catch (error) {
    const message = (error as Error).message
    const preset = config.preset ? PRESETS[config.preset] : undefined
    // The overwhelmingly likely cause, named, because "535 Authentication
    // failed" sends people to reset the wrong password.
    const hint = /auth|535|credential/i.test(message) && preset
      ? ` — this usually means SMTP_PASS is the account password rather than an app password. Create one at: ${preset.note}`
      : ''
    return { ok: false, detail: `${message}${hint}` }
  }
}

export const PRESET_NAMES = Object.keys(PRESETS)
