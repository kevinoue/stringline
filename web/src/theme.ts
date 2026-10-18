/**
 * Light, dark, or whatever the machine is set to.
 *
 * The preference is one of three values, but the *document* only ever carries
 * two: `data-theme` is resolved to `light` or `dark` here, in script, rather
 * than leaving `system` to be handled by a `prefers-color-scheme` media query
 * in CSS.
 *
 * That is a deliberate trade. Resolving in CSS would mean every dark token
 * written twice — once under `[data-theme='dark']` and again inside the media
 * query — and a token added to one copy and not the other is invisible until
 * somebody with the opposite OS setting opens the app. One resolved attribute
 * means one source of truth, and it also makes the theme assertable from a
 * headless browser, which cannot change its OS appearance.
 */

export type ThemeChoice = 'light' | 'dark' | 'system'
export type Resolved = 'light' | 'dark'

const KEY = 'stringline.theme'
const DARK = '(prefers-color-scheme: dark)'

export function storedChoice(): ThemeChoice {
  try {
    const raw = localStorage.getItem(KEY)
    return raw === 'light' || raw === 'dark' || raw === 'system' ? raw : 'system'
  } catch {
    // Private browsing, or storage disabled. Following the machine is the
    // right answer when we cannot remember a preference.
    return 'system'
  }
}

export function systemIsDark(): boolean {
  return typeof matchMedia === 'function' && matchMedia(DARK).matches
}

export function resolve(choice: ThemeChoice): Resolved {
  if (choice === 'system') return systemIsDark() ? 'dark' : 'light'
  return choice
}

/**
 * Put the resolved theme on `<html>`.
 *
 * Also sets `color-scheme` on the element so the browser's own furniture —
 * scrollbars, form controls, the flash of background before paint — matches.
 * Without it a dark page gets light scrollbars, which looks broken in a way
 * that is hard to attribute.
 */
export function apply(choice: ThemeChoice): Resolved {
  const resolved = resolve(choice)
  const root = document.documentElement
  root.dataset.theme = resolved
  root.style.colorScheme = resolved
  return resolved
}

export function remember(choice: ThemeChoice): void {
  try {
    if (choice === 'system') localStorage.removeItem(KEY)
    else localStorage.setItem(KEY, choice)
  } catch {
    // Not worth surfacing: the theme still applied, it just will not persist.
  }
}

/**
 * Re-resolve when the machine's setting changes, but only while following it.
 *
 * Returns an unsubscribe. A no-op where `matchMedia` is missing rather than a
 * throw, because this runs during module init on the login screen.
 */
export function watchSystem(onChange: () => void): () => void {
  if (typeof matchMedia !== 'function') return () => {}
  const mq = matchMedia(DARK)
  mq.addEventListener('change', onChange)
  return () => mq.removeEventListener('change', onChange)
}
