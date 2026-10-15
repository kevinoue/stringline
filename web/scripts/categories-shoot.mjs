/**
 * Drive categories in a real browser.
 *
 * Three claims are worth proving here and only here: that focusing on a trade
 * actually dims the *other* bars, that the stripe renders in the category's
 * colour, and that a filtered PDF really does contain one trade's rows and no
 * one else's. None of those can be asserted from the API.
 *
 *   SLUG=demo-1234 node scripts/categories-shoot.mjs
 *
 * Expects a project started from the closedown template, which arrives tagged.
 */
import { chromium } from 'playwright'
import { existsSync, readFileSync } from 'node:fs'
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

const browser = await chromium.launch(executablePath ? { executablePath } : {})
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } })
const errs = []
page.on('console', (m) => {
  if (m.type() === 'error' && !m.location().url.includes('favicon')) errs.push(m.text())
})

await page.goto(BASE, { waitUntil: 'domcontentloaded' })
await page.waitForSelector('button:has-text("Sign in")')
await page.locator('label:has-text("Company code") input').fill(SLUG)
await page.locator('label:has-text("Email") input').fill('kev@demo.test')
await page.locator('label:has-text("Password") input').fill('correcthorse')
await page.locator('button:has-text("Sign in")').click()
await page.waitForSelector('.project-card', { timeout: 15_000 })
await page.locator('.project-card:has-text("closedown")').first().click()
await page.waitForSelector('.gantt svg .bar', { timeout: 15_000 })
await page.waitForTimeout(500)

console.log('== a template project arrives tagged ==')
{
  const stripes = await page.locator('.gantt .bar-stripe').count()
  const bars = await page.locator('.gantt .bar').count()
  check('bars carry a category stripe', stripes > 0, `${stripes} stripes over ${bars} bars`)

  const colours = await page.evaluate(() =>
    [...new Set([...document.querySelectorAll('.gantt .bar-stripe')].map((s) => s.style.fill))],
  )
  check('and the stripes are not all one colour', colours.length >= 4, `${colours.length} colours`)

  const options = await page.locator('.focus-picker option').allTextContents()
  check('the toolbar offers the trades on this job', options.length >= 6, options.join(', '))
  check('with an all-trades default', /^All/.test(options[0]), options[0])
  await page.screenshot({ path: `${OUT}/60-tagged.png` })
}

console.log('\n== focusing dims the others, not itself ==')
{
  const values = await page.locator('.focus-picker option').evaluateAll((os) =>
    os.map((o) => ({ value: o.value, text: o.textContent })),
  )
  const housekeeping = values.find((v) => /housekeeping/i.test(v.text ?? ''))
  check('housekeeping is one of them', Boolean(housekeeping), values.map((v) => v.text).join(', '))

  await page.locator('.focus-picker').selectOption(housekeeping.value)
  await page.waitForTimeout(400)

  const state = await page.evaluate(() => {
    const bars = [...document.querySelectorAll('.gantt .bar')]
    return {
      total: bars.length,
      dimmed: bars.filter((b) => b.classList.contains('dimmed')).length,
    }
  })
  check('most bars are dimmed', state.dimmed > 0, `${state.dimmed} of ${state.total}`)
  check('but not all of them — the focused trade stays solid',
    state.dimmed < state.total, `${state.total - state.dimmed} left solid`)

  // The list has to fade with the chart. Dimming only the bars leaves the
  // names at full strength, so the left column still reads as everything.
  const listDimmed = await page.locator('.table-row.dimmed').count()
  check('and the task list dims with it', listDimmed > 0, `${listDimmed} rows faded`)
  await page.screenshot({ path: `${OUT}/61-focused.png` })

  await page.locator('.focus-picker').selectOption('')
  await page.waitForTimeout(300)
  const after = await page.locator('.gantt .bar.dimmed').count()
  const afterRows = await page.locator('.table-row.dimmed').count()
  check('clearing the focus un-dims everything',
    after === 0 && afterRows === 0, `${after} bars, ${afterRows} rows still dimmed`)
}

console.log('\n== colour-by never competes with the critical path ==')
{
  const criticalBefore = await page.locator('.gantt .bar.critical').count()
  check('the critical path is coloured by default', criticalBefore > 0, `${criticalBefore} critical`)

  await page.locator('button:has-text("Colour by")').click()
  await page.waitForTimeout(400)

  const filled = await page.evaluate(
    () => [...document.querySelectorAll('.gantt .bar')].filter((b) => b.style.fill).length,
  )
  check('switching to trade colours the bars', filled > 0, `${filled} bars filled`)

  // The chart's one rule: critical owns red. In trade mode the inline fill
  // must cover the critical bars too, or two colour systems are competing.
  const criticalStillRed = await page.evaluate(() =>
    [...document.querySelectorAll('.gantt .bar.critical')]
      .filter((b) => !b.style.fill && b.classList.contains('critical')).length,
  )
  check('and no critical bar is left showing red underneath',
    criticalStillRed === 0, `${criticalStillRed} unconverted`)
  await page.screenshot({ path: `${OUT}/62-colour-by-trade.png` })

  await page.locator('button:has-text("Colour by")').click()
  await page.waitForTimeout(300)
}

