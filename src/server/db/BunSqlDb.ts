import { SQL } from 'bun'
import {
  LOCAL_RELYING_PARTY,
  persistenceOverDb,
  type Persistence,
  type RelyingParty,
} from '../Persistence'
import type { ServerClock } from '../Clock'
import { dialectOf, type Batch, type Db, type Dialect, type SqlValue } from './Db'

/**
 * The `Db` port (`./Db.ts`), over `Bun.SQL` — the adapter that runs today, in
 * a file, in memory, or against Postgres. Split out of `Db.ts` itself so that
 * file stays free of `bun`'s own types: importing `SQL`'s type pulls in
 * `@types/bun`, which pulls in `@types/node`'s ambient `NodeJS` namespace,
 * which conflicts with `@cloudflare/workers-types`' own globals the moment
 * both are reachable from one TypeScript project — see `Db.ts`'s own note.
 * `openPersistence` lives here for the same reason, rather than beside
 * `persistenceOverDb` in `Persistence.ts`: it is the part of that file that
 * actually opens a `Bun.SQL` connection.
 */

export async function openPersistence(
  clock: ServerClock,
  url = ':memory:',
  party: RelyingParty = LOCAL_RELYING_PARTY,
): Promise<Persistence> {
  const db = await openDb(url)
  return persistenceOverDb(db, clock, party)
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

function wrap(sql: SQL, dialect: Dialect): Db {
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
    async transaction(batch: Batch): Promise<void> {
      if (batch.steps.length === 0) return
      // `begin` rolls back when the callback rejects, which is the first step
      // to fail: the same all-or-nothing `DoSqliteDb` gets from `transactionSync`.
      await sql.begin(async (tx) => {
        for (const step of batch.steps) {
          if (step.kind === 'exec') await tx.unsafe(step.statement)
          else await tx(step.strings, ...step.values)
        }
      })
    },
    async close(): Promise<void> {
      await sql.close()
    },
  }
}
