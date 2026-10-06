import { describe, expect, test } from 'vitest'
import { captureBaseline, diffAgainstBaseline } from '../baseline.js'
import { solve } from '../cpm.js'
import { explainImpact } from '../impact.js'
import { ScheduleError, type CalendarDef, type ScheduleInput, type TaskInput } from '../types.js'

const MON_FRI: CalendarDef = { id: 'std', name: 'Mon–Fri', workingWeekdays: [1, 2, 3, 4, 5] }

/**
 * The same four-step renovation used throughout: permit → framing → drywall →
 * handover. Planned, with no progress applied, it runs 2026-01-05 to 2026-02-02.
 */
function renovation(
  overrides: Record<string, Partial<TaskInput>> = {},
  extra: Partial<ScheduleInput> = {},
): ScheduleInput {
  const base: TaskInput[] = [
    { id: 'permit', name: 'Permit approval', durationDays: 5 },
    { id: 'framing', name: 'Framing', durationDays: 10 },
    { id: 'drywall', name: 'Drywall', durationDays: 5 },
    { id: 'handover', name: 'Handover', durationDays: 0 },
  ]
  return {
    projectStart: '2026-01-05',
    defaultCalendarId: 'std',
    calendars: [MON_FRI],
    tasks: base.map((t) => ({ ...t, ...overrides[t.id] })),
    dependencies: [
      { predecessorId: 'permit', successorId: 'framing', type: 'FS' },
      { predecessorId: 'framing', successorId: 'drywall', type: 'FS' },
      { predecessorId: 'drywall', successorId: 'handover', type: 'FS' },
    ],
    ...extra,
  }
}

describe('the plan is unchanged when no progress is applied', () => {
  test('every task is not-started and the schedule matches the pure plan', () => {
    const result = solve(renovation())
    expect(result.dataDate).toBeNull()
    expect(result.projectFinish).toBe('2026-02-02')
    for (const task of Object.values(result.tasks)) {
      expect(task.status).toBe('not-started')
      expect(task.isForecast).toBe(true)
    }
    expect(result.tasks['permit']!.remainingDays).toBe(5)
  })
})

describe('completed work is fact, not forecast', () => {
  const result = solve(
    renovation(
      {
        // The permit took eight days instead of five.
        permit: { actualStart: '2026-01-05', actualFinish: '2026-01-14' },
        framing: { actualStart: '2026-01-15', percentComplete: 20 },
      },
      { dataDate: '2026-01-19' },
    ),
  )

  test('a finished task keeps its actual dates', () => {
    expect(result.tasks['permit']).toMatchObject({
      status: 'complete',
      isForecast: false,
      earlyStart: '2026-01-05',
      earlyFinish: '2026-01-14',
      remainingDays: 0,
    })
  })

  test('finished work never appears on the critical path', () => {
    // It cannot slip, so calling it critical would be noise.
    expect(result.tasks['permit']!.isCritical).toBe(false)
    expect(result.criticalPath).not.toContain('permit')
    expect(result.criticalPath).toContain('framing')
  })

  test('float on a started task measures the remaining work, not the recorded start', () => {
    // Regression guard. Framing actually started 2026-01-15 and its late start
    // computes to 2026-01-19, so comparing those two gives a phantic 2 days of
    // float and drops framing off the critical path. The start already
    // happened; only the eight days still in front of it have any slack, and
    // they have none.
    expect(result.tasks['framing']!.totalFloat).toBe(0)
    expect(result.tasks['framing']!.isCritical).toBe(true)
  })

  test('an in-progress task keeps its actual start and forecasts the rest', () => {
    // 20% of ten days done leaves eight, resuming at the data date.
    expect(result.tasks['framing']).toMatchObject({
      status: 'in-progress',
      isForecast: true,
      earlyStart: '2026-01-15',
      earlyFinish: '2026-01-28',
      remainingDays: 8,
    })
  })

  test('downstream work is forecast from the revised finish', () => {
    expect(result.tasks['drywall']).toMatchObject({
      status: 'not-started',
      earlyStart: '2026-01-29',
      earlyFinish: '2026-02-04',
    })
    expect(result.projectFinish).toBe('2026-02-05')
    expect(result.dataDate).toBe('2026-01-19')
  })
})

