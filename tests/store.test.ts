import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Faction } from '../src/config'
import { defaultLoadout } from '../src/game/Loadout'
import { RECORDING_VERSION } from '../src/game/Recording'
import { MatchStore, STORE_VERSION, type UnsequencedEvent } from '../src/server/MatchStore'
import { STOCK_PLAN } from '../src/sim/Balance'
import { SimMatch } from '../src/sim/SimMatch'
import { replay } from '../src/sim/Replay'
import type { CombatRecording, RecordingHeader } from '../src/game/Recording'

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
    sheets: { [Faction.Blue]: [], [Faction.Red]: [] },
    loadouts: { [Faction.Blue]: defaultLoadout(), [Faction.Red]: defaultLoadout() },
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

describe('A match goes into the store as its intents and comes back out as a match', () => {
  test('the header and every event survive, in order', () => {
    const store = new MatchStore()
    const id = store.create(log.header)
    store.appendAll(id, unsequenced(log))

    const stored = store.match(id)
    expect(stored).not.toBeNull()
    expect(stored!.id).toBe(id)
    expect(stored!.header).toEqual(log.header)
    // Identical numbering as well as identical content: the recorder and the
    // store both number a log densely from zero, so a client that saw a match
    // live and a client that read it back are counting in the same units.
    expect(stored!.events).toEqual(log.events)

    store.close()
  })

  test('a stored log replays: every intent in it is one this build carries out', () => {
    // The property the store exists to preserve. A log that does not replay is
    // not a store of record, so a skipped event here is a store failure and
    // not a rules finding.
    const store = new MatchStore()
    const id = store.create(log.header)
    store.appendAll(id, unsequenced(log))

    const outcome = replay(store.match(id)!)

    expect(outcome.events).toBe(log.events.length)
    expect(outcome.applied).toBe(outcome.events)
    expect(outcome.skipped).toEqual([])
    // Out of the store, over the same seed, into the same world.
    expect(outcome.digest).toEqual(replay(log).digest)

    store.close()
  })
})

describe('Rejoin reads the tail', () => {
  test('afterSeq is exclusive and returns exactly what came later', () => {
    const store = new MatchStore()
    const id = store.create(log.header)
    store.appendAll(id, unsequenced(log))

    const all = store.events(id)
    const lastSeen = all[9]!.seq
    const tail = store.events(id, lastSeen)

    expect(tail.length).toBe(all.length - 10)
    expect(tail[0]!.seq).toBe(lastSeen + 1)
    expect(tail).toEqual(all.slice(10))
    // A client that is already current asks for nothing and gets nothing,
    // rather than the last event a second time.
    expect(store.events(id, all[all.length - 1]!.seq)).toEqual([])

    store.close()
  })

  test('a client that has nothing gets the whole log', () => {
    const store = new MatchStore()
    const id = store.create(log.header)
    store.appendAll(id, unsequenced(log))

    expect(store.events(id, -1)).toEqual(store.events(id))

    store.close()
  })
})

describe('The store owns the numbering', () => {
  test('appends are numbered densely from zero however they arrive', () => {
    const store = new MatchStore()
    const id = store.create(header('2026-09-18T10:00:00Z', 'dense'))

    expect(store.append(id, END_TURN).seq).toBe(0)
    expect(store.append(id, END_TURN).seq).toBe(1)
    // The same intent twice is a legal thing for a player to do, and it must
    // not collapse into one row or collide on the key.
    expect(store.appendAll(id, [END_TURN, END_TURN]).map((event) => event.seq)).toEqual([2, 3])
    expect(store.append(id, END_TURN).seq).toBe(4)

    expect(store.events(id).map((event) => event.seq)).toEqual([0, 1, 2, 3, 4])

    store.close()
  })

  test('two logs are numbered independently', () => {
    // Numbering is per match, because what a rejoining client counts is its own
    // match's intents and nothing else in the store.
    const store = new MatchStore()
    const first = store.create(header('2026-09-18T10:00:00Z', 'first'))
    const second = store.create(header('2026-09-18T11:00:00Z', 'second'))

    store.append(first, END_TURN)
    expect(store.append(second, END_TURN).seq).toBe(0)
    expect(store.append(first, END_TURN).seq).toBe(1)

    store.close()
  })
})

