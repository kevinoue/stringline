/**
 * Projects, tasks, dependencies, baselines.
 *
 * Every route that can move a date goes through `applyAndExplain`, so the
 * response carries the impact banner and `change_log` gets a row. That is the
 * product: not "saved", but "saved, and here is what it cost you."
 */

import { Router, type Request, type Response } from 'express'
import { transaction } from '../db/pool.js'
import { authenticate, requirePlanner } from '../middleware/auth.js'
import { checkCompanyLimit, requireCompany } from '../middleware/company.js'
import { ScheduleError } from '../scheduler/index.js'
import { previewMove, unconstrainedStart, type MoveMode } from '../services/moves.js'
import { removeStoredFiles } from '../services/files.js'
import { buildSummary } from '../services/summary.js'
import {
  createProjectFromTemplate,
  deleteTemplate,
  listTemplates,
  saveProjectAsTemplate,
} from '../services/templates.js'
import {
  applyAndExplain,
  loadActiveBaseline,
  loadScheduleInput,
  resolveProject,
  storeBaseline,
} from '../services/schedule.js'
import { broadcast } from './sse.js'
import { param } from './util.js'

const router = Router()

router.use(authenticate)
router.use(requireCompany)

/** Confirm a project belongs to the caller's company before touching it. */
async function ownsProject(
  client: { query: (q: string, v: unknown[]) => Promise<{ rows: unknown[] }> },
  projectId: string,
  companyId: string,
): Promise<boolean> {
  const { rows } = await client.query(
    'SELECT 1 FROM projects WHERE id = $1 AND company_id = $2',
    [projectId, companyId],
  )
  return rows.length > 0
}

/**
 * Scheduling errors are the user's mistake far more often than ours — a cycle,
 * an impossible constraint — so they get a 422 naming the problem rather than a
 * generic 500.
 */
function handleError(res: Response, error: unknown, context: string): void {
  if (error instanceof ScheduleError) {
    res.status(422).json({ error: error.message, code: error.code, detail: error.detail })
    return
  }

  // Database-level rejections are also the user's input, not our bug. Surfacing
  // them as 500s would send someone digging through server logs for what is
  // really a bad form submission.
  const pg = error as { code?: string; constraint?: string }
  if (pg.code === '23514') {
    const friendly: Record<string, string> = {
      tasks_constraint_needs_date: 'A constraint other than ASAP needs a date.',
      tasks_finish_after_start: 'A task cannot finish before it started.',
      dependencies_no_self_link: 'A task cannot depend on itself.',
    }
    res.status(422).json({
      error: friendly[pg.constraint ?? ''] ?? 'That change violates a data rule.',
      code: 'CHECK_VIOLATION',
    })
    return
  }
  if (pg.code === '23505') {
    res.status(409).json({ error: 'That link already exists.', code: 'DUPLICATE' })
    return
  }

  console.error(`[${context}]`, (error as Error).message)
  res.status(500).json({ error: 'Internal error' })
}

// ── Projects ─────────────────────────────────────────────────────────────────

router.get('/', async (req: Request, res: Response) => {
  const { rows } = await transaction(async (client) =>
    client.query(
      `SELECT id, name, start_date::text AS start_date, deadline::text AS deadline,
              data_date::text AS data_date, computed_finish::text AS computed_finish, status
       FROM projects WHERE company_id = $1 AND status = 'active'
       ORDER BY created_at DESC`,
      [req.company!.id],
    ),
  )
  res.json({ projects: rows })
})

