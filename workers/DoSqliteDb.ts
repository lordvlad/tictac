import type { Batch, Db, SqlValue } from '../src/server/db/Db'

/**
 * The slice of a Durable Object's `ctx.storage` this adapter uses, stated
 * structurally rather than imported from `@cloudflare/workers-types`: that
 * package's ambient globals cannot share a TypeScript project with `bun`'s
 * (see `src/server/db/Db.ts`), and the contract test (`tests/dbContract.test.ts`)
 * hands this adapter a fake that rolls back the way `transactionSync` does.
 * The real `ctx.storage` satisfies it as it is.
 */
export interface DoStorage {
  readonly sql: {
    exec(query: string, ...bindings: SqlValue[]): { toArray(): unknown[] }
  }
  /** Runs `closure` as one transaction and returns what it returns; a throw rolls every write in it back. Cannot wrap an `await`. */
  transactionSync<T>(closure: () => T): T
}

/**
 * A `Db` (`src/server/db/Db.ts`) over a Durable Object's own SQLite storage
 * (`ctx.storage.sql`) — the adapter `[ITEM-045]` left unwritten while this
 * was being reasoned through; see `docs/architecture/deployment.md` §3.
 *
 * `query`/`exec` map directly: `SqlStorage.exec` takes `?` placeholders and
 * positional bindings, which is exactly what a tagged-template call already
 * carries. The work is genuinely synchronous underneath — no real I/O wait,
 * unlike `Bun.SQL`'s wire protocol — so wrapping it in `async` functions
 * changes nothing about *when* the work happens, only when the caller is
 * told it is done.
 *
 * `transaction` runs a {@link Batch} inside `ctx.storage.transactionSync`,
 * which is why the port takes a batch and not a callback: `transactionSync`
 * requires a callback with **no** `await` in it (`await` always defers to the
 * microtask queue, so a statement after one would run *after* the runtime had
 * considered the transaction committed), and a batch is already a list of
 * statements with nothing to await. Every step runs inside that one
 * synchronous closure, and the first to throw rolls the whole batch back —
 * what `BunSqlDb.ts`'s `begin` does, so a migration or a registration is
 * all-or-nothing on both.
 *
 * What a batch cannot do is read: whatever a caller must decide from the
 * database it decides *before* building the batch, and a Durable Object's
 * single-threaded input gates are what keep a different request from writing
 * in between.
 */
export function dbOverStorage(storage: DoStorage): Db {
  const { sql } = storage

  const placeholders = (strings: readonly string[]): string =>
    strings.slice(1).reduce((text, part) => `${text}?${part}`, strings[0] ?? '')

  return {
    async query<T>(strings: TemplateStringsArray, ...values: SqlValue[]): Promise<T[]> {
      return sql.exec(placeholders(strings), ...values).toArray() as T[]
    },
    async exec(statement: string): Promise<void> {
      sql.exec(statement)
    },
    async transaction(batch: Batch): Promise<void> {
      if (batch.steps.length === 0) return
      storage.transactionSync(() => {
        for (const step of batch.steps) {
          if (step.kind === 'exec') sql.exec(step.statement)
          else sql.exec(placeholders(step.strings), ...step.values)
        }
      })
    },
    async close(): Promise<void> {
      // Nothing to close: the Durable Object owns the storage's lifecycle,
      // not this adapter — closing here would mean closing it out from under
      // every other request this instance still has to answer.
    },
  }
}
