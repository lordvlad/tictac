/**
 * The one way this server talks to a database.
 *
 * The database is SQLite, whether it is a file or memory under Bun or a
 * Durable Object's own storage. This file is the port only: `SqlValue`, the
 * `Db` interface itself, and `Batch`. Deliberately free of any engine's own
 * import — `BunSqlDb.ts` (`Bun.SQL` over a SQLite file or `:memory:`) and
 * `workers/DoSqliteDb.ts` (a Durable Object's own SQLite storage, `[ITEM-045]`)
 * are adapters *of* this port, not part of it, and each is free to import
 * whatever its own runtime needs without dragging that runtime's ambient
 * globals into every file that only needs the port's types. `Db.ts` importing
 * `bun` for `SQL`'s type used to do exactly that: `@types/bun` pulls in
 * `@types/node`'s ambient `NodeJS` namespace, which redeclares
 * `crypto`/`BufferSource` in a way that conflicts with
 * `@cloudflare/workers-types`' own — invisible until something in the *same*
 * TypeScript project imports both, which `workers/MatchDurableObject.ts`
 * (via `Api.ts` → `Rosters.ts`/`Accounts.ts` → this file) now does.
 *
 * **Conventions.** Every query written against this port follows them:
 *
 * - Values are TEXT or INTEGER. A timestamp is an ISO string written from JS,
 *   never `CURRENT_TIMESTAMP`, so the injected clock is the only clock.
 *   Binary data is base64url TEXT.
 * - A count is `CAST(COUNT(*) AS INTEGER)`, so its type is stated rather than
 *   inferred.
 * - A camelCase alias is double-quoted (`AS "createdAt"`).
 * - `RETURNING`, partial indexes, `INSERT … VALUES (…, (subselect))` and
 *   `INSERT … ON CONFLICT (…) DO UPDATE SET … = excluded.…` are fair game.
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

/** What may be bound into a query. See the conventions above. */
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
  /**
   * A query, as a tagged template. Every interpolated value is *bound*, never
   * spliced into the text — which is why this is the only way to pass one.
   */
  query<T>(strings: TemplateStringsArray, ...values: SqlValue[]): Promise<T[]>
  /**
   * One statement with no parameters: DDL, a pragma, a test reset.
   *
   * One per call on purpose. Multi-statement support differs between adapters,
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
