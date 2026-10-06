import pg from 'pg'

/**
 * Postgres DATE columns must come back as plain `'YYYY-MM-DD'` strings.
 *
 * By default node-postgres parses OID 1082 (DATE) into a JS `Date` at local
 * midnight. West of UTC that turns `2026-01-05` into `2026-01-04T…Z`, so a task
 * silently loses a day on every round trip — and it only shows up for users in
 * some timezones, which is the worst kind of bug to find.
 *
 * The scheduling engine already works exclusively in UTC day indices and
 * `IsoDate` strings. Handing the raw string straight through means dates never
 * become instants anywhere in the stack.
 */
pg.types.setTypeParser(pg.types.builtins.DATE, (value: string) => value)

/**
 * NUMERIC comes back as a string by default to protect precision. Resource
 * capacity and units are small decimals where a float is fine and a string is
 * a nuisance.
 */
pg.types.setTypeParser(pg.types.builtins.NUMERIC, (value: string) => Number(value))

export const pool = new pg.Pool({
  connectionString:
    process.env.DATABASE_URL ?? 'postgresql://stringline:stringline@localhost:5432/stringline',
  max: Number(process.env.PG_POOL_MAX ?? 10),
  idleTimeoutMillis: 30_000,
})

pool.on('error', (error) => {
  // An idle client erroring out must not take the process down.
  console.error('[db] idle client error:', error.message)
})

export type Queryable = Pick<pg.PoolClient, 'query'>

/** Run `fn` inside a transaction, rolling back on any throw. */
export async function transaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const result = await fn(client)
    await client.query('COMMIT')
    return result
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

export async function closePool(): Promise<void> {
  await pool.end()
}
