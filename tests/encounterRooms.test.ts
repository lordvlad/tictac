import { describe, expect, test } from 'bun:test'
import { ENCOUNTER, Faction, HEALING, MEDICAL_BAY, SQUAD_SIZE } from '../src/config'
import { rollSquadSheets, sanitizeSheet } from '../src/core/Characters'
import { mergeDeeds, noDeeds } from '../src/core/Progression'
import { Rng } from '../src/core/rng'
import { isCommand } from '../src/ecs/systems/CommandSystem'
import { carriedOut, settlement, winnerOf, type UnitFate } from '../src/game/MatchEnd'
import type { RecordedEvent, RecordingHeader } from '../src/game/Recording'
import { RpcMethods, type JsonRpcNotification } from '../src/game/JsonRpc'
import type { Seated, ServerIntent } from '../src/game/Lobby'
import type { Player } from '../src/game/Rpc'
import { loopback } from '../src/game/Transport'
import type { EncounterContact } from '../src/server/EncounterPort'
import { Lobby } from '../src/server/Lobby'
import type { Persistence } from '../src/server/Persistence'
import type { Client, RefereeVerdict } from '../src/server/Room'
import { MatchHost } from '../src/sim/MatchHost'
import { Policy } from '../src/sim/Policy'
import { MY_VERSION } from '../src/version'
import { freshPersistence } from './support/db'
import { handClock, type HandClock } from './support/handServer'
import { connect, type Connection } from './support/lobby'

/**
 * A fight on the road is a room the server opens itself (`ITEM-048`): already
 * playing, unlisted, its aliens an AI seat and its player's side theirs to take
 * or the AI's to play. These drive it through `Lobby.openEncounter` and the
 * sockets a window would hold, with the grace and the join window on a clock
 * the test turns.
 *
 * A fight between two AI seats plays out in the microtask queue, so a test
 * that wants to see the room *while* the AI holds a seat — before it has
 * played a move — asks for it in the same turn the seat was passed (`fire`),
 * and a test that wants the whole fight lets the queue drain (`finish`).
 */

const START = Date.UTC(2026, 9, 8, 9)
const GRACE = 120_000
const ADA: Player = { id: 'A', name: 'Ada' }
const BO: Player = { id: 'B', name: 'Bo' }
const AI_HAS_IT = 'The AI is playing that seat now.'

const place = { lat: 48.137, lng: 11.575 }

function contactFor(player: Player, over: Partial<EncounterContact> = {}): EncounterContact {
  return {
    player,
    squadId: `squad-${player.id}`,
    trip: 'trip',
    checkpoint: 0,
    at: START,
    place,
    alienSeed: 17,
    sizeOffset: 0,
    ...over,
  }
}

interface RosterRow {
  character_id: string
  slot: number
  status: string
  sheet: string
  matches: number
  hp: number
  deeds: string
  downtime: number
  died_in: string | null
}

/** A stored match, refought from its log. */
interface Fought {
  header: RecordingHeader
  events: RecordedEvent[]
  host: MatchHost
  winner: Faction | null
  fates: Record<Faction, UnitFate[]> | null
}

/** One database and a server over it, which can be stopped and started again. */
interface World {
  persistence: Persistence
  clock: HandClock
  verdicts: RefereeVerdict[]
  logs: string[]
  /** Rooms whose seat a player took before the AI did. */
  taken: string[]
  /** The server running now. */
  readonly lobby: Lobby
  /** The seed of the next fight's map. */
  mapSeed: number
  /** Start a server over the database, restoring every room it holds. */
  serve(): Promise<Lobby>
  /** A server stopping: sockets closed, no word to anybody, every row left as it was. */
  stop(): Promise<void>
  /** Fire the timer the lobby asked for `ms` from now, in this turn (`manual` only). */
  fire(ms: number): void
  /** Let every fight in progress play out and every write land. */
  finish(): Promise<void>
  enlist(player: Player, size?: number, seed?: number): Promise<void>
  roster(player: Player): Promise<RosterRow[]>
  /** The stored match, refought from its log: the way an audit, a replay and a settlement read it. */
  fought(roomId: string): Promise<Fought>
}

