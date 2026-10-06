import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Faction } from '../src/config'
import { RECORDING_VERSION } from '../src/game/Recording'
import { openDb, openPersistence } from '../src/server/db/BunSqlDb'
import { MIGRATIONS } from '../src/server/db/migrations'
import type { UnsequencedEvent } from '../src/server/MatchStore'
import type { StoredRoom } from '../src/server/RoomStore'
import { STOCK_PLAN } from '../src/sim/Balance'
import { SimMatch } from '../src/sim/SimMatch'
import { replay } from '../src/sim/Replay'
import type { CombatRecording, RecordingHeader } from '../src/game/Recording'
import { DATABASE_URLS, freshPersistence } from './support/db'

/**
 * A real intent log, not a handmade one: the store exists so a match can be
 * replayed out of it, and an invented command stream would prove that a row
 * came back rather than that a match did.
 */
function recorded(seed: number): CombatRecording {
  const match = new SimMatch({ seed, blue: STOCK_PLAN, red: STOCK_PLAN, turnCap: 40, record: true })
  match.run()
  const recording = match.recording
  if (!recording) throw new Error('match did not record')
  return recording
}

/** The same log, minus the numbering the store insists on owning. */
function unsequenced(recording: CombatRecording): UnsequencedEvent[] {
  return recording.events.map(({ turn, faction, command }) => ({ turn, faction, command }))
}

/** A header with nothing interesting in it but the fields a list sorts and labels by. */
function header(createdAt: string, seedLabel: string): RecordingHeader {
  return {
    version: RECORDING_VERSION,
    seed: 1,
    seedLabel,
    source: 'sim',
    createdAt,
    turnCap: null,
    squads: { [Faction.Blue]: [], [Faction.Red]: [] },
  }
}

/** One intent, for the tests that are about the log rather than the fight. */
const END_TURN: UnsequencedEvent = {
  turn: 1,
  faction: Faction.Blue,
  command: { type: 'endTurn', faction: Faction.Blue },
}

let log: CombatRecording

beforeAll(() => {
  log = recorded(4242)
  expect(log.events.length).toBeGreaterThan(20)
})