describe('The log is evidence', () => {
  let dir: string

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'tictac-store-'))
  })
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  test('a match survives close and reopen on disk', async () => {
    const path = join(dir, 'roundtrip.sqlite')

    const writing = new MatchStore(path)
    const id = writing.create(log.header)
    writing.appendAll(id, unsequenced(log))
    writing.close()

    const reading = new MatchStore(path)
    expect(reading.header(id)).toEqual(log.header)
    expect(reading.events(id)).toEqual(log.events)
    expect(reading.recent()).toEqual([
      {
        id,
        createdAt: log.header.createdAt,
        seedLabel: log.header.seedLabel,
        events: log.events.length,
      },
    ])
    reading.close()
  })

  test('an event cannot be rewritten or deleted, even behind the API', async () => {
    // Append-only is a property of the file, not a courtesy of this class: the
    // log is what tells a foul from a bug in the rules, and one that can be
    // edited proves nothing about either.
    const path = join(dir, 'append-only.sqlite')
    const store = new MatchStore(path)
    const id = store.create(header('2026-09-18T12:00:00Z', 'evidence'))
    store.append(id, END_TURN)
    store.close()

    const raw = new Database(path)
    expect(() => raw.run('UPDATE events SET turn = 99')).toThrow(/append-only/)
    expect(() => raw.run('DELETE FROM events')).toThrow(/append-only/)
    expect(raw.query('SELECT turn FROM events').all()).toEqual([{ turn: 1 }])
    raw.close()
  })

  test('a store from another schema version is refused by name, not read as current', async () => {
    // `ITEM-028` will bring a migration; until then the only alternative to
    // refusing is replaying a log whose shape changed underneath it.
    const path = join(dir, 'future.sqlite')
    new MatchStore(path).close()

    const raw = new Database(path)
    raw.exec(`PRAGMA user_version = ${STORE_VERSION + 1}`)
    raw.close()

    expect(() => new MatchStore(path)).toThrow(
      new RegExp(`version ${STORE_VERSION + 1}.*version ${STORE_VERSION}`, 's'),
    )
  })
})

describe('A store that has never heard of a match says so', () => {
  test('reading an unknown id answers nothing rather than throwing', () => {
    const store = new MatchStore()

    expect(store.header('nobody')).toBeNull()
    expect(store.match('nobody')).toBeNull()
    expect(store.events('nobody')).toEqual([])

    store.close()
  })

  test('appending to an unknown id is refused', () => {
    // The asymmetry is deliberate: a failed read has its answer, a failed write
    // has lost an intent.
    const store = new MatchStore()

    expect(() => store.append('nobody', END_TURN)).toThrow(/no match nobody/)
    expect(() => store.appendAll('nobody', [END_TURN])).toThrow(/no match nobody/)

    store.close()
  })

  test('a recording from another format version is not stored as if current', () => {
    const store = new MatchStore()
    const stale = { ...header('2026-09-18T10:00:00Z', 'stale'), version: RECORDING_VERSION - 1 }

    expect(() => store.create(stale)).toThrow(/cannot store a version/)
    expect(store.recent()).toEqual([])

    store.close()
  })
})

describe('Listing matches', () => {
  test('recent orders newest first and counts each log', () => {
    const store = new MatchStore()
    const older = store.create(header('2026-09-17T08:00:00Z', 'older'))
    const newest = store.create(header('2026-09-18T09:00:00Z', 'newest'))
    const middle = store.create(header('2026-09-17T20:00:00Z', 'middle'))

    store.append(newest, END_TURN)
    store.append(newest, END_TURN)
    store.append(middle, END_TURN)

    expect(store.recent()).toEqual([
      { id: newest, createdAt: '2026-09-18T09:00:00Z', seedLabel: 'newest', events: 2 },
      { id: middle, createdAt: '2026-09-17T20:00:00Z', seedLabel: 'middle', events: 1 },
      { id: older, createdAt: '2026-09-17T08:00:00Z', seedLabel: 'older', events: 0 },
    ])
    expect(store.recent(2).map((row) => row.id)).toEqual([newest, middle])

    store.close()
  })
})