router.post(
  '/',
  requirePlanner,
  checkCompanyLimit('projects'),
  async (req: Request, res: Response) => {
    const { name, startDate, deadline, calendarId } = req.body ?? {}
    if (!name || !startDate) {
      res.status(400).json({ error: 'name and startDate are required' })
      return
    }

    try {
      const project = await transaction(async (client) => {
        let calendar = calendarId
        if (!calendar) {
          const found = await client.query<{ id: string }>(
            'SELECT id FROM calendars WHERE company_id = $1 AND is_default LIMIT 1',
            [req.company!.id],
          )
          calendar = found.rows[0]?.id
        }
        if (!calendar) throw new Error('No calendar available for this company')

        const inserted = await client.query(
          `INSERT INTO projects (company_id, name, calendar_id, start_date, deadline)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING id, name, start_date::text AS start_date, deadline::text AS deadline`,
          [req.company!.id, name, calendar, startDate, deadline ?? null],
        )
        return inserted.rows[0]
      })
      res.status(201).json({ project })
    } catch (error) {
      handleError(res, error, 'create-project')
    }
  },
)

// ── Templates ────────────────────────────────────────────────────────────────
//
// Mounted under /projects because that is what they produce. Built-in templates
// have a NULL company_id and are visible to everyone; saved ones belong to the
// company that made them.

router.get('/templates', async (req: Request, res: Response) => {
  try {
    const templates = await transaction((client) => listTemplates(client, req.company!.id))
    res.json({ templates })
  } catch (error) {
    handleError(res, error, 'list-templates')
  }
})

router.post(
  '/from-template',
  requirePlanner,
  checkCompanyLimit('projects'),
  async (req: Request, res: Response) => {
    const { templateId, name, startDate, deadline } = req.body ?? {}
    if (!templateId || !name || !startDate) {
      res.status(400).json({ error: 'templateId, name and startDate are required' })
      return
    }
    try {
      const made = await transaction((client) =>
        createProjectFromTemplate(
          client,
          templateId,
          req.company!.id,
          name,
          startDate,
          deadline ?? null,
        ),
      )
      if (!made) {
        res.status(404).json({ error: 'Template not found' })
        return
      }
      res.status(201).json(made)
    } catch (error) {
      handleError(res, error, 'from-template')
    }
  },
)

router.post('/:projectId/save-as-template', requirePlanner, async (req: Request, res: Response) => {
  const projectId = param(req, 'projectId')
  const { name, description, category } = req.body ?? {}
  if (!name) {
    res.status(400).json({ error: 'name is required' })
    return
  }
  try {
    const templateId = await transaction(async (client) => {
      if (!(await ownsProject(client, projectId, req.company!.id))) return null
      return saveProjectAsTemplate(
        client,
        projectId,
        req.company!.id,
        req.user!.id,
        String(name),
        description ?? null,
        category ?? 'general',
      )
    })
    if (!templateId) {
      res.status(404).json({ error: 'Project not found' })
      return
    }
    res.status(201).json({ templateId })
  } catch (error) {
    handleError(res, error, 'save-as-template')
  }
})

router.delete('/templates/:templateId', requirePlanner, async (req: Request, res: Response) => {
  try {
    const gone = await transaction((client) =>
      deleteTemplate(client, param(req, 'templateId'), req.company!.id),
    )
    if (!gone) {
      // Built-ins are not deletable, and neither is another company's template.
      res.status(404).json({ error: 'Template not found' })
      return
    }
    res.status(204).end()
  } catch (error) {
    handleError(res, error, 'delete-template')
  }
})

/** Archive a project. Soft — the change log and baselines are worth keeping. */
router.delete('/:projectId', requirePlanner, async (req: Request, res: Response) => {
  const projectId = param(req, 'projectId')
  try {
    const gone = await transaction(async (client) => {
      if (!(await ownsProject(client, projectId, req.company!.id))) return false
      await client.query(
        `UPDATE projects SET status = 'archived', updated_at = NOW() WHERE id = $1`,
        [projectId],
      )
      return true
    })
    if (!gone) {
      res.status(404).json({ error: 'Project not found' })
      return
    }
    res.status(204).end()
  } catch (error) {
    handleError(res, error, 'archive-project')
  }
})

