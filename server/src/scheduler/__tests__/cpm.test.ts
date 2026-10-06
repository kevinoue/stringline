import { describe, expect, test } from 'vitest'
import { solve } from '../cpm.js'
import { ScheduleError, type CalendarDef, type ScheduleInput } from '../types.js'

/** Every day works, so working days equal calendar days and CPM math is isolated. */
const EVERY_DAY: CalendarDef = {
  id: 'every',
  name: 'Every day',
  workingWeekdays: [0, 1, 2, 3, 4, 5, 6],
}

const MON_FRI: CalendarDef = {
  id: 'std',
  name: 'Mon–Fri',
  workingWeekdays: [1, 2, 3, 4, 5],
}

/** 2026-01-05 is a Monday — the anchor for every fixture below. */
const MONDAY = '2026-01-05'

function build(partial: Partial<ScheduleInput> & Pick<ScheduleInput, 'tasks'>): ScheduleInput {
  return {
    projectStart: MONDAY,
    defaultCalendarId: MON_FRI.id,
    calendars: [MON_FRI],
    dependencies: [],
    ...partial,
  }
}

describe('golden network — classic six-task CPM', () => {
  // A(3) ─┬─ B(4) ── D(5) ─┬─ F(2)
  //       └─ C(2) ── E(1) ─┘
  // Hand-computed critical path is A → B → D → F, total duration 14 days.
  const input: ScheduleInput = {
    projectStart: MONDAY,
    defaultCalendarId: EVERY_DAY.id,
    calendars: [EVERY_DAY],
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

  const result = solve(input)

  test('early dates match the hand-computed forward pass', () => {
    expect(result.tasks['A']).toMatchObject({ earlyStart: '2026-01-05', earlyFinish: '2026-01-07' })
    expect(result.tasks['B']).toMatchObject({ earlyStart: '2026-01-08', earlyFinish: '2026-01-11' })
    expect(result.tasks['C']).toMatchObject({ earlyStart: '2026-01-08', earlyFinish: '2026-01-09' })
    expect(result.tasks['D']).toMatchObject({ earlyStart: '2026-01-12', earlyFinish: '2026-01-16' })
    expect(result.tasks['E']).toMatchObject({ earlyStart: '2026-01-10', earlyFinish: '2026-01-10' })
    expect(result.tasks['F']).toMatchObject({ earlyStart: '2026-01-17', earlyFinish: '2026-01-18' })
  })

  test('late dates match the hand-computed backward pass', () => {
    expect(result.tasks['A']).toMatchObject({ lateStart: '2026-01-05', lateFinish: '2026-01-07' })
    expect(result.tasks['B']).toMatchObject({ lateStart: '2026-01-08', lateFinish: '2026-01-11' })
    expect(result.tasks['C']).toMatchObject({ lateStart: '2026-01-14', lateFinish: '2026-01-15' })
    expect(result.tasks['D']).toMatchObject({ lateStart: '2026-01-12', lateFinish: '2026-01-16' })
    expect(result.tasks['E']).toMatchObject({ lateStart: '2026-01-16', lateFinish: '2026-01-16' })
    expect(result.tasks['F']).toMatchObject({ lateStart: '2026-01-17', lateFinish: '2026-01-18' })
  })

  test('total float is zero on the critical chain and six on the slack branch', () => {
    expect(result.tasks['A']!.totalFloat).toBe(0)
    expect(result.tasks['B']!.totalFloat).toBe(0)
    expect(result.tasks['C']!.totalFloat).toBe(6)
    expect(result.tasks['D']!.totalFloat).toBe(0)
    expect(result.tasks['E']!.totalFloat).toBe(6)
    expect(result.tasks['F']!.totalFloat).toBe(0)
  })

  test('free float distinguishes slipping a task from slipping its successor', () => {
    // C has six days of total float but zero free float: slipping C moves E
    // immediately, even though the project finish holds.
    expect(result.tasks['C']!.freeFloat).toBe(0)
    // E owns the whole branch slack, because F is driven by D rather than by E.
    expect(result.tasks['E']!.freeFloat).toBe(6)
  })

  test('critical path is A → B → D → F', () => {
    expect(result.criticalPath).toEqual(['A', 'B', 'D', 'F'])
  })

  test('project finish and duration', () => {
    expect(result.projectFinish).toBe('2026-01-18')
    expect(result.durationWorkingDays).toBe(14)
  })
})

describe('working-day calendars', () => {
  test('a five-day task starting Monday finishes Friday, not mid-weekend', () => {
    const result = solve(
      build({
        tasks: [
          { id: 'A', name: 'Drywall', durationDays: 5 },
          { id: 'B', name: 'Paint', durationDays: 3 },
        ],
        dependencies: [{ predecessorId: 'A', successorId: 'B', type: 'FS' }],
      }),
    )
    expect(result.tasks['A']).toMatchObject({ earlyStart: '2026-01-05', earlyFinish: '2026-01-09' })
    // Skips Sat/Sun and resumes Monday.
    expect(result.tasks['B']).toMatchObject({ earlyStart: '2026-01-12', earlyFinish: '2026-01-14' })
  })

  test('a holiday mid-task pushes the finish out by a day', () => {
    const withHoliday: CalendarDef = { ...MON_FRI, holidays: ['2026-01-07'] }
    const result = solve(
      build({
        calendars: [withHoliday],
        tasks: [{ id: 'A', name: 'Inspection prep', durationDays: 3 }],
      }),
    )
    // Mon 5, Tue 6, Wed 7 is a holiday, so the third working day is Thu 8.
    expect(result.tasks['A']!.earlyFinish).toBe('2026-01-08')
  })

  test('a working exception overrides both the holiday and the weekend', () => {
    const saturdayPush: CalendarDef = {
      ...MON_FRI,
      holidays: ['2026-01-07'],
      workingExceptions: ['2026-01-07', '2026-01-10'],
    }
    const result = solve(
      build({
        calendars: [saturdayPush],
        tasks: [{ id: 'A', name: 'Push week', durationDays: 6 }],
      }),
    )
    // Mon 5, Tue 6, Wed 7 (exception beats holiday), Thu 8, Fri 9, Sat 10.
    expect(result.tasks['A']!.earlyFinish).toBe('2026-01-10')
  })

  test('a Tue–Sat crew starts Tuesday even when the project starts Monday', () => {
    const tueSat: CalendarDef = { id: 'crew', name: 'Tue–Sat', workingWeekdays: [2, 3, 4, 5, 6] }
    const result = solve(
      build({
        calendars: [MON_FRI, tueSat],
        tasks: [{ id: 'A', name: 'Roofing crew', durationDays: 3, calendarId: 'crew' }],
      }),
    )
    expect(result.tasks['A']).toMatchObject({ earlyStart: '2026-01-06', earlyFinish: '2026-01-08' })
  })

  test('a dependency across two different calendars lands on the successor’s working days', () => {
    const sunThu: CalendarDef = { id: 'alt', name: 'Sun–Thu', workingWeekdays: [0, 1, 2, 3, 4] }
    const result = solve(
      build({
        calendars: [MON_FRI, sunThu],
        tasks: [
          { id: 'A', name: 'Mon–Fri task', durationDays: 5 },
          { id: 'B', name: 'Sun–Thu task', durationDays: 2, calendarId: 'alt' },
        ],
        dependencies: [{ predecessorId: 'A', successorId: 'B', type: 'FS' }],
      }),
    )
    // A finishes Fri 2026-01-09 and frees at Mon 01-12; Monday is a working day
    // on the Sun–Thu calendar too, so B starts there.
    expect(result.tasks['A']!.earlyFinish).toBe('2026-01-09')
    expect(result.tasks['B']).toMatchObject({ earlyStart: '2026-01-12', earlyFinish: '2026-01-13' })
  })
})

describe('milestones', () => {
  test('a zero-duration milestone consumes no time', () => {
    const result = solve(
      build({
        tasks: [
          { id: 'A', name: 'Rough-in', durationDays: 2 },
          { id: 'M', name: 'Inspection passed', durationDays: 0 },
          { id: 'B', name: 'Insulation', durationDays: 1 },
        ],
        dependencies: [
          { predecessorId: 'A', successorId: 'M', type: 'FS' },
          { predecessorId: 'M', successorId: 'B', type: 'FS' },
        ],
      }),
    )
    // A occupies Mon–Tue. The milestone lands Wednesday, and B starts that same
    // Wednesday: passing through a milestone must not cost a day.
    expect(result.tasks['A']!.earlyFinish).toBe('2026-01-06')
    expect(result.tasks['M']).toMatchObject({
      earlyStart: '2026-01-07',
      earlyFinish: '2026-01-07',
      isMilestone: true,
    })
    expect(result.tasks['B']!.earlyStart).toBe('2026-01-07')
  })
})

describe('dependency types and lag', () => {
  test('FS with positive lag inserts a cure period in working days', () => {
    const result = solve(
      build({
        tasks: [
          { id: 'A', name: 'Pour slab', durationDays: 2 },
          { id: 'B', name: 'Strip forms', durationDays: 1 },
        ],
        dependencies: [{ predecessorId: 'A', successorId: 'B', type: 'FS', lagDays: 3 }],
      }),
    )
    // A frees at Wed 01-07; three working days later is Mon 01-12.
    expect(result.tasks['B']!.earlyStart).toBe('2026-01-12')
  })

  test('FS with negative lag overlaps the successor into the predecessor', () => {
    const result = solve(
      build({
        tasks: [
          { id: 'A', name: 'Framing', durationDays: 5 },
          { id: 'B', name: 'Electrical rough-in', durationDays: 3 },
        ],
        dependencies: [{ predecessorId: 'A', successorId: 'B', type: 'FS', lagDays: -2 }],
      }),
    )
    // A frees Mon 01-12; two working days back is Thu 01-08.
    expect(result.tasks['B']!.earlyStart).toBe('2026-01-08')
  })

  test('SS starts the successor relative to the predecessor’s start', () => {
    const result = solve(
      build({
        tasks: [
          { id: 'A', name: 'Excavation', durationDays: 10 },
          { id: 'B', name: 'Haul-off', durationDays: 8 },
        ],
        dependencies: [{ predecessorId: 'A', successorId: 'B', type: 'SS', lagDays: 2 }],
      }),
    )
    expect(result.tasks['B']!.earlyStart).toBe('2026-01-07')
  })

  test('FF ties the finishes together, back-solving the successor’s start', () => {
    const result = solve(
      build({
        tasks: [
          { id: 'A', name: 'Punch list', durationDays: 5 },
          { id: 'B', name: 'Final clean', durationDays: 2 },
        ],
        dependencies: [{ predecessorId: 'A', successorId: 'B', type: 'FF' }],
      }),
    )
    // Both finish Fri 01-09; B is two days long so it starts Thu 01-08.
    expect(result.tasks['A']!.earlyFinish).toBe('2026-01-09')
    expect(result.tasks['B']).toMatchObject({ earlyStart: '2026-01-08', earlyFinish: '2026-01-09' })
  })

  test('SF finishes the successor relative to the predecessor’s start', () => {
    const result = solve(
      build({
        tasks: [
          {
            id: 'A',
            name: 'New system online',
            durationDays: 5,
            constraintType: 'START_NO_EARLIER_THAN',
            constraintDate: '2026-01-19',
          },
          { id: 'B', name: 'Legacy system shutdown', durationDays: 3 },
        ],
        dependencies: [{ predecessorId: 'A', successorId: 'B', type: 'SF', lagDays: 2 }],
      }),
    )
    // SF is the one relationship that drives a successor *earlier* than its
    // predecessor: the old system stays up until two days after the new one
    // starts. A starts Mon 01-19, so B must be finished by Tue 01-20, which
    // puts its three days at Fri 01-16, Mon 01-19, Tue 01-20.
    expect(result.tasks['A']!.earlyStart).toBe('2026-01-19')
    expect(result.tasks['B']).toMatchObject({ earlyStart: '2026-01-16', earlyFinish: '2026-01-20' })
  })

  test('nothing is scheduled before the project start, even when SF pulls backwards', () => {
    const result = solve(
      build({
        tasks: [
          { id: 'A', name: 'New system online', durationDays: 5 },
          { id: 'B', name: 'Legacy system shutdown', durationDays: 3 },
        ],
        dependencies: [{ predecessorId: 'A', successorId: 'B', type: 'SF', lagDays: 2 }],
      }),
    )
    // Unclamped, SF would place B on 2026-01-02 — before the project exists.
    // The floor wins, and the relationship is still satisfied (B finishes on or
    // after A's start plus two days).
    expect(result.tasks['B']).toMatchObject({ earlyStart: '2026-01-05', earlyFinish: '2026-01-07' })
  })
})

describe('constraints', () => {
  test('START_NO_EARLIER_THAN holds a task back but predecessors can still push it later', () => {
    const result = solve(
      build({
        tasks: [
          { id: 'A', name: 'Mobilise', durationDays: 1 },
          {
            id: 'B',
            name: 'Permit window opens',
            durationDays: 2,
            constraintType: 'START_NO_EARLIER_THAN',
            constraintDate: '2026-01-14',
          },
        ],
        dependencies: [{ predecessorId: 'A', successorId: 'B', type: 'FS' }],
      }),
    )
    expect(result.tasks['B']!.earlyStart).toBe('2026-01-14')
  })

  test('MUST_START_ON pins the task and leaves it with no float', () => {
    const result = solve(
      build({
        tasks: [
          {
            id: 'A',
            name: 'Crane delivery',
            durationDays: 1,
            constraintType: 'MUST_START_ON',
            constraintDate: '2026-01-14',
          },
        ],
      }),
    )
    expect(result.tasks['A']).toMatchObject({
      earlyStart: '2026-01-14',
      lateStart: '2026-01-14',
      totalFloat: 0,
    })
  })

  test('FINISH_NO_LATER_THAN consumes float and goes negative when unachievable', () => {
    const result = solve(
      build({
        tasks: [
          { id: 'A', name: 'Long lead item', durationDays: 10 },
          {
            id: 'B',
            name: 'Must ship by',
            durationDays: 2,
            constraintType: 'FINISH_NO_LATER_THAN',
            constraintDate: '2026-01-16',
          },
        ],
        dependencies: [{ predecessorId: 'A', successorId: 'B', type: 'FS' }],
      }),
    )
    // A runs Mon 01-05 to Fri 01-16, so B cannot start before Mon 01-19 and
    // cannot possibly finish by Fri 01-16.
    expect(result.tasks['B']!.earlyStart).toBe('2026-01-19')
    expect(result.tasks['B']!.totalFloat).toBeLessThan(0)
  })
})

describe('project deadline', () => {
  test('a missed deadline produces negative float rather than a healthy-looking schedule', () => {
    const result = solve(
      build({
        projectDeadline: '2026-01-14',
        tasks: [
          { id: 'A', name: 'Phase one', durationDays: 5 },
          { id: 'B', name: 'Phase two', durationDays: 5 },
        ],
        dependencies: [{ predecessorId: 'A', successorId: 'B', type: 'FS' }],
      }),
    )
    expect(result.projectFinish).toBe('2026-01-16')
    expect(result.deadlineFloat).toBe(-2)
    expect(result.tasks['B']!.totalFloat).toBe(-2)
    expect(result.tasks['A']!.totalFloat).toBe(-2)
  })

  test('an achievable deadline reports positive float', () => {
    const result = solve(
      build({
        projectDeadline: '2026-01-23',
        tasks: [{ id: 'A', name: 'Phase one', durationDays: 5 }],
      }),
    )
    expect(result.deadlineFloat).toBe(10)
  })

  /**
   * A deadline moves the backward-pass anchor, which shifts every float. The
   * critical path has to survive that, because it is the one thing on the chart
   * that says *where to push*. Marking criticality at "float <= 0" did not: it
   * over-reported behind schedule and vanished entirely when ahead.
   */
  describe('the critical path survives a deadline', () => {
    // A(5) ─┬─ B(5) ─┬─ D(1)
    //       └─ C(1) ─┘
    // A → B → D is the chain that sets the finish. C has four days of slack
    // whatever the deadline says, so it must never be critical.
    const network = {
      tasks: [
        { id: 'A', name: 'Groundwork', durationDays: 5 },
        { id: 'B', name: 'Frame', durationDays: 5 },
        { id: 'C', name: 'Signage', durationDays: 1 },
        { id: 'D', name: 'Handover', durationDays: 1 },
      ],
      dependencies: [
        { predecessorId: 'A', successorId: 'B', type: 'FS' as const },
        { predecessorId: 'A', successorId: 'C', type: 'FS' as const },
        { predecessorId: 'B', successorId: 'D', type: 'FS' as const },
        { predecessorId: 'C', successorId: 'D', type: 'FS' as const },
      ],
    }

    test('with no deadline, the longest chain is critical', () => {
      const result = solve(build(network))
      expect(result.criticalPath.sort()).toEqual(['A', 'B', 'D'])
      expect(result.tasks['C']!.isCritical).toBe(false)
    })

    test('behind a deadline, only the longest chain is critical — not everything late', () => {
      const result = solve(build({ ...network, projectDeadline: '2026-01-12' }))

      // Everything is late, so every float is negative...
      expect(result.deadlineFloat!).toBeLessThan(0)
      expect(result.tasks['C']!.totalFloat).toBeLessThan(0)

      // ...but being late is not the same as being the reason. C still has
      // slack relative to the chain beside it, so it stays off the path.
      expect(result.criticalPath.sort()).toEqual(['A', 'B', 'D'])
      expect(result.tasks['C']!.isCritical).toBe(false)
    })

    test('comfortably ahead of a deadline, there is still a critical path', () => {
      const result = solve(build({ ...network, projectDeadline: '2026-06-01' }))

      // Nothing is anywhere near zero float here. Requiring float <= 0 reported
      // no critical path at all, which is the chart quietly losing its point
      // precisely when the project is healthy.
      expect(result.tasks['A']!.totalFloat).toBeGreaterThan(0)
      expect(result.criticalPath.sort()).toEqual(['A', 'B', 'D'])
      expect(result.tasks['C']!.isCritical).toBe(false)
    })

    test('completed work never sets the bar for what counts as critical', () => {
      // A is done, so its float is irrelevant — and must not become the
      // minimum that everything else is measured against.
      const result = solve(
        build({
          ...network,
          tasks: [
            { ...network.tasks[0]!, actualStart: '2026-01-05', actualFinish: '2026-01-09' },
            ...network.tasks.slice(1),
          ],
          dataDate: '2026-01-12',
        }),
      )
      expect(result.tasks['A']!.isCritical).toBe(false)
      expect(result.criticalPath.sort()).toEqual(['B', 'D'])
    })
  })
})

describe('rejections', () => {
  test('a dependency cycle is reported with the actual loop, not a hang', () => {
    const attempt = () =>
      solve(
        build({
          tasks: [
            { id: 'A', name: 'A', durationDays: 1 },
            { id: 'B', name: 'B', durationDays: 1 },
            { id: 'C', name: 'C', durationDays: 1 },
          ],
          dependencies: [
            { predecessorId: 'A', successorId: 'B', type: 'FS' },
            { predecessorId: 'B', successorId: 'C', type: 'FS' },
            { predecessorId: 'C', successorId: 'A', type: 'FS' },
          ],
        }),
      )
    expect(attempt).toThrow(ScheduleError)
    try {
      attempt()
    } catch (error) {
      const err = error as ScheduleError
      expect(err.code).toBe('CYCLE')
      // The loop is named, and closes back on itself.
      expect(err.detail.length).toBe(4)
      expect(err.detail[0]).toBe(err.detail[3])
      expect(new Set(err.detail)).toEqual(new Set(['A', 'B', 'C']))
    }
  })

  test('a self-dependency is caught', () => {
    expect(() =>
      solve(
        build({
          tasks: [{ id: 'A', name: 'A', durationDays: 1 }],
          dependencies: [{ predecessorId: 'A', successorId: 'A', type: 'FS' }],
        }),
      ),
    ).toThrow(/depends on itself/)
  })

  test('an unknown predecessor is named', () => {
    expect(() =>
      solve(
        build({
          tasks: [{ id: 'A', name: 'A', durationDays: 1 }],
          dependencies: [{ predecessorId: 'GHOST', successorId: 'A', type: 'FS' }],
        }),
      ),
    ).toThrow(/unknown predecessor "GHOST"/)
  })

  test('a calendar with no working days is rejected up front', () => {
    expect(() =>
      solve(
        build({
          calendars: [{ id: 'std', name: 'Never', workingWeekdays: [] }],
          tasks: [{ id: 'A', name: 'A', durationDays: 1 }],
        }),
      ),
    ).toThrow(/no working weekdays/)
  })

  test('a negative duration is rejected', () => {
    expect(() =>
      solve(build({ tasks: [{ id: 'A', name: 'A', durationDays: -1 }] })),
    ).toThrow(/non-negative/)
  })

  test('a constraint without its date is rejected', () => {
    expect(() =>
      solve(
        build({
          tasks: [
            { id: 'A', name: 'A', durationDays: 1, constraintType: 'START_NO_EARLIER_THAN' },
          ],
        }),
      ),
    ).toThrow(/no constraintDate/)
  })
})
