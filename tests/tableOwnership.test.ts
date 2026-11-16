import { describe, expect, test } from 'bun:test'

/**
 * One store per table (tictac-uqt.11): every table is named in SQL by exactly
 * one module, and what another store needs from it is asked of that store.
 * Schema changes to a table then break one file, loudly, instead of a join in
 * a neighbour silently.
 *
 * The schema itself (`db/migrations.ts`) names every table by definition and is
 * not a reader; `db/migrate.ts` is the one module of its own table,
 * `schema_migrations`.
 */

const SCHEMA = 'src/server/db/migrations.ts'
const ROOTS = ['src/server/**/*.ts', 'workers/**/*.ts']

/** The source with its comments blanked: prose that says "FROM rooms" is not SQL. */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

async function sourcesOf(): Promise<Map<string, string>> {
  const sources = new Map<string, string>()
  for (const root of ROOTS) {
    for await (const path of new Bun.Glob(root).scan('.')) {
      if (path !== SCHEMA) sources.set(path, withoutComments(await Bun.file(path).text()))
    }
  }
  return sources
}

describe('Every table is read and written by exactly one module', async () => {
  const schema = await Bun.file(SCHEMA).text()
  const tables = [...new Set([...schema.matchAll(/CREATE TABLE (\w+)/g)].map((match) => match[1]!))]
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