/** The full solved schedule — what the Gantt renders. */
router.get('/:projectId/schedule', async (req: Request, res: Response) => {
  try {
    const payload = await transaction(async (client) => {
      if (!(await ownsProject(client, param(req, 'projectId'), req.company!.id))) return null
      const result = await resolveProject(client, param(req, 'projectId'))
      const baseline = await loadActiveBaseline(client, param(req, 'projectId'))
      // The Gantt draws real dependency arrows from this. Inferring links from
      // which dates happen to line up produces confident, wrong arrows.
      const dependencies = await client.query(
        `SELECT id, predecessor_id AS "predecessorId", successor_id AS "successorId",
                type, lag_days AS "lagDays"
         FROM dependencies WHERE project_id = $1`,
        [param(req, 'projectId')],
      )
      // The solved schedule carries computed dates; the editor needs the raw
      // inputs behind them. Returning both in one response keeps the panel from
      // needing a second round trip every time a row is selected.
      const details = await client.query(
        `SELECT id, name, duration_days AS "durationDays", phase_id AS "phaseId",
                constraint_type AS "constraintType",
                constraint_date::text AS "constraintDate",
                actual_start::text    AS "actualStart",
                actual_finish::text   AS "actualFinish",
                percent_complete      AS "percentComplete",
                remaining_days        AS "remainingDays",
                visibility, sort_order AS "sortOrder"
         FROM tasks WHERE project_id = $1`,
        [param(req, 'projectId')],
      )
      // Phases come back whether or not any exist. They are how the mobile
      // chart stays legible — six rolled-up bars fit a phone where twenty-two
      // tasks do not — so the client needs the grouping, not just each task's
      // phase_id.
      const phases = await client.query(
        `SELECT id, name, sort_order AS "sortOrder", visibility
           FROM phases WHERE project_id = $1 ORDER BY sort_order, name`,
        [param(req, 'projectId')],
      )
      return {
        schedule: result,
        baseline,
        dependencies: dependencies.rows,
        details: details.rows,
        phases: phases.rows,
      }
    })
    if (!payload) {
      res.status(404).json({ error: 'Project not found' })
      return
    }
    res.json(payload)
  } catch (error) {
    handleError(res, error, 'schedule')
  }
})

/**
 * What a free client seat sees: phases, milestones, and the completion date.
 * Not individual tasks, not crew notes, not internal float.
 */
router.get('/:projectId/client-view', async (req: Request, res: Response) => {
  try {
    const payload = await transaction(async (client) => {
      if (!(await ownsProject(client, param(req, 'projectId'), req.company!.id))) return null
      const result = await resolveProject(client, param(req, 'projectId'))

      const visible = await client.query<{ id: string }>(
        `SELECT t.id FROM tasks t
         LEFT JOIN phases p ON p.id = t.phase_id
         WHERE t.project_id = $1
           AND t.visibility = 'client'
           AND (p.id IS NULL OR p.visibility = 'client')`,
        [param(req, 'projectId')],
      )
      const allowed = new Set(visible.rows.map((r) => r.id))

      return {
        projectFinish: result.projectFinish,
        dataDate: result.dataDate,
        milestones: Object.values(result.tasks)
          .filter((t) => allowed.has(t.id))
          .map((t) => ({
            id: t.id,
            name: t.name,
            date: t.earlyFinish,
            status: t.status,
          })),
      }
    })
    if (!payload) {
      res.status(404).json({ error: 'Project not found' })
      return
    }
    res.json(payload)
  } catch (error) {
    handleError(res, error, 'client-view')
  }
})

// ── Tasks ────────────────────────────────────────────────────────────────────