describe('the data date is what stops a stalled task reporting on time', () => {
  test('remaining work resumes at the data date, not at the original start', () => {
    const result = solve(
      renovation(
        // Started three weeks ago, still five days of work left: it stalled.
        { permit: { actualStart: '2026-01-05', remainingDays: 5 } },
        { dataDate: '2026-01-19' },
      ),
    )
    // Without a data date this would still claim to finish on 2026-01-09.
    expect(result.tasks['permit']).toMatchObject({
      status: 'in-progress',
      earlyStart: '2026-01-05',
      earlyFinish: '2026-01-23',
    })
  })

  test('unstarted work is never forecast to have begun in the past', () => {
    const result = solve(renovation({}, { dataDate: '2026-01-19' }))
    // The permit was planned for 2026-01-05 but nobody started it.
    expect(result.tasks['permit']!.earlyStart).toBe('2026-01-19')
  })

  test('a started task with no progress reported is assumed to have tracked the plan', () => {
    const result = solve(
      renovation({ permit: { actualStart: '2026-01-05' } }, { dataDate: '2026-01-12' }),
    )
    // Five working days elapsed against a five-day task, so nothing is left.
    // Generous by design — which is why reporting real progress has to be easy.
    expect(result.tasks['permit']).toMatchObject({
      status: 'in-progress',
      remainingDays: 0,
      earlyFinish: '2026-01-09',
    })
  })
})

describe('out-of-sequence progress', () => {
  // Framing started on plan even though the permit is still open — the single
  // most common thing a real schedule has to cope with.
  const outOfSequence = (mode: ScheduleInput['outOfSequence']) =>
    solve(
      renovation(
        {
          permit: { actualStart: '2026-01-05', remainingDays: 5 },
          framing: { actualStart: '2026-01-12', remainingDays: 10 },
        },
        { dataDate: '2026-01-19', ...(mode ? { outOfSequence: mode } : {}) },
      ),
    )

  test('retained logic makes the remaining work wait for the predecessor', () => {
    const result = outOfSequence('retained')
    // The permit now forecasts finishing 2026-01-23, so framing's remaining ten
    // days cannot resume until 2026-01-26.
    expect(result.tasks['permit']!.earlyFinish).toBe('2026-01-23')
    expect(result.tasks['framing']).toMatchObject({
      earlyStart: '2026-01-12',
      earlyFinish: '2026-02-06',
    })
  })

  test('progress override lets work already under way carry on', () => {
    const result = outOfSequence('progress-override')
    expect(result.tasks['framing']).toMatchObject({
      earlyStart: '2026-01-12',
      earlyFinish: '2026-01-30',
    })
  })

  test('retained is the default', () => {
    expect(outOfSequence(undefined).tasks['framing']!.earlyFinish).toBe(
      outOfSequence('retained').tasks['framing']!.earlyFinish,
    )
  })
})

describe('variance against a baseline, once progress exists', () => {
  const plan = renovation()
  const baseline = captureBaseline('Contract baseline', '2026-01-05', solve(plan), plan)

  const current = renovation(
    {
      permit: { actualStart: '2026-01-05', actualFinish: '2026-01-14' },
      framing: { actualStart: '2026-01-15', percentComplete: 20 },
    },
    { dataDate: '2026-01-19' },
  )
  const variance = diffAgainstBaseline(baseline, solve(current), current)
  const impact = explainImpact(variance, current)

  test('the forecast is measured against the plan of record', () => {
    expect(variance.projectFinishVarianceDays).toBe(3)
    expect(variance.currentProjectFinish).toBe('2026-02-05')
  })

  test('the completed permit is named as the single cause', () => {
    expect(impact.drivers).toHaveLength(1)
    expect(impact.drivers[0]).toMatchObject({
      taskId: 'permit',
      ownSlipDays: 3,
      status: 'complete',
    })
  })

  test('a cause that is already finished says the time cannot be made up there', () => {
    expect(impact.summary).toBe(
      'Completion moved 3 days later, to 2026-02-05. ' +
        'Cause: Permit approval slipped 3 days. ' +
        'That work is finished, so the time cannot be made up there.',
    )
  })
})

describe('rejections', () => {
  test('finishing before starting is caught', () => {
    expect(() =>
      solve(
        renovation({ permit: { actualStart: '2026-01-14', actualFinish: '2026-01-05' } }),
      ),
    ).toThrow(ScheduleError)
    expect(() =>
      solve(
        renovation({ permit: { actualStart: '2026-01-14', actualFinish: '2026-01-05' } }),
      ),
    ).toThrow(/before it started/)
  })

  test('an impossible percentage is caught', () => {
    expect(() =>
      solve(renovation({ permit: { actualStart: '2026-01-05', percentComplete: 150 } })),
    ).toThrow(/between 0 and 100/)
  })

  test('negative remaining work is caught', () => {
    expect(() =>
      solve(renovation({ permit: { actualStart: '2026-01-05', remainingDays: -3 } })),
    ).toThrow(/must not be negative/)
  })
})
