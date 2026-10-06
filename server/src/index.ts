import cors from 'cors'
import express from 'express'
import helmet from 'helmet'
import rateLimit from 'express-rate-limit'
import { migrate } from './db/migrate.js'
import { closePool, pool } from './db/pool.js'
import authRoutes from './routes/auth.js'
import attachmentRoutes from './routes/attachments.js'
import passwordResetRoutes from './routes/password-reset.js'
import projectRoutes from './routes/projects.js'
import setupRoutes, { setupNeeded, setupToken } from './routes/setup.js'
import sseRoutes from './routes/sse.js'
import teamRoutes from './routes/team.js'

const app = express()

/**
 * Stringline is served under `kevinoue.com/stringline/` today and will move to its
 * own domain later. Everything mounts under a configurable base path so that
 * move is an environment variable, not a refactor.
 */
const BASE_PATH = process.env.BASE_PATH ?? '/stringline/api'
const PORT = Number(process.env.PORT ?? 3006)

app.set('trust proxy', 1)
app.use(helmet())
app.use(cors({ origin: process.env.CORS_ORIGIN ?? true }))
app.use(express.json({ limit: '2mb' }))

const api = express.Router()

/**
 * Login is the endpoint worth brute-forcing, so it gets its own tighter budget.
 *
 * Configurable because a test run signs up a dozen throwaway companies and
 * trips the production figure in seconds — at which point every suite fails
 * with a JSON parse error on an HTML rate-limit page, which looks like a bug in
 * whatever was being tested. Production keeps the default.
 */
const AUTH_RATE_LIMIT = Number(process.env.AUTH_RATE_LIMIT ?? 20)
api.use(
  '/auth',
  rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: AUTH_RATE_LIMIT,
    standardHeaders: true,
    legacyHeaders: false,
    // JSON, so a client that hits it gets something it can actually parse.
    message: { error: 'Too many attempts. Please wait a few minutes.' },
  }),
  authRoutes,
  // Mounted inside the same `/auth` block rather than as a second `api.use`,
  // which would stack two limiters on every request that reaches either. The
  // reset routes carry their own tighter, hourly limit internally.
  passwordResetRoutes,
)
/**
 * First-run setup gets the tight budget too. It is guessable only by brute
 * force, and brute force is exactly what a rate limit is for.
 *
 * `GET /setup/status` is polled once per page load by every visitor before
 * anyone has signed in, so the allowance has to cover ordinary traffic rather
 * than just the one POST that claims the instance.
 */
api.use(
  '/setup',
  rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: Number(process.env.SETUP_RATE_LIMIT ?? 60),
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many attempts. Please wait a few minutes.' },
  }),
  setupRoutes,
)

api.use(
  rateLimit({ windowMs: 15 * 60 * 1000, limit: 1000, standardHeaders: true, legacyHeaders: false }),
)
api.use('/team', teamRoutes)
api.use('/projects', projectRoutes)
api.use('/', attachmentRoutes)
api.use('/', sseRoutes)

api.get('/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1')
    res.json({ status: 'ok', database: 'up' })
  } catch {
    res.status(503).json({ status: 'degraded', database: 'down' })
  }
})

app.use(BASE_PATH, api)

/**
 * Print the setup code when the instance has no accounts yet.
 *
 * The log is the channel on purpose: reading it requires access to the host,
 * which is the one thing that distinguishes whoever deployed this from a
 * stranger who found the URL. Printed on every boot while setup is pending, so
 * a restart part-way through an install does not strand anyone.
 */
async function announceSetup(): Promise<void> {
  try {
    if (!(await setupNeeded())) return
    const token = setupToken()
    console.log('')
    console.log('  ┌─────────────────────────────────────────────────────────┐')
    console.log('  │  This Stringline has no accounts yet.                   │')
    console.log('  │  Open the web app and use this setup code:              │')
    console.log(`  │                                                         │`)
    // 51 = the 57-character interior, less the six leading spaces.
    console.log(`  │      ${token.padEnd(51)}│`)
    console.log('  │                                                         │')
    console.log('  │  It stops working as soon as the first company exists.  │')
    console.log('  └─────────────────────────────────────────────────────────┘')
    console.log('')
  } catch (error) {
    // Never fatal. A server that will not boot because it could not print a
    // hint is worse than one you have to read the docs to install.
    console.warn('[setup] could not determine setup state:', (error as Error).message)
  }
}

async function start(): Promise<void> {
  await migrate()
  await announceSetup()
  const server = app.listen(PORT, () => {
    console.log(`[stringline] listening on :${PORT}, API at ${BASE_PATH}`)
  })

  const shutdown = async (signal: string): Promise<void> => {
    console.log(`[stringline] ${signal} received, shutting down`)
    server.close()
    await closePool()
    process.exit(0)
  }
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('SIGINT', () => void shutdown('SIGINT'))
}

// Only start a listener when run directly; tests import the app.
if (process.env.NODE_ENV !== 'test') {
  start().catch((error) => {
    console.error('[stringline] failed to start:', error)
    process.exit(1)
  })
}

export { app }