router.post('/:projectId/tasks', requirePlanner, async (req: Request, res: Response) => {
  const projectId = param(req, 'projectId')
  const { name, durationDays, phaseId, calendarId, constraintType, constraintDate, visibility } =
    req.body ?? {}

  if (!name || durationDays === undefined) {
    res.status(400).json({ error: 'name and durationDays are required' })
    return
  }

  try {
    const payload = await transaction(async (client) => {
      if (!(await ownsProject(client, projectId, req.company!.id))) return null

      let taskId: string | null = null
      const change = await applyAndExplain(
        client,
        { projectId, actorId: req.user!.id, action: 'task.create', newValue: String(name) },
        async () => {
          const inserted = await client.query<{ id: string }>(
            // sort_order is assigned from the end of the list so the task list
            // has a stable order of its own. Without it every task shares
            // sort_order 0, the view falls back to sorting by date, and rows
            // jump around the moment a schedule shifts.
            `INSERT INTO tasks (project_id, phase_id, name, duration_days, calendar_id,
                                constraint_type, constraint_date, visibility, sort_order)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8,
                     COALESCE((SELECT MAX(sort_order) + 10 FROM tasks WHERE project_id = $1), 0))
             RETURNING id`,
            [
              projectId,
              phaseId ?? null,
              name,
              durationDays,
              calendarId ?? null,
              constraintType ?? 'ASAP',
              constraintDate ?? null,
              // A milestone is the thing a client is meant to see, so it is
              // visible unless someone says otherwise.
              visibility ?? (Number(durationDays) === 0 ? 'client' : 'internal'),
            ],
          )
          taskId = inserted.rows[0]!.id
        },
      )
      return { taskId, change }
    })

    if (!payload) {
      res.status(404).json({ error: 'Project not found' })
      return
    }
    broadcast(projectId, 'schedule.changed', { finishAfter: payload.change.finishAfter })
    res.status(201).json({
      taskId: payload.taskId,
      schedule: payload.change.result,
      impact: payload.change.impact,
      finishMovedDays: payload.change.finishMovedDays,
    })
  } catch (error) {
    handleError(res, error, 'create-task')
  }
})

// ─── Phases ──────────────────────────────────────────────────────────────────
//
// Phases existed in the schema and arrived with templates, but nothing could
// create or change one — so 28 of 83 projects had phases and the other 55 could
// never get them. None of these routes touch a date, which is why they do not
// go through `applyAndExplain`: grouping tasks does not move them, and an
// impact banner reading "nothing changed" on every rename is noise.

router.post('/:projectId/phases', requirePlanner, async (req: Request, res: Response) => {
  const { name, visibility } = req.body ?? {}
  if (!name || !String(name).trim()) {
    res.status(400).json({ error: 'A phase needs a name' })
    return
  }

  try {
    const phase = await transaction(async (client) => {
      if (!(await ownsProject(client, param(req, 'projectId'), req.company!.id))) return null

      // Appended, not inserted at zero. A new phase belongs at the end of the
      // job until someone says otherwise.
      const { rows } = await client.query(
        `INSERT INTO phases (project_id, name, visibility, sort_order)
         VALUES ($1, $2, COALESCE($3, 'client'),
                 COALESCE((SELECT MAX(sort_order) + 1 FROM phases WHERE project_id = $1), 0))
         RETURNING id, name, sort_order AS "sortOrder", visibility`,
        [param(req, 'projectId'), String(name).trim(), visibility ?? null],
      )
      return rows[0]
    })

    if (!phase) {
      res.status(404).json({ error: 'Project not found' })
      return
    }
    broadcast(param(req, 'projectId'), 'phases.changed', {})
    res.status(201).json({ phase })
  } catch (error) {
    handleError(res, error, 'create-phase')
  }
})

router.patch('/:projectId/phases/:phaseId', requirePlanner, async (req: Request, res: Response) => {
  const { name, visibility, sortOrder } = req.body ?? {}
  if (name === undefined && visibility === undefined && sortOrder === undefined) {
    res.status(400).json({ error: 'Nothing to change' })
    return
  }
  if (name !== undefined && !String(name).trim()) {
    res.status(400).json({ error: 'A phase needs a name' })
    return
  }

  try {
    const phase = await transaction(async (client) => {
      if (!(await ownsProject(client, param(req, 'projectId'), req.company!.id))) return null

      const { rows } = await client.query(
        `UPDATE phases
            SET name       = COALESCE($3, name),
                visibility = COALESCE($4, visibility),
                sort_order = COALESCE($5, sort_order)
          WHERE id = $1 AND project_id = $2
          RETURNING id, name, sort_order AS "sortOrder", visibility`,
        [
          param(req, 'phaseId'),
          param(req, 'projectId'),
          name === undefined ? null : String(name).trim(),
          visibility ?? null,
          sortOrder ?? null,
        ],
      )
      return rows[0] ?? null
    })

    if (!phase) {
      res.status(404).json({ error: 'Phase not found' })
      return
    }
    broadcast(param(req, 'projectId'), 'phases.changed', {})
    res.json({ phase })
  } catch (error) {
    handleError(res, error, 'update-phase')
  }
})

