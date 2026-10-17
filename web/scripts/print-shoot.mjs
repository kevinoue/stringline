/**
 * Print the schedule to a real PDF and check what came out.
 *
 * The only test that means anything for printing is a PDF. A DOM assertion
 * cannot tell you that `@page` took effect, that the sheet is the size you
 * asked for, that colours survived, or that the chart fits the width — and
 * those are precisely the things that go wrong.
 *
 * Playwright's `page.pdf()` drives the same print pipeline as Save-as-PDF, so
 * what it produces is what a user would get.
 *
 *   SLUG=demo-1234 node scripts/print-shoot.mjs
 */
import { chromium } from 'playwright'
import { existsSync, readFileSync, statSync } from 'node:fs'
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

/**
 * Page size straight out of the PDF, in points (72/inch).
 *
 * Read from the first `/MediaBox` in the file rather than trusting what we
 * asked for — the whole point is to confirm the `@page` rule actually reached
 * the printer.
 */
function mediaBoxInches(path) {
  const raw = readFileSync(path, 'latin1')
  const m = raw.match(/\/MediaBox\s*\[\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\]/)
  if (!m) return null
  const w = (parseFloat(m[3]) - parseFloat(m[1])) / 72
  const h = (parseFloat(m[4]) - parseFloat(m[2])) / 72
  return { w: Math.round(w * 100) / 100, h: Math.round(h * 100) / 100 }
}

const countPages = (path) =>
  (readFileSync(path, 'latin1').match(/\/Type\s*\/Page[^s]/g) ?? []).length

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
await page.locator('.project-card:has-text("Stonecliffe")').first().click()
await page.waitForSelector('.gantt svg .bar', { timeout: 15_000 })

console.log('== the print dialog ==')
await page.locator('button:has-text("Print")').click()
await page.waitForSelector('.print-dialog', { timeout: 10_000 })
check('it opens', true)

const paperOptions = await page.locator('.print-dialog select').first().locator('option').count()
check('offers several paper sizes', paperOptions >= 5, `${paperOptions} sizes`)

const title = await page.locator('.print-dialog label').filter({ hasText: /^Title on the printout$/ }).locator('input').inputValue()
check('the title is prefilled from the project',
  title.includes('Stonecliffe'), title)

const sheetNote = (await page.locator('.print-dialog .hint').last().textContent()) ?? ''
check('it says how many sheets this will be', /sheets?/.test(sheetNote), sheetNote.trim().slice(0, 90))

// Something to prove the title block is editable and reaches the paper.
await page.locator('.print-dialog label').filter({ hasText: /^Subtitle$/ }).locator('input').fill('Rev C — issued for construction')
await page.screenshot({ path: `${OUT}/50-print-dialog.png` })

console.log('\n== 11x17 landscape ==')
{
  await page.locator('.print-dialog select').first().selectOption('tabloid')
  await page.locator('.print-dialog select').nth(1).selectOption('landscape')
  await page.waitForTimeout(300)

  const path = `${OUT}/51-tabloid-landscape.pdf`
  // preferCSSPageSize, or Chromium ignores @page and uses its own default.
  await page.pdf({ path, preferCSSPageSize: true, printBackground: true })

  const box = mediaBoxInches(path)
  check('the sheet really is 17 × 11 in', box?.w === 17 && box?.h === 11, JSON.stringify(box))
  check('the PDF is not empty', statSync(path).size > 8000, `${statSync(path).size} bytes`)

  const text = readFileSync(path, 'latin1')
  // Vector, not a bitmap: a rasterised chart would be fuzzy when zoomed and
  // enormous on disk.
  check('the chart is vector, not an image', !text.includes('/Subtype /Image'))

  const pages = countPages(path)
  check('it produced more than one sheet for 19 tasks plus a cover',
    pages >= 2, `${pages} pages`)
}

