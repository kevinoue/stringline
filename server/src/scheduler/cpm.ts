/**
 * Critical Path Method solver.
 *
 * Time model — every task is described by three day indices:
 *
 *   `start`   first working day of the task
 *   `finish`  last working day, inclusive (what a Gantt bar's right edge shows)
 *   `freeAt`  first day a successor may begin — the working day after `finish`
 *
 * Carrying `freeAt` explicitly, rather than deriving it with ±1 at each use,
 * is what keeps milestones honest. A milestone has zero duration, so its
 * `freeAt` equals its `start`: an FS successor begins the *same* day, because
 * no time was consumed. Every other formulation of this ends up either
 * inserting a phantom day after each milestone or special-casing the ±1 in a
 * dozen places.
 *
 * Lag is measured in working days on the **successor's** calendar, matching the
 * convention used by MS Project and P6.
 */

import { buildCalendars, type WorkCalendar } from './calendar.js'
import { fromDayIndex, toDayIndex } from './dates.js'
import { DependencyGraph, type GraphEdge } from './graph.js'
import {
  ScheduleError,
  type DayIndex,
  type OutOfSequenceMode,
  type ScheduleInput,
  type ScheduleResult,
  type ScheduledTask,
  type TaskInput,
  type TaskStatus,
} from './types.js'

interface Node {
  input: TaskInput
  calendar: WorkCalendar
  duration: number
  isMilestone: boolean
  status: TaskStatus
  actualStart: DayIndex | null
  actualFinish: DayIndex | null
  /** Working days of work still to do. Drives the forecast; `0` once complete. */
  remaining: number
  earlyStart: DayIndex
  /**
   * Where the *remaining* work is forecast to begin. Equals `earlyStart` for
   * anything not yet under way; for a started task it is the resume point at or
   * after the data date.
   *
   * Float is measured from here, never from `earlyStart`. A task that actually
   * started three weeks ago cannot slip its start — only the work still in
   * front of it has any slack, and comparing a recorded actual against a
   * forecast late start produces a float figure that means nothing.
   */
  remainingStart: DayIndex
  earlyFreeAt: DayIndex
  lateStart: DayIndex
  lateFreeAt: DayIndex
}

export function solve(input: ScheduleInput): ScheduleResult {
  const projectStartDay = toDayIndex(input.projectStart)
  const horizonEnd = estimateHorizon(input, projectStartDay)
  const calendars = buildCalendars(input.calendars, projectStartDay, horizonEnd)

  const graph = new DependencyGraph(input.tasks, input.dependencies)
  const order = graph.topologicalOrder()

  const nodes = new Map<string, Node>()
  for (const task of input.tasks) {
    if (!Number.isInteger(task.durationDays) || task.durationDays < 0) {
      throw new ScheduleError(
        'INVALID_DURATION',
        `Task "${task.id}" has duration ${task.durationDays}; must be a non-negative whole number of working days`,
      )
    }
    const calendarId = task.calendarId ?? input.defaultCalendarId
    const calendar = calendars.get(calendarId)
    if (!calendar) {
      throw new ScheduleError(
        'UNKNOWN_CALENDAR',
        `Task "${task.id}" references calendar "${calendarId}", which is not defined`,
      )
    }
    if (task.constraintType && task.constraintType !== 'ASAP' && !task.constraintDate) {
      throw new ScheduleError(
        'MISSING_CONSTRAINT_DATE',
        `Task "${task.id}" has constraint ${task.constraintType} but no constraintDate`,
      )
    }
    nodes.set(task.id, {
      input: task,
      calendar,
      duration: task.durationDays,
      isMilestone: task.durationDays === 0,
      ...resolveProgress(task),
      earlyStart: 0,
      remainingStart: 0,
      earlyFreeAt: 0,
      lateStart: 0,
      lateFreeAt: 0,
    })
  }

  const dataDateDay = input.dataDate ? toDayIndex(input.dataDate) : null
  forwardPass(order, nodes, graph, projectStartDay, dataDateDay, input.outOfSequence ?? 'retained')
  const projectFinishFreeAt = Math.max(...order.map((id) => nodes.get(id)!.earlyFreeAt))
  backwardPass(order, nodes, graph, projectFinishFreeAt, input)

  return assemble(input, order, nodes, graph, calendars, projectStartDay, dataDateDay)
}

// ── Progress ─────────────────────────────────────────────────────────────────