/**
 * Delete a phase. Its tasks survive, unassigned.
 *
 * The schema already says `ON DELETE SET NULL`, and that is the right rule:
 * deleting a grouping must never delete the work inside it. The count comes
 * back so the UI can say what became loose rather than leaving someone to
 * wonder where twelve tasks went.
 */
router.delete('/:projectId/phases/:phaseId', requirePlanner, async (req: Request, res: Response) => {
  try {
    const result = await transaction(async (client) => {
      if (!(await ownsProject(client, param(req, 'projectId'), req.company!.id))) return null

      const { rows: counted } = await client.query<{ count: string }>(
        'SELECT COUNT(*)::text AS count FROM tasks WHERE phase_id = $1',
        [param(req, 'phaseId')],
      )
      const { rowCount } = await client.query(
        'DELETE FROM phases WHERE id = $1 AND project_id = $2',
        [param(req, 'phaseId'), param(req, 'projectId')],
      )
      return rowCount === 0 ? null : { unassignedTasks: Number(counted[0]!.count) }
    })

    if (!result) {
      res.status(404).json({ error: 'Phase not found' })
      return
    }
    broadcast(param(req, 'projectId'), 'phases.changed', {})
    res.json(result)
  } catch (error) {
    handleError(res, error, 'delete-phase')
  }
})

/**
 * Reorder every phase at once.
 *
 * One request rather than one per phase, because dragging a phase up a list
 * renumbers several of them and doing that as N requests leaves the order
 * briefly wrong — and permanently wrong if one of them fails.
 */
router.put('/:projectId/phases/order', requirePlanner, async (req: Request, res: Response) => {
  const { order } = req.body ?? {}
  if (!Array.isArray(order) || order.length === 0) {
    res.status(400).json({ error: 'order must be a non-empty array of phase ids' })
    return
  }

  try {
    const phases = await transaction(async (client) => {
      if (!(await ownsProject(client, param(req, 'projectId'), req.company!.id))) return null

      for (const [index, id] of order.entries()) {
        await client.query(
          'UPDATE phases SET sort_order = $3 WHERE id = $1 AND project_id = $2',
          [id, param(req, 'projectId'), index],
        )
      }
      const { rows } = await client.query(
        `SELECT id, name, sort_order AS "sortOrder", visibility
           FROM phases WHERE project_id = $1 ORDER BY sort_order, name`,
        [param(req, 'projectId')],
      )
      return rows
    })

    if (!phases) {
      res.status(404).json({ error: 'Project not found' })
      return
    }
    broadcast(param(req, 'projectId'), 'phases.changed', {})
    res.json({ phases })
  } catch (error) {
    handleError(res, error, 'reorder-phases')
  }
})

const UPDATABLE: Record<string, string> = {
  name: 'name',
  durationDays: 'duration_days',
  phaseId: 'phase_id',
  calendarId: 'calendar_id',
  constraintType: 'constraint_type',
  constraintDate: 'constraint_date',
  actualStart: 'actual_start',
  actualFinish: 'actual_finish',
  percentComplete: 'percent_complete',
  remainingDays: 'remaining_days',
  visibility: 'visibility',
  sortOrder: 'sort_order',
}