async function world({ manual = false }: { manual?: boolean } = {}): Promise<World> {
  const persistence = await freshPersistence(':memory:')
  const clock = handClock()
  const verdicts: RefereeVerdict[] = []
  const logs: string[] = []
  const taken: string[] = []
  /** Timers the lobby asked for when `manual`: held, for a test to fire one itself. */
  const timers: { fn: () => void; ms: number; live: boolean }[] = []
  const state = { mapSeed: 1, lobby: undefined as unknown as Lobby }

  const serve = async (): Promise<Lobby> => {
    const lobby = new Lobby({
      matches: persistence.matches,
      rooms: persistence.rooms,
      rosters: persistence.rosters,
      log: (message) => logs.push(message),
      graceMs: GRACE,
      now: () => START + clock.now,
      mapSeed: () => state.mapSeed,
      onVerdict: (verdict) => verdicts.push(verdict),
      onEncounterTaken: (roomId) => taken.push(roomId),
      schedule: (fn, ms) => {
        if (!manual) return clock.schedule(fn, ms)
        const timer = { fn, ms, live: true }
        timers.push(timer)
        return () => {
          timer.live = false
        }
      },
    })
    await lobby.restore()
    state.lobby = lobby
    return lobby
  }
  await serve()

  return {
    persistence,
    clock,
    verdicts,
    logs,
    taken,
    get lobby() {
      return state.lobby
    },
    get mapSeed() {
      return state.mapSeed
    },
    set mapSeed(seed: number) {
      state.mapSeed = seed
    },
    serve,
    async stop(): Promise<void> {
      await state.lobby.dispose()
    },
    fire(ms) {
      const timer = timers.find((held) => held.live && held.ms === ms)
      if (!timer) throw new Error(`no timer of ${ms} ms is held; held: ${timers.filter((t) => t.live).map((t) => t.ms)}`)
      timer.live = false
      timer.fn()
    },
    async finish() {
      await clock.advance(0)
      await state.lobby.idle()
    },
    async enlist(player, size = SQUAD_SIZE, seed = 5) {
      await persistence.db
        .query`INSERT INTO players (id, name, created_at) VALUES (${player.id}, ${player.name}, ${'2026-01-01T00:00:00Z'})`
      await persistence.rosters.enlist(persistence.db, player.id, rollSquadSheets(new Rng(seed), size))
    },
    async roster(player) {
      return persistence.db.query<RosterRow>`SELECT character_id, slot, status, sheet, matches, hp, deeds, downtime, died_in
           FROM roster WHERE player_id = ${player.id} ORDER BY slot, created_at`
    },
    async fought(roomId) {
      const match = await persistence.matches.match(roomId)
      if (!match) throw new Error(`no match ${roomId}`)
      const host = new MatchHost(match.header)
      for (const event of match.events) {
        const applied = host.apply(event.command)
        if (!applied.applied) throw new Error(`event ${event.seq} (${event.command.type}) refused: ${applied.reason}`)
      }
      const winner = winnerOf(host.squads)
      const loser = winner === Faction.Blue ? Faction.Red : Faction.Blue
      const fates =
        winner === null
          ? null
          : settlement(host.squads, winner, carriedOut(host.squads, loser, host.grid, match.header.seed))
      return { header: match.header, events: match.events, host, winner, fates }
    },
  }
}
/**
 * A window held straight on the lobby, without the session layer between: what
 * a test needs when it asks for something in the one turn the AI is in a
 * seat and has yet to move. Signed in as `player`, so it is where a push to
 * them arrives.
 */