describe.each(DATABASE_URLS)('The match store on %s', (url) => {
  describe('A match goes into the store as its intents and comes back out as a match', () => {
    test('the header and every event survive, in order', async () => {
      const store = await freshPersistence(url)
      const id = await store.matches.create(log.header)
      await store.matches.appendAll(id, unsequenced(log))

      const stored = await store.matches.match(id)
      expect(stored).not.toBeNull()
      expect(stored!.id).toBe(id)
      expect(stored!.header).toEqual(log.header)
      // Identical numbering as well as identical content: the recorder and the
      // store both number a log densely from zero, so a client that saw a match
      // live and a client that read it back are counting in the same units.
      expect(stored!.events).toEqual(log.events)

      await store.close()
    })

    test('a stored log replays: every intent in it is one this build carries out', async () => {
      // The property the store exists to preserve. A log that does not replay is
      // not a store of record, so a skipped event here is a store failure and
      // not a rules finding.
      const store = await freshPersistence(url)
      const id = await store.matches.create(log.header)
      await store.matches.appendAll(id, unsequenced(log))

      const outcome = replay((await store.matches.match(id))!)

      expect(outcome.events).toBe(log.events.length)
      expect(outcome.applied).toBe(outcome.events)
      expect(outcome.skipped).toEqual([])
      // Out of the store, over the same seed, into the same world.
      expect(outcome.digest).toEqual(replay(log).digest)

      await store.close()
    })
  })

  describe('Rejoin reads the tail', () => {
    test('afterSeq is exclusive and returns exactly what came later', async () => {
      const store = await freshPersistence(url)
      const id = await store.matches.create(log.header)
      await store.matches.appendAll(id, unsequenced(log))

      const all = await store.matches.events(id)
      const lastSeen = all[9]!.seq
      const tail = await store.matches.events(id, lastSeen)

      expect(tail.length).toBe(all.length - 10)
      expect(tail[0]!.seq).toBe(lastSeen + 1)
      expect(tail).toEqual(all.slice(10))
      // A client that is already current asks for nothing and gets nothing,
      // rather than the last event a second time.
      expect(await store.matches.events(id, all[all.length - 1]!.seq)).toEqual([])

      await store.close()
    })

    test('a client that has nothing gets the whole log', async () => {
      const store = await freshPersistence(url)
      const id = await store.matches.create(log.header)
      await store.matches.appendAll(id, unsequenced(log))

      expect(await store.matches.events(id, -1)).toEqual(await store.matches.events(id))

      await store.close()
    })
  })

  describe('The store owns the numbering', () => {
    test('appends are numbered densely from zero however they arrive', async () => {
      const store = await freshPersistence(url)
      const id = await store.matches.create(header('2026-09-18T10:00:00Z', 'dense'))

      expect((await store.matches.append(id, END_TURN)).seq).toBe(0)
      expect((await store.matches.append(id, END_TURN)).seq).toBe(1)
      // The same intent twice is a legal thing for a player to do, and it must
      // not collapse into one row or collide on the key.
      const pair = await store.matches.appendAll(id, [END_TURN, END_TURN])
      expect(pair.map((event) => event.seq)).toEqual([2, 3])
      expect((await store.matches.append(id, END_TURN)).seq).toBe(4)

      expect((await store.matches.events(id)).map((event) => event.seq)).toEqual([0, 1, 2, 3, 4])

      await store.close()
    })

    test('two logs are numbered independently', async () => {
      // Numbering is per match, because what a rejoining client counts is its own
      // match's intents and nothing else in the store.
      const store = await freshPersistence(url)
      const first = await store.matches.create(header('2026-09-18T10:00:00Z', 'first'))
      const second = await store.matches.create(header('2026-09-18T11:00:00Z', 'second'))

      await store.matches.append(first, END_TURN)
      expect((await store.matches.append(second, END_TURN)).seq).toBe(0)
      expect((await store.matches.append(first, END_TURN)).seq).toBe(1)

      await store.close()
    })
  })

  describe('The log is evidence', () => {
    test('an event cannot be rewritten or deleted, even behind the API', async () => {
      // Append-only is a property of the database, not a courtesy of this class:
      // the log is what tells a foul from a bug in the rules, and one that can be
      // edited proves nothing about either.
      const store = await freshPersistence(url)
      const id = await store.matches.create(header('2026-09-18T12:00:00Z', 'evidence'))
      await store.matches.append(id, END_TURN)

      await expect(store.db.exec('UPDATE events SET turn = 99')).rejects.toThrow(/append-only/)
      await expect(store.db.exec('DELETE FROM events')).rejects.toThrow(/append-only/)
      expect(await store.db.query<{ turn: number }>`SELECT turn FROM events`).toEqual([{ turn: 1 }])

      await store.close()
    })
  })

  describe('A store that has never heard of a match says so', () => {
    test('reading an unknown id answers nothing rather than throwing', async () => {
      const store = await freshPersistence(url)

      expect(await store.matches.header('nobody')).toBeNull()
      expect(await store.matches.match('nobody')).toBeNull()
      expect(await store.matches.events('nobody')).toEqual([])

      await store.close()
    })

    test('appending to an unknown id is refused', async () => {
      // The asymmetry is deliberate: a failed read has its answer, a failed write
      // has lost an intent.
      const store = await freshPersistence(url)

      await expect(store.matches.append('nobody', END_TURN)).rejects.toThrow(/no match nobody/)
      await expect(store.matches.appendAll('nobody', [END_TURN])).rejects.toThrow(/no match nobody/)

      await store.close()
    })

    test('a recording from another format version is not stored as if current', async () => {
      const store = await freshPersistence(url)
      const stale = { ...header('2026-09-18T10:00:00Z', 'stale'), version: RECORDING_VERSION - 1 }

      await expect(store.matches.create(stale)).rejects.toThrow(/cannot store a version/)
      expect(await store.matches.recent()).toEqual([])

      await store.close()
    })
  })

  describe('Listing matches', () => {
    test('recent orders newest first and counts each log', async () => {
      const store = await freshPersistence(url)
      const older = await store.matches.create(header('2026-09-17T08:00:00Z', 'older'))
      const newest = await store.matches.create(header('2026-09-18T09:00:00Z', 'newest'))
      const middle = await store.matches.create(header('2026-09-17T20:00:00Z', 'middle'))

      await store.matches.append(newest, END_TURN)
      await store.matches.append(newest, END_TURN)
      await store.matches.append(middle, END_TURN)

      expect(await store.matches.recent()).toEqual([
        { id: newest, createdAt: '2026-09-18T09:00:00Z', seedLabel: 'newest', events: 2 },
        { id: middle, createdAt: '2026-09-17T20:00:00Z', seedLabel: 'middle', events: 1 },
        { id: older, createdAt: '2026-09-17T08:00:00Z', seedLabel: 'older', events: 0 },
      ])
      expect((await store.matches.recent(2)).map((row) => row.id)).toEqual([newest, middle])

      await store.close()
    })
  })

  describe('Rooms a lobby holds open', () => {
    const room = (id: string, createdAt: string): StoredRoom => ({
      id,
      version: { protocol: 6, build: 'abc1234' },
      phase: 'waiting',
      createdAt,
      judged: true,
      sides: { [Faction.Blue]: null, [Faction.Red]: null },
      blue: { playerId: 'A', name: 'Ada', keyHash: 'hash-of-blue' },
      red: null,
    })

    test('a room comes back as it was written, and each transition rewrites its one row', async () => {
      const store = await freshPersistence(url)
      const waiting = room('r1', '2026-09-18T10:00:00.000Z')
      await store.rooms.save(waiting)
      expect(await store.rooms.live()).toEqual([waiting])

      // Joined by an anonymous player, started, verified, and no longer judged:
      // every field a restore reads moves, and the row is still one row.
      const later: StoredRoom = {
        ...waiting,
        phase: 'playing',
        judged: false,
        sides: { [Faction.Blue]: { playerId: 'A', characterIds: ['c1', 'c2'] }, [Faction.Red]: null },
        blue: { ...waiting.blue, keyHash: 'rotated' },
        red: { playerId: null, name: null, keyHash: 'hash-of-red' },
      }
      await store.rooms.save(later)
      expect(await store.rooms.live()).toEqual([later])

      await store.close()
    })

    test('live rooms come back oldest first, and a room that ended does not come back', async () => {
      const store = await freshPersistence(url)
      await store.rooms.save(room('newest', '2026-09-18T12:00:00.000Z'))
      await store.rooms.save(room('oldest', '2026-09-18T10:00:00.000Z'))
      await store.rooms.save(room('ended', '2026-09-18T11:00:00.000Z'))

      await store.rooms.end('ended')

      expect((await store.rooms.live()).map((stored) => stored.id)).toEqual(['oldest', 'newest'])

      await store.close()
    })
  })
})

