import { readdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pool } from './pool.js'

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'migrations')

/**
 * Apply any migration files not yet recorded, in filename order, each in its
 * own transaction. A failed migration rolls back and stops the run rather than
 * leaving the schema half-applied.
 */
export async function migrate(): Promise<string[]> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name       TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)

  const applied = new Set(
    (await pool.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map(
      (r) => r.name,
    ),
  )

  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort()

  // Finding nothing means the .sql files were not shipped — tsc does not emit
  // them, so a broken build step leaves this directory empty or nested. Failing
  // loudly beats reporting "schema up to date" while the database is missing
  // every table the code is about to use.
  if (files.length === 0) {
    throw new Error(
      `No migrations found in ${MIGRATIONS_DIR}. The build must copy src/db/migrations into dist.`,
    )
  }

  const ran: string[] = []

  for (const file of files) {
    if (applied.has(file)) continue
    const sql = await readFile(join(MIGRATIONS_DIR, file), 'utf8')
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(sql)
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file])
      await client.query('COMMIT')
      ran.push(file)
      console.log(`[migrate] applied ${file}`)
    } catch (error) {
      await client.query('ROLLBACK')
      throw new Error(`Migration ${file} failed: ${(error as Error).message}`)
    } finally {
      client.release()
    }
  }

  if (ran.length === 0) console.log('[migrate] schema up to date')
  return ran
}