function window(lobby: Lobby, player: Player) {
  const [mine, theirs] = loopback()
  const client: Client = { transport: theirs, player: null, version: MY_VERSION, room: null, faction: null, gone: false }
  const frames: JsonRpcNotification[] = []
  mine.onFrame((frame) => {
    if ('method' in frame) frames.push(frame as JsonRpcNotification)
  })
  lobby.arrive(client)
  lobby.bind(client, player)
  return {
    frames,
    /** Ask for a room and be answered with where the lobby put this window; the answer is decided before this returns. */
    enter(intent: ServerIntent): Promise<Seated> {
      const seated = Promise.withResolvers<Seated>()
      lobby.enter(client, intent, seated.resolve).then(
        () => {},
        (error: unknown) => seated.reject(error),
      )
      return seated.promise
    },
  }
}

async function opened(w: World, contact: EncounterContact) {
  const answer = await w.lobby.openEncounter(contact)
  if (!answer.opened) throw new Error(`passed by: ${answer.passedFor}`)
  return answer
}

/** Blue's whole turn, played by the policy on `host` and sent over the socket, as a window's controller would. */
function playTurn(connection: Connection, host: MatchHost): void {
  new Policy(
    host,
    (command) => {
      const applied = host.apply(command)
      if (applied.applied) connection.send(command)
      return applied
    },
    { observer: { ending: () => connection.send({ type: 'digest', digest: host.digest() }) } },
  ).playTurn()
}

/** Everything the server relayed to `connection` since `from`, applied to its local world. */
function hear(connection: Connection, host: MatchHost, from: number): number {
  for (const message of connection.received.slice(from)) {
    if (!isCommand(message)) continue
    const applied = host.apply(message)
    if (!applied.applied) throw new Error(`the server relayed a ${message.type} this window cannot apply: ${applied.reason}`)
  }
  return connection.received.length
}

/** What the roster has to say about every member of the human side, as the match left them. */
async function expectRosterSettled(w: World, player: Player, roomId: string): Promise<void> {
  const fight = await w.fought(roomId)
  expect(fight.fates).not.toBeNull()
  const rows = await w.roster(player)
  const ids = fight.header.squads[Faction.Blue].map((deployment) => deployment.characterId)
  for (const [i, fate] of fight.fates![Faction.Blue].entries()) {
    const row = rows.find((candidate) => candidate.character_id === ids[i])!
    expect(row.matches).toBe(1)
    switch (fate.kind) {
      case 'survived':
        expect(row.status).toBe('active')
        expect(JSON.parse(row.sheet)).toEqual(sanitizeSheet(fate.sheet))
        expect(JSON.parse(row.deeds)).toEqual(mergeDeeds(noDeeds(), fate.deeds))
        break
      case 'carried':
        expect(row.status).toBe('active')
        expect([row.hp, row.downtime]).toEqual([HEALING.carriedOutHp, MEDICAL_BAY.carriedOut])
        break
      case 'died':
        expect([row.status, row.died_in]).toEqual(['dead', roomId])
        break
    }
  }
}

