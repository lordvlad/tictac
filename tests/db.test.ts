import { describe, expect, test } from 'bun:test'
import { dialectOf } from '../src/server/db/Db'
import { migrate, type Migration } from '../src/server/db/migrate'
import { MIGRATIONS } from '../src/server/db/migrations'
import { DATABASE_URLS, freshDb } from './support/db'

describe('A url names an engine, or is refused', () => {
  test('the shapes Bun detects are the shapes this build accepts', () => {
    expect(dialectOf(':memory:')).toBe('sqlite')
    expect(dialectOf('sqlite://matches.sqlite')).toBe('sqlite')
    expect(dialectOf('file:///tmp/matches.sqlite')).toBe('sqlite')
    expect(dialectOf('postgres://user@localhost/tictac')).toBe('postgres')
    expect(dialectOf('postgresql://user@localhost/tictac')).toBe('postgres')
  })

  test('anything else is refused rather than guessed at', () => {
    // Bun treats an unrecognised string as Postgres. A typo would therefore
    // reach for a server instead of a file, which is a confusing failure at
    // best and the wrong database at worst.
    expect(() => dialectOf('mysql://localhost/tictac')).toThrow(/unsupported database url/)
    expect(() => dialectOf('matches.sqlite')).toThrow(/unsupported database url/)
  })
})

describe.each(DATABASE_URLS)('Migrations on %s', (url) => {
  test('a fresh database gets every migration, and a second run gets none', async () => {
    const db = await freshDb(url)

    expect(await migrate(db)).toEqual(MIGRATIONS.map((m) => m.id))
    // Idempotent, because every process that opens the database runs this on
    // the way in: a second server must not re-run migration 1.
    expect(await migrate(db)).toEqual([])

    await db.close()
  })

  test('a build whose own list has a gap refuses before touching the database', async () => {
    const db = await freshDb(url)
    const gapped = [MIGRATIONS[0]!, { ...MIGRATIONS[2]!, id: 3 }]

    await expect(migrate(db, gapped)).rejects.toThrow(/numbered 1\.\.n/)
    // Refused by the list, not by the database: an empty list still migrates.
    await expect(migrate(db, [])).resolves.toEqual([])

    await db.close()
  })

  test('a migration that fails part way leaves nothing of itself behind', async () => {
    const db = await freshDb(url)
    const list: Migration[] = [
      { id: 1, name: 'first', up: ['CREATE TABLE alpha (id TEXT PRIMARY KEY)'] },
      {
        id: 2,
        name: 'second',
        up: ['CREATE TABLE beta (id TEXT PRIMARY KEY)', 'CREATE TABLE beta (this is not sql)'],
      },
    ]

    await expect(migrate(db, list)).rejects.toThrow(/migration 2 \(second\) failed/)
    // The whole migration rolled back, so `beta` is not half-there — and
    // migration 2 is not recorded, so a fixed build can run it again.
    await expect(db.query`SELECT id FROM beta`).rejects.toThrow()
    expect(await db.query<{ id: number }>`SELECT id FROM schema_migrations ORDER BY id`).toEqual([
      { id: 1 },
    ])
    expect(await db.query`SELECT id FROM alpha`).toEqual([])

    await db.close()
  })

  test('a migration renamed underneath a database is refused by both names', async () => {
    const db = await freshDb(url)
    await migrate(db)
    const renamed = MIGRATIONS.map((m) => (m.id === 2 ? { ...m, name: 'accounts and things' } : m))

    await expect(migrate(db, renamed)).rejects.toThrow(
      /migration 2 in the database is "accounts", this build calls it "accounts and things"/,
    )

    await db.close()
  })

  test('a database from a newer build is refused, not opened as if current', async () => {
    // The dangerous direction. An older build reading a newer schema writes
    // rows the newer build will not recognise, so it never gets that far.
    const db = await freshDb(url)
    await migrate(db)
    await db.query`INSERT INTO schema_migrations (id, name, applied_at)
                   VALUES (${99}, ${'from the future'}, ${new Date().toISOString()})`

    await expect(migrate(db)).rejects.toThrow(/at migration 99.*up to 3/s)

    await db.close()
  })
})