router.patch(
  '/:projectId/tasks/:taskId',
  requirePlanner,
  async (req: Request, res: Response) => {
    const projectId = param(req, 'projectId')
    const taskId = param(req, 'taskId')
    const updates = Object.entries(req.body ?? {}).filter(([key]) => key in UPDATABLE)

    if (updates.length === 0) {
      res.status(400).json({ error: 'No updatable fields supplied' })
      return
    }

    try {
      const payload = await transaction(async (client) => {
        if (!(await ownsProject(client, projectId, req.company!.id))) return null

        const before = await client.query<Record<string, unknown>>(
          `SELECT ${updates.map(([k]) => UPDATABLE[k]).join(', ')} FROM tasks
           WHERE id = $1 AND project_id = $2`,
          [taskId, projectId],
        )
        if (before.rows.length === 0) return null

        const change = await applyAndExplain(
          client,
          {
            projectId,
            taskId,
            actorId: req.user!.id,
            action: 'task.update',
            field: updates.map(([k]) => k).join(','),
            oldValue: JSON.stringify(before.rows[0]),
            newValue: JSON.stringify(Object.fromEntries(updates)),
          },
          async () => {
            const assignments = updates
              .map(([key], i) => `${UPDATABLE[key]} = $${i + 3}`)
              .join(', ')
            await client.query(
              `UPDATE tasks SET ${assignments}, updated_at = NOW()
               WHERE id = $1 AND project_id = $2`,
              [taskId, projectId, ...updates.map(([, value]) => value)],
            )
          },
        )
        return change
      })

      if (!payload) {
        res.status(404).json({ error: 'Task not found' })
        return
      }
      broadcast(projectId, 'schedule.changed', { finishAfter: payload.finishAfter })
      res.json({
        schedule: payload.result,
        impact: payload.impact,
        finishMovedDays: payload.finishMovedDays,
      })
    } catch (error) {
      handleError(res, error, 'update-task')
    }
  },
)

router.delete(
  '/:projectId/tasks/:taskId',
  requirePlanner,
  async (req: Request, res: Response) => {
    const projectId = param(req, 'projectId')
    const taskId = param(req, 'taskId')
    try {
      // Filled inside the transaction, acted on once it has committed.
      let orphaned: string[] = []
      const payload = await transaction(async (client) => {
        if (!(await ownsProject(client, projectId, req.company!.id))) return null
        const existing = await client.query<{ name: string }>(
          'SELECT name FROM tasks WHERE id = $1 AND project_id = $2',
          [taskId, projectId],
        )
        if (existing.rows.length === 0) return null
        // Read before the delete: `attachments` cascades from `tasks`, so once
        // this commits there is nothing left to say which files on disk
        // belonged to it. Collected here, unlinked after the commit.
        const files = await client.query<{ stored_name: string }>(
          'SELECT stored_name FROM attachments WHERE task_id = $1',
          [taskId],
        )
        orphaned = files.rows.map((r) => r.stored_name)

        return applyAndExplain(
          client,
          {
            projectId,
            actorId: req.user!.id,
            action: 'task.delete',
            oldValue: existing.rows[0]!.name,
          },
          async () => {
            // Dependencies and attachment rows cascade on the foreign key, so
            // the links and the rows go with it.
            await client.query('DELETE FROM tasks WHERE id = $1 AND project_id = $2', [
              taskId,
              projectId,
            ])
          },
        )
      })
      if (!payload) {
        res.status(404).json({ error: 'Task not found' })
        return
      }
      // After the commit, never inside it: unlinking during the transaction
      // would destroy the files and then lose them for good on a rollback.
      await removeStoredFiles(orphaned)
      broadcast(projectId, 'schedule.changed', { finishAfter: payload.finishAfter })
      res.json({
        schedule: payload.result,
        impact: payload.impact,
        finishMovedDays: payload.finishMovedDays,
      })
    } catch (error) {
      handleError(res, error, 'delete-task')
    }
  },
)

// ── Dependencies ─────────────────────────────────────────────────────────────

