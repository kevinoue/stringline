import type { Category, Dependency, Phase, Schedule, ScheduledTask, Step, TaskDetail } from '../api/types.js'
import { geometryFor, type Orientation, type PaperSize } from './paper.js'

/**
 * A short, human-quotable reference for a task.
 *
 * The sheet comes back with pen on it and somebody types the results in. Ten
 * buildings each have a step called "Drain the water lines and blow out at no
 * more than 50 PSI", and "Winterize" versus "Winterise" is exactly the sort of
 * difference that turns five minutes of data entry into twenty. A code on the
 * page removes the matching problem entirely.
 *
 * Derived from the id rather than stored, so it needs no schema and cannot
 * drift. Four hex characters is one collision in roughly 65,000 within a
 * single project, and the project name is on the sheet too.
 */
export function taskRef(taskId: string): string {
  return `T-${taskId.replace(/-/g, '').slice(0, 4).toUpperCase()}`
}

/**
 * Printed checklists — one task per page, to be carried, marked up and handed
 * back.
 *
 * A different document from the Gantt, not a variant of it. The chart answers
 * "when does this happen and what does it hold up"; this answers "what am I
 * doing today and what do I write down". Trying to serve both from one layout
 * produces something that does neither.
 *
 * Deliberately low-ink and high-contrast: these get photocopied, folded into a
 * pocket, and filled in with a biro in a plant room.
 */
export function Checklist({
  tasks,
  stepsByTask,
  details,
  schedule,
  dependencies,
  phases,
  categories,
  categoryOf,
  projectTitle,
  subtitle,
  paper,
  orientation,
}: {
  tasks: ScheduledTask[]
  stepsByTask: Map<string, Step[]>
  details: Record<string, TaskDetail>
  schedule: Schedule
  dependencies: Dependency[]
  phases: Phase[]
  categories: Category[]
  categoryOf: Map<string, string>
  projectTitle: string
  subtitle: string
  paper: PaperSize
  orientation: Orientation
}) {
  const geometry = geometryFor(paper, orientation)
  const phaseName = new Map(phases.map((p) => [p.id, p.name]))
  const categoryName = new Map(categories.map((c) => [c.id, c.name]))
  const byId = new Map(Object.values(schedule.tasks).map((t) => [t.id, t]))
  const printedOn = new Date().toISOString().slice(0, 10)

  return (
    <div className="print-root">
      {tasks.map((task, index) => {
        const steps = stepsByTask.get(task.id) ?? []
        const detail = details[task.id]

        /*
         * What this task is waiting on.
         *
         * A crew holding this sheet needs to know they cannot start until
         * somebody else has finished — that is the single most useful line on
         * the page, and the one thing a checklist usually leaves out.
         */
        const waitingOn = dependencies
          .filter((d) => d.successorId === task.id)
          .map((d) => byId.get(d.predecessorId))
          .filter((t): t is ScheduledTask => Boolean(t))

        return (
          <section
            key={task.id}
            className="print-page checklist-page"
            style={{ width: geometry.contentWidth, height: geometry.contentHeight }}
            data-task={task.id}
          >
            <header className="checklist-head">
              <div>
                <p className="checklist-project">{projectTitle}</p>
                <h1>{task.name}</h1>
                <p className="checklist-meta">
                  {detail?.categoryId && categoryName.get(detail.categoryId) && (
                    <strong>{categoryName.get(detail.categoryId)}</strong>
                  )}
                  {detail?.phaseId && phaseName.get(detail.phaseId) && (
                    <> · {phaseName.get(detail.phaseId)}</>
                  )}
                  {subtitle && <> · {subtitle}</>}
                </p>
              </div>
              <dl className="checklist-ref">
                <div>
                  <dt>Reference</dt>
                  <dd className="ref-code">{taskRef(task.id)}</dd>
                </div>
                <div>
                  <dt>Planned</dt>
                  <dd>
                    {task.earlyStart} → {task.earlyFinish}
                  </dd>
                </div>
                <div>
                  <dt>Sheet</dt>
                  <dd>
                    {index + 1} of {tasks.length}
                  </dd>
                </div>
              </dl>
            </header>

            {waitingOn.length > 0 && (
              <p className="checklist-waiting">
                <strong>Cannot start until:</strong>{' '}
                {waitingOn
                  .map((w) => {
                    const owner = categoryName.get(categoryOf.get(w.id) ?? '')
                    return `${w.name}${owner ? ` (${owner})` : ''} — due ${w.earlyFinish}`
                  })
                  .join(' · ')}
              </p>
            )}

            <table className="checklist-table">
              <thead>
                <tr>
                  <th className="col-tick">Done</th>
                  <th className="col-step">Step</th>
                  <th className="col-plan">Planned</th>
                  <th className="col-actual">Date done</th>
                  <th className="col-initials">Initials</th>
                </tr>
              </thead>
              <tbody>
                {steps.length === 0 ? (
                  <tr>
                    <td className="col-tick">☐</td>
                    {/* A task with no steps is still worth a sheet — it just
                        has one line to sign off. */}
                    <td className="col-step">{task.name}</td>
                    <td className="col-plan">
                      {task.earlyStart} → {task.earlyFinish}
                    </td>
                    <td className="col-actual" />
                    <td className="col-initials" />
                  </tr>
                ) : (
                  steps.map((step) => (
                    <tr key={step.id} className={step.isCheck ? 'is-check' : ''}>
                      <td className="col-tick">☐</td>
                      <td className="col-step">{step.name}</td>
                      <td className="col-plan">
                        {step.isCheck
                          ? '—'
                          : step.start === step.finish
                            ? step.start
                            : `${step.start} → ${step.finish}`}
                      </td>
                      <td className="col-actual" />
                      <td className="col-initials" />
                    </tr>
                  ))
                )}
              </tbody>
            </table>

            {/* Defects are the thing a closedown actually produces, and a
                checklist with nowhere to write them gets them written on the
                back, or not at all. */}
            <div className="checklist-notes">
              <p className="checklist-label">Defects, damage and anything that needs ordering</p>
              {/* One ruled block that stretches, rather than a fixed count of
                  lines. The space left over varies with how many steps a task
                  has, and dead paper above the signature block is wasted
                  writing room. */}
              <div className="ruled" />
            </div>

            <footer className="checklist-foot">
              <div className="sign">
                <span className="checklist-label">Completed by</span>
                <div className="rule" />
              </div>
              <div className="sign">
                <span className="checklist-label">Date</span>
                <div className="rule" />
              </div>
              <div className="sign wide">
                <span className="checklist-label">Checked by</span>
                <div className="rule" />
              </div>
              <p className="checklist-return">
                Return this sheet so the schedule can be updated · printed {printedOn}
              </p>
            </footer>
          </section>
        )
      })}
    </div>
  )
}
