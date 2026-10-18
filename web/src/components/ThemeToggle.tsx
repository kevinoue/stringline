import { useEffect, useState } from 'react'
import { apply, remember, storedChoice, watchSystem, type ThemeChoice } from '../theme.js'

const NEXT: Record<ThemeChoice, ThemeChoice> = {
  system: 'light',
  light: 'dark',
  dark: 'system',
}

const FACE: Record<ThemeChoice, { glyph: string; name: string }> = {
  system: { glyph: '◐', name: 'Match the system' },
  light: { glyph: '☀', name: 'Light' },
  dark: { glyph: '☾', name: 'Dark' },
}

/**
 * Light / dark / follow-the-system, as one button that cycles.
 *
 * A cycling button rather than three, because the toolbar already wraps to a
 * second row on a laptop and this is the least important control on it. The
 * `title` names what the *next* press does, which is the part a cycling
 * control hides; the accessible name states where it is now.
 *
 * "Match the system" is the default and the third state rather than being
 * implied by the absence of a choice — somebody who has deliberately picked
 * light needs a way back to automatic that is not "clear your site data".
 */
export function ThemeToggle() {
  const [choice, setChoice] = useState<ThemeChoice>(storedChoice)

  // While following the machine, a change to its appearance has to land
  // immediately — the usual case being an OS that switches at sunset with the
  // app left open.
  useEffect(() => {
    if (choice !== 'system') return
    return watchSystem(() => apply('system'))
  }, [choice])

  const face = FACE[choice]
  const next = NEXT[choice]

  return (
    <button
      className="theme-toggle"
      aria-label={`Theme: ${face.name}`}
      title={`Theme: ${face.name} — click for ${FACE[next].name.toLowerCase()}`}
      onClick={() => {
        setChoice(next)
        remember(next)
        apply(next)
      }}
    >
      <span aria-hidden="true">{face.glyph}</span>
    </button>
  )
}
