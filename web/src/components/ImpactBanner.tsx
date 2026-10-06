import type { Impact } from '../api/types.js'

interface Props {
  impact: Impact | null
  finishMovedDays: number
  onDismiss(): void
}

/**
 * The sentence, front and centre.
 *
 * A tool that says "saved" teaches people that saving is the point. A tool that
 * says "that cost you four days, and here is why" teaches them the schedule is
 * real. The banner is deliberately loud when the date moves and quiet when it
 * does not.
 */
export function ImpactBanner({ impact, finishMovedDays, onDismiss }: Props) {
  if (!impact && finishMovedDays === 0) return null

  const tone = finishMovedDays > 0 ? 'bad' : finishMovedDays < 0 ? 'good' : 'neutral'
  const text =
    impact?.summary ??
    (finishMovedDays > 0
      ? `Completion moved ${finishMovedDays} ${finishMovedDays === 1 ? 'day' : 'days'} later.`
      : `Completion pulled in ${-finishMovedDays} ${finishMovedDays === -1 ? 'day' : 'days'}.`)

  return (
    <div className={`impact impact-${tone}`} role="status">
      <span className="impact-text">{text}</span>
      {!impact && (
        <span className="impact-hint">
          Capture a baseline to see what caused it.
        </span>
      )}
      <button className="impact-close" onClick={onDismiss} aria-label="Dismiss">
        ×
      </button>
    </div>
  )
}
