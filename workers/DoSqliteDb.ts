import type { Db, Dialect, SqlValue } from '../src/server/db/Db'

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
 * `transaction` is the one place this adapter does not do what the `Bun.SQL`
 * one does, and says so rather than pretending otherwise. `Db.transaction<T>(fn:
 * (tx: Db) => Promise<T>)` is written with `await` between statements, and
 * Cloudflare's synchronous transaction primitive, `ctx.storage.sql`'s sibling
 * `transactionSync`, requires a callback that contains **no** `await` at all
 * — `await` unconditionally defers to the microtask queue even for an
 * already-resolved promise, so any statement in `fn` after its first `await`
 * would run *after* `transactionSync`'s callback had already returned and the
 * runtime had already considered the transaction committed, outside the
 * boundary it was meant to be in. There is no way to satisfy both
 * `transactionSync`'s synchronous-callback requirement and `Db.transaction`'s
 * async one for an `fn` with more than one statement — see the citations in
 * the deployment doc for exactly which Cloudflare guarantee does and does not
 * cover this.
 *
 * What this adapter keeps: a Durable Object processes one request at a time,
 * and its input gates stop a *different* request's storage operations from
 * interleaving with this one's while it runs, so two overlapping calls to
 * `transaction` never see each other's half-done work. What it does **not**
 * keep is rollback on throw: if `fn` throws after its second statement has
 * already run, that statement stays written, where the `Bun.SQL` adapter's
 * genuine `sql.begin()` would have rolled it back. `migrate.ts`'s `apply()`
 * is the one caller this matters for in practice — a migration that fails
 * partway on this adapter needs a human to notice and fix the row it left
 * behind, the same way a `down` migration would have needed one to write and
 * run it.
 */
export function dbOverSqlStorage(sql: SqlStorage): Db {
  const dialect: Dialect = 'sqlite'

  const placeholders = (strings: TemplateStringsArray): string =>
    strings.slice(1).reduce((text, part) => `${text}?${part}`, strings[0] ?? '')

  const self: Db = {
    dialect,
    async query<T>(strings: TemplateStringsArray, ...values: SqlValue[]): Promise<T[]> {
      return sql.exec<Record<string, SqlValue>>(placeholders(strings), ...values).toArray() as T[]
    },
    async exec(statement: string): Promise<void> {
      sql.exec(statement)
    },
    transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
      return fn(self)
    },
    async close(): Promise<void> {
      // Nothing to close: the Durable Object owns the storage's lifecycle,
      // not this adapter — closing here would mean closing it out from under
      // every other request this instance still has to answer.
    },
  }
  return self
}