describe('a fight found for a player who is not there', () => {
  test('is played by the AI on both sides, recorded, and settled onto the roster like a played match', async () => {
    const w = await world()
    await w.enlist(ADA)
    const before = await w.roster(ADA)

    const fight = await opened(w, contactFor(ADA))
    expect(fight).toMatchObject({ aliens: SQUAD_SIZE, joinBy: null })
    await w.finish()

    expect(w.verdicts).toEqual([])
    const stored = await w.fought(fight.roomId)
    // The header says whose each side is — the aliens' and the player's, even
    // though the AI moved both — and composes the player's from the roster.
    expect(stored.header.controllers).toEqual({ [Faction.Blue]: 'human', [Faction.Red]: 'ai' })
    expect(stored.header.squads[Faction.Blue].map((d) => d.characterId)).toEqual(before.map((row) => row.character_id))
    expect(stored.header.squads[Faction.Red].every((d) => d.characterId === undefined)).toBe(true)
    // Both sides moved, though nobody was there.
    expect(new Set(stored.events.map((event) => event.faction))).toEqual(new Set([Faction.Blue, Faction.Red]))
    expect(stored.winner).not.toBeNull()

    expect(await w.persistence.db.query`SELECT winner, blue_player, red_player FROM match_results WHERE match_id = ${fight.roomId}`)
      .toEqual([{ winner: stored.winner!, blue_player: ADA.id, red_player: null }])
    await expectRosterSettled(w, ADA, fight.roomId)
    // The aliens are not anybody's: no row for them anywhere.
    expect(await w.persistence.db.query`SELECT character_id FROM roster`).toHaveLength(before.length)
    // The room is gone from the server and the store; the match is not.
    expect(w.lobby.room(fight.roomId)).toBeUndefined()
    expect(await w.persistence.rooms.live()).toEqual([])
  })

  test('grows the survivors of a won fight, because the AI that played for them is no excuse', async () => {
    const w = await world()
    let grew = false
    for (let seed = 1; seed <= 8 && !grew; seed++) {
      const player: Player = { id: `P${seed}`, name: `P${seed}` }
      await w.enlist(player, SQUAD_SIZE, seed)
      const sheets = (await w.roster(player)).map((row) => row.sheet)
      w.mapSeed = seed
      const fight = await opened(w, contactFor(player, { alienSeed: 100 + seed }))
      await w.finish()
      await expectRosterSettled(w, player, fight.roomId)
      const rows = await w.roster(player)
      grew = rows.some((row, i) => row.status === 'active' && row.sheet !== sheets[i])
    }
    expect(grew).toBe(true)
  }, 60_000)

  test('is the same match when it is played twice: the AI draws nothing of the match', async () => {
    // Two servers, one fight each from the same contact and map: the same
    // intents and the same result. An AI that drew from the match's dice,
    // or from anything but the world it sees, would make them differ — and
    // would already have been found out by the referee, which refights
    // every intent with the dice only the rules draw from.
    const first = await world()
    const second = await world()
    await first.enlist(ADA)
    await second.enlist(ADA)
    const [a, b] = [await opened(first, contactFor(ADA)), await opened(second, contactFor(ADA))]
    await first.finish()
    await second.finish()
    expect(first.verdicts).toEqual([])
    const logA = (await first.fought(a.roomId)).events.map((event) => event.command)
    const logB = (await second.fought(b.roomId)).events.map((event) => event.command)
    expect(logA.length).toBeGreaterThan(0)
    expect(logA).toEqual(logB)
  })

  test('is not listed, cannot be joined or watched by anyone else, and is shown to its player alone', async () => {
    const w = await world()
    await w.enlist(ADA)
    const ordinary = await connect(w.lobby, BO, { kind: 'open' })
    const ada = await connect(w.lobby, ADA, null)
    const { roomId } = await opened(w, contactFor(ADA))

    const listed = w.lobby.view(null).rooms.map((room) => room.id)
    expect(listed).toHaveLength(1)
    expect(listed).not.toContain(roomId)
    const view = await ada.request('tictac/api/lobby/subscribe', {})
    expect(view.rooms.map((room) => room.id)).not.toContain(roomId)
    expect(view.you).toMatchObject({ roomId, faction: Faction.Blue, phase: 'playing' })

    // Nobody else gets in, however they ask.
    for (const intent of [
      { kind: 'join', roomId },
      { kind: 'watch', roomId },
    ] as const) {
      const stranger = await connect(w.lobby, null, intent)
      expect(stranger.of('abort').map((abort) => abort.reason)).toEqual(['That match is gone.'])
    }
    ordinary.close()
    await w.finish()
  })
})

