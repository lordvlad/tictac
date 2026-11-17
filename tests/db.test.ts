import { WALL_CLOCK } from '../src/server/Clock'
import { describe, expect, test } from 'bun:test'
import { accountStoreOverDb } from '../src/server/AccountStore'
import { ACCOUNT_SCHEMA } from '../src/server/db/accountMigrations'
import { openDb } from '../src/server/db/BunSqlDb'
import type { Db } from '../src/server/db/Db'
import { migrate, type Migration } from '../src/server/db/migrate'
import { REGION_SCHEMA } from '../src/server/db/regionMigrations'
import { persistenceOverDb } from '../src/server/Persistence'
import { regionStoreOverDb } from '../src/server/RegionStore'
import { freshDb } from './support/db'
import { legacyDb } from './support/legacySchema'

describe('A url names a SQLite database, or is refused', () => {
  test('the shapes Bun detects as SQLite are the shapes this build accepts', async () => {
    for (const url of [':memory:', 'sqlite://:memory:']) {
      await (await openDb(url)).close()
    }
  })

  test('anything else is refused rather than guessed at', async () => {
    // Bun treats an unrecognised string as a network database's connection
    // string. A typo would therefore reach for a server instead of a file,
    // which is a confusing failure at best and the wrong database at worst.
    for (const url of ['mysql://localhost/tictac', 'mariadb://localhost/tictac', 'matches.sqlite']) {
      await expect(openDb(url)).rejects.toThrow(/unsupported database url/)
    }
  })
})

