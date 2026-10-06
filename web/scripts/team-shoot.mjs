/**
 * Drive invites and team management in a real browser.
 *
 * The flow this covers is the one the API suite cannot: an owner copies a code
 * out of the Team screen, and a second person — in a clean browser context with
 * no session — follows the link and joins. That hand-off is the whole feature,
 * and it is made of two screens rather than two endpoints.
 *
 *   APP_URL=http://localhost:5174/stringline/ node scripts/team-shoot.mjs
 *
 * Needs a server with no email configured, which is the case worth testing:
 * the invite has to be usable with nothing but what is on screen.
 */
import { chromium } from 'playwright'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const CACHE = join(homedir(), 'Library/Caches/ms-playwright')
const CANDIDATES = [
  'chromium-1243/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
  'chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
]
const executablePath = CANDIDATES.map((c) => join(CACHE, c)).find(existsSync)

const BASE = process.env.APP_URL ?? 'http://localhost:5174/stringline/'
const OUT = process.env.OUT_DIR ?? '/tmp/stringline-shots'
const API = process.env.STRINGLINE_API ?? 'http://localhost:3006/stringline/api'

const problems = []
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`)
  if (!ok) problems.push(label)
}

// A company of our own, so this suite does not depend on seed data.
const slug = `shoot${Math.floor(Math.random() * 90000) + 10000}`
const OWNER = { email: 'owner@shoot.test', password: 'correcthorse', name: 'Olivia Owner' }
await fetch(`${API}/auth/signup`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ companyName: 'Shoot Co', slug, ...OWNER }),
}).then((r) => {
  if (!r.ok) throw new Error(`signup failed: ${r.status}`)
})

const browser = await chromium.launch(executablePath ? { executablePath } : {})
const owner = await browser.newPage({ viewport: { width: 1400, height: 950 } })

const consoleErrors = []
for (const p of [owner]) {
  p.on('console', (m) => {
    if (m.type() === 'error' && !m.location().url.includes('favicon')) consoleErrors.push(m.text())
  })
}

const signIn = async (page, email, password) => {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('button:has-text("Sign in")')
  await page.locator('label:has-text("Company code") input').fill(slug)
  await page.locator('label:has-text("Email") input').fill(email)
  await page.locator('label:has-text("Password") input').fill(password)
  await page.locator('button:has-text("Sign in")').click()
  await page.waitForSelector('.new-project', { timeout: 15_000 })
}

console.log('== the owner opens the team screen ==')
await signIn(owner, OWNER.email, OWNER.password)
{
  // With no RESEND_API_KEY the login must not dangle a reset link that cannot
  // work — that is the whole point of asking the server first.
  await owner.goto(BASE, { waitUntil: 'domcontentloaded' })
  await owner.waitForSelector('.new-project', { timeout: 15_000 })

  await owner.locator('button:has-text("Team")').click()
  await owner.waitForSelector('.modal-wide h2:has-text("Team")', { timeout: 10_000 })
  // The heading renders before the fetch resolves, so waiting on it alone
  // measures an empty table. Wait for a row.
  await owner.waitForSelector('.team-table tr', { timeout: 10_000 })
  check('the team screen opens', true)

  const rows = await owner.locator('.team-table tr').count()
  check('a new company has exactly one person in it', rows === 1, `${rows} rows`)
  check('it marks which row is you',
    (await owner.locator('.team-table .sub:has-text("you")').count()) === 1)
  check('and does not offer to disable yourself',
    (await owner.locator('.team-table button:has-text("Disable")').count()) === 0)

  const hint = (await owner.locator('.modal-wide .hint').first().textContent()) ?? ''
  check('it says field and client seats are free', /free/i.test(hint), hint.slice(0, 90))
  check('and explains that codes must be passed on by hand',
    /cannot send email/i.test(hint), hint.slice(0, 140))
  await owner.screenshot({ path: `${OUT}/30-team.png` })
}

console.log('\n== inviting someone shows a code to copy ==')
let inviteUrl
{
  await owner.locator('.invite-form input[type="email"]').fill('frank@shoot.test')
  await owner.locator('.invite-form input').nth(1).fill('Frank Field')
  await owner.locator('.invite-form select').selectOption('field')
  await owner.locator('.invite-form button:has-text("Invite")').click()

  await owner.waitForSelector('.handout', { timeout: 10_000 })
  check('the invite produces something to hand over', true)

  inviteUrl = (await owner.locator('.handout-row code.grow').textContent())?.trim() ?? ''
  check('including a full link', /\?invite=/.test(inviteUrl), inviteUrl)
  check('and the bare code as well',
    ((await owner.locator('.handout-row code').nth(1).textContent()) ?? '').length >= 9)
  check('the invite is listed as waiting',
    (await owner.locator('h3:has-text("Waiting to accept")').count()) === 1)
  await owner.screenshot({ path: `${OUT}/31-invite-code.png` })
}

console.log('\n== a different person follows the link ==')
{
  // A separate context, not just a tab: this person has no session, no
  // localStorage and no cookies. That is the situation the link has to work in.
  const guestContext = await browser.newContext({ viewport: { width: 1400, height: 950 } })
  const guest = await guestContext.newPage()
  guest.on('console', (m) => {
    if (m.type() === 'error' && !m.location().url.includes('favicon')) consoleErrors.push(m.text())
  })

  // The server builds the link from PUBLIC_URL, which points at production.
  // Follow the same code against the instance under test.
  const code = new URL(inviteUrl).searchParams.get('invite')
  await guest.goto(`${BASE}?invite=${encodeURIComponent(code)}`, { waitUntil: 'domcontentloaded' })

  await guest.waitForSelector('h1:has-text("Join Shoot Co")', { timeout: 10_000 })
  check('they are shown what they are joining', true)
  const tagline = (await guest.locator('.tagline').textContent()) ?? ''
  check('and in what role', /field crew/i.test(tagline), tagline)

  const emailField = guest.locator('label:has-text("Email") input')
  check('the email is fixed to the one invited',
    (await emailField.inputValue()) === 'frank@shoot.test', await emailField.inputValue())
  check('and cannot be edited', await emailField.isDisabled())

  check('the token is not left in the address bar',
    !guest.url().includes('invite='), guest.url())
  await guest.screenshot({ path: `${OUT}/32-accept-invite.png` })

  await guest.locator('label:has-text("Choose a password") input').fill('frankspassword')
  await guest.locator('button:has-text("Join")').click()

  await guest.waitForSelector('.new-project', { timeout: 15_000 })
  check('joining signs them straight in, with no second login', true)
  await guest.screenshot({ path: `${OUT}/33-joined.png` })

  await guestContext.close()
}

console.log('\n== the owner sees them arrive ==')
{
  await owner.goto(BASE, { waitUntil: 'domcontentloaded' })
  await owner.waitForSelector('.new-project', { timeout: 15_000 })
  await owner.locator('button:has-text("Team")').click()
  await owner.waitForSelector('.modal-wide h2:has-text("Team")')
  await owner.waitForSelector('.team-table tr', { timeout: 10_000 })

  const names = await owner.locator('.team-table strong').allTextContents()
  check('the new person is on the team', names.includes('Frank Field'), names.join(', '))
  check('and the invite is no longer waiting',
    (await owner.locator('h3:has-text("Waiting to accept")').count()) === 0)
  await owner.screenshot({ path: `${OUT}/34-team-after-join.png` })
}

console.log('\n== console ==')
check('no console errors', consoleErrors.length === 0, consoleErrors.slice(0, 2).join(' | '))

await browser.close()
console.log('\n' + (problems.length ? `FAILURES: ${problems.join(', ')}` : 'ALL TEAM BROWSER CHECKS PASSED'))
console.log(`screenshots in ${OUT}`)
process.exit(problems.length ? 1 : 0)
