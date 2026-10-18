import cors from 'cors'
import express from 'express'
import helmet from 'helmet'
import rateLimit from 'express-rate-limit'
import { migrate } from './db/migrate.js'
import { closePool, pool } from './db/pool.js'
import authRoutes from './routes/auth.js'
import attachmentRoutes from './routes/attachments.js'
import categoryRoutes from './routes/categories.js'
import passwordResetRoutes from './routes/password-reset.js'
import projectRoutes from './routes/projects.js'
import setupRoutes, { setupNeeded, setupToken } from './routes/setup.js'
import sseRoutes from './routes/sse.js'
import stepRoutes from './routes/steps.js'
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
 * The broad limit, applied to everything including auth.
 *
 * Registered before any route so it genuinely covers all of them. It used to
 * be mounted after `/auth`, which meant the auth routes never reached it and
 * were governed only by the tight limit below — fine for login, wrong for the
 * ordinary requests that share that prefix.
 */
api.use(
  rateLimit({ windowMs: 15 * 60 * 1000, limit: 1000, standardHeaders: true, legacyHeaders: false }),
)

/**
 * The tight limit, for the handful of endpoints where a request is a *guess*.
 *
 * Configurable because a test run signs up a dozen throwaway companies and
 * trips the production figure in seconds — at which point every suite fails
 * with a JSON parse error on a rate-limit page, which looks like a bug in
 * whatever was being tested. Production keeps the default.
 */
const AUTH_RATE_LIMIT = Number(process.env.AUTH_RATE_LIMIT ?? 20)
const credentialLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: AUTH_RATE_LIMIT,
  standardHeaders: true,
  legacyHeaders: false,
  // JSON, so a client that hits it gets something it can actually parse.
  message: { error: 'Too many attempts. Please wait a few minutes.' },
  /*
   * Successes are counted too, deliberately.
   *
   * `skipSuccessfulRequests` is tempting — a sign-in that worked is not a
   * guess — but `/signup` is on this list and a *successful* signup is exactly
   * what you want to cap. Skipping successes would leave a stranger able to
   * mint companies on this instance without limit.
   *
   * The cost is a shared office address spending budget on ordinary sign-ins,
   * and twenty in a quarter of an hour is far more than a small team does.
   * Brute force is handled properly by the per-identifier lockout in
   * `services/security.ts`; this is only the outer backstop.
   */
})

/**
 * Which paths under `/auth` are guesses, by name.
 *
 * This list exists because the tight limiter used to cover the whole `/auth`
 * prefix — and `/auth/me` lives there, is called on every page load, and is
 * already authenticated. Twenty page loads in a quarter of an hour, which is a
 * slow morning, and the user could no longer sign in. A limit that punishes
 * ordinary use is one people route around.
 */
const GUESSABLE = new Set([
  '/login',
  '/signup',
  '/change-password',
  '/forgot-password',
  '/reset-password',
])

api.use(
  '/auth',
  (req, res, next) => {
    if (GUESSABLE.has(req.path)) {
      credentialLimiter(req, res, next)
      return
    }
    next()
  },
  authRoutes,
  // Mounted inside the same block so the path filter above governs both. The
  // reset routes also carry their own tighter, hourly, per-account limit.
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

/**
 * Redeeming an invite is a guess too.
 *
 * A code is 44 bits, so this is not what stops it being guessed — the entropy
 * is. It stops a host sitting on the endpoint indefinitely, and it is the only
 * limit between a stranger and the company name a valid code reveals.
 */
api.use(
  '/team/invites',
  rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: Number(process.env.INVITE_RATE_LIMIT ?? 60),
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many attempts. Please wait a few minutes.' },
  }),
)

api.use('/team', teamRoutes)
api.use('/categories', categoryRoutes)
api.use('/projects', projectRoutes)
api.use('/projects', stepRoutes)
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