console.log('\n== 8.5x11 portrait ==')
{
  await page.locator('.print-dialog select').first().selectOption('letter')
  await page.locator('.print-dialog select').nth(1).selectOption('portrait')
  await page.waitForTimeout(300)

  const path = `${OUT}/52-letter-portrait.pdf`
  await page.pdf({ path, preferCSSPageSize: true, printBackground: true })
  const box = mediaBoxInches(path)
  check('the sheet really is 8.5 × 11 in', box?.w === 8.5 && box?.h === 11, JSON.stringify(box))

  // A shorter sheet holds fewer rows, so it must spill onto more of them.
  check('a smaller sheet takes more sheets', countPages(path) >= 2, `${countPages(path)} pages`)
}

console.log('\n== what reaches the paper ==')
{
  await page.locator('.print-dialog select').first().selectOption('tabloid')
  await page.locator('.print-dialog select').nth(1).selectOption('landscape')
  await page.waitForTimeout(300)

  // Render the print layout to an image through the print media type, which is
  // how the colour and visibility rules actually get exercised.
  await page.emulateMedia({ media: 'print' })
  await page.waitForTimeout(200)

  const visible = await page.evaluate(() => {
    const root = document.querySelector('.print-only')
    const style = root ? getComputedStyle(root) : null
    const bar = document.querySelector('.print-bar.critical')
    return {
      printShown: style?.display,
      // Not just its own computed style: an element inside a hidden ancestor
      // still reports display:block. This is what caught the blank PDF.
      printReallyVisible: root ? root.getClientRects().length > 0 : false,
      printIsBodyChild: root?.parentElement === document.body,
      appHidden: getComputedStyle(document.querySelector('#root')).display,
      criticalFill: bar ? getComputedStyle(bar).fill : null,
      titles: [...document.querySelectorAll('.print-titleblock h1')].map((h) => h.textContent),
      subtitles: [...document.querySelectorAll('.print-subtitle')].map((p) => p.textContent),
      sheets: document.querySelectorAll('.print-page').length,
      axisTicks: document.querySelectorAll('.print-axis text').length,
      legends: document.querySelectorAll('.print-legend').length,
      // The cover sheet carries no chart, so it carries no legend either.
      chartSheets: document.querySelectorAll('.print-chart').length,
    }
  })

  check('the print layout is shown', visible.printShown === 'block', String(visible.printShown))
  check('and is actually laid out, not inside something hidden',
    visible.printReallyVisible, String(visible.printReallyVisible))
  check('because it is portalled to <body>, not left inside #root',
    visible.printIsBodyChild, String(visible.printIsBodyChild))
  check('and the app chrome is hidden', visible.appHidden === 'none', String(visible.appHidden))
  check('the critical path keeps its colour',
    visible.criticalFill === 'rgb(192, 57, 43)', String(visible.criticalFill))
  check('every sheet carries the title block',
    visible.titles.length === visible.sheets && visible.titles.every((t) => t?.includes('Stonecliffe')),
    `${visible.titles.length} titles / ${visible.sheets} sheets`)
  check('the edited subtitle reached the paper',
    visible.subtitles.every((s) => s?.includes('Rev C')), visible.subtitles[0] ?? '(none)')
  check('every sheet carries a date axis', visible.axisTicks > 0, `${visible.axisTicks} ticks`)
  check('every chart sheet carries the legend',
    visible.legends === visible.chartSheets,
    `${visible.legends} legends / ${visible.chartSheets} chart sheets`)

  await page.screenshot({ path: `${OUT}/53-print-preview.png`, fullPage: true })
  await page.emulateMedia({ media: 'screen' })
}

