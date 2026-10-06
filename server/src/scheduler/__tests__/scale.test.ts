import { describe, expect, test } from 'vitest'
import { solve } from '../cpm.js'
import type { CalendarDef, DependencyInput, ScheduleInput, TaskInput } from '../types.js'

const MON_FRI: CalendarDef = { id: 'std', name: 'Mon–Fri', workingWeekdays: [1, 2, 3, 4, 5] }

/**
 * A realistically shaped programme: `phases` sequential phases, each fanning out
 * into `width` parallel trades that rejoin at a phase-closing milestone. That
 * mix of chain depth and fan-out is what a real construction schedule looks
 * like, and it exercises both passes far harder than a single long chain.
 */
function programme(phases: number, width: number): ScheduleInput {
  const tasks: TaskInput[] = []
  const dependencies: DependencyInput[] = []
  let previousMilestone: string | null = null

  for (let p = 0; p < phases; p++) {
    const gate = `phase-${p}-complete`
    for (let w = 0; w < width; w++) {
      const id = `t-${p}-${w}`
      tasks.push({ id, name: `Phase ${p} trade ${w}`, durationDays: 1 + ((p + w) % 8) })
      if (previousMilestone) {
        dependencies.push({ predecessorId: previousMilestone, successorId: id, type: 'FS' })
      }
      dependencies.push({ predecessorId: id, successorId: gate, type: 'FS' })
    }
    tasks.push({ id: gate, name: `Phase ${p} complete`, durationDays: 0 })
    previousMilestone = gate
  }
  return {
    projectStart: '2026-01-05',
    defaultCalendarId: 'std',
    calendars: [MON_FRI],
    tasks,
    dependencies,
  }
}

describe('scale', () => {
  test('solves a 10,000-task programme well inside interactive latency', () => {
    const input = programme(500, 20) // 10,000 trades + 500 milestones
    expect(input.tasks.length).toBe(10_500)

    const started = performance.now()
    const result = solve(input)
    const elapsed = performance.now() - started

    expect(Object.keys(result.tasks)).toHaveLength(10_500)
    expect(result.criticalPath.length).toBeGreaterThan(0)

    // Dragging a bar in the Gantt re-solves the whole schedule, so this has to
    // stay comfortably under a frame budget's worth of work. The threshold is
    // deliberately loose — it is a regression guard against accidentally
    // reintroducing day-by-day calendar walking, not a benchmark.
    expect(elapsed).toBeLessThan(2000)
  })

  test('a cycle buried in a large graph is reported rather than hanging', () => {
    const input = programme(50, 10)
    input.dependencies.push({
      predecessorId: 'phase-40-complete',
      successorId: 't-10-3',
      type: 'FS',
    })
    expect(() => solve(input)).toThrow(/Circular dependency/)
  })
})