describe('a fight found for a player who is online', () => {
  test('is announced, taken inside the window, and played through the referee, and the AI never sits in the seat', async () => {
    const w = await world()
    await w.enlist(ADA)
    const ada = await connect(w.lobby, ADA, null)
    const { roomId, joinBy } = await opened(w, contactFor(ADA))
    expect(joinBy).toBe(START + ENCOUNTER.joinWindowMs)

    expect(ada.pushed.filter((push) => push.method === 'tictac/api/encounter/started').map((push) => push.params)).toEqual([
      { roomId, joinBy, at: START, place },
    ])
    // Kept for her, not yet hers: the panel offers it rather than taking it over.
    expect(w.lobby.view(ADA).you).toEqual({ roomId, faction: Faction.Blue, phase: 'playing', control: 'reserved', joinBy })
    expect(w.taken).toEqual([])

    const seated = await ada.request('tictac/api/room/enter', { intent: { kind: 'resume', roomId } })
    expect(seated).toMatchObject({ roomId, faction: Faction.Blue, phase: 'playing', redirected: false })
    expect(w.taken).toEqual([roomId])
    expect(w.lobby.view(ADA).you).toEqual({ roomId, faction: Faction.Blue, phase: 'playing', control: 'player', joinBy: null })

    // She plays Blue's first turn from the log the room handed her; the AI's
    // aliens answer through the same referee.
    const log = ada.of('log')[0]!
    expect(log.events).toEqual([])
    const host = new MatchHost(log.header)
    playTurn(ada, host)
    await w.finish()
    hear(ada, host, 0)
    const room = w.lobby.room(roomId)!
    expect(host.activeFaction).toBe(Faction.Blue)
    expect(ada.of('endTurn').map((message) => message.faction)).toEqual([Faction.Red])
    expect(room.digest()).toEqual(host.digest())
    expect(w.verdicts).toEqual([])

    // The window is over: the fight is hers, and the AI does not come for it.
    await w.clock.advance(ENCOUNTER.joinWindowMs + 1)
    expect(room.controlOf(Faction.Blue)).toBe('player')
    expect(w.logs.filter((line) => line.includes('the AI takes'))).toEqual([])
  })

  test('is the AI’s once the window lapses, and a late takeover is refused with the reason — watching is still allowed', async () => {
    const w = await world({ manual: true })
    await w.enlist(ADA)
    const ada = window(w.lobby, ADA)
    const { roomId } = await opened(w, contactFor(ADA))
    expect(w.lobby.view(ADA).you).toMatchObject({ control: 'reserved' })

    // The window closes, and the AI is in the seat before it has made a move.
    // Everything below is asked in this same turn, since the fight plays out
    // in the next ones: what the lobby answers is what it answers *now*.
    w.fire(ENCOUNTER.joinWindowMs)
    expect(w.lobby.view(ADA).you).toEqual({ roomId, faction: Faction.Blue, phase: 'playing', control: 'ai', joinBy: null })
    const late = [ada.enter({ kind: 'resume', roomId }), ada.enter({ kind: 'open' })].map((asked) =>
      asked.then(
        () => null,
        (error: Error) => error.message,
      ),
    )
    // Watching is what is left.
    const watching = ada.enter({ kind: 'watch', roomId })
    expect(await Promise.all(late)).toEqual([AI_HAS_IT, AI_HAS_IT])
    expect(await watching).toMatchObject({ roomId, faction: null, phase: 'playing', seatKey: null })
    expect(w.taken).toEqual([])
    await w.finish()

    expect(w.verdicts).toEqual([])
    const fight = await w.fought(roomId)
    expect(fight.events.some((event) => event.faction === Faction.Blue)).toBe(true)
    await expectRosterSettled(w, ADA, roomId)
    // She saw the fight as it was played: the log, then every intent.
    const methods = ada.frames.map((frame) => frame.method)
    expect(methods.filter((method) => method === RpcMethods.log)).toHaveLength(1)
    expect(methods.filter((method) => method === RpcMethods.endTurn).length).toBeGreaterThan(0)
  })

  test('a takeover that names some other match is refused as gone, and the fight stays hers to take', async () => {
    const w = await world()
    await w.enlist(ADA)
    const ada = await connect(w.lobby, ADA, null)
    const { roomId } = await opened(w, contactFor(ADA))

    await expect(ada.request('tictac/api/room/enter', { intent: { kind: 'resume', roomId: 'not-this-one' } })).rejects.toThrow(
      'That match is gone.',
    )
    expect(w.taken).toEqual([])
    expect(w.lobby.view(ADA).you).toMatchObject({ roomId, control: 'reserved' })
    const seated = await ada.request('tictac/api/room/enter', { intent: { kind: 'resume', roomId } })
    expect(seated).toMatchObject({ roomId, faction: Faction.Blue })
  })

  test('a window that lapsed the grace of a seat it took passes the seat to the AI instead of ending the fight', async () => {
    const w = await world({ manual: true })
    await w.enlist(ADA)
    const ada = await connect(w.lobby, ADA, null)
    const { roomId } = await opened(w, contactFor(ADA))
    await ada.request('tictac/api/room/enter', { intent: { kind: 'resume', roomId } })
    expect(w.lobby.view(ADA).you).toMatchObject({ control: 'player' })

    ada.close()
    // Dropped, and still hers while the grace runs.
    expect(w.lobby.view(ADA).you).toMatchObject({ control: 'player', joinBy: null })
    w.fire(GRACE)
    expect(w.lobby.view(ADA).you).toMatchObject({ control: 'ai' })
    await w.finish()

    expect(w.logs.filter((line) => line.includes('aborting room'))).toEqual([])
    expect(w.logs).toContain(`room ${roomId}: the AI takes Ada's seat`)
    expect(w.verdicts).toEqual([])
    await expectRosterSettled(w, ADA, roomId)
    expect(w.taken).toEqual([roomId])
  })

  test('a window that comes back with its key before the grace runs out keeps the seat', async () => {
    const w = await world()
    await w.enlist(ADA)
    const ada = await connect(w.lobby, ADA, null)
    const { roomId } = await opened(w, contactFor(ADA))
    const seated = await ada.request('tictac/api/room/enter', { intent: { kind: 'resume', roomId } })
    ada.close()
    await w.clock.advance(GRACE - 1)

    const back = await connect(w.lobby, null, { kind: 'resume', roomId, seatKey: seated.seatKey! })
    expect(back.of('seated')[0]).toMatchObject({ roomId, faction: Faction.Blue })
    await w.clock.advance(GRACE * 2)
    expect(w.lobby.room(roomId)!.controlOf(Faction.Blue)).toBe('player')
    expect(w.logs.filter((line) => line.includes('the AI takes'))).toEqual([])
  })
})

