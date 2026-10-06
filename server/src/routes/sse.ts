/**
 * Server-sent events for live schedule updates.
 *
 * Lifted from `~/Nexus/server/src/sse.ts`, keyed by project instead of by user:
 * two planners with the same Gantt open should both see a reflow the moment
 * either one drags a bar.
 *
 * The `X-Accel-Buffering: no` header is the load-bearing line. Without it Caddy
 * buffers the stream and events arrive in bursts, or not at all — and the
 * failure looks exactly like a broken client.
 */

import { Router, type Request, type Response } from 'express'
import { authenticate } from '../middleware/auth.js'
import { requireCompany } from '../middleware/company.js'
import { param } from './util.js'

const router = Router()

const clients = new Map<string, Set<Response>>()

export function broadcast(projectId: string, event: string, data: unknown): void {
  const listeners = clients.get(projectId)
  if (!listeners) return
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
  for (const res of listeners) res.write(payload)
}

router.get('/projects/:projectId/events', authenticate, requireCompany, (req, res) => {
  const projectId = param(req, 'projectId')

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  })
  res.write(`data: ${JSON.stringify({ type: 'connected' })}\n\n`)

  const keepAlive = setInterval(() => res.write(': keepalive\n\n'), 30_000)

  if (!clients.has(projectId)) clients.set(projectId, new Set())
  clients.get(projectId)!.add(res)

  req.on('close', () => {
    clearInterval(keepAlive)
    const listeners = clients.get(projectId)
    listeners?.delete(res)
    if (listeners && listeners.size === 0) clients.delete(projectId)
  })
})

export default router