router.post('/:projectId/dependencies', requirePlanner, async (req: Request, res: Response) => {
  const projectId = param(req, 'projectId')
  const { predecessorId, successorId, type, lagDays } = req.body ?? {}
  if (!predecessorId || !successorId) {
    res.status(400).json({ error: 'predecessorId and successorId are required' })
    return
  }

  try {
    const payload = await transaction(async (client) => {
      if (!(await ownsProject(client, projectId, req.company!.id))) return null
      return applyAndExplain(
        client,
        {
          projectId,
          actorId: req.user!.id,
          action: 'dependency.create',
          newValue: `${predecessorId} → ${successorId} (${type ?? 'FS'})`,
        },
        async () => {
          await client.query(
            `INSERT INTO dependencies (project_id, predecessor_id, successor_id, type, lag_days)
             VALUES ($1, $2, $3, $4, $5)`,
            [projectId, predecessorId, successorId, type ?? 'FS', lagDays ?? 0],
          )
        },
      )
    })

    if (!payload) {
      res.status(404).json({ error: 'Project not found' })
      return
    }
    broadcast(projectId, 'schedule.changed', { finishAfter: payload.finishAfter })
    res.status(201).json({
      schedule: payload.result,
      impact: payload.impact,
      finishMovedDays: payload.finishMovedDays,
    })
  } catch (error) {
    // A cycle rolls the whole transaction back, so the bad link is never stored.
    handleError(res, error, 'create-dependency')
  }
})

router.delete(
  '/:projectId/dependencies/:dependencyId',
  requirePlanner,
  async (req: Request, res: Response) => {
    const projectId = param(req, 'projectId')
    const dependencyId = param(req, 'dependencyId')
    try {
      const payload = await transaction(async (client) => {
        if (!(await ownsProject(client, projectId, req.company!.id))) return null
        const existing = await client.query(
          'SELECT 1 FROM dependencies WHERE id = $1 AND project_id = $2',
          [dependencyId, projectId],
        )
        if (existing.rows.length === 0) return null
        return applyAndExplain(
          client,
          { projectId, actorId: req.user!.id, action: 'dependency.delete' },
          async () => {
            await client.query('DELETE FROM dependencies WHERE id = $1 AND project_id = $2', [
              dependencyId,
              projectId,
            ])
          },
        )
      })
      if (!payload) {
        res.status(404).json({ error: 'Dependency not found' })
        return
      }
      broadcast(projectId, 'schedule.changed', { finishAfter: payload.finishAfter })
      res.json({
        schedule: payload.result,
        impact: payload.impact,
        finishMovedDays: payload.finishMovedDays,
      })
    } catch (error) {
      handleError(res, error, 'delete-dependency')
    }
  },
)

/**
 * The project in plain language, recomputed on every request. Everything in it
 * is already known to the engine; this is the part that says it out loud.
 */
router.get('/:projectId/summary', async (req: Request, res: Response) => {
  const projectId = param(req, 'projectId')
  // The data date is the project's own sense of "now"; fall back to today.
  const asOf = typeof req.query.asOf === 'string' ? req.query.asOf : null
  try {
    const summary = await transaction(async (client) => {
      if (!(await ownsProject(client, projectId, req.company!.id))) return null
      const row = await client.query<{ as_of: string }>(
        `SELECT COALESCE($2::date, data_date, CURRENT_DATE)::text AS as_of
         FROM projects WHERE id = $1`,
        [projectId, asOf],
      )
      return buildSummary(client, projectId, row.rows[0]!.as_of)
    })
    if (!summary) {
      res.status(404).json({ error: 'Project not found' })
      return
    }
    res.json(summary)
  } catch (error) {
    handleError(res, error, 'summary')
  }
})

// ── Drag preview ─────────────────────────────────────────────────────────────

/**
 * What a drag means, decided server-side.
 *
 * The client reports which edge was dragged and where it landed; everything
 * else — calendar arithmetic, whether to write a constraint or an actual,
 * whether the move is possible at all — is worked out here, where the project's
 * calendars actually live.
 */
router.post(
  '/:projectId/tasks/:taskId/preview-move',
  requirePlanner,
  async (req: Request, res: Response) => {
    const projectId = param(req, 'projectId')
    const taskId = param(req, 'taskId')
    const { mode, targetDate } = (req.body ?? {}) as { mode?: MoveMode; targetDate?: string }

    if (!mode || !['move', 'resize-start', 'resize-end'].includes(mode) || !targetDate) {
      res.status(400).json({ error: 'mode and targetDate are required' })
      return
    }

    try {
      const preview = await transaction(async (client) => {
        if (!(await ownsProject(client, projectId, req.company!.id))) return null
        return previewMove(client, projectId, taskId, mode, targetDate)
      })
      if (!preview) {
        res.status(404).json({ error: 'Task not found' })
        return
      }
      res.json(preview)
    } catch (error) {
      handleError(res, error, 'preview-move')
    }
  },
)

