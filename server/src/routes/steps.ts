/**
 * Steps on a task.
 *
 * Mounted under a project so ownership is checked the same way everything else
 * is. Every route that can change a duration goes through `applyAndExplain`,
 * because a step's duration *is* part of its task's duration — lengthen a step
 * and the whole schedule downstream moves. That is the one way steps reach the
 * rest of the system, and it has to be explained like any other date move.
 *
 * Ticking a step off does not go through it: progress is a record of what
 * happened, and `applyAndExplain` is for changes that move dates.
 */

import { Router, type Request, type Response } from 'express'
import { transaction } from '../db/pool.js'
import { authenticate, requireRole } from '../middleware/auth.js'
import { requireCompany } from '../middleware/company.js'
import { ScheduleError } from '../scheduler/index.js'
import { applyAndExplain } from '../services/schedule.js'
import { syncTaskFromSteps } from '../services/steps.js'
import { broadcast } from './sse.js'
import { param } from './util.js'

const router = Router()

router.use(authenticate)
router.use(requireCompany)

/** Planners restructure; field users tick things off. Both need a route in. */
const requirePlanner = requireRole('owner', 'planner')

function handleError(res: Response, error: unknown, context: string): void {
  if (error instanceof ScheduleError) {
    res.status(422).json({ error: error.message, code: error.code, detail: error.detail })
    return
  }
  console.error(`[${context}]`, (error as Error).message)
  res.status(500).json({ error: 'Internal error' })
}

/** Confirm the task belongs to a project belonging to the caller's company. */
async function ownsTask(
  client: { query: (q: string, v: unknown[]) => Promise<{ rows: unknown[] }> },
  taskId: string,
  projectId: string,
  companyId: string,
): Promise<boolean> {
  const { rows } = await client.query(
    `SELECT 1 FROM tasks t JOIN projects p ON p.id = t.project_id
      WHERE t.id = $1 AND t.project_id = $2 AND p.company_id = $3`,
    [taskId, projectId, companyId],
  )
  return rows.length > 0
}

router.post(
  '/:projectId/tasks/:taskId/steps',
  requirePlanner,
  async (req: Request, res: Response) => {
    const projectId = param(req, 'projectId')
    const taskId = param(req, 'taskId')
    const { name, durationDays } = req.body ?? {}

    if (!name || !String(name).trim()) {
      res.status(400).json({ error: 'A step needs a name' })
      return
    }
    const duration = durationDays === undefined ? 0 : Number(durationDays)
    if (!Number.isInteger(duration) || duration < 0) {
      res.status(400).json({
        error: 'A step lasts a whole number of working days, or zero to make it a tick-box',
      })
      return
    }

    try {
      const payload = await transaction(async (client) => {
        if (!(await ownsTask(client, taskId, projectId, req.company!.id))) return null

        return applyAndExplain(
          client,
          {
            projectId,
            taskId,
            actorId: req.user!.id,
            action: 'step.add',
            field: 'steps',
            newValue: String(name).trim(),
          },
          async () => {
            await client.query(
              `INSERT INTO steps (task_id, name, duration_days, sort_order)
               VALUES ($1, $2, $3,
                       COALESCE((SELECT MAX(sort_order) + 1 FROM steps WHERE task_id = $1), 0))`,
              [taskId, String(name).trim(), duration],
            )
            // Before the solve inside applyAndExplain, so the new duration is
            // what gets scheduled rather than the one it replaced.
            await syncTaskFromSteps(client, taskId)
          },
        )
      })

      if (!payload) {
        res.status(404).json({ error: 'Task not found' })
        return
      }
      broadcast(projectId, 'schedule.changed', { finishAfter: payload.finishAfter })
      res.status(201).json({
        schedule: payload.result,
        impact: payload.impact,
        finishMovedDays: payload.finishMovedDays,
      })
    } catch (error) {
      handleError(res, error, 'add-step')
    }
  },
)

