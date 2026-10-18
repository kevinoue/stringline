/**
 * The password policy, and the mail configuration it travels with.
 *
 * Both are pure functions of their input, so they get real unit tests rather
 * than being exercised only through HTTP. The policy in particular is the kind
 * of code where a regex change quietly starts accepting everything and no
 * integration test notices, because an integration test only ever tries
 * passwords somebody thought of.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { checkPassword, MIN_PASSWORD_LENGTH } from '../security.js'
import { smtpConfig } from '../mailer.js'

describe('password policy', () => {
  it('accepts a long memorable phrase', () => {
    // The thing the policy exists to encourage. If this ever fails, the rules
    // have started working against the guidance they implement.
    expect(checkPassword('correct horse battery staple').ok).toBe(true)
    expect(checkPassword('harbour-crane-slip').ok).toBe(true)
  })

  it('rejects anything shorter than the minimum', () => {
    // Deliberately not a repeated character: `'a'.repeat(9)` is also rejected,
    // but by the repetition rule, so it would pass this test without the
    // length rule existing at all.
    const verdict = checkPassword('abcdefghi'.slice(0, MIN_PASSWORD_LENGTH - 1))
    expect(verdict.ok).toBe(false)
    expect(verdict.reason).toContain(String(MIN_PASSWORD_LENGTH))
  })

  it('rejects past what bcrypt will hash', () => {
    // bcrypt truncates at 72 bytes. A 100-character password that is silently
    // only 72 characters strong is worse than being told.
    // Varied characters, for the same reason as above — a run of one letter
    // is rejected by the repetition rule whatever its length.
    const varied = (n: number): string => 'abcdefghij'.repeat(Math.ceil(n / 10)).slice(0, n)
    expect(checkPassword(varied(73)).ok).toBe(false)
    expect(checkPassword(varied(72)).ok).toBe(true)
  })

  it('counts bytes, not characters, against the bcrypt limit', () => {
    // 36 four-byte characters is 144 bytes but only 36 code points, so a
    // length check in characters would wave it through and bcrypt would
    // quietly keep half of it.
    const emoji = '🧱'.repeat(36)
    expect([...emoji].length).toBe(36)
    expect(Buffer.byteLength(emoji)).toBe(144)
    expect(checkPassword(emoji).ok).toBe(false)
  })

  it('rejects the passwords an attacker leads with', () => {
    for (const bad of ['password', 'Password1', 'password123', 'qwerty!!', 'letmein99']) {
      expect(checkPassword(bad.padEnd(MIN_PASSWORD_LENGTH, '1')).ok, bad).toBe(false)
    }
  })

  it('rejects a password built from the email or the company code', () => {
    expect(checkPassword('acme-roofing-2026', ['acme-roofing']).ok).toBe(false)
    expect(checkPassword('kevinKEVINkevin', ['kevin']).ok).toBe(false)
  })

  it('does not let a short context string block everything', () => {
    // A company called "ACE" must not reject every password containing "ace",
    // which would include "peaceful-morning-light".
    expect(checkPassword('peaceful-morning-light', ['ace']).ok).toBe(true)
  })

  it('rejects one repeated character', () => {
    expect(checkPassword('aaaaaaaaaaaaaa').ok).toBe(false)
  })
})

describe('smtp configuration', () => {
  const saved = { ...process.env }
  afterEach(() => {
    process.env = { ...saved }
  })

  const clear = (): void => {
    for (const key of ['SMTP_PRESET', 'SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM', 'SMTP_SECURE']) {
      delete process.env[key]
    }
  }

  it('is null when nothing is set', () => {
    clear()
    expect(smtpConfig()).toBeNull()
  })

  it('fills in host, port and TLS from a preset', () => {
    clear()
    process.env.SMTP_PRESET = 'gmail'
    process.env.SMTP_USER = 'kev@gmail.com'
    process.env.SMTP_PASS = 'app-password'

    const config = smtpConfig()!
    expect(config.host).toBe('smtp.gmail.com')
    expect(config.port).toBe(465)
    // 465 is TLS from the first byte. Getting this wrong hangs rather than
    // erroring, which is why it is inferred rather than configured.
    expect(config.secure).toBe(true)
    // Gmail rewrites a From it does not own, so the account address is the
    // only honest default.
    expect(config.from).toBe('kev@gmail.com')
  })

  it('knows iCloud starts in the clear and upgrades', () => {
    clear()
    process.env.SMTP_PRESET = 'icloud'
    process.env.SMTP_USER = 'kev@icloud.com'
    process.env.SMTP_PASS = 'app-password'

    const config = smtpConfig()!
    expect(config.port).toBe(587)
    expect(config.secure).toBe(false)
  })

  it('infers TLS from the port for a hand-configured server', () => {
    clear()
    process.env.SMTP_HOST = 'smtp.example.com'
    process.env.SMTP_USER = 'a'
    process.env.SMTP_PASS = 'b'

    process.env.SMTP_PORT = '465'
    expect(smtpConfig()!.secure).toBe(true)
    process.env.SMTP_PORT = '587'
    expect(smtpConfig()!.secure).toBe(false)
  })

  it('throws on a half-written configuration rather than silently disabling mail', () => {
    clear()
    process.env.SMTP_HOST = 'smtp.example.com'
    // No user, no password — somebody midway through setting this up.
    expect(() => smtpConfig()).toThrow(/half-configured/)
  })

  it('names the valid presets when given a bad one', () => {
    clear()
    process.env.SMTP_PRESET = 'hotmail'
    process.env.SMTP_USER = 'a'
    process.env.SMTP_PASS = 'b'
    expect(() => smtpConfig()).toThrow(/gmail/)
  })
})