/**
 * Reconcile a task's actuals into a status and a remaining duration.
 *
 * The precedence is deliberate: an explicit `remainingDays` beats a percentage,
 * and a percentage beats inference. Inference only kicks in for a task that has
 * started with no progress reported at all, and it assumes work has tracked the
 * plan — the same assumption a Gantt makes when you drag an actual start.
 * That assumption is generous, which is exactly why reporting real progress
 * has to be one tap in the field app.
 */
function resolveProgress(task: TaskInput): Pick<
  Node,
  'status' | 'actualStart' | 'actualFinish' | 'remaining'
> {
  const actualStart = task.actualStart ? toDayIndex(task.actualStart) : null
  const actualFinish = task.actualFinish ? toDayIndex(task.actualFinish) : null

  if (actualFinish !== null && actualStart !== null && actualFinish < actualStart) {
    throw new ScheduleError(
      'INCONSISTENT_ACTUALS',
      `Task "${task.id}" reports finishing (${task.actualFinish}) before it started (${task.actualStart})`,
    )
  }
  if (task.percentComplete !== undefined) {
    if (task.percentComplete < 0 || task.percentComplete > 100) {
      throw new ScheduleError(
        'INVALID_PROGRESS',
        `Task "${task.id}" reports ${task.percentComplete}% complete; must be between 0 and 100`,
      )
    }
  }
  if (task.remainingDays !== undefined && task.remainingDays < 0) {
    throw new ScheduleError(
      'INVALID_PROGRESS',
      `Task "${task.id}" reports ${task.remainingDays} days remaining; must not be negative`,
    )
  }

  if (actualFinish !== null) {
    return { status: 'complete', actualStart, actualFinish, remaining: 0 }
  }

  if (actualStart === null) {
    const remaining =
      task.remainingDays ??
      (task.percentComplete !== undefined
        ? Math.ceil(task.durationDays * (1 - task.percentComplete / 100))
        : task.durationDays)
    return { status: 'not-started', actualStart: null, actualFinish: null, remaining }
  }

  // Started but not finished. `remaining` may still be inferred below, once the
  // calendar is known, so a negative sentinel marks "not yet decided".
  const remaining =
    task.remainingDays ??
    (task.percentComplete !== undefined
      ? Math.ceil(task.durationDays * (1 - task.percentComplete / 100))
      : -1)
  return { status: 'in-progress', actualStart, actualFinish: null, remaining }
}

/**
 * The calendars a schedule runs on, built over the same horizon `solve` uses.
 * Exposed so variance and impact analysis can measure in working days rather
 * than falling back to calendar days and reporting weekends as slippage.
 */
export function projectCalendars(input: ScheduleInput): Map<string, WorkCalendar> {
  const start = toDayIndex(input.projectStart)
  return buildCalendars(input.calendars, start, estimateHorizon(input, start))
}

// ── Forward pass: earliest possible dates ────────────────────────────────────

