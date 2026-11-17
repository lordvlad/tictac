import type { ServerClock } from '../Clock'
import { Batch, type Db } from './Db'

/**
 * Forward-only migrations.
 *
 * There is no `down`. A rollback is a second description of the same change,
 * written at the moment it is least likely to be tested, and run at the moment
 * it is least likely to be understood; the honest alternative is a new
 * migration forward. A schema that has gone somewhere wrong goes somewhere else
 * next, and the log of what was applied stays true either way.
 *
 * Nothing here is clever enough to need a dependency. A migration is a numbered
 * list of statements, `store_migrations` says which numbers a store has seen,
 * and the two are checked against each other every time a database is
 * opened — including the check that matters most, which is a database written
 * by a *newer* build than the one now opening it.
 *
 * **One ledger, one list per store.** The account store and a region's store
 * migrate independently (RFC-0002 §4) but may share one database — the
 * singleton Durable Object, a development file — so the ledger is keyed by
 * store: each list is numbered 1..n on its own and never sees the other's rows.
 */

/** One store's schema: the name its ledger rows are kept under, and its migrations in order. */
export interface Schema {
  readonly store: string
  readonly migrations: readonly Migration[]
}

/**
 * The single list every database written before the split ran, under
 * `schema_migrations`. Nothing is applied from it any more; it is only read,
 * to make sure a database that still carries it is complete (`checkMonolith`)
 * before the two stores adopt its tables as theirs.
 */
const MONOLITH_LEDGER = 'schema_migrations'
const MONOLITH_NAMES: readonly string[] = [
  'match log',
  'accounts',
  'rosters',
  'lasting wounds',
  'fatigue and medical bay',
  'rooms',
  'squads',
  'encounter rooms',
  'encounters',
  'player encounters',
  'squad owner',
  'encounter intent',
]

export interface Migration {
  readonly id: number
  readonly name: string
  /** SQL statements, run in order under one commit with the ledger row. */
  readonly up: readonly string[]
}

interface AppliedRow {
  id: number
  name: string
}

/**
 * Bring `db` up to the end of `schema`'s migrations, and say what was applied now.
 *
 * Two processes migrating one database at the same moment are not
 * handled: the `store_migrations` primary key makes the loser fail, which is
 * loud and recoverable, unlike two half-applied schemas.
 */
export async function migrate(db: Db, clock: ServerClock, schema: Schema): Promise<number[]> {
  const { store, migrations } = schema
  for (const [index, migration] of migrations.entries()) {
    // The build's own list, checked before the database is touched: a gap or a
    // reorder here would apply the wrong statements under the right number.
    if (migration.id !== index + 1) {
      throw new Error(
        `migrations must be numbered 1..n in order; found ${migration.id} at position ${index}`,
      )
    }
  }

  await checkMonolith(db)
  await db.exec(
    `CREATE TABLE IF NOT EXISTS store_migrations (
       store      TEXT    NOT NULL,
       id         INTEGER NOT NULL,
       name       TEXT    NOT NULL,
       applied_at TEXT    NOT NULL,
       PRIMARY KEY (store, id)
     )`,
  )
  const applied = await db.query<AppliedRow>`SELECT id, name FROM store_migrations WHERE store = ${store} ORDER BY id`

  for (const row of applied) {
    const id = Number(row.id)
    if (id > migrations.length) {
      // The dangerous direction. An older build opening a newer schema would
      // read columns that have moved and write rows the newer build will not
      // recognise, so it is refused by name instead.
      throw new Error(
        `the ${store} database is at migration ${id}, but this build only knows migrations up to ` +
          `${migrations.length}: open it with a newer build`,
      )
    }
    const known = migrations[id - 1]!
    if (known.name !== row.name) {
      throw new Error(
        `migration ${id} in the database is "${row.name}", this build calls it "${known.name}"`,
      )
    }
  }

  const done = new Set(applied.map((row) => Number(row.id)))
  const ran: number[] = []
  for (const migration of migrations) {
    if (done.has(migration.id)) continue
    await apply(db, store, migration, new Date(clock.now()).toISOString())
    ran.push(migration.id)
  }
  return ran
}

/**
 * Refuse a database written before the stores were split unless it was
 * finished: the stores' first migrations adopt its tables as they are
 * (`CREATE … IF NOT EXISTS`), which is only right for the shape its last
 * migration left. A fresh database has no such ledger and passes.
 */
async function checkMonolith(db: Db): Promise<void> {
  const found = await db.query<{ name: string }>`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ${MONOLITH_LEDGER}`
  if (found.length === 0) return
  const rows = await db.query<AppliedRow>`SELECT id, name FROM schema_migrations ORDER BY id`
  const names = rows.map((row) => row.name)
  if (names.length > MONOLITH_NAMES.length) {
    throw new Error(
      `the database is at migration ${names.length}, but this build only knows migrations up to ` +
        `${MONOLITH_NAMES.length} of the old single schema: open it with a newer build`,
    )
  }
  if (names.length < MONOLITH_NAMES.length || names.some((name, index) => name !== MONOLITH_NAMES[index])) {
    throw new Error(
      `this database was last opened by a build before the account/region split and stops at migration ${names.length} ` +
        `of ${MONOLITH_NAMES.length}: open it once with the previous build to finish its migrations, then with this one`,
    )
  }
}

/**
 * One migration, under one commit with the row that records it.
 *
 * A migration that half-applied would be a schema no version number describes,
 * so the bookkeeping and the change are the same transaction. (SQLite runs DDL
 * transactionally, which is the whole reason this is possible at all.)
 */
async function apply(db: Db, store: string, migration: Migration, appliedAt: string): Promise<void> {
  const batch = new Batch()
  for (const statement of migration.up) batch.exec(statement)
  batch.query`INSERT INTO store_migrations (store, id, name, applied_at)
              VALUES (${store}, ${migration.id}, ${migration.name}, ${appliedAt})`
  try {
    await db.transaction(batch)
  } catch (error) {
    throw new Error(
      `migration ${migration.id} (${migration.name}) failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
  }
}
