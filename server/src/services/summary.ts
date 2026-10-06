/**
 * The project, in plain language.
 *
 * Everything here is already known — the solver produced it, the baseline diff
 * measured it, `impact.ts` attributed it. The only thing missing was somebody
 * to say it out loud. This assembles that into the paragraph a project manager
 * would otherwise write by hand every Monday morning.
 *
 * Deliberately computed rather than generated. A schedule summary that invents
 * a date is worse than no summary, and every number below is one the engine
 * already stands behind.
 */

import type { PoolClient } from 'pg'
import {
  diffAgainstBaseline,
  explainImpact,
  projectCalendars,
  solve,
  toDayIndex,
  type ImpactDriver,
  type IsoDate,
  type ScheduledTask,
} from '../scheduler/index.js'
import { loadActiveBaseline, loadScheduleInput } from './schedule.js'

export type ProjectPhase = 'not-started' | 'in-flight' | 'complete'
export type ProjectHealth = 'on-track' | 'ahead' | 'behind-baseline' | 'at-risk'

export interface ProjectSummary {
  /** One line, safe to put in a heading. */
  headline: string
  /** The narrative, one string per paragraph. */
  paragraphs: string[]
  facts: {
    phase: ProjectPhase
    health: ProjectHealth
    asOf: IsoDate
    start: IsoDate
    finish: IsoDate
    deadline: IsoDate | null
    deadlineFloat: number | null
    durationWorkingDays: number
    elapsedWorkingDays: number
    tasksTotal: number
    tasksComplete: number
    tasksInProgress: number
    /** Share of the planned work actually finished, 0–100. */
    percentWorkComplete: number
    /** True when `asOf` is past the forecast finish — the schedule is stale. */
    overdue: boolean
    criticalCount: number
    baselineName: string | null
    baselineFinish: IsoDate | null
    varianceDays: number | null
    drivers: ImpactDriver[]
    nextUp: { id: string; name: string; start: IsoDate; isCritical: boolean } | null
    atRisk: Array<{ id: string; name: string; totalFloat: number }>
  }
}

export async function buildSummary(
  client: PoolClient,
  projectId: string,
  asOf: IsoDate,
): Promise<ProjectSummary | null> {
  const input = await loadScheduleInput(client, projectId)
  if (!input.tasks.length) return null

  const nameRow = await client.query<{ name: string }>(
    'SELECT name FROM projects WHERE id = $1',
    [projectId],
  )
  const projectName = nameRow.rows[0]?.name ?? 'This project'

  const result = solve(input)
  const baseline = await loadActiveBaseline(client, projectId)
  const tasks = Object.values(result.tasks)

  const complete = tasks.filter((t) => t.status === 'complete')
  const inProgress = tasks.filter((t) => t.status === 'in-progress')
  const phase: ProjectPhase =
    complete.length === tasks.length
      ? 'complete'
      : complete.length === 0 && inProgress.length === 0
        ? 'not-started'
        : 'in-flight'

  // Elapsed time is measured on the project's own calendar, so a summary never
  // counts weekends as progress.
  const calendar = projectCalendars(input).get(input.defaultCalendarId)!
  const elapsed = Math.max(
    0,
    Math.min(
      result.durationWorkingDays,
      calendar.countWorkingDays(
        calendar.snapForward(toDayIndex(result.projectStart)),
        calendar.snapForward(toDayIndex(asOf)),
      ),
    ),
  )

  // Progress is measured by work finished, not time elapsed. They diverge
  // badly on a neglected schedule, and when they do, saying "100% through"
  // because the calendar moved on is actively misleading.
  const plannedWork = tasks.reduce((sum, t) => sum + t.durationDays, 0)
  const doneWork = tasks.reduce((sum, t) => {
    if (t.status === 'complete') return sum + t.durationDays
    if (t.status === 'in-progress') return sum + Math.max(0, t.durationDays - t.remainingDays)
    return sum
  }, 0)
  const percentWorkComplete =
    plannedWork === 0 ? 0 : Math.round((doneWork / plannedWork) * 100)
  const overdue = asOf > result.projectFinish

  let varianceDays: number | null = null
  let drivers: ImpactDriver[] = []
  if (baseline) {
    const variance = diffAgainstBaseline(baseline, result, input)
    varianceDays = variance.projectFinishVarianceDays
    drivers = explainImpact(variance, input).drivers
  }

  const health: ProjectHealth =
    result.deadlineFloat !== null && result.deadlineFloat < 0
      ? 'at-risk'
      : varianceDays !== null && varianceDays > 0
        ? 'behind-baseline'
        : varianceDays !== null && varianceDays < 0
          ? 'ahead'
          : 'on-track'

  // The next thing to start, which is the question people actually open a
  // schedule to answer.
  const upcoming = tasks
    .filter((t) => t.status === 'not-started' && t.earlyStart >= asOf)
    .sort((a, b) => a.earlyStart.localeCompare(b.earlyStart))
  const nextUp = upcoming[0]
    ? {
        id: upcoming[0].id,
        name: upcoming[0].name,
        start: upcoming[0].earlyStart,
        isCritical: upcoming[0].isCritical,
      }
    : null

  const atRisk = tasks
    .filter((t) => t.totalFloat < 0 && t.status !== 'complete')
    .sort((a, b) => a.totalFloat - b.totalFloat)
    .slice(0, 5)
    .map((t) => ({ id: t.id, name: t.name, totalFloat: t.totalFloat }))

  const facts: ProjectSummary['facts'] = {
    phase,
    health,
    asOf,
    start: result.projectStart,
    finish: result.projectFinish,
    deadline: input.projectDeadline ?? null,
    deadlineFloat: result.deadlineFloat,
    durationWorkingDays: result.durationWorkingDays,
    elapsedWorkingDays: elapsed,
    tasksTotal: tasks.length,
    tasksComplete: complete.length,
    tasksInProgress: inProgress.length,
    percentWorkComplete,
    overdue,
    criticalCount: result.criticalPath.length,
    baselineName: baseline?.name ?? null,
    baselineFinish: baseline?.projectFinish ?? null,
    varianceDays,
    drivers,
    nextUp,
    atRisk,
  }

  return { headline: headlineFor(projectName, facts), paragraphs: narrate(facts, inProgress), facts }
}