describe('Migrations', () => {
  const stores = [ACCOUNT_SCHEMA, REGION_SCHEMA]

  test('a fresh database gets every migration of both stores, and a second run gets none', async () => {
    const db = await freshDb()

    for (const schema of stores) {
      expect(await migrate(db, WALL_CLOCK, schema)).toEqual(schema.migrations.map((m) => m.id))
    }
    // Idempotent, because every process that opens the database runs this on
    // the way in: a second server must not re-run migration 1.
    for (const schema of stores) expect(await migrate(db, WALL_CLOCK, schema)).toEqual([])
    // One database, two ledgers: neither store's rows are the other's.
    expect(await db.query<{ store: string; n: number }>`
      SELECT store, CAST(COUNT(*) AS INTEGER) AS n FROM store_migrations GROUP BY store ORDER BY store`).toEqual([
      { store: 'accounts', n: ACCOUNT_SCHEMA.migrations.length },
      { store: 'region', n: REGION_SCHEMA.migrations.length },
    ])

    await db.close()
  })

  test('a store opened alone makes only its own tables', async () => {
    const accounts = await freshDb()
    await migrate(accounts, WALL_CLOCK, ACCOUNT_SCHEMA)
    await expect(accounts.query`SELECT id FROM squads`).rejects.toThrow()
    expect(await accounts.query`SELECT id FROM players`).toEqual([])
    await accounts.close()

    // A region's database has no `players` to point at, and holds a row for a
    // player it has never heard of: the id is all a region knows.
    const region = await freshDb()
    await migrate(region, WALL_CLOCK, REGION_SCHEMA)
    await expect(region.query`SELECT id FROM players`).rejects.toThrow()
    await region.query`INSERT INTO squads (id, player_id, waypoints, start_lat_e6, start_lng_e6, created_at)
                       VALUES (${'s'}, ${'a-player-of-another-region'}, ${'[]'}, ${0}, ${0}, ${'2026-01-01T00:00:00Z'})`
    await region.query`INSERT INTO roster (character_id, player_id, slot, sheet, status, matches, created_at)
                       VALUES (${'c'}, ${'a-player-of-another-region'}, ${0}, ${'{}'}, ${'active'}, ${0}, ${'2026-01-01T00:00:00Z'})`
    expect(await region.query`SELECT player_id FROM squads`).toEqual([{ player_id: 'a-player-of-another-region' }])
    await region.close()
  })

  test('a build whose own list has a gap refuses before touching the database', async () => {
    const db = await freshDb()
    const gapped = { store: 'test', migrations: [REGION_SCHEMA.migrations[0]!, { ...REGION_SCHEMA.migrations[1]!, id: 3 }] }

    await expect(migrate(db, WALL_CLOCK, gapped)).rejects.toThrow(/numbered 1\.\.n/)
    // Refused by the list, not by the database: an empty list still migrates.
    await expect(migrate(db, WALL_CLOCK, { store: 'test', migrations: [] })).resolves.toEqual([])

    await db.close()
  })

  test('a migration that fails part way leaves nothing of itself behind', async () => {
    const db = await freshDb()
    const list: Migration[] = [
      { id: 1, name: 'first', up: ['CREATE TABLE alpha (id TEXT PRIMARY KEY)'] },
      {
        id: 2,
        name: 'second',
        up: ['CREATE TABLE beta (id TEXT PRIMARY KEY)', 'CREATE TABLE beta (this is not sql)'],
      },
    ]
    const schema = { store: 'test', migrations: list }

    await expect(migrate(db, WALL_CLOCK, schema)).rejects.toThrow(/migration 2 \(second\) failed/)
    await expect(migrate(db, WALL_CLOCK, schema)).rejects.toThrow(/migration 2 \(second\) failed/)
    // The whole migration rolled back, so `beta` is not half-there — and
    // migration 2 is not recorded, so a fixed build can run it again.
    await expect(db.query`SELECT id FROM beta`).rejects.toThrow()
    expect(await db.query<{ id: number }>`SELECT id FROM store_migrations WHERE store = 'test' ORDER BY id`).toEqual([
      { id: 1 },
    ])
    expect(await db.query`SELECT id FROM alpha`).toEqual([])

    await db.close()
  })

  test('a migration renamed underneath a database is refused by both names', async () => {
    const db = await freshDb()
    await migrate(db, WALL_CLOCK, REGION_SCHEMA)
    const renamed = {
      ...REGION_SCHEMA,
      migrations: REGION_SCHEMA.migrations.map((m) => (m.id === 2 ? { ...m, name: 'player keys and things' } : m)),
    }

    await expect(migrate(db, WALL_CLOCK, renamed)).rejects.toThrow(
      /migration 2 in the database is "no player foreign keys", this build calls it "player keys and things"/,
    )

    await db.close()
  })

  test('a database from a newer build is refused, not opened as if current', async () => {
    // The dangerous direction. An older build reading a newer schema writes
    // rows the newer build will not recognise, so it never gets that far.
    const db = await freshDb()
    await migrate(db, WALL_CLOCK, REGION_SCHEMA)
    await db.query`INSERT INTO store_migrations (store, id, name, applied_at)
                   VALUES (${'region'}, ${99}, ${'from the future'}, ${new Date().toISOString()})`

    await expect(migrate(db, WALL_CLOCK, REGION_SCHEMA)).rejects.toThrow(
      new RegExp(`region database is at migration 99.*up to ${REGION_SCHEMA.migrations.length}`, 's'),
    )
    // The other store's ledger is its own: the account store opens as ever.
    await expect(migrate(db, WALL_CLOCK, ACCOUNT_SCHEMA)).resolves.toEqual(ACCOUNT_SCHEMA.migrations.map((m) => m.id))

    await db.close()
  })
})

