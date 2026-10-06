import { describe, expect, test } from 'vitest'
import { captureBaseline, diffAgainstBaseline } from '../baseline.js'
import { solve } from '../cpm.js'
import { explainImpact } from '../impact.js'
import type { CalendarDef, ScheduleInput } from '../types.js'

const MON_FRI: CalendarDef = { id: 'std', name: 'Mon–Fri', workingWeekdays: [1, 2, 3, 4, 5] }

/** A four-step renovation ending in a handover milestone. */
function renovation(permitDays: number, drywallDays = 5): ScheduleInput {
  return {
    projectStart: '2026-01-05',
    defaultCalendarId: 'std',
    calendars: [MON_FRI],
    tasks: [
      { id: 'permit', name: 'Permit approval', durationDays: permitDays },
      { id: 'framing', name: 'Framing', durationDays: 10 },
      { id: 'drywall', name: 'Drywall', durationDays: drywallDays },
      { id: 'handover', name: 'Handover', durationDays: 0 },
    ],
    dependencies: [
      { predecessorId: 'permit', successorId: 'framing', type: 'FS' },
      { predecessorId: 'framing', successorId: 'drywall', type: 'FS' },
      { predecessorId: 'drywall', successorId: 'handover', type: 'FS' },
    ],
  }
}

describe('baseline capture', () => {
  test('freezes the planned dates including the terminating milestone', () => {
    const input = renovation(5)
    const planned = solve(input)
    const baseline = captureBaseline('Contract baseline', '2026-01-05', planned, input)

    expect(baseline.tasks['permit']).toMatchObject({
      start: '2026-01-05',
      finish: '2026-01-09',
      durationDays: 5,
    })
    expect(baseline.tasks['framing']).toMatchObject({
      start: '2026-01-12',
      finish: '2026-01-23',
    })
    expect(baseline.tasks['drywall']).toMatchObject({
      start: '2026-01-26',
      finish: '2026-01-30',
    })
    // The project ends on the milestone's own date, not the day the last work stopped.
    expect(baseline.tasks['handover']).toMatchObject({ start: '2026-02-02', finish: '2026-02-02' })
    expect(baseline.projectFinish).toBe('2026-02-02')
  })
})

describe('variance', () => {
  test('measures slip in working days, not calendar days', () => {
    const input = renovation(5)
    const baseline = captureBaseline('Contract baseline', '2026-01-05', solve(input), input)

    // The permit takes three extra working days.
    const current = renovation(8)
    const variance = diffAgainstBaseline(baseline, solve(current), current)

    expect(variance.projectFinishVarianceDays).toBe(3)
    expect(variance.currentProjectFinish).toBe('2026-02-05')

    // Every downstream task moved by the same three days — and the weekends in
    // between are not counted as slippage.
    expect(variance.slipped.map((t) => [t.taskId, t.finishVarianceDays])).toEqual([
      ['permit', 3],
      ['framing', 3],
      ['drywall', 3],
      ['handover', 3],
    ])
  })

  test('reports tasks added and removed since the baseline', () => {
    const input = renovation(5)
    const baseline = captureBaseline('Contract baseline', '2026-01-05', solve(input), input)

    const revised: ScheduleInput = {
      ...input,
      tasks: [
        ...input.tasks.filter((t) => t.id !== 'drywall'),
        { id: 'paint', name: 'Paint', durationDays: 3 },
      ],
      dependencies: [
        { predecessorId: 'permit', successorId: 'framing', type: 'FS' },
        { predecessorId: 'framing', successorId: 'paint', type: 'FS' },
        { predecessorId: 'paint', successorId: 'handover', type: 'FS' },
      ],
    }
    const variance = diffAgainstBaseline(baseline, solve(revised), revised)

    expect(variance.changed.find((t) => t.taskId === 'paint')).toMatchObject({ isNew: true })
    expect(variance.changed.find((t) => t.taskId === 'drywall')).toMatchObject({ isRemoved: true })
  })

  test('an unchanged schedule reports no variance at all', () => {
    const input = renovation(5)
    const baseline = captureBaseline('Contract baseline', '2026-01-05', solve(input), input)
    const variance = diffAgainstBaseline(baseline, solve(input), input)

    expect(variance.changed).toEqual([])
    expect(variance.projectFinishVarianceDays).toBe(0)
  })
})

