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
 * `schema_migrations`. It is read to make sure a database that still carries
 * it is complete (`checkMonolith`) before the two stores adopt its tables as
 * theirs. Its last two steps were never deployed before the split — production
 * stopped at 10 — so they carry their statements and the adoption finishes
 * them; a database that stops earlier still needs an older build first.
 */
const MONOLITH_LEDGER = 'schema_migrations'
const MONOLITH: readonly { name: string; up?: readonly string[] }[] = [
  { name: 'match log' },
  { name: 'accounts' },
  { name: 'rosters' },
  { name: 'lasting wounds' },
  { name: 'fatigue and medical bay' },
  { name: 'rooms' },
  { name: 'squads' },
  { name: 'encounter rooms' },
  { name: 'encounters' },
  { name: 'player encounters' },
  // Every squad there was belongs to the one region there was.
  { name: 'squad owner', up: ["ALTER TABLE squads ADD COLUMN owner TEXT NOT NULL DEFAULT 'singleton'"] },
  // Every contact written before was written after its outcome, so it is settled.
  { name: 'encounter intent', up: ['ALTER TABLE encounters ADD COLUMN settled INTEGER NOT NULL DEFAULT 1'] },
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

  await checkMonolith(db, clock)
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
 * Bring a database written before the stores were split to the end of its own
 * list, or refuse it: the stores' first migrations adopt its tables as they
 * are (`CREATE … IF NOT EXISTS`), which is only right for the shape its last
 * migration left. The steps this build still carries run each under one commit
 * with their old ledger row, as the build before the split would have run them.
 * A fresh database has no such ledger and passes.
 */
async function checkMonolith(db: Db, clock: ServerClock): Promise<void> {
  const found = await db.query<{ name: string }>`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ${MONOLITH_LEDGER}`
  if (found.length === 0) return
  const rows = await db.query<AppliedRow>`SELECT id, name FROM schema_migrations ORDER BY id`
  const names = rows.map((row) => row.name)
  if (names.length > MONOLITH.length) {
    throw new Error(
      `the database is at migration ${names.length}, but this build only knows migrations up to ` +
        `${MONOLITH.length} of the old single schema: open it with a newer build`,
    )
  }
  const missing = MONOLITH.slice(names.length)
  if (names.some((name, index) => name !== MONOLITH[index]!.name) || missing.some((step) => !step.up)) {
    throw new Error(
      `this database was last opened by a build before the account/region split and stops at migration ${names.length} ` +
        `of ${MONOLITH.length}: open it once with the previous build to finish its migrations, then with this one`,
    )
  }
  for (const [offset, step] of missing.entries()) {
    const id = names.length + offset + 1
    const batch = new Batch()
    for (const statement of step.up!) batch.exec(statement)
    batch.query`INSERT INTO schema_migrations (id, name, applied_at) VALUES (${id}, ${step.name}, ${new Date(clock.now()).toISOString()})`
    await db.transaction(batch)
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
