import type { Db } from './Db'
import { MIGRATIONS } from './migrations'

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
 * list of statements, `schema_migrations` says which numbers a database has
 * seen, and the two are checked against each other every time a database is
 * opened — including the check that matters most, which is a database written
 * by a *newer* build than the one now opening it.
 */

/**
 * One statement, either identical on both engines or spelled per engine.
 *
 * The per-engine form exists for exactly one thing so far — an append-only
 * trigger, which SQLite writes as `RAISE(ABORT, …)` and Postgres as a plpgsql
 * function — and both halves must be the *same number of statements*, so a
 * database's statement count does not depend on where it lives.
 */
export type Statement = string | { readonly sqlite: string; readonly postgres: string }

export interface Migration {
  readonly id: number
  readonly name: string
  readonly up: readonly Statement[]
}

interface AppliedRow {
  id: number
  name: string
}

/**
 * Bring `db` up to the end of `migrations`, and say what was applied now.
 *
 * Two processes migrating one Postgres database at the same moment are not
 * handled: the `schema_migrations` primary key makes the loser fail, which is
 * loud and recoverable, unlike two half-applied schemas.
 */
export async function migrate(
  db: Db,
  migrations: readonly Migration[] = MIGRATIONS,
): Promise<number[]> {
  for (const [index, migration] of migrations.entries()) {
    // The build's own list, checked before the database is touched: a gap or a
    // reorder here would apply the wrong statements under the right number.
    if (migration.id !== index + 1) {
      throw new Error(
        `migrations must be numbered 1..n in order; found ${migration.id} at position ${index}`,
      )
    }
  }

  await db.exec(
    'CREATE TABLE IF NOT EXISTS schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)',
  )
  const applied = await db.query<AppliedRow>`SELECT id, name FROM schema_migrations ORDER BY id`

  for (const row of applied) {
    const id = Number(row.id)
    if (id > migrations.length) {
      // The dangerous direction. An older build opening a newer schema would
      // read columns that have moved and write rows the newer build will not
      // recognise, so it is refused by name instead.
      throw new Error(
        `the database is at migration ${id}, but this build only knows migrations up to ` +
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
    await apply(db, migration)
    ran.push(migration.id)
  }
  return ran
}

/**
 * One migration, under one commit with the row that records it.
 *
 * A migration that half-applied would be a schema no version number describes,
 * so the bookkeeping and the change are the same transaction. (SQLite runs DDL
 * transactionally, which is the whole reason this is possible at all.)
 */
async function apply(db: Db, migration: Migration): Promise<void> {
  const appliedAt = new Date().toISOString()
  try {
    await db.transaction(async (tx) => {
      for (const statement of migration.up) {
        await tx.exec(typeof statement === 'string' ? statement : statement[tx.dialect])
      }
      await tx.query`INSERT INTO schema_migrations (id, name, applied_at)
                     VALUES (${migration.id}, ${migration.name}, ${appliedAt})`
    })
  } catch (error) {
    throw new Error(
      `migration ${migration.id} (${migration.name}) failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
  }
}
