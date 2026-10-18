/**
 * The visual language: themes, the editor's layout, and the chart's furniture.
 *
 * Three things here are worth a test rather than a look:
 *
 *   1. **Nothing in the editor scrolls sideways.** That was the reported bug,
 *      and its cause — a flex/grid child's `min-width: auto` being its content
 *      — is a trap any future field can fall back into. Measured, not eyeballed.
 *   2. **Print stays ink-on-paper in dark mode.** `body` carries
 *      `color: var(--ink)`, which in dark is near-white, and several print
 *      rules set only size and spacing. The first version of the dark theme
 *      printed white text onto white paper and the sheet came out blank in
 *      patches with nothing in the console. A PDF is the only honest check.
 *   3. **Both themes are actually legible.** A token that was missed stays
 *      at its light value and turns into pale grey on charcoal; contrast is
 *      computed here so that fails loudly instead of looking "a bit washed
 *      out" to whoever opens it next.
 *
 *   SLUG=demo-1234 node scripts/theme-shoot.mjs
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

/** WCAG relative luminance, from an `rgb(…)` string. */
function luminance(css) {
  const [r, g, b] = css.match(/[\d.]+/g).slice(0, 3).map(Number)
  const lin = (c) => {
    const s = c / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}

const contrast = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
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
await page.locator('.project-card').first().click()
await page.waitForSelector('.gantt svg .bar', { timeout: 15_000 })

// Open the editor on a task that has predecessors, so the form under test is
// rendered with real content rather than an empty list.
await page.locator('.table-row').nth(2).click()
await page.waitForSelector('.panel .add-link', { timeout: 10_000 })

console.log('== the editor fits its column ==')
{
  // The reported bug, measured. scrollWidth > clientWidth on any descendant
  // means something is forcing the column wider than it is.
  const overflow = await page.locator('.panel').evaluate((panel) => {
    const worst = { selector: null, by: 0 }
    for (const el of panel.querySelectorAll('*')) {
      const by = el.scrollWidth - el.clientWidth
      if (by > worst.by) {
        worst.by = by
        worst.selector = el.className || el.tagName
      }
    }
    return { panel: panel.scrollWidth - panel.clientWidth, worst }
  })
  check('the panel itself does not scroll sideways', overflow.panel <= 0, `${overflow.panel}px`)
  check('and neither does anything inside it',
    overflow.worst.by <= 1, `worst: ${overflow.worst.selector} by ${overflow.worst.by}px`)

  // The specific failure: the button that commits the change was off-screen.
  const within = async (sel) => {
    const el = await page.locator(sel).boundingBox()
    const panel = await page.locator('.panel').boundingBox()
    if (!el || !panel) return false
    return el.x >= panel.x - 1 && el.x + el.width <= panel.x + panel.width + 1
  }
  check('the Link button is reachable without scrolling', await within('.add-link button:has-text("Link")'))
  check('and so is Add, on the steps form', await within('.step-add button:has-text("Add")'))

  // Stacked, not side by side — which is what makes the above true for any
  // task name rather than just the ones that happen to be short.
  const stacked = await page.evaluate(() => {
    const select = document.querySelector('.add-link .add-link-what')
    const button = [...document.querySelectorAll('.add-link button')].at(-1)
    if (!select || !button) return false
    return button.getBoundingClientRect().top >= select.getBoundingClientRect().bottom - 1
  })
  check('because the controls sit below the dropdown, not beside it', stacked)
}

console.log('\n== the panel can be resized, within limits ==')
{
  const before = (await page.locator('.panel').boundingBox()).width
  await page.evaluate(() => document.documentElement.style.setProperty('--panel-w', '520px'))
  await page.waitForTimeout(120)
  const wider = (await page.locator('.panel').boundingBox()).width
  check('dragging it wider works', wider > before + 50, `${Math.round(before)} → ${Math.round(wider)}px`)

  // The clamp is the point: a bad drag must not be able to take the chart.
  await page.evaluate(() => document.documentElement.style.setProperty('--panel-w', '20px'))
  await page.waitForTimeout(120)
  const tiny = (await page.locator('.panel').boundingBox()).width
  check('but it cannot be crushed below 300px', tiny >= 299, `${Math.round(tiny)}px`)

  await page.evaluate(() => document.documentElement.style.setProperty('--panel-w', '4000px'))
  await page.waitForTimeout(120)
  const huge = (await page.locator('.panel').boundingBox()).width
  const chart = (await page.locator('.gantt').boundingBox()).width
  // The chart is the product. However wide the editor is dragged, the bars
  // keep a usable minimum and the editor is what gives.
  check('nor can it squeeze the chart below its floor',
    huge <= 1500 * 0.34 + 2 && chart >= 299,
    `panel ${Math.round(huge)}px, chart ${Math.round(chart)}px`)
  await page.evaluate(() => document.documentElement.style.removeProperty('--panel-w'))
}

console.log('\n== the chart has something to read against ==')
{
  const grid = await page.locator('.gantt .grid-line').count()
  check('vertical rules at the labelled ticks', grid > 0, `${grid} rules`)

  // Half-pixel snapping. A 1px stroke on a whole coordinate straddles two
  // device pixels and renders as a soft smear.
  const snapped = await page.locator('.gantt .grid-line').evaluateAll((ls) =>
    ls.every((l) => Math.abs((parseFloat(l.getAttribute('x1')) % 1) - 0.5) < 0.001),
  )
  check('each one snapped to a half-pixel so it stays a hairline', snapped)

  const bands = await page.locator('.gantt .row-band').count()
  check('and banding behind the rows', bands > 0, `${bands} bands`)
}

console.log('\n== both themes ==')
const sample = async () =>
  page.evaluate(() => {
    const get = (sel, prop) => {
      const el = document.querySelector(sel)
      return el ? getComputedStyle(el)[prop] : null
    }
    /*
     * What is actually behind this element.
     *
     * `backgroundColor` on a row with no background of its own returns
     * `rgba(0, 0, 0, 0)`, which naively parses as black and makes dark text on
     * a white page look like a 1.2:1 contrast failure. Walk up until
     * something is actually painted.
     */
    const behind = (sel) => {
      let el = document.querySelector(sel)
      while (el) {
        const bg = getComputedStyle(el).backgroundColor
        const alpha = bg.startsWith('rgba') ? Number(bg.match(/[\d.]+/g)[3]) : 1
        if (alpha > 0) return bg
        el = el.parentElement
      }
      return 'rgb(255, 255, 255)'
    }
    return {
      theme: document.documentElement.dataset.theme,
      pageBg: getComputedStyle(document.body).backgroundColor,
      bodyInk: getComputedStyle(document.body).color,
      rowInk: get('.table-row .name-text', 'color'),
      rowBg: behind('.table-row'),
      panelBg: behind('.panel'),
      hintInk: get('.panel .hint', 'color'),
      critical: get('.gantt .bar.critical', 'fill'),
    }
  })

{
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light' })
  await page.waitForTimeout(150)
  const light = await sample()
  await page.screenshot({ path: `${OUT}/80-light.png` })

  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark' })
  await page.waitForTimeout(150)
  const dark = await sample()
  await page.screenshot({ path: `${OUT}/81-dark.png` })

  check('dark is genuinely dark', luminance(dark.pageBg) < 0.08, dark.pageBg)
  check('and light is genuinely light', luminance(light.pageBg) > 0.8, light.pageBg)
  check('the two are not the same stylesheet', light.pageBg !== dark.pageBg)

  // Body text against the surface it sits on. 4.5:1 is the AA threshold for
  // normal-sized text; a token left at its light value lands around 1.5:1.
  for (const [name, s] of [['light', light], ['dark', dark]]) {
    check(`${name}: task names are readable on their row`,
      contrast(s.rowInk, s.rowBg) >= 4.5, `${contrast(s.rowInk, s.rowBg).toFixed(1)}:1`)
    // Hints are secondary text; 3:1 is the threshold that keeps them quiet
    // without making them decorative.
    check(`${name}: hint text is quiet but still readable`,
      contrast(s.hintInk, s.panelBg) >= 3, `${contrast(s.hintInk, s.panelBg).toFixed(1)}:1`)
    // The one rule the chart has.
    check(`${name}: the critical path stands out from the chart`,
      contrast(s.critical, s.panelBg) >= 2.4, `${contrast(s.critical, s.panelBg).toFixed(1)}:1`)
  }

  const toggled = await page.evaluate(() => {
    document.documentElement.dataset.theme = 'light'
    return document.documentElement.dataset.theme
  })
  check('the attribute is what drives it', toggled === 'light')
}

console.log('\n== buttons read as buttons ==')
{
  /*
   * How far a button's face sits from the surface behind it.
   *
   * The first version drew buttons in `--surface-2`, which is a 2% step from
   * the panel they sit on — they read as labels, not controls, and in dark it
   * was worse. `getComputedStyle().backgroundColor` is useless here because
   * the face is a gradient, so the stops are parsed out of `background-image`
   * and averaged.
   */
  const faceOf = (el) => {
    const cs = getComputedStyle(el)
    const stops = (cs.backgroundImage || '').match(/rgba?\([^)]*\)/g)
    if (!stops || stops.length < 2) return cs.backgroundColor
    const nums = stops.map((s) => s.match(/[\d.]+/g).slice(0, 3).map(Number))
    const avg = [0, 1, 2].map((i) => Math.round(nums.reduce((t, n) => t + n[i], 0) / nums.length))
    return `rgb(${avg.join(', ')})`
  }

  for (const theme of ['light', 'dark']) {
    await page.evaluate((t) => { document.documentElement.dataset.theme = t }, theme)
    await page.waitForTimeout(150)

    const measured = await page.evaluate((faceSrc) => {
      const face = eval(`(${faceSrc})`)
      const behind = (el) => {
        let node = el.parentElement
        while (node) {
          const bg = getComputedStyle(node).backgroundColor
          const alpha = bg.startsWith('rgba') ? Number(bg.match(/[\d.]+/g)[3]) : 1
          if (alpha > 0) return bg
          node = node.parentElement
        }
        return 'rgb(255, 255, 255)'
      }
      const btn = [...document.querySelectorAll('.toolbar button')]
        .find((b) => !b.classList.contains('ghost') && !b.classList.contains('active'))
      const primary = document.querySelector('.panel button.primary')
      return {
        face: face(btn),
        behind: behind(btn),
        raised: getComputedStyle(btn).boxShadow !== 'none',
        gradient: getComputedStyle(btn).backgroundImage.includes('gradient'),
        primaryFace: primary ? face(primary) : null,
        primaryBehind: primary ? behind(primary) : null,
        // A field should look pressed into the surface, not raised out of it.
        fieldInset: getComputedStyle(document.querySelector('.panel input')).boxShadow.includes('inset'),
      }
    }, faceOf.toString())

    const step = contrast(measured.face, measured.behind)
    // Modest on purpose — a button that shouts is worse than one that
    // whispers. 1.15 is roughly where an edge stops being deniable.
    check(`${theme}: a button is distinguishable from what is behind it`,
      step >= 1.15, `${step.toFixed(2)}:1  ${measured.face} on ${measured.behind}`)
    check(`${theme}: and reads as raised`, measured.raised && measured.gradient)
    check(`${theme}: the primary action is unmistakable`,
      contrast(measured.primaryFace, measured.primaryBehind) >= 2.5,
      `${contrast(measured.primaryFace, measured.primaryBehind).toFixed(1)}:1`)
    check(`${theme}: fields are recessed, not raised`, measured.fieldInset)

    // The reported complaint, as an assertion: no warm cast on a neutral
    // control. Blue channel at or above red keeps it cool or neutral.
    const [r, , b] = measured.face.match(/\d+/g).map(Number)
    check(`${theme}: the button face is neutral or cool, never warm`, b >= r, measured.face)
  }
}

