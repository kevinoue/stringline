/**
 * Drive phase management in a real browser.
 *
 * Phases were in the schema from the start but had no UI at all, so a blank
 * project could never have them. This covers the two places that changed: the
 * manager, and the control in the task editor.
 *
 * Expects a database seeded by `server/scripts/seed.py`, which now files its
 * nineteen tasks under five phases.
 *
 *   SLUG=demo-1234 node scripts/phases-shoot.mjs
 */
import { chromium } from 'playwright'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
const CACHE = join(homedir(), 'Library/Caches/ms-playwright')
const exe = [
  'chromium-1243/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
  'chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
].map((c) => join(CACHE, c)).find(existsSync)

const SLUG = process.env.SLUG
if (!SLUG) {
  console.error('SLUG is required — the company code of a seeded demo company.')
  process.exit(2)
}

const problems = []
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`)
  if (!ok) problems.push(label)
}
const b = await chromium.launch(exe ? { executablePath: exe } : {})
const p = await b.newPage({ viewport: { width: 1500, height: 950 } })
const errs = []
p.on('console', (m) => { if (m.type() === 'error' && !m.location().url.includes('favicon')) errs.push(m.text()) })

await p.goto('http://localhost:5174/stringline/', { waitUntil: 'domcontentloaded' })
await p.waitForSelector('button:has-text("Sign in")')
await p.locator('label:has-text("Company code") input').fill(SLUG)
await p.locator('label:has-text("Email") input').fill('kev@demo.test')
await p.locator('label:has-text("Password") input').fill('correcthorse')
await p.locator('button:has-text("Sign in")').click()
await p.waitForSelector('.project-card', { timeout: 15000 })
await p.locator('.project-card').first().click()

await p.waitForSelector('button:has-text("Phases")', { timeout: 15000 })
const buttonText = (await p.locator('button:has-text("Phases")').textContent()).trim()
// The count in the button is how someone notices phases exist at all.
check('the toolbar shows a phase count', /\(5\)/.test(buttonText), buttonText)
await p.locator('button:has-text("Phases")').click()
await p.waitForSelector('.modal-wide h2:has-text("Phases")', { timeout: 10000 })
await p.waitForSelector('.team-table tr', { timeout: 10000 })
const rows = await p.locator('.team-table tr').count()
check('the manager lists every phase', rows === 5, `${rows} rows`)
const names = (await p.locator('.team-table strong').allTextContents()).join(', ')
check('in the order the work happens',
  names === 'Enabling works, Structure, First fix, Finishes, Handover', names)
const counts = (await p.locator('.team-table .sub').allTextContents()).join(', ')
check('each with how many tasks it holds', /\d+ tasks?/.test(counts), counts)
check('the first phase cannot be moved up',
  await p.locator('.team-table tr').first().locator('button[aria-label^="Move"]').first().isDisabled())
await p.screenshot({ path: '/tmp/stringline-shots/40-phases.png' })

await p.locator('.modal-actions button:has-text("Close")').click()
await p.waitForTimeout(400)
// `.table-row`, not `tbody tr` — the task list is a div grid, because it has
// to stay in lockstep with the SVG chart's row heights.
await p.locator('.table-row').first().click()
await p.waitForSelector('.panel', { timeout: 10000 })
const n = await p.locator('label:has-text("Phase") select').count()
check('the task editor has a phase control', n === 1, `${n} found`)
const options = await p.locator('label:has-text("Phase") select option').allTextContents()
check('offering every phase, plus none and a way to add one',
  options.length === 7 && options[0] === 'No phase' && options.at(-1) === 'New phase…',
  options.join(' | '))
const current = await p.locator('label:has-text("Phase") select').inputValue()
check('and the task shows the phase it is already in', current !== '', current || '(empty)')
await p.screenshot({ path: '/tmp/stringline-shots/41-task-phase.png' })
check('no console errors', errs.length === 0, errs.slice(0, 2).join(' | '))

await b.close()
console.log('\n' + (problems.length ? `FAILURES: ${problems.join(', ')}` : 'ALL PHASE BROWSER CHECKS PASSED'))
process.exit(problems.length ? 1 : 0)