/** The dependency-imposed floor for a task, used to shade the drag area. */
router.get(
  '/:projectId/tasks/:taskId/floor',
  requirePlanner,
  async (req: Request, res: Response) => {
    const projectId = param(req, 'projectId')
    const taskId = param(req, 'taskId')
    try {
      const out = await transaction(async (client) => {
        if (!(await ownsProject(client, projectId, req.company!.id))) return null
        const input = await loadScheduleInput(client, projectId)
        if (!input.tasks.some((t) => t.id === taskId)) return null
        return { earliestStart: unconstrainedStart(input, taskId) }
      })
      if (!out) {
        res.status(404).json({ error: 'Task not found' })
        return
      }
      res.json(out)
    } catch (error) {
      handleError(res, error, 'task-floor')
    }
  },
)

// ── What-if ──────────────────────────────────────────────────────────────────

/**
 * Solve a hypothetical without saving it. This is what the Gantt's drag preview
 * calls: see the ripple, then commit or discard.
 */
router.post('/:projectId/what-if', requirePlanner, async (req: Request, res: Response) => {
  const projectId = param(req, 'projectId')
  const overrides = (req.body?.tasks ?? []) as Array<{ id: string } & Record<string, unknown>>

  try {
    const payload = await transaction(async (client) => {
      if (!(await ownsProject(client, projectId, req.company!.id))) return null

      const input = await loadScheduleInput(client, projectId)
      const patched = {
        ...input,
        tasks: input.tasks.map((task) => {
          const override = overrides.find((o) => o.id === task.id)
          return override ? { ...task, ...override } : task
        }),
      }

      const { solve } = await import('../scheduler/index.js')
      const before = solve(input)
      const after = solve(patched)
      return { before, after }
    })

    if (!payload) {
      res.status(404).json({ error: 'Project not found' })
      return
    }
    res.json({
      currentFinish: payload.before.projectFinish,
      hypotheticalFinish: payload.after.projectFinish,
      schedule: payload.after,
    })
  } catch (error) {
    handleError(res, error, 'what-if')
  }
})

// ── Baselines ────────────────────────────────────────────────────────────────

router.post('/:projectId/baselines', requirePlanner, async (req: Request, res: Response) => {
  const projectId = param(req, 'projectId')
  const name = req.body?.name ?? 'Baseline'

  try {
    const baseline = await transaction(async (client) => {
      if (!(await ownsProject(client, projectId, req.company!.id))) return null
      return storeBaseline(client, projectId, String(name), req.user!.id)
    })
    if (!baseline) {
      res.status(404).json({ error: 'Project not found' })
      return
    }
    res.status(201).json({ baseline })
  } catch (error) {
    handleError(res, error, 'capture-baseline')
  }
})

/** The "what changed since you last looked" feed — a digest, not a firehose. */
router.get('/:projectId/history', async (req: Request, res: Response) => {
  const { rows } = await transaction(async (client) =>
    client.query(
      `SELECT c.id, c.action, c.field, c.impact_days, c.summary, c.created_at,
              c.project_finish_before::text AS finish_before,
              c.project_finish_after::text  AS finish_after,
              u.name AS actor_name, t.name AS task_name
       FROM change_log c
       LEFT JOIN users u ON u.id = c.actor_id
       LEFT JOIN tasks t ON t.id = c.task_id
       JOIN projects p ON p.id = c.project_id AND p.company_id = $2
       WHERE c.project_id = $1
       ORDER BY c.created_at DESC LIMIT 100`,
      [param(req, 'projectId'), req.company!.id],
    ),
  )
  res.json({ history: rows })
})

export default router