describe('impact narration', () => {
  test('names the root cause once, not every task that inherited the slip', () => {
    const input = renovation(5)
    const baseline = captureBaseline('Contract baseline', '2026-01-05', solve(input), input)

    const current = renovation(8)
    const variance = diffAgainstBaseline(baseline, solve(current), current)
    const impact = explainImpact(variance, current)

    // Four tasks slipped, but only one of them caused anything.
    expect(variance.slipped).toHaveLength(4)
    expect(impact.drivers).toHaveLength(1)
    expect(impact.drivers[0]).toMatchObject({
      taskId: 'permit',
      ownSlipDays: 3,
      totalSlipDays: 3,
      isCritical: true,
    })

    expect(impact.projectMovedDays).toBe(3)
    expect(impact.summary).toBe(
      'Completion moved 3 days later, to 2026-02-05. ' +
        'Cause: Permit approval slipped 3 days. It is on the critical path.',
    )
  })

  test('a slip absorbed by float says so instead of raising an alarm', () => {
    // Six-task network where the C→E branch carries six days of float.
    const base: ScheduleInput = {
      projectStart: '2026-01-05',
      defaultCalendarId: 'every',
      calendars: [{ id: 'every', name: 'Every day', workingWeekdays: [0, 1, 2, 3, 4, 5, 6] }],
      tasks: [
        { id: 'A', name: 'Site prep', durationDays: 3 },
        { id: 'B', name: 'Foundation', durationDays: 4 },
        { id: 'C', name: 'Utilities', durationDays: 2 },
        { id: 'D', name: 'Framing', durationDays: 5 },
        { id: 'E', name: 'Trenching', durationDays: 1 },
        { id: 'F', name: 'Close out', durationDays: 2 },
      ],
      dependencies: [
        { predecessorId: 'A', successorId: 'B', type: 'FS' },
        { predecessorId: 'A', successorId: 'C', type: 'FS' },
        { predecessorId: 'B', successorId: 'D', type: 'FS' },
        { predecessorId: 'C', successorId: 'E', type: 'FS' },
        { predecessorId: 'D', successorId: 'F', type: 'FS' },
        { predecessorId: 'E', successorId: 'F', type: 'FS' },
      ],
    }
    const baseline = captureBaseline('Contract baseline', '2026-01-05', solve(base), base)

    // Trenching takes three extra days. It has the float to absorb them.
    const current: ScheduleInput = {
      ...base,
      tasks: base.tasks.map((t) => (t.id === 'E' ? { ...t, durationDays: 4 } : t)),
    }
    const impact = explainImpact(
      diffAgainstBaseline(baseline, solve(current), current),
      current,
    )

    expect(impact.projectMovedDays).toBe(0)
    expect(impact.summary).toBe(
      'Completion held at 2026-01-18. Trenching slipped 3 days, absorbed by float across 1 task.',
    )
  })

  test('time recovered is reported as a gain', () => {
    const input = renovation(5)
    const baseline = captureBaseline('Contract baseline', '2026-01-05', solve(input), input)

    // Drywall comes in two days under.
    const current = renovation(5, 3)
    const variance = diffAgainstBaseline(baseline, solve(current), current)
    const impact = explainImpact(variance, current)

    expect(impact.projectMovedDays).toBe(-2)
    expect(variance.gained.map((t) => t.taskId)).toContain('drywall')
    expect(impact.summary).toBe(
      'Completion pulled in 2 days, to 2026-01-29. Work finished ahead of the baseline.',
    )
  })

  test('an untouched schedule says nothing changed', () => {
    const input = renovation(5)
    const baseline = captureBaseline('Contract baseline', '2026-01-05', solve(input), input)
    const impact = explainImpact(diffAgainstBaseline(baseline, solve(input), input), input)

    expect(impact.drivers).toEqual([])
    expect(impact.summary).toBe('No change to the schedule. Completion remains 2026-02-02.')
  })

  test('two independent causes are both named', () => {
    const input = renovation(5)
    const baseline = captureBaseline('Contract baseline', '2026-01-05', solve(input), input)

    // Both the permit and the drywall run long, independently.
    const current = renovation(7, 8)
    const impact = explainImpact(
      diffAgainstBaseline(baseline, solve(current), current),
      current,
    )

    // Both are on the critical path, so they are ranked by how much each one
    // cost — the bigger cause is the one to go look at first.
    expect(impact.drivers.map((d) => [d.taskId, d.ownSlipDays])).toEqual([
      ['drywall', 3],
      ['permit', 2],
    ])
    expect(impact.summary).toContain('Drywall slipped 3 days, and Permit approval slipped 2 days')
  })
})