describe('A database written before the account/region split,', () => {
  const WHEN = '2026-01-01T00:00:00Z'

  /** What the old build's database holds for one player: an account, a roster with a casualty, a squad, a contact, a settled match. */
  async function seeded(): Promise<Db> {
    const db = await freshDb()
    await legacyDb(db)
    await db.query`INSERT INTO players (id, name, created_at) VALUES (${'ada'}, ${'Ada'}, ${WHEN})`
    await db.query`INSERT INTO matches (id, header, created_at, seed_label) VALUES (${'m1'}, ${'{}'}, ${WHEN}, ${'seed'})`
    await db.query`INSERT INTO roster (character_id, player_id, slot, sheet, status, matches, created_at, died_in)
                   VALUES (${'alive'}, ${'ada'}, ${0}, ${'{}'}, ${'active'}, ${1}, ${WHEN}, ${null}),
                          (${'fallen'}, ${'ada'}, ${1}, ${'{}'}, ${'dead'}, ${1}, ${WHEN}, ${'m1'})`
    await db.query`INSERT INTO squads (id, player_id, waypoints, start_lat_e6, start_lng_e6, created_at)
                   VALUES (${'sq'}, ${'ada'}, ${'[]'}, ${48_000_000}, ${9_000_000}, ${WHEN})`
    await db.query`INSERT INTO encounters (id, squad_id, player_id, trip, checkpoint, found_at, lat_e6, lng_e6, aliens, room_id)
                   VALUES (${'e1'}, ${'sq'}, ${'ada'}, ${'t'}, ${0}, ${1_000}, ${48_000_000}, ${9_000_000}, ${2}, ${'m1'})`
    await db.query`INSERT INTO match_results (match_id, winner, blue_player, red_player, settled_at)
                   VALUES (${'m1'}, ${0}, ${'ada'}, ${null}, ${WHEN})`
    return db
  }

  test('both stores adopt it as it is: nothing is lost, and the region lets go of the players table', async () => {
    const db = await seeded()

    const persistence = await persistenceOverDb(db, WALL_CLOCK)
    expect(await persistence.accounts.accounts.player('ada')).toEqual({ id: 'ada', name: 'Ada' })
    // Everyone who existed before regions were sharded lives in the one region there was.
    expect(await persistence.accounts.accounts.home('ada')).toBe('singleton')
    expect((await persistence.region.rosters.active('ada')).map((member) => member.characterId)).toEqual(['alive'])
    expect((await persistence.region.rosters.records('ada')).map((row) => [row.characterId, row.status, row.diedIn])).toEqual([
      ['alive', 'active', null],
      ['fallen', 'dead', 'm1'],
    ])
    expect(await persistence.region.squads.of('ada')).toMatchObject({ id: 'sq' })
    expect(await persistence.region.squads.ownerOf('sq')).toBe('singleton')
    expect(await persistence.region.rosters.result('m1')).toEqual({ winner: 0, bluePlayer: 'ada', redPlayer: null })
    expect((await persistence.region.encounters.feed('ada', 5)).map((entry) => entry.matchId)).toEqual(['m1'])
    expect(await db.query<{ store: string; id: number }>`SELECT store, id FROM store_migrations ORDER BY store, id`).toEqual([
      ...ACCOUNT_SCHEMA.migrations.map(({ id }) => ({ store: 'accounts', id })),
      ...REGION_SCHEMA.migrations.map(({ id }) => ({ store: 'region', id })),
    ])

    // The keys are gone: a region now holds a squad for a player it has no
    // account for, and the keys the squad's own encounters keep to it are
    // still there.
    await db.query`INSERT INTO squads (id, player_id, waypoints, start_lat_e6, start_lng_e6, created_at)
                   VALUES (${'sq2'}, ${'stranger'}, ${'[]'}, ${1}, ${1}, ${WHEN})`
    await expect(
      db.query`INSERT INTO encounters (id, squad_id, player_id, trip, checkpoint, found_at, lat_e6, lng_e6, aliens)
               VALUES (${'e2'}, ${'no-such-squad'}, ${'ada'}, ${'t'}, ${0}, ${1}, ${1}, ${1}, ${0})`,
    ).rejects.toThrow()
    // One squad per player in a region, as it always was.
    await expect(
      db.query`INSERT INTO squads (id, player_id, waypoints, start_lat_e6, start_lng_e6, created_at)
               VALUES (${'sq3'}, ${'stranger'}, ${'[]'}, ${1}, ${1}, ${WHEN})`,
    ).rejects.toThrow()

    // Opened again by the next process, it migrates nothing.
    const again = await persistenceOverDb(db, WALL_CLOCK)
    expect(await again.region.squads.of('ada')).toMatchObject({ id: 'sq' })
    await db.close()
  })

  test('each store adopts it on its own, in either order', async () => {
    const db = await seeded()
    const accounts = await accountStoreOverDb(db, WALL_CLOCK)
    expect(await accounts.accounts.player('ada')).toEqual({ id: 'ada', name: 'Ada' })
    const region = await regionStoreOverDb(db, WALL_CLOCK, accounts.accounts)
    expect(await region.rosters.records('ada')).toHaveLength(2)
    await db.close()
  })

  test('one the old build had not finished is refused, with the way out', async () => {
    const db = await freshDb()
    await legacyDb(db, 11)

    await expect(persistenceOverDb(db, WALL_CLOCK)).rejects.toThrow(/stops at migration 11 of 12: open it once with the previous build/)
    await db.close()
  })
})
