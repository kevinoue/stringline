import type { ProjectSummary } from '../api/types.js'

interface Props {
  summary: ProjectSummary | null
  open: boolean
  onToggle(): void
}

const HEALTH_LABEL: Record<ProjectSummary['facts']['health'], string> = {
  'on-track': 'On track',
  ahead: 'Ahead',
  'behind-baseline': 'Behind plan',
  'at-risk': 'At risk',
}

/**
 * The project stated in words, recomputed on every load.
 *
 * It sits above the chart because it answers the question people actually
 * arrive with — "where are we?" — which a wall of bars does not. Every figure
 * in it comes from the solver; nothing here is written by hand or guessed.
 */
export function SummaryPanel({ summary, open, onToggle }: Props) {
  if (!summary) return null
  const f = summary.facts
  const pct = Math.round((f.elapsedWorkingDays / Math.max(1, f.durationWorkingDays)) * 100)

  return (
    <section className={`summary health-${f.health}`}>
      <header onClick={onToggle} role="button" tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && onToggle()}>
        <span className={`health-dot health-${f.health}`} aria-hidden />
        <h2>{summary.headline}</h2>
        <span className="health-label">{HEALTH_LABEL[f.health]}</span>
        <span className="summary-toggle" aria-hidden>{open ? '▾' : '▸'}</span>
      </header>

      {open && (
        <div className="summary-body">
          <div className="summary-prose">
            {summary.paragraphs.map((p, i) => (
              <p key={i}>{p}</p>
            ))}
          </div>

          <div className="summary-stats">
            <div className="progress" title={`${pct}% of the schedule elapsed`}>
              <div className="progress-fill" style={{ width: `${Math.min(100, pct)}%` }} />
            </div>
            <dl>
              <div>
                <dt>Started</dt>
                <dd>{f.start}</dd>
              </div>
              <div>
                <dt>Forecast finish</dt>
                <dd>{f.finish}</dd>
              </div>
              {f.deadline && (
                <div>
                  <dt>Deadline</dt>
                  <dd className={(f.deadlineFloat ?? 0) < 0 ? 'negative' : ''}>
                    {f.deadline}
                    {f.deadlineFloat !== null && (
                      <span className="sub">
                        {f.deadlineFloat < 0 ? ` ${-f.deadlineFloat}d over` : ` ${f.deadlineFloat}d spare`}
                      </span>
                    )}
                  </dd>
                </div>
              )}
              <div>
                <dt>Tasks done</dt>
                <dd>
                  {f.tasksComplete} / {f.tasksTotal}
                  {f.tasksInProgress > 0 && <span className="sub"> · {f.tasksInProgress} under way</span>}
                </dd>
              </div>
              {f.varianceDays !== null && (
                <div>
                  <dt>Against baseline</dt>
                  <dd className={f.varianceDays > 0 ? 'negative' : ''}>
                    {f.varianceDays === 0
                      ? 'unchanged'
                      : f.varianceDays > 0
                        ? `${f.varianceDays}d later`
                        : `${-f.varianceDays}d earlier`}
                  </dd>
                </div>
              )}
              {f.nextUp && (
                <div>
                  <dt>Next up</dt>
                  <dd>
                    {f.nextUp.name}
                    <span className="sub"> · {f.nextUp.start}</span>
                  </dd>
                </div>
              )}
            </dl>
          </div>
        </div>
      )}
    </section>
  )
}