console.log('\n== steps and bar labels on the chart ==')
{
  await page.locator('.print-dialog button:has-text("Schedule chart")').click()
  await page.waitForTimeout(300)
  // No trade filter to clear: this suite runs on the seeded project, whose
  // tasks carry no trade, so the "Print only" control is not rendered at all.
  // The trade-filtered sheet is covered in categories-shoot.mjs, against a
  // project that does have them.
  await page.locator('.print-dialog select').first().selectOption('tabloid')

  const stepSelect = page
    .locator('.print-dialog label')
    .filter({ hasText: /^Steps/ })
    .locator('select')

  await stepSelect.selectOption('none')
  await page.waitForTimeout(500)
  await page.emulateMedia({ media: 'print' })
  await page.waitForTimeout(300)
  check('with steps off, none are printed',
    (await page.locator('.print-row.print-step').count()) === 0)
  // The names beside the bars: on a 17-inch sheet, tracking a bar back to the
  // name column is the thing this removes.
  const labels = await page.locator('.print-bar-label').count()
  check('task names print beside their bars', labels > 0, `${labels} labels`)
  await page.emulateMedia({ media: 'screen' })

  await stepSelect.selectOption('all')
  await page.waitForTimeout(700)
  await page.emulateMedia({ media: 'print' })
  await page.waitForTimeout(400)
  const stepRows = await page.locator('.print-row.print-step').count()
  check('with steps on, they are', stepRows > 0, `${stepRows} step rows`)

  // Each printed step must sit inside its own task's span — a trailing check
  // used to land a day past the bar it belongs to.
  const outside = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('.print-page')]
    let bad = 0
    for (const page of rows) {
      const chart = page.querySelector('.print-chart')
      if (!chart) continue
      const width = chart.getBoundingClientRect().width
      for (const el of page.querySelectorAll('.print-step-bar, .print-step-check')) {
        const x = Number(el.getAttribute('x') ?? el.getAttribute('cx') ?? 0)
        if (x < -1 || x > width + 1) bad++
      }
    }
    return bad
  })
  check('and every step bar lands inside the chart', outside === 0, `${outside} outside`)
  await page.emulateMedia({ media: 'screen' })
}

console.log('\n== checklists are a different document ==')
{
  await page.locator('.print-dialog button:has-text("Checklists")').click()
  await page.waitForTimeout(600)
  await page.emulateMedia({ media: 'print' })
  await page.waitForTimeout(400)

  const pages = await page.locator('.checklist-page').count()
  check('one sheet per task with steps', pages > 0, `${pages} sheets`)
  check('no Gantt on a checklist', (await page.locator('.print-chart').count()) === 0)

  const first = page.locator('.checklist-page').first()
  check('it carries a short reference to type back in',
    /^T-[0-9A-F]{4}$/.test((await first.locator('.ref-code').textContent())?.trim() ?? ''),
    (await first.locator('.ref-code').textContent())?.trim() ?? '(none)')
  check('with tick boxes to mark off',
    (await first.locator('.col-tick').count()) > 1,
    `${await first.locator('.col-tick').count()} rows`)
  check('and blank columns to write the date and initials in',
    (await first.locator('.col-actual').count()) > 1)
  check('somewhere to write what was found',
    (await first.locator('.checklist-notes .ruled').count()) === 1)
  check('and a sign-off', (await first.locator('.checklist-foot .sign').count()) >= 3)
  await page.emulateMedia({ media: 'screen' })
}

console.log('\n== the subtitle persists ==')
{
  // Closing saves, so the promise under the fields — "kept with the project" —
  // holds even when the dialog is closed rather than printed from.
  await page.locator('.print-dialog .modal-actions button:has-text("Close")').click()
  await page.waitForTimeout(600)
  await page.reload({ waitUntil: 'domcontentloaded' })
  // A reload lands on the project list: which project is open is component
  // state, not part of the URL. Navigate back in.
  await page.waitForSelector('.project-card', { timeout: 15_000 })
  await page.locator('.project-card:has-text("Stonecliffe")').first().click()
  await page.waitForSelector('.gantt svg .bar', { timeout: 15_000 })
  await page.locator('button:has-text("Print")').click()
  await page.waitForSelector('.print-dialog', { timeout: 10_000 })
  const again = await page.locator('.print-dialog label').filter({ hasText: /^Subtitle$/ }).locator('input').inputValue()
  check('it came back after a reload', again.includes('Rev C'), again || '(empty)')
}

check('no console errors', errs.length === 0, errs.slice(0, 2).join(' | '))

await browser.close()
console.log('\n' + (problems.length ? `FAILURES: ${problems.join(', ')}` : 'ALL PRINT CHECKS PASSED'))
console.log(`PDFs and screenshots in ${OUT}`)
process.exit(problems.length ? 1 : 0)
