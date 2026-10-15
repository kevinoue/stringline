/**
 * The category palette — a copy of `server/src/services/palette.ts`.
 *
 * Duplicated rather than imported because there is no build step joining the
 * two packages. Keep them identical: a divergence shows up as a colour that is
 * right on the chart and wrong in the database, which is a confusing thing to
 * debug. The server is the authority on which keys are valid.
 *
 *
 * A fixed set of keys rather than free hex values. Three reasons, in order of
 * how often they bite:
 *
 *   1. **Red is reserved.** The chart has one rule — critical is the only
 *      saturated colour — and that rule is what makes the critical path
 *      findable at a glance. A user-chosen red for "Fire systems" would
 *      quietly destroy it, and nobody would connect the two.
 *   2. **Print.** These are chosen to stay distinguishable on paper, where a
 *      screen-tuned palette collapses into similar greys.
 *   3. **Colour vision.** Roughly 8% of men cannot separate red from green.
 *      A free colour picker produces palettes that are unreadable to them;
 *      this one is ordered so the first choices stay distinct.
 *
 * Hues are muted on purpose. These sit behind the work, not in front of it.
 */

export interface PaletteEntry {
  key: string
  label: string
  /** Bar fill. */
  hex: string
  /** The darker edge stripe, which has to read at two pixels wide. */
  stripe: string
}

export const PALETTE: PaletteEntry[] = [
  { key: 'slate', label: 'Slate', hex: '#6b8aa8', stripe: '#3f5a74' },
  { key: 'teal', label: 'Teal', hex: '#4f9a93', stripe: '#2b6660' },
  { key: 'amber', label: 'Amber', hex: '#c68c3e', stripe: '#8a5c1c' },
  { key: 'violet', label: 'Violet', hex: '#8878b8', stripe: '#574a86' },
  { key: 'moss', label: 'Moss', hex: '#6f9152', stripe: '#465f31' },
  { key: 'clay', label: 'Clay', hex: '#a9735c', stripe: '#734635' },
  { key: 'indigo', label: 'Indigo', hex: '#5a6fa8', stripe: '#334473' },
  { key: 'plum', label: 'Plum', hex: '#9c6686', stripe: '#6a3e58' },
  { key: 'olive', label: 'Olive', hex: '#8a8a4a', stripe: '#5b5b2a' },
  { key: 'steel', label: 'Steel', hex: '#7c8894', stripe: '#4e5a66' },
]

export const PALETTE_KEYS = PALETTE.map((p) => p.key)

export function isPaletteKey(value: unknown): boolean {
  return typeof value === 'string' && PALETTE_KEYS.includes(value)
}

/**
 * The next colour that is not already taken.
 *
 * Assigning them in order means a company's first few categories are the most
 * distinguishable ones, and nobody has to think about colour to get a usable
 * chart. Falls back to cycling once the palette is exhausted — ten distinct
 * trades on one chart is already past what anyone can read.
 */
export function nextColour(taken: string[]): string {
  const unused = PALETTE_KEYS.find((key) => !taken.includes(key))
  return unused ?? PALETTE_KEYS[taken.length % PALETTE_KEYS.length]!
}