function forwardPass(
  order: string[],
  nodes: Map<string, Node>,
  graph: DependencyGraph,
  projectStartDay: DayIndex,
  dataDateDay: DayIndex | null,
  outOfSequence: OutOfSequenceMode,
): void {
  for (const id of order) {
    const node = nodes.get(id)!
    const cal = node.calendar

    // A finished task is a matter of record. Predecessors, constraints and the
    // data date have nothing to say about it.
    if (node.status === 'complete') {
      const finish = cal.snapBack(node.actualFinish!)
      node.earlyStart =
        node.actualStart !== null
          ? cal.snapForward(node.actualStart)
          : node.isMilestone
            ? finish
            : cal.addWorkingDays(finish, -(node.duration - 1))
      node.earlyFreeAt = node.isMilestone ? finish : cal.addWorkingDays(finish, 1)
      node.remainingStart = node.earlyStart
      continue
    }

    // Earliest the logic allows, ignoring any progress on this task.
    let logicStart = cal.snapForward(projectStartDay)
    for (const edge of graph.incoming.get(id)!) {
      const pred = nodes.get(edge.predecessorId)!
      const candidate = earliestStartFrom(edge, pred, node)
      if (candidate > logicStart) logicStart = candidate
    }

    // Soft floor: never earlier than this date, but predecessors can push later.
    if (node.input.constraintType === 'START_NO_EARLIER_THAN') {
      const floor = cal.snapForward(toDayIndex(node.input.constraintDate!))
      if (floor > logicStart) logicStart = floor
    }

    // Hard pin. Honoured even when predecessors disagree — that conflict then
    // surfaces as negative float rather than being silently absorbed.
    if (node.input.constraintType === 'MUST_START_ON') {
      logicStart = cal.snapForward(toDayIndex(node.input.constraintDate!))
    }

    if (node.status === 'in-progress') {
      const actualStart = cal.snapForward(node.actualStart!)
      node.earlyStart = actualStart

      // Remaining work resumes at the data date, not at the original start.
      // This is the whole point of a data date: a task that started three weeks
      // ago and stalled must not keep reporting its original finish.
      let resume = dataDateDay === null ? actualStart : cal.snapForward(Math.max(dataDateDay, actualStart))

      // Out-of-sequence: this task began before its predecessor finished.
      // Retained logic still gates the *remaining* work on that predecessor;
      // progress override lets the work in front of us carry on.
      if (outOfSequence === 'retained' && logicStart > resume) resume = logicStart

      if (node.remaining < 0) {
        // No progress reported. Assume it has tracked the plan: credit the
        // working days elapsed between the actual start and the data date.
        const elapsed = dataDateDay === null ? 0 : cal.countWorkingDays(actualStart, resume)
        node.remaining = Math.max(0, node.duration - elapsed)
      }
      node.remainingStart = resume
      node.earlyFreeAt = cal.addWorkingDays(resume, node.remaining)
      continue
    }

    // Not started. Nothing may be forecast to begin before the data date.
    let start = logicStart
    if (dataDateDay !== null) {
      const floor = cal.snapForward(dataDateDay)
      if (floor > start) start = floor
    }
    node.earlyStart = start
    node.remainingStart = start
    node.earlyFreeAt = cal.addWorkingDays(start, node.remaining)
  }
}

/** The earliest `successor` may start, given one predecessor relationship. */
function earliestStartFrom(edge: GraphEdge, pred: Node, succ: Node): DayIndex {
  const cal = succ.calendar
  const lag = edge.lagDays

  switch (edge.type) {
    case 'FS':
      return cal.addWorkingDays(cal.snapForward(pred.earlyFreeAt), lag)
    case 'SS':
      return cal.addWorkingDays(cal.snapForward(pred.earlyStart), lag)
    // Back-solved from the successor's *remaining* work, so a partly-complete
    // task is not pushed around as though it still had its full duration ahead.
    case 'FF': {
      const requiredFreeAt = cal.addWorkingDays(cal.snapForward(pred.earlyFreeAt), lag)
      return cal.addWorkingDays(requiredFreeAt, -succ.remaining)
    }
    case 'SF': {
      const requiredFreeAt = cal.addWorkingDays(cal.snapForward(pred.earlyStart), lag)
      return cal.addWorkingDays(requiredFreeAt, -succ.remaining)
    }
  }
}

// ── Backward pass: latest dates that still hold the finish ───────────────────

function backwardPass(
  order: string[],
  nodes: Map<string, Node>,
  graph: DependencyGraph,
  projectFinishFreeAt: DayIndex,
  input: ScheduleInput,
): void {
  // A deadline replaces the computed finish as the backward-pass origin, so a
  // schedule that cannot meet its contract reports negative float instead of
  // looking comfortable.
  const origin = input.projectDeadline
    ? deadlineFreeAt(input, nodes)
    : projectFinishFreeAt

  for (let i = order.length - 1; i >= 0; i--) {
    const id = order[i]!
    const node = nodes.get(id)!
    const cal = node.calendar

    // A completed task cannot slip, so it has no float and never appears on the
    // critical path. Pinning its late dates to its actuals says exactly that.
    if (node.status === 'complete') {
      node.lateStart = node.earlyStart
      node.lateFreeAt = node.earlyFreeAt
      continue
    }

    // Two independent ceilings: one on when the task may finish, one on when it
    // may start. FS/FF constrain the finish; SS/SF constrain the start.
    let freeAtBound = Number.POSITIVE_INFINITY
    let startBound = Number.POSITIVE_INFINITY

    const successors = graph.outgoing.get(id)!
    if (successors.length === 0) {
      freeAtBound = origin
    }
    for (const edge of successors) {
      const succ = nodes.get(edge.successorId)!
      const sCal = succ.calendar
      const lag = edge.lagDays
      const succLateFreeAt = sCal.addWorkingDays(succ.lateStart, succ.remaining)

      switch (edge.type) {
        case 'FS':
          freeAtBound = Math.min(freeAtBound, sCal.addWorkingDays(succ.lateStart, -lag))
          break
        case 'SS':
          startBound = Math.min(startBound, sCal.addWorkingDays(succ.lateStart, -lag))
          break
        case 'FF':
          freeAtBound = Math.min(freeAtBound, sCal.addWorkingDays(succLateFreeAt, -lag))
          break
        case 'SF':
          startBound = Math.min(startBound, sCal.addWorkingDays(succLateFreeAt, -lag))
          break
      }
    }

    if (node.input.constraintType === 'FINISH_NO_LATER_THAN') {
      const lastAllowedFinish = cal.snapBack(toDayIndex(node.input.constraintDate!))
      freeAtBound = Math.min(freeAtBound, cal.addWorkingDays(lastAllowedFinish, 1))
    }

    let lateStart: DayIndex
    if (node.input.constraintType === 'MUST_START_ON') {
      // Pinned in both directions, so the task has no float by construction.
      lateStart = node.earlyStart
    } else {
      const fromFinish =
        freeAtBound === Number.POSITIVE_INFINITY
          ? Number.POSITIVE_INFINITY
          : cal.addWorkingDays(cal.snapBack(freeAtBound), -node.remaining)
      const fromStart =
        startBound === Number.POSITIVE_INFINITY ? Number.POSITIVE_INFINITY : cal.snapBack(startBound)
      lateStart = Math.min(fromFinish, fromStart)
    }

    node.lateStart = lateStart
    node.lateFreeAt = cal.addWorkingDays(lateStart, node.remaining)
  }
}