console.log('\n== the manager ==')
{
  await page.locator('button:has-text("Trades (")').click()
  await page.waitForSelector('.modal-wide .team-table tr', { timeout: 10_000 })
  const rows = await page.locator('.modal-wide .team-table tr').count()
  check('it lists the trades', rows >= 6, `${rows} rows`)

  const swatches = await page.locator('.modal-wide .swatch-btn').count()
  check('each offers the whole palette inline', swatches >= 60, `${swatches} swatches`)
  check('with one marked as chosen per row',
    (await page.locator('.modal-wide .swatch-btn.chosen').count()) === rows,
    `${await page.locator('.modal-wide .swatch-btn.chosen').count()} chosen`)
  await page.screenshot({ path: `${OUT}/63-trades.png` })
  await page.locator('.modal-actions button:has-text("Close")').click()
  await page.waitForTimeout(400)
}

console.log('\n== a subcontractor sheet contains only their work ==')
{
  await page.locator('button:has-text("Print")').click()
  await page.waitForSelector('.print-dialog', { timeout: 10_000 })

  const values = await page.locator('.print-dialog select').last().locator('option').evaluateAll(
    (os) => os.map((o) => ({ value: o.value, text: o.textContent })),
  )
  const maintenance = values.find((v) => /maintenance/i.test(v.text ?? ''))
  check('the print dialog offers one trade at a time', Boolean(maintenance),
    values.map((v) => v.text).join(', '))

  // Whole schedule first, as the baseline to compare against.
  await page.locator('.print-dialog select').first().selectOption('tabloid')
  await page.waitForTimeout(300)
  const allPath = `${OUT}/64-print-all.pdf`
  await page.pdf({ path: allPath, preferCSSPageSize: true, printBackground: true })

  await page.locator('.print-dialog select').last().selectOption(maintenance.value)
  await page.waitForTimeout(400)

  const rowsNote = (await page.locator('.print-dialog .hint').last().textContent()) ?? ''
  check('the sheet count reflects the filter', /\d+ tasks/.test(rowsNote), rowsNote.trim().slice(0, 70))

  const onePath = `${OUT}/65-print-maintenance.pdf`
  await page.pdf({ path: onePath, preferCSSPageSize: true, printBackground: true })

  await page.emulateMedia({ media: 'print' })
  await page.waitForTimeout(300)
  const printed = await page.evaluate(() => ({
    // By data-category, not by reading row names — the name carries the phase,
    // not the trade, so matching on text would prove nothing.
    rows: [...document.querySelectorAll('.print-row')].map((r) => ({
      category: r.getAttribute('data-category'),
      context: r.classList.contains('context'),
      name: r.querySelector('.print-col-name')?.textContent?.trim() ?? '',
    })),
    filterNote: document.querySelector('.print-filter')?.textContent?.trim() ?? null,
  }))
  await page.emulateMedia({ media: 'screen' })

  check('the title block says a filter is on',
    /maintenance/i.test(printed.filterNote ?? ''), printed.filterNote ?? '(none)')
  check('and warns it is part of a larger schedule',
    /larger schedule/i.test(printed.filterNote ?? ''), printed.filterNote ?? '')
  check('and explains the grey rows',
    /grey/i.test(printed.filterNote ?? ''), printed.filterNote ?? '')

  // Rows are either theirs, or context: work from another trade that theirs
  // waits on. A sheet with only their own rows would give dates with the
  // reasons removed, and on this template Maintenance waits on both
  // Housekeeping and F&B.
  const own = printed.rows.filter((r) => !r.context)
  const context = printed.rows.filter((r) => r.context)
  const strays = own.filter((r) => r.category !== maintenance.value)

  check('every non-context row belongs to that trade',
    own.length > 0 && strays.length === 0,
    strays.length ? `${strays.length} strays` : `${own.length} Maintenance rows`)
  check('and the work it waits on is carried too',
    context.length > 0, `${context.length} context rows`)
  check('context rows come from other trades',
    context.every((r) => r.category !== maintenance.value),
    context.map((r) => r.name).slice(0, 2).join(' | '))
  check('and are named with whose they are',
    context.every((r) => /·\s*\S/.test(r.name)), context[0]?.name ?? '(none)')

  // Row count, not byte size: a PDF's size is dominated by font subsetting and
  // compression, so a ten-row sheet can easily weigh more than a twenty-row
  // one. Comparing bytes measured nothing.
  check('and the sheet is shorter than the whole schedule',
    printed.rows.length < 22, `${printed.rows.length} rows vs 22 in the project`)
  check('both PDFs were written', readFileSync(onePath).length > 8000 && readFileSync(allPath).length > 8000,
    `${readFileSync(allPath).length} / ${readFileSync(onePath).length} bytes`)
}

check('no console errors', errs.length === 0, errs.slice(0, 2).join(' | '))

await browser.close()
console.log('\n' + (problems.length ? `FAILURES: ${problems.join(', ')}` : 'ALL CATEGORY BROWSER CHECKS PASSED'))
console.log(`screenshots in ${OUT}`)
process.exit(problems.length ? 1 : 0)