router.patch(
  '/:projectId/tasks/:taskId/steps/:stepId',
  async (req: Request, res: Response) => {
    const projectId = param(req, 'projectId')
    const taskId = param(req, 'taskId')
    const stepId = param(req, 'stepId')
    const { name, durationDays, actualStart, actualFinish, sortOrder } = req.body ?? {}

    const restructuring =
      name !== undefined || durationDays !== undefined || sortOrder !== undefined
    const progressing = actualStart !== undefined || actualFinish !== undefined

    if (!restructuring && !progressing) {
      res.status(400).json({ error: 'Nothing to change' })
      return
    }
    // A field user may record what happened; changing what the work *is*
    // belongs to whoever plans it.
    if (restructuring && !['owner', 'planner'].includes(req.user!.role)) {
      res.status(403).json({ error: 'Only an owner or planner can change a step itself' })
      return
    }
    if (name !== undefined && !String(name).trim()) {
      res.status(400).json({ error: 'A step needs a name' })
      return
    }
    if (durationDays !== undefined) {
      const d = Number(durationDays)
      if (!Number.isInteger(d) || d < 0) {
        res.status(400).json({
          error: 'A step lasts a whole number of working days, or zero to make it a tick-box',
        })
        return
      }
    }

    try {
      const payload = await transaction(async (client) => {
        if (!(await ownsTask(client, taskId, projectId, req.company!.id))) return null

        const { rows: existing } = await client.query(
          'SELECT 1 FROM steps WHERE id = $1 AND task_id = $2',
          [stepId, taskId],
        )
        if (existing.length === 0) return null

        return applyAndExplain(
          client,
          {
            projectId,
            taskId,
            actorId: req.user!.id,
            action: progressing && !restructuring ? 'step.progress' : 'step.update',
            field: 'steps',
            newValue: name !== undefined ? String(name).trim() : null,
          },
          async () => {
            await client.query(
              `UPDATE steps
                  SET name          = COALESCE($3, name),
                      duration_days = COALESCE($4, duration_days),
                      -- Passed through a flag so null genuinely clears an
                      -- actual date rather than being read as "no change".
                      actual_start  = CASE WHEN $5::boolean THEN $6::date ELSE actual_start END,
                      actual_finish = CASE WHEN $7::boolean THEN $8::date ELSE actual_finish END,
                      sort_order    = COALESCE($9, sort_order),
                      updated_at    = NOW()
                WHERE id = $1 AND task_id = $2`,
              [
                stepId,
                taskId,
                name === undefined ? null : String(name).trim(),
                durationDays === undefined ? null : Number(durationDays),
                actualStart !== undefined,
                actualStart ?? null,
                actualFinish !== undefined,
                actualFinish ?? null,
                sortOrder ?? null,
              ],
            )
            await syncTaskFromSteps(client, taskId)
          },
        )
      })

      if (!payload) {
        res.status(404).json({ error: 'Step not found' })
        return
      }
      broadcast(projectId, 'schedule.changed', { finishAfter: payload.finishAfter })
      res.json({
        schedule: payload.result,
        impact: payload.impact,
        finishMovedDays: payload.finishMovedDays,
      })
    } catch (error) {
      handleError(res, error, 'update-step')
    }
  },
)

router.delete(
  '/:projectId/tasks/:taskId/steps/:stepId',
  requirePlanner,
  async (req: Request, res: Response) => {
    const projectId = param(req, 'projectId')
    const taskId = param(req, 'taskId')

    try {
      const payload = await transaction(async (client) => {
        if (!(await ownsTask(client, taskId, projectId, req.company!.id))) return null

        const { rows } = await client.query<{ name: string }>(
          'SELECT name FROM steps WHERE id = $1 AND task_id = $2',
          [param(req, 'stepId'), taskId],
        )
        if (rows.length === 0) return null

        return applyAndExplain(
          client,
          {
            projectId,
            taskId,
            actorId: req.user!.id,
            action: 'step.delete',
            field: 'steps',
            oldValue: rows[0]!.name,
          },
          async () => {
            await client.query('DELETE FROM steps WHERE id = $1 AND task_id = $2', [
              param(req, 'stepId'),
              taskId,
            ])
            // Removing a step shortens the task, which moves everything
            // downstream — so this is a date change like any other.
            await syncTaskFromSteps(client, taskId)
          },
        )
      })

      if (!payload) {
        res.status(404).json({ error: 'Step not found' })
        return
      }
      broadcast(projectId, 'schedule.changed', { finishAfter: payload.finishAfter })
      res.json({
        schedule: payload.result,
        impact: payload.impact,
        finishMovedDays: payload.finishMovedDays,
      })
    } catch (error) {
      handleError(res, error, 'delete-step')
    }
  },
)

/**
 * Reorder every step at once.
 *
 * One request rather than one per step: dragging a step up renumbers several,
 * and doing that as N requests leaves the order briefly wrong and permanently
 * wrong if one fails. Reordering also reflows every step's dates, since they
 * run in sequence.
 */
router.put(
  '/:projectId/tasks/:taskId/steps/order',
  requirePlanner,
  async (req: Request, res: Response) => {
    const projectId = param(req, 'projectId')
    const taskId = param(req, 'taskId')
    const { order } = req.body ?? {}

    if (!Array.isArray(order) || order.length === 0) {
      res.status(400).json({ error: 'order must be a non-empty array of step ids' })
      return
    }

    try {
      const ok = await transaction(async (client) => {
        if (!(await ownsTask(client, taskId, projectId, req.company!.id))) return false
        for (const [index, id] of order.entries()) {
          await client.query('UPDATE steps SET sort_order = $3 WHERE id = $1 AND task_id = $2', [
            id,
            taskId,
            index,
          ])
        }
        return true
      })

      if (!ok) {
        res.status(404).json({ error: 'Task not found' })
        return
      }
      // No date moves: the order changes which step runs when inside the task,
      // but the task's duration and therefore everything downstream is
      // unchanged. No impact banner to show.
      broadcast(projectId, 'steps.changed', {})
      res.status(204).end()
    } catch (error) {
      handleError(res, error, 'reorder-steps')
    }
  },
)

export default router