describe('a fight and a server that restarts', () => {
  test('is restored with its player’s seat held and its aliens playing on, and the AI finishes it when she does not come back', async () => {
    const w = await world()
    await w.enlist(ADA)
    const ada = await connect(w.lobby, ADA, null)
    const { roomId } = await opened(w, contactFor(ADA))
    const seated = await ada.request('tictac/api/room/enter', { intent: { kind: 'resume', roomId } })

    // One turn each, so there is a match to restart in the middle of.
    const host = new MatchHost(ada.of('log')[0]!.header)
    playTurn(ada, host)
    await w.finish()
    hear(ada, host, 0)

    await w.stop()
    const second = await w.serve()
    const room = second.room(roomId)!
    expect(room.judged).toBe(true)
    expect(second.view(ADA).you).toEqual({ roomId, faction: Faction.Blue, phase: 'playing', control: 'player', joinBy: null })
    expect(room.controlOf(Faction.Red)).toBe('ai')
    expect(room.digest()).toEqual(host.digest())

    // She is back with her key, and the aliens — re-attached from the log —
    // answer her next turn as they did the first.
    const back = await connect(second, null, { kind: 'resume', roomId, seatKey: seated.seatKey! })
    const rebuilt = new MatchHost(back.of('log')[0]!.header)
    for (const event of back.of('log')[0]!.events) rebuilt.apply(event.command)
    expect(rebuilt.digest()).toEqual(host.digest())
    const heard = back.received.length
    playTurn(back, rebuilt)
    await w.finish()
    hear(back, rebuilt, heard)
    expect(rebuilt.activeFaction).toBe(Faction.Blue)
    expect(rebuilt.turnNumber).toBeGreaterThan(host.turnNumber)
    expect(second.room(roomId)!.digest()).toEqual(rebuilt.digest())

    // And then she goes, for good: the AI plays out the rest.
    back.close()
    await w.clock.advance(GRACE)
    await w.finish()
    expect(w.verdicts).toEqual([])
    await expectRosterSettled(w, ADA, roomId)
  }, 60_000)

  test('with the AI in both seats, the restored room has them sit again and finish the fight', async () => {
    const w = await world()
    await w.enlist(ADA)
    const { roomId } = await opened(w, contactFor(ADA))
    // Stopped a few moves in, before anybody has won.
    await w.stop()
    expect(await w.persistence.db.query`SELECT blue_control, red_control, encounter FROM rooms`).toEqual([
      { blue_control: 'ai', red_control: 'ai', encounter: 1 },
    ])
    expect(await w.persistence.db.query`SELECT match_id FROM match_results`).toEqual([])

    const second = await w.serve()
    expect(second.room(roomId)?.encounter ?? true).toBe(true)
    await w.finish()

    expect(w.verdicts).toEqual([])
    const fight = await w.fought(roomId)
    expect(fight.winner).not.toBeNull()
    await expectRosterSettled(w, ADA, roomId)
  }, 60_000)

  test('keeps a reserved seat for its player until the deadline it had, and gives it to the AI at once once that has passed', async () => {
    const w = await world()
    await w.enlist(ADA)
    await w.enlist(BO)
    const ada = await connect(w.lobby, ADA, null)
    const bo = await connect(w.lobby, BO, null)
    const adas = await opened(w, contactFor(ADA))
    const bos = await opened(w, contactFor(BO, { alienSeed: 3 }))
    expect(ada.pushed).toHaveLength(1)
    expect(bo.pushed).toHaveLength(1)
    await w.stop()

    // A server back thirty seconds later: both still have time.
    await w.clock.advance(30_000)
    const second = await w.serve()
    expect(second.view(ADA).you).toEqual({
      roomId: adas.roomId,
      faction: Faction.Blue,
      phase: 'playing',
      control: 'reserved',
      joinBy: adas.joinBy!,
    })
    // The window runs out where it always would have.
    await w.clock.advance(ENCOUNTER.joinWindowMs - 30_000)
    await w.finish()
    expect(w.logs.filter((line) => line.includes('the AI takes'))).toHaveLength(2)
    await expectRosterSettled(w, ADA, adas.roomId)
    await expectRosterSettled(w, BO, bos.roomId)

    // And a server that was away for the whole window: the AI has the seat as it sits down.
    const late = await world()
    await late.enlist(ADA)
    await connect(late.lobby, ADA, null)
    const missed = await opened(late, contactFor(ADA))
    await late.stop()
    await late.clock.advance(ENCOUNTER.joinWindowMs * 2)
    await late.serve()
    await late.finish()
    expect(late.logs.filter((line) => line.includes('the AI takes'))).toHaveLength(1)
    await expectRosterSettled(late, ADA, missed.roomId)
  }, 60_000)
})

