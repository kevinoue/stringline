/**
 * Turning solver output into the sentence a foreman actually reads.
 *
 * A CPM engine can tell you that task 47 has -3 days of float. Nobody acts on
 * that. What people act on is "the handover moved to the 14th because the
 * permit inspection slipped three days." This module is the translation layer,
 * and it is the difference between a schedule that gets checked and one that
 * gets ignored.
 *
 * The interesting problem is attribution. When a task slips, every downstream
 * task slips with it, so a naive report blames twenty tasks for one event. The
 * fix is to separate a task's *own* slip from the slip it merely inherited:
 *
 *     ownSlip(t) = finishVariance(t) − max(finishVariance(predecessors of t))
 *
 * Only tasks with a positive own slip are causes. Everything else is a symptom.
 */

import { DependencyGraph } from './graph.js'
import type { ScheduleVariance, TaskVariance } from './baseline.js'
import type { IsoDate, ScheduleInput, TaskStatus } from './types.js'

export interface ImpactDriver {
  taskId: string
  name: string
  /** Slip this task caused itself, in working days, net of what it inherited. */
  ownSlipDays: number
  /** Total slip observed on this task, including what it inherited. */
  totalSlipDays: number
  isCritical: boolean
  status: TaskStatus | null
}

export interface ImpactExplanation {
  /** Positive means the project finishes later than baselined. */
  projectMovedDays: number
  currentFinish: IsoDate
  baselineFinish: IsoDate
  /** One sentence stating what happened to the completion date. */
  headline: string
  /** One sentence naming the cause, or empty when nothing moved. */
  cause: string
  /** Root causes, largest own slip first. */
  drivers: ImpactDriver[]
  /** The whole thing, ready to render as a banner. */
  summary: string
}

export function explainImpact(
  variance: ScheduleVariance,
  input: ScheduleInput,
): ImpactExplanation {
  const graph = new DependencyGraph(input.tasks, input.dependencies)
  const byId = new Map(variance.changed.map((t) => [t.taskId, t]))

  const drivers: ImpactDriver[] = []
  for (const task of variance.slipped) {
    if (task.isRemoved) continue

    let inherited = 0
    for (const edge of graph.incoming.get(task.taskId) ?? []) {
      const pred = byId.get(edge.predecessorId)
      if (pred && pred.finishVarianceDays > inherited) inherited = pred.finishVarianceDays
    }

    const ownSlip = task.finishVarianceDays - inherited
    if (ownSlip <= 0) continue

    drivers.push({
      taskId: task.taskId,
      name: task.name,
      ownSlipDays: ownSlip,
      totalSlipDays: task.finishVarianceDays,
      isCritical: task.isCritical,
      status: task.status,
    })
  }

  // Causes still in play come first — they are the ones something can still be
  // done about. Finished work that caused a slip is reported, but ranked below
  // the live problems.
  drivers.sort((a, b) => {
    const aLive = a.status !== 'complete'
    const bLive = b.status !== 'complete'
    if (aLive !== bLive) return aLive ? -1 : 1
    if (a.isCritical !== b.isCritical) return a.isCritical ? -1 : 1
    return b.ownSlipDays - a.ownSlipDays
  })

  const moved = variance.projectFinishVarianceDays
  const headline = buildHeadline(moved, variance)
  const cause = buildCause(moved, drivers, variance)

  return {
    projectMovedDays: moved,
    currentFinish: variance.currentProjectFinish,
    baselineFinish: variance.baselineProjectFinish,
    headline,
    cause,
    drivers,
    summary: cause ? `${headline} ${cause}` : headline,
  }
}

function buildHeadline(moved: number, variance: ScheduleVariance): string {
  if (moved > 0) {
    return `Completion moved ${days(moved)} later, to ${variance.currentProjectFinish}.`
  }
  if (moved < 0) {
    return `Completion pulled in ${days(-moved)}, to ${variance.currentProjectFinish}.`
  }
  if (variance.slipped.length > 0) {
    // The most reassuring thing a scheduling tool can say, and the one no
    // spreadsheet ever says: something slipped and it did not cost you anything.
    return `Completion held at ${variance.currentProjectFinish}.`
  }
  return `No change to the schedule. Completion remains ${variance.currentProjectFinish}.`
}

function buildCause(
  moved: number,
  drivers: ImpactDriver[],
  variance: ScheduleVariance,
): string {
  if (drivers.length === 0) {
    if (moved < 0) return 'Work finished ahead of the baseline.'
    return ''
  }

  const named = drivers
    .slice(0, 2)
    .map((d) => `${d.name} slipped ${days(d.ownSlipDays)}`)
    .join(', and ')

  const others = drivers.length > 2 ? ` (plus ${drivers.length - 2} more)` : ''

  if (moved === 0) {
    const absorbed = variance.slipped.length
    return `${capitalise(named)}${others}, absorbed by float across ${count(absorbed, 'task')}.`
  }

  return `Cause: ${named}${others}.${suffixFor(drivers[0]!)}`
}

/**
 * The clause that tells someone what they can do about it. A finished task that
 * ran long is a different situation from a live one eating into float: the time
 * is already spent, so the only route back is elsewhere in the schedule.
 */
function suffixFor(driver: ImpactDriver): string {
  if (driver.status === 'complete') {
    return ' That work is finished, so the time cannot be made up there.'
  }
  if (driver.isCritical) {
    return ' It is on the critical path.'
  }
  return ' It has consumed the float that was protecting the finish date.'
}

function days(n: number): string {
  return count(n, 'day')
}

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1)
}