function deadlineFreeAt(input: ScheduleInput, nodes: Map<string, Node>): DayIndex {
  const deadline = toDayIndex(input.projectDeadline!)
  // Measured on the default calendar; that is the project-level clock.
  const anyNode = nodes.values().next().value as Node | undefined
  if (!anyNode) return deadline
  const cal = anyNode.calendar
  return cal.addWorkingDays(cal.snapBack(deadline), 1)
}

// ── Result assembly: float, criticality, and the critical path ───────────────

function assemble(
  input: ScheduleInput,
  order: string[],
  nodes: Map<string, Node>,
  graph: DependencyGraph,
  calendars: Map<string, WorkCalendar>,
  projectStartDay: DayIndex,
  dataDateDay: DayIndex | null,
): ScheduleResult {
  const tasks: Record<string, ScheduledTask> = {}
  const criticalPath: string[] = []

  // Measured from the remaining work, not from a start that already happened.
  const floats = new Map<string, number>()
  for (const id of order) {
    const node = nodes.get(id)!
    floats.set(id, node.calendar.countWorkingDays(node.remainingStart, node.lateStart))
  }

  /**
   * The critical path is the chain with the *least* float, not the chain with
   * float at or below zero.
   *
   * Those are the same thing only when the backward pass is anchored on the
   * computed finish. A deadline replaces that anchor, which shifts every float
   * by roughly a constant and broke the old `totalFloat <= 0` test in both
   * directions:
   *
   *   - Behind the deadline, nearly everything feeding the end goes negative.
   *     On the demo project that painted 17 of 19 tasks red, so red stopped
   *     meaning "this is the chain to fix" and started meaning "you are late"
   *     — which the deadline chip and the summary already say.
   *   - Comfortably ahead of it, nothing reached zero at all, so a healthy
   *     project showed no critical path whatsoever. That one was arguably
   *     worse: the feature silently vanished exactly when things were fine.
   *
   * Taking the minimum restores the real meaning in both cases, and is
   * identical to the old behaviour when there is no deadline, because then the
   * minimum is zero by construction.
   *
   * Finished work is excluded from the minimum as well as from the path: it
   * cannot delay anything, so letting it set the bar would hide the live chain
   * behind completed tasks.
   */
  let minFloat = Number.POSITIVE_INFINITY
  for (const id of order) {
    if (nodes.get(id)!.status === 'complete') continue
    const f = floats.get(id)!
    if (f < minFloat) minFloat = f
  }

  for (const id of order) {
    const node = nodes.get(id)!
    const cal = node.calendar

    const totalFloat = floats.get(id)!
    const freeFloat = computeFreeFloat(node, graph.outgoing.get(id)!, nodes, totalFloat)
    const isCritical = node.status !== 'complete' && totalFloat === minFloat

    tasks[id] = {
      id,
      name: node.input.name,
      durationDays: node.duration,
      isMilestone: node.isMilestone,
      status: node.status,
      remainingDays: node.remaining,
      isForecast: node.status !== 'complete',
      earlyStart: fromDayIndex(node.earlyStart),
      earlyFinish: fromDayIndex(inclusiveFinish(node)),
      lateStart: fromDayIndex(node.lateStart),
      lateFinish: fromDayIndex(
        node.isMilestone ? node.lateStart : cal.addWorkingDays(node.lateFreeAt, -1),
      ),
      totalFloat,
      freeFloat,
      isCritical,
    }
    if (isCritical) criticalPath.push(id)
  }

  const defaultCal = calendars.get(input.defaultCalendarId)
  if (!defaultCal) {
    throw new ScheduleError(
      'UNKNOWN_CALENDAR',
      `defaultCalendarId "${input.defaultCalendarId}" is not among the defined calendars`,
    )
  }

  // The project finishes on the last day any task is still running — which for a
  // project that ends on a handover milestone is the milestone's own date, not
  // the day the preceding work stopped. Deriving this from the tasks rather than
  // from the maximum `freeAt` is what keeps that milestone from being reported a
  // day early.
  let inclusiveProjectFinish = defaultCal.snapForward(projectStartDay)
  for (const id of order) {
    const day = inclusiveFinish(nodes.get(id)!)
    if (day > inclusiveProjectFinish) inclusiveProjectFinish = day
  }

  let deadlineFloat: number | null = null
  if (input.projectDeadline) {
    const deadlineDay = defaultCal.snapBack(toDayIndex(input.projectDeadline))
    deadlineFloat = defaultCal.countWorkingDays(inclusiveProjectFinish, deadlineDay)
  }

  return {
    projectStart: fromDayIndex(defaultCal.snapForward(projectStartDay)),
    dataDate: dataDateDay === null ? null : fromDayIndex(dataDateDay),
    projectFinish: fromDayIndex(inclusiveProjectFinish),
    durationWorkingDays: defaultCal.countWorkingDays(
      defaultCal.snapForward(projectStartDay),
      inclusiveProjectFinish,
    ) + 1,
    tasks,
    criticalPath,
    deadlineFloat,
  }
}

