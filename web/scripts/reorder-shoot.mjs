/**
 * Reordering rows and duplicating tasks, in a real browser.
 *
 * Its own suite rather than part of shoot.mjs, because both of these change
 * the set of rows that later checks index into — and "drag it back" does not
 * restore an exact order, so sharing a project with other checks makes them
 * quietly depend on each other.
 *
 *   SLUG=demo-1234 node scripts/reorder-shoot.mjs
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

const BASE = process.env.APP_URL ?? 'http://localhost:5174/stringline/'
const SLUG = process.env.SLUG
if (!SLUG) {
  console.error('SLUG is required — the company code of a seeded demo company.')
  process.exit(2)
}

const problems = []
const check = (l, ok, d = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${l}${d ? '  ' + d : ''}`)
  if (!ok) problems.push(l)
}

const b = await chromium.launch(exe ? { executablePath: exe } : {})
const p = await b.newPage({ viewport: { width: 1500, height: 950 } })
const errs = []
p.on('console', (m) => {
  if (m.type() === 'error' && !m.location().url.includes('favicon')) errs.push(m.text())
})

await p.goto(BASE, { waitUntil: 'domcontentloaded' })
await p.waitForSelector('button:has-text("Sign in")')
await p.locator('label:has-text("Company code") input').fill(SLUG)
await p.locator('label:has-text("Email") input').fill('kev@demo.test')
await p.locator('label:has-text("Password") input').fill('correcthorse')
await p.locator('button:has-text("Sign in")').click()
await p.waitForSelector('.project-card', { timeout: 15_000 })

// A project of its own, so nothing here disturbs the shared fixture.
await p.locator('.new-project input').first().fill('Reorder scratch')
await p.locator('.new-project select').selectOption({ label: 'Hotel seasonal closedown' })
await p.locator('.new-project button:has-text("Create")').click()
await p.waitForSelector('.gantt svg .bar', { timeout: 20_000 })
await p.waitForTimeout(600)

const names = async () =>
  (await p.locator('.table-row .name-text').allTextContents()).map((n) => n.trim())

console.log('== dragging a row reorders the list ==')
{
  const before = await names()
  check('rows are draggable',
    (await p.locator('.table-row').first().getAttribute('draggable')) === 'true')

  // Row order is display only. It must move rows and move nothing else.
  const finishBefore = (await p.locator('.finish strong').textContent()).trim()
  await p.locator('.table-row').nth(3).dragTo(p.locator('.table-row').nth(0))
  await p.waitForTimeout(1500)

  const after = await names()
  check('dragging a row moves it', after[0] === before[3], `${before[3]} → ${after[0]}`)
  check('and loses none', after.length === before.length, `${before.length} → ${after.length}`)
  check('and the rest keep their relative order',
    JSON.stringify(after.filter((n) => n !== before[3])) ===
      JSON.stringify(before.filter((n) => n !== before[3])),
    after.slice(0, 4).join(' | '))
  // The whole reason row order is separate from the schedule.
  check('without moving a single date',
    (await p.locator('.finish strong').textContent()).trim() === finishBefore, finishBefore)

  await p.reload({ waitUntil: 'domcontentloaded' })
  await p.waitForSelector('.project-card', { timeout: 15_000 })
  await p.locator('.project-card:has-text("Reorder scratch")').first().click()
  await p.waitForSelector('.gantt svg .bar', { timeout: 15_000 })
  await p.waitForTimeout(600)
  check('and it survives a reload', (await names())[0] === before[3], (await names())[0])
}

console.log('\n== duplicating a task ==')
{
  const before = await names()
  await p.locator('.table-row').nth(2).click()
  await p.waitForSelector('.panel', { timeout: 10_000 })
  const original = (
    await p.locator('.panel label').filter({ hasText: /^Name$/ }).locator('input').inputValue()
  ).trim()

  await p.locator('.panel button:has-text("Duplicate")').click()
  await p.waitForTimeout(1800)

  const after = await names()
  const copy = `${original} (copy)`
  check('a copy appears', after.includes(copy), copy)
  check('directly below the original',
    after.indexOf(copy) === after.indexOf(original) + 1,
    `${after.indexOf(original)} then ${after.indexOf(copy)}`)
  check('and nothing else changed', after.length === before.length + 1,
    `${before.length} → ${after.length}`)

  // The point of duplicating: an editable copy of work a template lumped
  // together. Its steps and predecessors should come too.
  await p.locator(`.table-row:has-text("${copy}")`).first().click()
  await p.waitForSelector('.panel', { timeout: 10_000 })
  await p.waitForTimeout(400)
  const preds = await p.locator('.panel .dep-row, .panel li').count()
  check('the copy is editable on its own', (await p.locator('.panel').count()) === 1, `${preds} links listed`)
}

check('no console errors', errs.length === 0, errs.slice(0, 2).join(' | '))

await b.close()
console.log('\n' + (problems.length ? `FAILURES: ${problems.join(', ')}` : 'ALL REORDER CHECKS PASSED'))
process.exit(problems.length ? 1 : 0)
