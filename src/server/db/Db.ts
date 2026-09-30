import { SQL, type TransactionSQL } from 'bun'

/**
 * The one way this server talks to a database.
 *
 * Where the database will live is still open — a Durable Object per match, or
 * one central Postgres — so nothing above this file may know which engine it is
 * speaking to. `Bun.SQL` already speaks both SQLite and Postgres through one
 * tagged-template interface, which is why there is no driver and no ORM here:
 * the port is thin because the runtime already carries the hard part.
 *
 * SQLite is what runs today, in a file or in memory, and it is what the tests
 * run against by default. Postgres is run against the same suite whenever
 * `TICTAC_TEST_POSTGRES_URL` is set, which is the only way a portability claim
 * stays true.
 *
 * **Portability rules.** Every query written against this port obeys them, and
 * a query that does not is a query that works here and fails wherever the
 * database ends up:
 *
 * - Values are TEXT or INTEGER. A timestamp is an ISO string written from JS,
 *   never `CURRENT_TIMESTAMP`, because the two engines disagree about both the
 *   type and the clock. Binary data is base64url TEXT.
 * - A count is `CAST(COUNT(*) AS INTEGER)`: Postgres hands back `bigint`, which
 *   arrives as a string and silently loses `toEqual`.
 * - A camelCase alias is double-quoted (`AS "createdAt"`), or Postgres folds it
 *   to lower case.
 * - No generated columns, no JSON operators in SQL, no `rowid`, no
 *   `WITHOUT ROWID`. All four are SQLite's alone.
 * - `RETURNING`, partial indexes and `INSERT … VALUES (…, (subselect))` are
 *   fair game: both engines have them.
 *
 * A Durable Objects deployment means one more implementation of {@link Db}, and
 * nothing above it changes. A host has now been chosen and planted
 * (`[ITEM-045]`, `workers/MatchDurableObject.ts`), but the adapter is still not
 * written: `ctx.storage.sql` is synchronous and its transaction primitive
 * cannot run an `async` callback, which every caller of {@link Db.transaction}
 * is. See [ARCH-DEPLOYMENT §3](../../../docs/architecture/deployment.md) for
 * why that is a real mismatch and not just unstarted work.
 */

/** The engines this build knows how to speak to. */
export type Dialect = 'sqlite' | 'postgres'

/** What may be bound into a query. See the portability rules above. */
export type SqlValue = string | number | null

export interface Db {
  readonly dialect: Dialect
  /**
   * A query, as a tagged template. Every interpolated value is *bound*, never
   * spliced into the text — which is why this is the only way to pass one.
   */
  query<T>(strings: TemplateStringsArray, ...values: SqlValue[]): Promise<T[]>
  /**
   * One statement with no parameters: DDL, a pragma, a test reset.
   *
   * One per call on purpose. Multi-statement support differs between engines,
   * so a migration lists its statements separately rather than relying on it.
   */
  exec(statement: string): Promise<void>
  /** Run `fn` inside a transaction, committing on return and rolling back on throw. */
  transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T>
  close(): Promise<void>
}

/**
 * Which engine a url names, refusing anything else by name.
 *
 * The patterns are `Bun.SQL`'s own auto-detection, restated here so an
 * unsupported url fails with a sentence rather than by connecting to the wrong
 * thing: Bun treats any unrecognised string as Postgres.
 */
export function dialectOf(url: string): Dialect {
  if (url === ':memory:' || url.startsWith('sqlite:') || url.startsWith('file:')) return 'sqlite'
  if (url.startsWith('postgres://') || url.startsWith('postgresql://')) return 'postgres'
  throw new Error(`unsupported database url "${url}": use :memory:, sqlite://… or postgres://…`)
}

/** Open a database. It is not migrated here — see `migrate`. */
export async function openDb(url: string): Promise<Db> {
  const dialect = dialectOf(url)
  const sql = new SQL(url)
  const db = wrap(sql, dialect)
  if (dialect === 'sqlite') {
    // A row may not name a parent that is not there. SQLite has to be told;
    // Postgres enforces it natively.
    await db.exec('PRAGMA foreign_keys = ON')
    // Readers never block the append path, which is what lets an audit read a
    // match that is still being played.
    await db.exec('PRAGMA journal_mode = WAL')
  }
  return db
}

function wrap(sql: SQL | TransactionSQL, dialect: Dialect): Db {
  return {
    dialect,
    async query<T>(strings: TemplateStringsArray, ...values: SqlValue[]): Promise<T[]> {
      const rows = await sql<T[]>(strings, ...values)
      // Copied out of Bun's result array, which carries `count` and `command`
      // as own properties — enough to break any `toEqual` against a plain array.
      return [...rows]
    },
    async exec(statement: string): Promise<void> {
      await sql.unsafe(statement)
    },
    transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
      return sql.begin((tx) => fn(wrap(tx, dialect))) as Promise<T>
    },
    async close(): Promise<void> {
      await sql.close()
    },
  }
}