describe('a fight that is passed by', () => {
  test('a player who already holds a seat is busy: nothing opens, and nothing is rolled for them', async () => {
    const w = await world()
    await w.enlist(ADA)
    const ada = await connect(w.lobby, ADA, { kind: 'open' })
    expect(ada.of('seated')).toHaveLength(1)

    expect(await w.lobby.openEncounter(contactFor(ADA))).toEqual({ opened: false, passedFor: 'busy' })
    expect(w.lobby.view(null).rooms).toHaveLength(1)
    expect(await w.persistence.rooms.live()).toHaveLength(1)
  })

  test('a player in a fight is busy for the next, until it is settled', async () => {
    const w = await world()
    await w.enlist(ADA)
    // Online, so the fight waits for them and is still on when the next is found.
    const ada = await connect(w.lobby, ADA, null)
    const { roomId } = await opened(w, contactFor(ADA))
    const again = contactFor(ADA, { trip: 'another', alienSeed: 9 })
    expect(await w.lobby.openEncounter(again)).toEqual({ opened: false, passedFor: 'busy' })
    await ada.request('tictac/api/room/enter', { intent: { kind: 'resume', roomId } })
    expect(await w.lobby.openEncounter(again)).toEqual({ opened: false, passedFor: 'busy' })
    expect(await w.persistence.rooms.live()).toHaveLength(1)

    // Once it is settled they are free again — to whoever is still fit.
    ada.close()
    await w.clock.advance(GRACE)
    await w.finish()
    const next = await w.lobby.openEncounter(again)
    expect(next.opened || next.passedFor === 'nobodyFit').toBe(true)
  })

  test('a squad with nobody fit is passed by', async () => {
    const w = await world()
    await w.enlist(ADA)
    await w.persistence.db.query`UPDATE roster SET downtime = 1 WHERE player_id = ${ADA.id}`

    expect(await w.lobby.openEncounter(contactFor(ADA))).toEqual({ opened: false, passedFor: 'nobodyFit' })
    expect(await w.persistence.rooms.live()).toEqual([])
  })

  test('the party is the first four fit members by slot, and the aliens come in the size the contact rolled, within one to four', async () => {
    const w = await world()
    await w.enlist(ADA, SQUAD_SIZE)
    await w.persistence.rosters.recruit(ADA.id)
    await w.persistence.rosters.recruit(ADA.id)
    const roster = await w.roster(ADA)
    expect(roster.map((row) => row.slot)).toEqual([0, 1, 2, 3, 4, 5])
    // Slots 0 and 3 are in the medical bay: the party is 1, 2, 4, 5.
    await w.persistence.db.query`UPDATE roster SET downtime = 2 WHERE player_id = ${ADA.id} AND (slot = 0 OR slot = 3)`

    const bigger = await opened(w, contactFor(ADA, { sizeOffset: 1 }))
    const header = (await w.persistence.matches.header(bigger.roomId))!
    expect(header.squads[Faction.Blue].map((d) => d.characterId)).toEqual([1, 2, 4, 5].map((slot) => roster[slot]!.character_id))
    // Clamped: four and one more is four.
    expect(bigger.aliens).toBe(SQUAD_SIZE)
    expect(header.squads[Faction.Red]).toHaveLength(SQUAD_SIZE)
    await w.finish()
  })

  test('a short-handed party meets a short-handed enemy, and never none', async () => {
    const sizes: number[] = []
    for (const [fit, offset] of [
      [3, 1],
      [3, -1],
      [1, -1],
    ] as const) {
      const w = await world()
      await w.enlist(ADA)
      await w.persistence.db.query`UPDATE roster SET downtime = 1 WHERE player_id = ${ADA.id} AND slot >= ${fit}`
      const fight = await opened(w, contactFor(ADA, { sizeOffset: offset }))
      sizes.push(fight.aliens)
      const header = (await w.persistence.matches.header(fight.roomId))!
      expect(header.squads[Faction.Blue]).toHaveLength(fit)
      await w.stop()
    }
    expect(sizes).toEqual([4, 2, 1])
  })
})
