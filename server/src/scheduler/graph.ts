/**
 * Dependency graph: adjacency, topological ordering, and cycle detection.
 *
 * Cycle detection is not optional. User-authored dependency graphs contain
 * loops routinely — someone links inspection back to framing "so it shows up
 * on the list" — and a CPM solver handed a cycle will either loop forever or
 * return a confidently wrong schedule. This module makes that case a named,
 * reported error carrying the actual loop.
 */

import { ScheduleError, type DependencyInput, type TaskInput } from './types.js'

export interface GraphEdge {
  predecessorId: string
  successorId: string
  type: DependencyInput['type']
  lagDays: number
}

export class DependencyGraph {
  readonly taskIds: string[]
  /** Edges keyed by the successor — "what must happen before this task?" */
  readonly incoming: Map<string, GraphEdge[]>
  /** Edges keyed by the predecessor — "what does this task hold up?" */
  readonly outgoing: Map<string, GraphEdge[]>

  constructor(tasks: TaskInput[], dependencies: DependencyInput[]) {
    this.taskIds = tasks.map((t) => t.id)
    const known = new Set<string>()
    for (const task of tasks) {
      if (known.has(task.id)) {
        throw new ScheduleError('DUPLICATE_TASK', `Task id "${task.id}" appears more than once`)
      }
      known.add(task.id)
    }

    this.incoming = new Map(this.taskIds.map((id) => [id, [] as GraphEdge[]]))
    this.outgoing = new Map(this.taskIds.map((id) => [id, [] as GraphEdge[]]))

    for (const dep of dependencies) {
      if (!known.has(dep.predecessorId)) {
        throw new ScheduleError(
          'UNKNOWN_TASK',
          `Dependency references unknown predecessor "${dep.predecessorId}"`,
        )
      }
      if (!known.has(dep.successorId)) {
        throw new ScheduleError(
          'UNKNOWN_TASK',
          `Dependency references unknown successor "${dep.successorId}"`,
        )
      }
      if (dep.predecessorId === dep.successorId) {
        throw new ScheduleError(
          'CYCLE',
          `Task "${dep.predecessorId}" depends on itself`,
          [dep.predecessorId, dep.predecessorId],
        )
      }
      const edge: GraphEdge = {
        predecessorId: dep.predecessorId,
        successorId: dep.successorId,
        type: dep.type,
        lagDays: dep.lagDays ?? 0,
      }
      this.incoming.get(dep.successorId)!.push(edge)
      this.outgoing.get(dep.predecessorId)!.push(edge)
    }
  }

  /**
   * Kahn's algorithm. Returns predecessors-before-successors ordering, or throws
   * `CYCLE` with the offending loop.
   */
  topologicalOrder(): string[] {
    const remaining = new Map<string, number>()
    for (const id of this.taskIds) remaining.set(id, this.incoming.get(id)!.length)

    const ready = this.taskIds.filter((id) => remaining.get(id) === 0)
    const order: string[] = []

    while (ready.length > 0) {
      const id = ready.shift()!
      order.push(id)
      for (const edge of this.outgoing.get(id)!) {
        const left = remaining.get(edge.successorId)! - 1
        remaining.set(edge.successorId, left)
        if (left === 0) ready.push(edge.successorId)
      }
    }

    if (order.length !== this.taskIds.length) {
      const stuck = this.taskIds.filter((id) => remaining.get(id)! > 0)
      const cycle = this.findCycle(new Set(stuck))
      throw new ScheduleError(
        'CYCLE',
        `Circular dependency: ${cycle.join(' → ')}. A task cannot depend on itself, ` +
          `directly or through a chain.`,
        cycle,
      )
    }
    return order
  }

  /**
   * Depth-first walk restricted to the tasks Kahn's algorithm could not settle,
   * returning one concrete loop. Reporting the actual path is the difference
   * between an error someone can fix and one they can only stare at.
   */
  private findCycle(candidates: Set<string>): string[] {
    const WHITE = 0
    const GREY = 1
    const BLACK = 2
    const colour = new Map<string, number>()
    for (const id of candidates) colour.set(id, WHITE)

    const stack: string[] = []

    const visit = (id: string): string[] | null => {
      colour.set(id, GREY)
      stack.push(id)
      for (const edge of this.outgoing.get(id)!) {
        const next = edge.successorId
        if (!candidates.has(next)) continue
        if (colour.get(next) === GREY) {
          // Trim the stack back to where the loop opened.
          const from = stack.indexOf(next)
          return [...stack.slice(from), next]
        }
        if (colour.get(next) === WHITE) {
          const found = visit(next)
          if (found) return found
        }
      }
      stack.pop()
      colour.set(id, BLACK)
      return null
    }

    for (const id of candidates) {
      if (colour.get(id) === WHITE) {
        const found = visit(id)
        if (found) return found
      }
    }
    // Unreachable when Kahn reported leftovers, but never guess at a cycle path.
    return [...candidates]
  }
}