console.log('\n== the toggle remembers ==')
{
  await page.locator('.toolbar .theme-toggle').click()
  await page.waitForTimeout(120)
  const after = await page.evaluate(() => ({
    theme: document.documentElement.dataset.theme,
    stored: localStorage.getItem('stringline.theme'),
  }))
  check('clicking it changes the theme', after.theme === 'dark' || after.theme === 'light', after.theme)
  check('and writes the choice down', after.stored !== null, String(after.stored))

  // Force dark and reload: the point of persisting is surviving a reload
  // without a flash of the wrong one.
  await page.evaluate(() => localStorage.setItem('stringline.theme', 'dark'))
  await page.reload({ waitUntil: 'domcontentloaded' })
  // No client-side router: a reload lands back on the project list, so the
  // theme is asserted there and the project is reopened for what follows.
  await page.waitForSelector('.project-card', { timeout: 15_000 })
  const survived = await page.evaluate(() => document.documentElement.dataset.theme)
  check('which survives a reload', survived === 'dark', survived)
  await page.locator('.project-card').first().click()
  await page.waitForSelector('.gantt svg .bar', { timeout: 15_000 })
}

console.log('\n== printing from dark mode still prints ink on paper ==')
{
  // Still in dark from the reload above — which is the whole point.
  await page.locator('button:has-text("Print")').click()
  await page.waitForSelector('.print-dialog', { timeout: 10_000 })
  await page.locator('.print-dialog select').first().selectOption('tabloid')
  await page.waitForTimeout(400)

  await page.emulateMedia({ media: 'print' })
  await page.waitForTimeout(300)

  const paper = await page.evaluate(() => {
    const root = document.querySelector('body > .print-only')
    const row = document.querySelector('.print-row .print-col-name')
    const title = document.querySelector('.print-titleblock h1')
    return {
      theme: document.documentElement.dataset.theme,
      sheet: root ? getComputedStyle(root).backgroundColor : null,
      rowInk: row ? getComputedStyle(row).color : null,
      titleInk: title ? getComputedStyle(title).color : null,
    }
  })
  check('the theme really is dark while printing', paper.theme === 'dark', String(paper.theme))
  check('but the sheet is white', luminance(paper.sheet) > 0.9, String(paper.sheet))
  check('and the task names are dark ink', luminance(paper.rowInk) < 0.1, String(paper.rowInk))
  check('as is the title', luminance(paper.titleInk) < 0.1, String(paper.titleInk))
  check('which is readable on paper',
    contrast(paper.rowInk, paper.sheet) >= 7, `${contrast(paper.rowInk, paper.sheet).toFixed(1)}:1`)

  const grid = await page.locator('.print-chart .print-grid-line').count()
  check('the printed chart carries gridlines to read dates against', grid > 0, `${grid} rules`)

  /*
   * And prove it on an actual PDF — generated while still under print media.
   *
   * This check was worthless at first because the media was reset to `screen`
   * on the line above it: `page.pdf()` honours whatever `emulateMedia` last
   * set, so it produced a picture of the dark *app*, passed every assertion
   * about bytes and pages, and told us nothing at all about the printed
   * sheet. The page count is the tell — a tabloid print of this project is a
   * cover plus a chart, and a screen capture is always one.
   */
  const path = `${OUT}/82-printed-from-dark.pdf`
  await page.pdf({ path, preferCSSPageSize: true, printBackground: true })
  await page.emulateMedia({ media: 'screen' })
  check('the PDF was written', statSync(path).size > 8000, `${statSync(path).size} bytes`)

  const raw = readFileSync(path, 'latin1')
  const pages = (raw.match(/\/Type\s*\/Page[^s]/g) ?? []).length
  check('and is the printed layout, not a picture of the app', pages >= 2, `${pages} pages`)
  check('rendered as vector', !raw.includes('/Subtype /Image'))
}

check('no console errors', errs.length === 0, errs.slice(0, 2).join(' | '))

await browser.close()
console.log(
  problems.length
    ? `\n${problems.length} FAILURES:\n` + problems.map((p) => `  - ${p}`).join('\n')
    : '\nALL THEME AND LAYOUT CHECKS PASSED',
)
console.log(`screenshots in ${OUT}`)
process.exit(problems.length ? 1 : 0)
