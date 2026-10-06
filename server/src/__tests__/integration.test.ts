/**
 * End-to-end verification against a real Postgres.
 *
 * Runs only when `TEST_DATABASE_URL` is set — there is no Postgres on the dev
 * machine, so these skip locally and run against the NAS instance (or any
 * throwaway database) via:
 *
 *   TEST_DATABASE_URL=postgresql://... npm test
 *
 * They deliberately exercise the whole stack rather than mocking the database.
 * The parts most likely to break — DATE round-tripping, `unnest` bulk updates,
 * transaction rollback on a cycle — are exactly the parts a mock would hide.
 */

import { afterAll, beforeAll, describe, expect, test } from 'vitest'

const DATABASE_URL = process.env.TEST_DATABASE_URL
const describeIfDb = DATABASE_URL ? describe : describe.skip

if (!DATABASE_URL) {
  console.log('[integration] TEST_DATABASE_URL not set — skipping database tests')
}

describeIfDb('schedule persistence round trip', () => {
  let pool: import('pg').Pool
  let transaction: typeof import('../db/pool.js').transaction
  let schedule: typeof import('../services/schedule.js')
  let companyId: string
  let calendarId: string
  let projectId: string

  beforeAll(async () => {
    process.env.DATABASE_URL = DATABASE_URL
    process.env.JWT_SECRET ??= 'test-secret-not-used-for-anything-real'

    const poolModule = await import('../db/pool.js')
    const migrateModule = await import('../db/migrate.js')
    schedule = await import('../services/schedule.js')
    pool = poolModule.pool
    transaction = poolModule.transaction

    await migrateModule.migrate()

    // A disposable company per run, so repeat runs never collide.
    const slug = `test-${Math.abs(Date.now() % 1_000_000)}`
    const company = await pool.query<{ id: string }>(
      `INSERT INTO companies (name, slug, plan, status, max_projects)
       VALUES ('Integration Test Co', $1, 'partner', 'active', 100) RETURNING id`,
      [slug],
    )
    companyId = company.rows[0]!.id

    const calendar = await pool.query<{ id: string }>(
      `INSERT INTO calendars (company_id, name, working_weekdays, holidays, is_default)
       VALUES ($1, 'Mon–Fri', '{1,2,3,4,5}', '{}', TRUE) RETURNING id`,
      [companyId],
    )
    calendarId = calendar.rows[0]!.id

    const project = await pool.query<{ id: string }>(
      `INSERT INTO projects (company_id, name, calendar_id, start_date)
       VALUES ($1, 'Renovation', $2, DATE '2026-01-05') RETURNING id`,
      [companyId, calendarId],
    )
    projectId = project.rows[0]!.id
  })

  afterAll(async () => {
    if (companyId) await pool.query('DELETE FROM companies WHERE id = $1', [companyId])
    await pool.end()
  })

  test('dates survive the round trip without shifting a day', async () => {
    // The failure this guards against is timezone-dependent: node-postgres
    // parsing DATE into a local-midnight JS Date turns 2026-01-05 into
    // 2026-01-04 anywhere west of UTC.
    const { rows } = await pool.query<{ start_date: string }>(
      'SELECT start_date::text AS start_date FROM projects WHERE id = $1',
      [projectId],
    )
    expect(rows[0]!.start_date).toBe('2026-01-05')
  })

  test('a chain solves and the computed columns are written back', async () => {
    const ids = await transaction(async (client) => {
      const made: Record<string, string> = {}
      for (const [key, name, duration] of [
        ['permit', 'Permit approval', 5],
        ['framing', 'Framing', 10],
        ['drywall', 'Drywall', 5],
        ['handover', 'Handover', 0],
      ] as const) {
        const row = await client.query<{ id: string }>(
          `INSERT INTO tasks (project_id, name, duration_days) VALUES ($1, $2, $3) RETURNING id`,
          [projectId, name, duration],
        )
        made[key] = row.rows[0]!.id
      }
      for (const [from, to] of [
        ['permit', 'framing'],
        ['framing', 'drywall'],
        ['drywall', 'handover'],
      ] as const) {
        await client.query(
          `INSERT INTO dependencies (project_id, predecessor_id, successor_id, type)
           VALUES ($1, $2, $3, 'FS')`,
          [projectId, made[from], made[to]],
        )
      }
      await schedule.resolveProject(client, projectId)
      return made
    })

    const { rows } = await pool.query<{
      name: string
      computed_early_start: string
      computed_early_finish: string
      computed_is_critical: boolean
    }>(
      `SELECT name,
              computed_early_start::text  AS computed_early_start,
              computed_early_finish::text AS computed_early_finish,
              computed_is_critical
       FROM tasks WHERE id = ANY($1::uuid[]) ORDER BY computed_early_start`,
      [Object.values(ids)],
    )

    expect(rows[0]).toMatchObject({
      name: 'Permit approval',
      computed_early_start: '2026-01-05',
      computed_early_finish: '2026-01-09',
      computed_is_critical: true,
    })
    // Weekends are skipped by the calendar, not by counting days.
    expect(rows[1]).toMatchObject({ computed_early_start: '2026-01-12' })

    const project = await pool.query<{ computed_finish: string }>(
      'SELECT computed_finish::text AS computed_finish FROM projects WHERE id = $1',
      [projectId],
    )
    expect(project.rows[0]!.computed_finish).toBe('2026-02-02')
  })

  test('a baseline is captured, then a slip is explained against it', async () => {
    await transaction(async (client) => {
      await schedule.storeBaseline(client, projectId, 'Contract baseline', null)
    })

    const permit = await pool.query<{ id: string }>(
      `SELECT id FROM tasks WHERE project_id = $1 AND name = 'Permit approval'`,
      [projectId],
    )
    const permitId = permit.rows[0]!.id

    const change = await transaction(async (client) =>
      schedule.applyAndExplain(
        client,
        { projectId, taskId: permitId, actorId: null, action: 'task.update', field: 'duration_days' },
        async () => {
          await client.query('UPDATE tasks SET duration_days = 8 WHERE id = $1', [permitId])
        },
      ),
    )

    expect(change.finishBefore).toBe('2026-02-02')
    expect(change.finishAfter).toBe('2026-02-05')
    expect(change.finishMovedDays).toBe(3)
    // The baseline exists, so the cause is named rather than merely reported.
    expect(change.impact?.summary).toBe(
      'Completion moved 3 days later, to 2026-02-05. ' +
        'Cause: Permit approval slipped 3 days. It is on the critical path.',
    )

    const log = await pool.query<{ impact_days: number; summary: string }>(
      'SELECT impact_days, summary FROM change_log WHERE project_id = $1 ORDER BY created_at DESC LIMIT 1',
      [projectId],
    )
    expect(log.rows[0]!.impact_days).toBe(3)
  })

  test('a dependency cycle is rejected and nothing is left behind', async () => {
    const tasks = await pool.query<{ id: string; name: string }>(
      `SELECT id, name FROM tasks WHERE project_id = $1`,
      [projectId],
    )
    const handover = tasks.rows.find((t) => t.name === 'Handover')!
    const permit = tasks.rows.find((t) => t.name === 'Permit approval')!

    const before = await pool.query<{ count: string }>(
      'SELECT COUNT(*) AS count FROM dependencies WHERE project_id = $1',
      [projectId],
    )

    await expect(
      transaction(async (client) =>
        schedule.applyAndExplain(
          client,
          { projectId, actorId: null, action: 'dependency.create' },
          async () => {
            await client.query(
              `INSERT INTO dependencies (project_id, predecessor_id, successor_id, type)
               VALUES ($1, $2, $3, 'FS')`,
              [projectId, handover.id, permit.id],
            )
          },
        ),
      ),
    ).rejects.toThrow(/Circular dependency/)

    // The whole transaction rolled back, so the bad link was never stored.
    const after = await pool.query<{ count: string }>(
      'SELECT COUNT(*) AS count FROM dependencies WHERE project_id = $1',
      [projectId],
    )
    expect(after.rows[0]!.count).toBe(before.rows[0]!.count)
  })

  test('self-links are rejected by the database, not just the engine', async () => {
    const task = await pool.query<{ id: string }>(
      `SELECT id FROM tasks WHERE project_id = $1 LIMIT 1`,
      [projectId],
    )
    const id = task.rows[0]!.id
    await expect(
      pool.query(
        `INSERT INTO dependencies (project_id, predecessor_id, successor_id, type)
         VALUES ($1, $2, $2, 'FS')`,
        [projectId, id],
      ),
    ).rejects.toThrow(/dependencies_no_self_link/)
  })

  test('only one baseline can be the plan of record', async () => {
    await transaction(async (client) => {
      await schedule.storeBaseline(client, projectId, 'Revision 1', null)
    })
    const { rows } = await pool.query<{ count: string }>(
      'SELECT COUNT(*) AS count FROM baselines WHERE project_id = $1 AND is_active',
      [projectId],
    )
    expect(rows[0]!.count).toBe('1')
  })
})
