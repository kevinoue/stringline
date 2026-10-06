/**
 * Drive first-run setup in a real browser.
 *
 * Separate from shoot.mjs because it needs the opposite starting conditions: a
 * database with no companies in it. Running it against a live instance proves
 * nothing, since the whole point is what an unclaimed instance does.
 *
 *   SETUP_TOKEN=<code> APP_URL=http://localhost:5174/stringline/ \
 *     node scripts/setup-shoot.mjs
 *
 * The thing worth testing in a browser rather than with curl is the gap before
 * /setup/status answers. Showing the login during that gap and then swapping it
 * for the setup screen makes a fresh install look broken, so this checks that a
 * login form never appears on an unclaimed instance.
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
const TOKEN = process.env.SETUP_TOKEN

if (!TOKEN) {
  console.error('SETUP_TOKEN is required — it is printed in the server log at startup.')
  process.exit(2)
}

const problems = []
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`)
  if (!ok) problems.push(label)
}

const browser = await chromium.launch(executablePath ? { executablePath } : {})
const page = await browser.newPage({ viewport: { width: 1500, height: 940 } })

const consoleErrors = []
page.on('console', (m) => {
  if (m.type() !== 'error') return
  const url = m.location().url
  // The wrong-code step below deliberately provokes a 401 from /setup. A
  // browser logs every non-2xx as a console error, so an expected refusal
  // would otherwise fail this suite for working correctly.
  if (url.includes('favicon') || url.includes('/setup')) return
  consoleErrors.push(m.text())
})

console.log('== an unclaimed instance offers setup, not a login ==')
{
  await page.goto(BASE, { waitUntil: 'domcontentloaded' })

  // Caught immediately, before the status call can have resolved. A login form
  // here means someone on a slow connection sees the wrong screen first.
  const earlyLogin = await page.locator('button:has-text("Sign in")').count()
  check('no login form flashes while the status call is in flight', earlyLogin === 0,
    earlyLogin ? 'a Sign in button rendered before setup state was known' : '')

  // waitForSelector throws on timeout, so reaching the next line *is* the
  // assertion. Passing `true` keeps it visible in the output.
  await page.waitForSelector('h1:has-text("Set up Stringline")', { timeout: 10_000 })
  check('the setup screen appears', true)
  check('and it does not offer a sign-in',
    (await page.locator('button:has-text("Sign in")').count()) === 0)
  await page.screenshot({ path: `${OUT}/20-setup.png` })
}

console.log('\n== it refuses a wrong code, in the browser ==')
{
  const fill = async (label, value) => {
    await page.locator(`label:has-text("${label}") input`).fill(value)
  }
  await fill('Setup code', 'definitelynotit')
  await fill('Company name', 'Browser Test Co')
  await fill('Your name', 'Tester')
  await fill('Your email', 'tester@browser.test')
  await fill('Password', 'correcthorse')

  // The company code should have been suggested from the company name.
  const slug = await page.locator('label:has-text("Company code") input').inputValue()
  check('the company code was suggested from the name', slug === 'browser-test-co', slug)

  await page.locator('button:has-text("Create my company")').click()
  await page.waitForSelector('.error', { timeout: 10_000 })
  const message = (await page.locator('.error').textContent())?.trim() ?? ''
  check('a wrong code is refused', /setup code/i.test(message), message)
  check('and the form is still there to correct',
    (await page.locator('h1:has-text("Set up Stringline")').count()) === 1)
  await page.screenshot({ path: `${OUT}/21-setup-wrong-code.png` })
}

console.log('\n== the right code sets it up ==')
{
  await page.locator('label:has-text("Setup code") input').fill(TOKEN)
  await page.locator('button:has-text("Create my company")').click()

  // Landing in the app rather than back at a login is the whole point: the
  // response carries a session, so nobody should have to type a password they
  // set ten seconds ago.
  await page.waitForSelector('.projects, .new-project, h1:has-text("Projects")', { timeout: 15_000 })
  check('it lands straight in the app, already signed in', true)
  check('and the setup screen is gone',
    (await page.locator('h1:has-text("Set up Stringline")').count()) === 0)
  await page.screenshot({ path: `${OUT}/22-after-setup.png` })
}

console.log('\n== reloading now shows a login, not setup ==')
{
  await page.evaluate(() => localStorage.clear())
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForSelector('button:has-text("Sign in")', { timeout: 10_000 })
  check('a claimed instance shows the login', true)
  check('and will not offer setup again',
    (await page.locator('h1:has-text("Set up Stringline")').count()) === 0)
  await page.screenshot({ path: `${OUT}/23-login-after-setup.png` })
}

console.log('\n== console ==')
check('no console errors', consoleErrors.length === 0, consoleErrors.slice(0, 2).join(' | '))

await browser.close()
console.log('\n' + (problems.length ? `FAILURES: ${problems.join(', ')}` : 'ALL SETUP BROWSER CHECKS PASSED'))
console.log(`screenshots in ${OUT}`)
process.exit(problems.length ? 1 : 0)
