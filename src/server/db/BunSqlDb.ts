import { SQL } from 'bun'
import type { RelyingParty } from '../AccountStore'
import { persistenceOverDb, type Persistence } from '../Persistence'
import type { ServerClock } from '../Clock'
import type { Batch, Db, SqlValue } from './Db'

/**
 * The `Db` port (`./Db.ts`), over `Bun.SQL` — the adapter that runs today, over
 * a SQLite file or in memory. Split out of `Db.ts` itself so that
 * file stays free of `bun`'s own types: importing `SQL`'s type pulls in
 * `@types/bun`, which pulls in `@types/node`'s ambient `NodeJS` namespace,
 * which conflicts with `@cloudflare/workers-types`' own globals the moment
 * both are reachable from one TypeScript project — see `Db.ts`'s own note.
 * `openPersistence` lives here for the same reason, rather than beside
 * `persistenceOverDb` in `Persistence.ts`: it is the part of that file that
 * actually opens a `Bun.SQL` connection.
 */

export interface OpenPersistenceOptions {
  /** The passkeys' relying party; `LOCAL_RELYING_PARTY` unless set. */
  party?: RelyingParty
  /**
   * The region's own database. Unset, it is the same file or server as the
   * accounts' — which is what a single database written before the split is —
   * except for `:memory:`, which is private to its connection, so there each
   * store gets one of its own.
   */
  regionUrl?: string
  /** The region this is, as an owner column names it; the singleton unless set. */
  self?: string
}

/**
 * Both stores of the Bun host, in this process. `url` is the account store's
 * database. A `:memory:` default is what a test runs against, and the reason a
 * join between the two stores' tables fails there instead of passing by
 * accident; a test that wants both in one database opens a `Db` itself and
 * hands it to `persistenceOverDb`.
 */
export async function openPersistence(
  clock: ServerClock,
  url = ':memory:',
  options: OpenPersistenceOptions = {},
): Promise<Persistence> {
  const db = await openDb(url)
  const regionUrl = options.regionUrl ?? (url === ':memory:' ? ':memory:' : undefined)
  return persistenceOverDb(db, clock, {
    party: options.party,
    self: options.self,
    regionDb: regionUrl === undefined ? undefined : await openDb(regionUrl),
  })
}

/**
 * Open a SQLite database: a file or `:memory:`. It is not migrated here — see
 * `migrate`.
 *
 * The accepted forms are `Bun.SQL`'s own SQLite detection, restated so an
 * unsupported url fails with a sentence: Bun treats any unrecognised string as
 * a network database's connection string and would try to connect to one.
 */
export async function openDb(url: string): Promise<Db> {
  if (url !== ':memory:' && !url.startsWith('sqlite:') && !url.startsWith('file:')) {
    throw new Error(`unsupported database url "${url}": use :memory:, sqlite://… or file://…`)
  }
  const db = wrap(new SQL(url))
  // A row may not name a parent that is not there; SQLite has to be told.
  await db.exec('PRAGMA foreign_keys = ON')
  // Readers never block the append path, which is what lets an audit read a
  // match that is still being played.
  await db.exec('PRAGMA journal_mode = WAL')
  return db
}

function wrap(sql: SQL): Db {
  return {
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
