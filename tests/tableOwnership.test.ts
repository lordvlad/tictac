import { describe, expect, test } from 'bun:test'
import { WALL_CLOCK } from '../src/server/Clock'
import { ACCOUNT_SCHEMA } from '../src/server/db/accountMigrations'
import { migrate } from '../src/server/db/migrate'
import { REGION_SCHEMA } from '../src/server/db/regionMigrations'
import { freshDb } from './support/db'

/**
 * One store per table (tictac-uqt.11): every table is named in SQL by exactly
 * one module, and what another store needs from it is asked of that store.
 * Schema changes to a table then break one file, loudly, instead of a join in
 * a neighbour silently.
 *
 * The schemas themselves (`db/accountMigrations.ts`, `db/regionMigrations.ts`)
 * name every table by definition and are not readers; `db/migrate.ts` is the
 * one module of its own tables, `store_migrations` and the old single ledger.
 */

const SCHEMAS = ['src/server/db/accountMigrations.ts', 'src/server/db/regionMigrations.ts']
const ROOTS = ['src/server/**/*.ts', 'workers/**/*.ts']

/** The source with its comments blanked: prose that says "FROM rooms" is not SQL. */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

async function sourcesOf(): Promise<Map<string, string>> {
  const sources = new Map<string, string>()
  for (const root of ROOTS) {
    for await (const path of new Bun.Glob(root).scan('.')) {
      if (!SCHEMAS.includes(path)) sources.set(path, withoutComments(await Bun.file(path).text()))
    }
  }
  return sources
}

describe('Every table is read and written by exactly one module', async () => {
  // The tables the migrations leave behind in a real database, not the ones
  // their text names: a rebuild's scratch tables are created and dropped, and
  // a table may be spelled by a template.
  const db = await freshDb()
  await migrate(db, WALL_CLOCK, ACCOUNT_SCHEMA)
  await migrate(db, WALL_CLOCK, REGION_SCHEMA)
  const tables = (
    await db.query<{ name: string }>`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name != 'store_migrations'
       ORDER BY name`
  ).map((row) => row.name)
  await db.close()
  const sources = await sourcesOf()

  /** The modules whose SQL reads or writes `table`. */
  const touching = (table: string): string[] => {
    const pattern = new RegExp(`\\b(?:FROM|JOIN|INTO|UPDATE)\\s+${table}\\b`)
    return [...sources].filter(([, source]) => pattern.test(source)).map(([path]) => path)
  }

  test('the schema names tables worth checking', () => {
    expect(tables).toEqual(
      expect.arrayContaining(['events', 'matches', 'players', 'rooms', 'roster', 'match_results', 'squads', 'encounters']),
    )
  })

  test.each(tables)('%s', (table) => {
    expect(touching(table)).toHaveLength(1)
  })
})
