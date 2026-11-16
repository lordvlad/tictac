/**
 * The one way this server talks to a database.
 *
 * Where the database will live is still open — a Durable Object per match, or
 * one central Postgres — so nothing above this file may know which engine it is
 * speaking to. This file is the port only: `Dialect`, `SqlValue`, the `Db`
 * interface itself, and `dialectOf`. Deliberately free of any engine's own
 * import — `BunSqlDb.ts` (`Bun.SQL`, both SQLite and Postgres through one
 * tagged-template interface) and `workers/DoSqliteDb.ts` (a Durable Object's
 * own SQLite storage, `[ITEM-045]`) are adapters *of* this port, not part of
 * it, and each is free to import whatever its own engine needs without
 * dragging that engine's ambient globals into every file that only needs the
 * port's types. `Db.ts` importing `bun` for `SQL`'s type used to do exactly
 * that: `@types/bun` pulls in `@types/node`'s ambient `NodeJS` namespace,
 * which redeclares `crypto`/`BufferSource` in a way that conflicts with
 * `@cloudflare/workers-types`' own — invisible until something in the *same*
 * TypeScript project imports both, which `workers/MatchDurableObject.ts`
 * (via `Api.ts` → `Rosters.ts`/`Accounts.ts` → this file) now does.
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
 * - `RETURNING`, partial indexes, `INSERT … VALUES (…, (subselect))` and
 *   `INSERT … ON CONFLICT (…) DO UPDATE SET … = excluded.…` are fair game:
 *   both engines have them.
 *
 * A Durable Objects deployment means one more implementation of {@link Db},
 * and nothing above it changes: `workers/DoSqliteDb.ts` is that
 * implementation.
 *
 * **Atomicity is a batch, not a callback.** A Durable Object's
 * `transactionSync` cannot wrap an `await`, so a transaction here is not a
 * function that interleaves reads and writes: it is a {@link Batch} of writes
 * built beforehand, which {@link Db.transaction} then runs all-or-nothing on
 * every adapter. A caller reads what it needs, computes, and hands over the
 * writes in one go; a batch cannot read, so it cannot decide anything halfway.
 * Anything that must be read *and* written atomically is a single statement
 * (`INSERT … SELECT`, a subselect, a guarded `UPDATE`), not a transaction.
 */

/** The engines this build knows how to speak to. */
export type Dialect = 'sqlite' | 'postgres'

/** What may be bound into a query. See the portability rules above. */
export type SqlValue = string | number | null

/** One recorded write, kept as the template it was written as so each adapter binds it its own way. */
export type Step =
  | { readonly kind: 'query'; readonly strings: TemplateStringsArray; readonly values: readonly SqlValue[] }
  | { readonly kind: 'exec'; readonly statement: string }

/**
 * Writes to run together, in order, under one commit (`Db.transaction`).
 *
 * It takes the same two calls as a {@link Db} and returns nothing from either:
 * nothing is sent to the database until the batch is handed over, so there is
 * nothing yet to read back.
 */
export class Batch {
  readonly steps: Step[] = []

  query(strings: TemplateStringsArray, ...values: SqlValue[]): void {
    this.steps.push({ kind: 'query', strings, values })
  }

  exec(statement: string): void {
    this.steps.push({ kind: 'exec', statement })
  }
}

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
  /**
   * Run every step of `batch`, in order, as one transaction: all of them
   * commit, or the first one to fail rolls the rest back and rejects with its
   * error. The same on every adapter. A batch with no steps does nothing.
   */
  transaction(batch: Batch): Promise<void>
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