// ── Wording ──────────────────────────────────────────────────────────────────

const days = (n: number) => `${n} ${n === 1 ? 'day' : 'days'}`

function headlineFor(name: string, f: ProjectSummary['facts']): string {
  if (f.phase === 'complete') return `${name} is complete.`
  // An unupdated schedule is the first thing to say, because every other
  // number below is suspect until somebody brings it current.
  if (f.overdue) {
    return `${name} has run past its forecast finish of ${f.finish} and needs updating.`
  }
  if (f.health === 'at-risk') {
    return `${name} will miss its deadline by ${days(-f.deadlineFloat!)}.`
  }
  if (f.health === 'behind-baseline') {
    return `${name} is running ${days(f.varianceDays!)} behind plan.`
  }
  if (f.health === 'ahead') {
    return `${name} is ${days(-f.varianceDays!)} ahead of plan.`
  }
  if (f.phase === 'not-started') return `${name} has not started yet.`
  return `${name} is on schedule.`
}

function narrate(f: ProjectSummary['facts'], inProgress: ScheduledTask[]): string[] {
  const out: string[] = []

  // 1. Where it runs, and how far through it is.
  if (f.phase === 'not-started') {
    out.push(
      `Planned to run from ${f.start} to ${f.finish} — ${days(f.durationWorkingDays)} of work ` +
        `across ${f.tasksTotal} tasks. Nothing has been started yet.`,
    )
  } else if (f.phase === 'complete') {
    out.push(`All ${f.tasksTotal} tasks are complete. The project ran from ${f.start} to ${f.finish}.`)
  } else {
    const working =
      inProgress.length === 0
        ? 'nothing is under way'
        : inProgress.length === 1
          ? `${inProgress[0]!.name} is under way`
          : `${inProgress.length} tasks are under way`

    if (f.overdue) {
      out.push(
        `The schedule forecasts finishing ${f.finish}, which is already behind us as of ` +
          `${f.asOf}. Only ${f.percentWorkComplete}% of the work is recorded as done ` +
          `(${f.tasksComplete} of ${f.tasksTotal} tasks), so these dates are out of date — ` +
          `update progress to get a real forecast.`,
      )
    } else {
      const elapsedPct = Math.round((f.elapsedWorkingDays / Math.max(1, f.durationWorkingDays)) * 100)
      out.push(
        `As of ${f.asOf}, ${f.percentWorkComplete}% of the work is done — ${f.tasksComplete} of ` +
          `${f.tasksTotal} tasks complete and ${working}. That is against ${elapsedPct}% of the ` +
          `schedule elapsed, day ${f.elapsedWorkingDays} of ${f.durationWorkingDays}, ` +
          `finishing ${f.finish}.`,
      )
    }
  }

  // 2. How that compares to the promise, which is the part people act on.
  if (f.deadline) {
    out.push(
      f.deadlineFloat! < 0
        ? `The deadline is ${f.deadline}, so the current forecast overruns it by ` +
          `${days(-f.deadlineFloat!)}.`
        : `The deadline is ${f.deadline}, leaving ${days(f.deadlineFloat!)} of room.`,
    )
  }

  // 3. Movement against the plan of record, and what caused it.
  if (f.varianceDays !== null && f.baselineName) {
    if (f.varianceDays === 0) {
      out.push(`The finish date is unchanged from the ${f.baselineName.toLowerCase()}.`)
    } else {
      const direction = f.varianceDays > 0 ? 'later than' : 'earlier than'
      let text =
        `Completion has moved ${days(Math.abs(f.varianceDays))} ${direction} the ` +
        `${f.baselineName.toLowerCase()} of ${f.baselineFinish}.`
      if (f.drivers.length > 0) {
        const named = f.drivers
          .slice(0, 2)
          .map((d) => `${d.name} (${days(d.ownSlipDays)})`)
          .join(' and ')
        const extra = f.drivers.length - 2
        const more = extra > 0 ? `, plus ${extra} other ${extra === 1 ? 'task' : 'tasks'}` : ''
        text += ` The cause is ${named}${more}.`
      }
      out.push(text)
    }
  }

  // 4. What happens next, and what to watch.
  const bits: string[] = []
  if (f.nextUp) {
    bits.push(
      `Next to start is ${f.nextUp.name} on ${f.nextUp.start}` +
        (f.nextUp.isCritical ? ', which is on the critical path' : ''),
    )
  }
  if (f.criticalCount > 0) {
    bits.push(
      `${f.criticalCount} of ${f.tasksTotal} tasks drive the completion date — ` +
        `slipping any of them slips the finish`,
    )
  }
  if (bits.length) out.push(bits.join('. ') + '.')

  return out
}
