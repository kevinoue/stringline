/**
 * Categories — the trade, department or crew a task belongs to.
 *
 * Company-scoped, not project-scoped. That is the whole difference from
 * phases: phases are the stages of one job and die with it, where a company's
 * trades are the same on every job and are defined once.
 *
 * None of these routes move a date, so none go through `applyAndExplain`.
 * Labelling work does not reschedule it, and an impact banner reading "nothing
 * changed" on every rename is noise.
 */

import { Router, type Request, type Response } from 'express'
import { pool, transaction } from '../db/pool.js'
import { authenticate, requirePlanner } from '../middleware/auth.js'
import { requireCompany } from '../middleware/company.js'
import { isPaletteKey, nextColour, PALETTE } from '../services/palette.js'

const router = Router()

router.use(authenticate)
router.use(requireCompany)

const KINDS = ['trade', 'area']

/**
 * The palette and the company's chosen word for this dimension.
 *
 * Both are needed before any category can be shown, and neither changes often,
 * so they ride along with the list rather than costing a second request.
 */
router.get('/', async (req: Request, res: Response) => {
  const kind = typeof req.query.kind === 'string' ? req.query.kind : 'trade'
  if (!KINDS.includes(kind)) {
    res.status(400).json({ error: `kind must be one of ${KINDS.join(', ')}` })
    return
  }

  const { rows } = await pool.query(
    `SELECT c.id, c.name, c.description, c.colour, c.sort_order AS "sortOrder", c.kind,
            (SELECT COUNT(*) FROM tasks t WHERE t.category_id = c.id)::int AS "taskCount"
       FROM categories c
      WHERE c.company_id = $1 AND c.kind = $2
      ORDER BY c.sort_order, c.name`,
    [req.company!.id, kind],
  )

  const { rows: company } = await pool.query<{ category_label: string }>(
    'SELECT category_label FROM companies WHERE id = $1',
    [req.company!.id],
  )

  res.json({
    categories: rows,
    palette: PALETTE,
    // What to call this dimension in the UI. A hotel says Department, a
    // contractor says Trade, and the machinery does not care which.
    label: company[0]?.category_label ?? 'Trade',
  })
})

router.post('/', requirePlanner, async (req: Request, res: Response) => {
  const { name, description, colour, kind } = req.body ?? {}

  if (!name || !String(name).trim()) {
    res.status(400).json({ error: 'A category needs a name' })
    return
  }
  if (colour !== undefined && !isPaletteKey(colour)) {
    res.status(400).json({ error: 'Unknown colour' })
    return
  }
  if (kind !== undefined && !KINDS.includes(kind)) {
    res.status(400).json({ error: `kind must be one of ${KINDS.join(', ')}` })
    return
  }

  try {
    const category = await transaction(async (client) => {
      const { rows: existing } = await client.query<{ colour: string }>(
        'SELECT colour FROM categories WHERE company_id = $1 AND kind = $2',
        [req.company!.id, kind ?? 'trade'],
      )

      const { rows } = await client.query(
        `INSERT INTO categories (company_id, kind, name, description, colour, sort_order)
         VALUES ($1, $2, $3, $4, $5,
                 COALESCE((SELECT MAX(sort_order) + 1 FROM categories
                            WHERE company_id = $1 AND kind = $2), 0))
         RETURNING id, name, description, colour, sort_order AS "sortOrder", kind,
                   0 AS "taskCount"`,
        [
          req.company!.id,
          kind ?? 'trade',
          String(name).trim(),
          description ? String(description).trim() : null,
          // Picked for them, in palette order, so the first few categories are
          // the most distinguishable and nobody has to think about colour to
          // get a usable chart.
          colour ?? nextColour(existing.map((c) => c.colour)),
        ],
      )
      return rows[0]
    })
    res.status(201).json({ category })
  } catch (error) {
    if ((error as { code?: string }).code === '23505') {
      res.status(409).json({ error: 'You already have one with that name' })
      return
    }
    throw error
  }
})

router.patch('/:id', requirePlanner, async (req: Request, res: Response) => {
  const { name, description, colour, sortOrder } = req.body ?? {}

  if (name === undefined && description === undefined && colour === undefined && sortOrder === undefined) {
    res.status(400).json({ error: 'Nothing to change' })
    return
  }
  if (name !== undefined && !String(name).trim()) {
    res.status(400).json({ error: 'A category needs a name' })
    return
  }
  if (colour !== undefined && !isPaletteKey(colour)) {
    res.status(400).json({ error: 'Unknown colour' })
    return
  }

  try {
    const { rows } = await pool.query(
      `UPDATE categories
          SET name        = COALESCE($3, name),
              -- An empty description clears it rather than storing a blank.
              description = CASE WHEN $4::boolean THEN $5 ELSE description END,
              colour      = COALESCE($6, colour),
              sort_order  = COALESCE($7, sort_order)
        WHERE id = $1 AND company_id = $2
        RETURNING id, name, description, colour, sort_order AS "sortOrder", kind,
                  (SELECT COUNT(*) FROM tasks t WHERE t.category_id = categories.id)::int
                    AS "taskCount"`,
      [
        req.params.id,
        req.company!.id,
        name === undefined ? null : String(name).trim(),
        description !== undefined,
        description ? String(description).trim() : null,
        colour ?? null,
        sortOrder ?? null,
      ],
    )

    if (rows.length === 0) {
      res.status(404).json({ error: 'Category not found' })
      return
    }
    res.json({ category: rows[0] })
  } catch (error) {
    if ((error as { code?: string }).code === '23505') {
      res.status(409).json({ error: 'You already have one with that name' })
      return
    }
    throw error
  }
})

/**
 * Delete a category. Its tasks survive, untagged.
 *
 * `ON DELETE SET NULL` in the schema, and the count comes back so the UI can
 * say what became untagged — the same rule phases follow. Deleting a label
 * must never delete the work.
 */
router.delete('/:id', requirePlanner, async (req: Request, res: Response) => {
  const result = await transaction(async (client) => {
    const { rows } = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM tasks t
         JOIN categories c ON c.id = t.category_id
        WHERE c.id = $1 AND c.company_id = $2`,
      [req.params.id, req.company!.id],
    )
    const { rowCount } = await client.query(
      'DELETE FROM categories WHERE id = $1 AND company_id = $2',
      [req.params.id, req.company!.id],
    )
    return rowCount === 0 ? null : { untaggedTasks: Number(rows[0]!.count) }
  })

  if (!result) {
    res.status(404).json({ error: 'Category not found' })
    return
  }
  res.json(result)
})

/** What this dimension is called. One word, company-wide. */
router.put('/label', requirePlanner, async (req: Request, res: Response) => {
  const { label } = req.body ?? {}
  if (!label || !String(label).trim()) {
    res.status(400).json({ error: 'A label is required' })
    return
  }
  const trimmed = String(label).trim().slice(0, 24)

  const { rows } = await pool.query<{ category_label: string }>(
    'UPDATE companies SET category_label = $2 WHERE id = $1 RETURNING category_label',
    [req.company!.id, trimmed],
  )
  res.json({ label: rows[0]!.category_label })
})

export default router