function inclusiveFinish(node: Node): DayIndex {
  // A milestone consumes no time, so its finish is the day it lands on.
  return node.isMilestone ? node.earlyStart : node.calendar.addWorkingDays(node.earlyFreeAt, -1)
}

/**
 * Working days this task can slip before *any* successor is pushed — as opposed
 * to total float, which measures slip before the project finish moves.
 *
 * With mixed calendars this is measured on the successor's calendar, since that
 * is the clock the successor actually runs on.
 */
function computeFreeFloat(
  node: Node,
  successors: GraphEdge[],
  nodes: Map<string, Node>,
  totalFloat: number,
): number {
  if (successors.length === 0) return totalFloat

  let slack = Number.POSITIVE_INFINITY
  for (const edge of successors) {
    const succ = nodes.get(edge.successorId)!
    const cal = succ.calendar
    const allowed = earliestStartFrom(edge, node, succ)
    const edgeSlack = cal.countWorkingDays(cal.snapForward(allowed), succ.remainingStart)
    if (edgeSlack < slack) slack = edgeSlack
  }
  return Math.min(slack, totalFloat)
}

// ── Horizon sizing ───────────────────────────────────────────────────────────

/**
 * Calendars precompute their working-day tables, so they need an end date up
 * front. Overshoot deliberately: the tables are one byte plus four bytes per
 * day, so a decade of headroom costs a few hundred kilobytes, while an
 * undershoot is a hard failure mid-solve.
 */
function estimateHorizon(input: ScheduleInput, projectStartDay: DayIndex): DayIndex {
  let workingDays = 0
  for (const task of input.tasks) workingDays += Math.max(0, task.durationDays)
  for (const dep of input.dependencies) workingDays += Math.abs(dep.lagDays ?? 0)

  // Worst case a calendar has one working day per week, so seven calendar days
  // per working day, and the whole plan could be one long chain.
  let end = projectStartDay + workingDays * 7 + 800

  for (const task of input.tasks) {
    if (task.constraintDate) {
      const day = toDayIndex(task.constraintDate)
      if (day + 800 > end) end = day + 800
    }
  }
  if (input.projectDeadline) {
    const day = toDayIndex(input.projectDeadline)
    if (day + 800 > end) end = day + 800
  }
  return end
}