describe('A match outlives the process that played it', () => {
  let dir: string

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'tictac-store-'))
  })
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  test('a match survives close and reopen on disk', async () => {
    // SQLite only: what is being tested is a file, and a Postgres database is
    // already somebody else's process.
    const url = `sqlite://${join(dir, 'roundtrip.sqlite')}`

    const writing = await openPersistence(url)
    const id = await writing.matches.create(log.header)
    await writing.matches.appendAll(id, unsequenced(log))
    await writing.close()

    const reading = await openPersistence(url)
    expect(await reading.matches.header(id)).toEqual(log.header)
    expect(await reading.matches.events(id)).toEqual(log.events)
    expect(await reading.matches.recent()).toEqual([
      {
        id,
        createdAt: log.header.createdAt,
        seedLabel: log.header.seedLabel,
        events: log.events.length,
      },
    ])
    await reading.close()
  })

  test('a database from a newer build is refused by number, not read as current', async () => {
    // The migration the file has seen and the migrations this build knows are
    // checked against each other on the way in. Opening it quietly would replay
    // an intent log whose shape changed underneath it.
    const url = `sqlite://${join(dir, 'future.sqlite')}`
    await (await openPersistence(url)).close()

    const raw = await openDb(url)
    await raw.query`INSERT INTO schema_migrations (id, name, applied_at)
                    VALUES (${99}, ${'from the future'}, ${new Date().toISOString()})`
    await raw.close()

    await expect(openPersistence(url)).rejects.toThrow(
      new RegExp(`at migration 99.*up to ${MIGRATIONS.length}`, 's'),
    )
  })
})
