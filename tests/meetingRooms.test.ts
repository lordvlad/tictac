import { describe, expect, test } from 'bun:test'
import { ENCOUNTER, Faction, HEALING, MEDICAL_BAY, SQUAD_SIZE } from '../src/config'
import { rollSquadSheets, sanitizeSheet } from '../src/core/Characters'
import { mergeDeeds, noDeeds } from '../src/core/Progression'
import { firstContact } from '../src/core/Meetings'
import { Rng } from '../src/core/rng'
import type { LatLng } from '../src/core/Travel'
import { isCommand } from '../src/ecs/systems/CommandSystem'
import { carriedOut, settlement, winnerOf, type UnitFate } from '../src/game/MatchEnd'
import type { RecordedEvent, RecordingHeader } from '../src/game/Recording'
import type { EncounterEntry } from '../src/game/Encounter'
import { RPC_ERRORS, type Player } from '../src/game/Rpc'
import type { MeetingContact, MeetingOpened } from '../src/server/EncounterPort'
import { Lobby } from '../src/server/Lobby'
import type { Persistence } from '../src/server/Persistence'
import type { RefereeVerdict } from '../src/server/Room'
import { MatchHost } from '../src/sim/MatchHost'
import { Policy, type StandingOrder } from '../src/sim/Policy'
import { freshPersistence } from './support/db'
import { handClock, type HandClock } from './support/handServer'
import { connect, type Connection } from './support/lobby'
import { registerAt, rpcServer } from './support/rpcServer'

/**
 * Two players' squads meet on the road (`ITEM-053`, GDD-WORLD §5.5) and the
 * server opens the fight (`Lobby.openMeeting`): a room already playing, with a
 * seat for each player — theirs to take inside the join window, the AI's to
 * play to their standing order after it — and a roster on each side to settle.
 * Driven through the lobby and the sockets a window would hold, with the grace
 * and the join window on a clock the test turns, as `tests/encounterRooms`
 * does for a fight against aliens.
 *
 * A fight between two AI seats plays out in the microtask queue: a test that
 * wants the room *while* an AI holds a seat asks in the turn it was passed
 * (`fire`), and one that wants the whole fight lets the queue drain (`finish`).
 */

const START = Date.UTC(2026, 9, 8, 9)
const GRACE = 120_000
const ADA: Player = { id: 'A', name: 'Ada' }
const BO: Player = { id: 'B', name: 'Bo' }
const CY: Player = { id: 'C', name: 'Cy' }

const place = { lat: 48.137, lng: 11.575 }

/** Ada is Blue and Bo is Red, with the orders the AI would play them to. */
function meeting(
  blue: Player,
  red: Player,
  standing: { blue?: StandingOrder; red?: StandingOrder } = {},
  over: Partial<MeetingContact> = {},
): MeetingContact {
  return {
    blue: { player: blue, squadId: `squad-${blue.id}`, standing: standing.blue ?? 'stand' },
    red: { player: red, squadId: `squad-${red.id}`, standing: standing.red ?? 'stand' },
    at: START,
    place,
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

interface World {
  persistence: Persistence
  clock: HandClock
  verdicts: RefereeVerdict[]
  logs: string[]
  /** Seats a player took before the AI did, as `roomId|playerId`. */
  taken: string[]
  readonly lobby: Lobby
  /** The seed of the next fight's map. */
  mapSeed: number
  serve(): Promise<Lobby>
  /** A server stopping: sockets closed, no word to anybody, every row left as it was. */
  stop(): Promise<void>
  /** Fire the timer the lobby asked for `ms` from now, in this turn (`manual` only). */
  fire(ms: number): void
  /** Let every fight in progress play out and every write land. */
  finish(): Promise<void>
  enlist(player: Player, size?: number, seed?: number): Promise<void>
  roster(player: Player): Promise<RosterRow[]>
  fought(roomId: string): Promise<Fought>
}

async function world({ manual = false }: { manual?: boolean } = {}): Promise<World> {
  const persistence = await freshPersistence(':memory:')
  const clock = handClock()
  const verdicts: RefereeVerdict[] = []
  const logs: string[] = []
  const taken: string[] = []
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
      onEncounterTaken: (roomId, playerId) => taken.push(`${roomId}|${playerId}`),
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
        // The referee settles on the intent that decides the match, whatever a
        // window goes on to say after it (`Room.settle`).
        if (winnerOf(host.squads) !== null) break
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

/** Two players with a roster each; Ada's from seed 5 and Bo's from seed 6, so they are not the same people. */
async function twoPlayers(w: World): Promise<void> {
  await w.enlist(ADA, SQUAD_SIZE, 5)
  await w.enlist(BO, SQUAD_SIZE, 6)
}

async function opened(w: World, contact: MeetingContact) {
  const answer = await w.lobby.openMeeting(contact)
  if (!answer.opened) throw new Error(`passed by: ${answer.passedFor}`)
  return answer
}

/** The active side's whole turn, played by the policy on `host` and sent over the socket, as a window's controller would. */
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

/** How many times `faction` called a retreat in a fight. */
function retreats(fight: Fought, faction: Faction): number {
  return fight.events.filter((event) => event.command.type === 'retreat' && event.command.faction === faction).length
}

/** What the roster says of every member of `faction`'s side in `roomId`, as the match left them. */
async function expectRosterSettled(w: World, player: Player, roomId: string, faction: Faction): Promise<void> {
  const fight = await w.fought(roomId)
  expect(fight.fates).not.toBeNull()
  const rows = await w.roster(player)
  const ids = fight.header.squads[faction].map((deployment) => deployment.characterId)
  for (const [i, fate] of fight.fates![faction].entries()) {
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

/** Both sides, each against its own roster. */
async function expectBothSettled(w: World, roomId: string): Promise<void> {
  await expectRosterSettled(w, ADA, roomId, Faction.Blue)
  await expectRosterSettled(w, BO, roomId, Faction.Red)
}

const started = (connection: Connection) =>
  connection.pushed.filter((push) => push.method === 'tictac/api/encounter/started').map((push) => push.params)

describe('a meeting of two players who are both away', () => {
  test('is played by the AI on both sides, recorded as two humans, and settles both rosters like a played match', async () => {
    const w = await world()
    await twoPlayers(w)
    const before = { ada: await w.roster(ADA), bo: await w.roster(BO) }

    const fight = await opened(w, meeting(ADA, BO))
    expect(fight).toEqual({ opened: true, roomId: fight.roomId, blueJoinBy: null, redJoinBy: null })
    await w.finish()

    expect(w.verdicts).toEqual([])
    const stored = await w.fought(fight.roomId)
    // Whose each side is: both are somebody's, and the header composes each
    // from its player's roster.
    expect(stored.header.controllers).toEqual({ [Faction.Blue]: 'human', [Faction.Red]: 'human' })
    expect(stored.header.squads[Faction.Blue].map((d) => d.characterId)).toEqual(before.ada.map((row) => row.character_id))
    expect(stored.header.squads[Faction.Red].map((d) => d.characterId)).toEqual(before.bo.map((row) => row.character_id))
    expect(new Set(stored.events.map((event) => event.faction))).toEqual(new Set([Faction.Blue, Faction.Red]))
    expect(stored.winner).not.toBeNull()

    expect(await w.persistence.db.query`SELECT winner, blue_player, red_player FROM match_results WHERE match_id = ${fight.roomId}`)
      .toEqual([{ winner: stored.winner!, blue_player: ADA.id, red_player: BO.id }])
    await expectBothSettled(w, fight.roomId)
    // Nothing is taken from either and nothing changes hands: the same
    // characters, each still on their own player's roster.
    const after = { ada: await w.roster(ADA), bo: await w.roster(BO) }
    expect(after.ada.map((row) => row.character_id)).toEqual(before.ada.map((row) => row.character_id))
    expect(after.bo.map((row) => row.character_id)).toEqual(before.bo.map((row) => row.character_id))
    expect(await w.persistence.db.query`SELECT character_id FROM roster`).toHaveLength(2 * SQUAD_SIZE)
    // Gone from the server and the store; the match is not.
    expect(w.lobby.room(fight.roomId)).toBeUndefined()
    expect(await w.persistence.rooms.live()).toEqual([])
    expect(w.logs.filter((line) => line.includes('aborting'))).toEqual([])
  })

  test('grows the survivors of both rosters, because the AI that played for them is no excuse', async () => {
    const w = await world()
    const grew = { ada: false, bo: false }
    for (let seed = 1; seed <= 12 && !(grew.ada && grew.bo); seed++) {
      const ada: Player = { id: `A${seed}`, name: `Ada${seed}` }
      const bo: Player = { id: `B${seed}`, name: `Bo${seed}` }
      await w.enlist(ada, SQUAD_SIZE, seed)
      await w.enlist(bo, SQUAD_SIZE, seed + 100)
      const sheets = { ada: (await w.roster(ada)).map((row) => row.sheet), bo: (await w.roster(bo)).map((row) => row.sheet) }
      w.mapSeed = seed
      const fight = await opened(w, meeting(ada, bo))
      await w.finish()
      await expectRosterSettled(w, ada, fight.roomId, Faction.Blue)
      await expectRosterSettled(w, bo, fight.roomId, Faction.Red)
      const grown = (rows: RosterRow[], was: string[]) => rows.some((row, i) => row.status === 'active' && row.sheet !== was[i])
      grew.ada ||= grown(await w.roster(ada), sheets.ada)
      grew.bo ||= grown(await w.roster(bo), sheets.bo)
    }
    expect(grew).toEqual({ ada: true, bo: true })
  }, 120_000)

  test('is the same match when it is played twice: the AI draws nothing of the match', async () => {
    const first = await world()
    const second = await world()
    for (const w of [first, second]) await twoPlayers(w)
    const [a, b] = [await opened(first, meeting(ADA, BO)), await opened(second, meeting(ADA, BO))]
    await first.finish()
    await second.finish()
    expect(first.verdicts).toEqual([])
    const logA = (await first.fought(a.roomId)).events.map((event) => event.command)
    const logB = (await second.fought(b.roomId)).events.map((event) => event.command)
    expect(logA.length).toBeGreaterThan(0)
    expect(logA).toEqual(logB)
  })

  test('fights to each side’s standing order: evade gets out at once, stand fights on', async () => {
    const results: Record<string, { retreated: Record<'blue' | 'red', number>; turns: number; winner: Faction | null; fought: Fought }> = {}
    for (const [name, standing] of [
      ['blue evades', { blue: 'evade', red: 'stand' }],
      ['red evades', { blue: 'stand', red: 'evade' }],
      ['both stand', { blue: 'stand', red: 'stand' }],
    ] as const) {
      const w = await world()
      await twoPlayers(w)
      const fight = await opened(w, meeting(ADA, BO, standing))
      await w.finish()
      expect(w.verdicts, name).toEqual([])
      const fought = await w.fought(fight.roomId)
      await expectBothSettled(w, fight.roomId)
      results[name] = {
        retreated: { blue: retreats(fought, Faction.Blue), red: retreats(fought, Faction.Red) },
        turns: fought.host.turnNumber,
        winner: fought.winner,
        fought,
      }
    }

    // The side told to get out is the side that does, and the other wins.
    expect(results['blue evades']).toMatchObject({ retreated: { blue: 1, red: 0 }, winner: Faction.Red })
    expect(results['red evades']).toMatchObject({ retreated: { blue: 0, red: 1 }, winner: Faction.Blue })
    // At once: a turn or two of walking to the way out, and gone.
    expect(results['blue evades']!.turns).toBeLessThanOrEqual(3)
    expect(results['red evades']!.turns).toBeLessThanOrEqual(3)
    // Both standing fight until one side has nobody left on the field.
    const stood = results['both stand']!
    expect(stood.retreated).toEqual({ blue: 0, red: 0 })
    expect(stood.turns).toBeGreaterThan(results['blue evades']!.turns)
    const loser = stood.winner === Faction.Blue ? Faction.Red : Faction.Blue
    expect(stood.fought.host.living[loser]).toBe(0)
  }, 60_000)

  test('is not listed, cannot be joined or watched by anyone else, and each player is shown it as their own', async () => {
    const w = await world()
    await twoPlayers(w)
    const ordinary = await connect(w.lobby, CY, { kind: 'open' })
    const ada = await connect(w.lobby, ADA, null)
    const { roomId } = await opened(w, meeting(ADA, BO))

    expect(w.lobby.view(null).rooms.map((room) => room.id)).not.toContain(roomId)
    expect((await ada.request('tictac/api/lobby/subscribe', {})).rooms.map((room) => room.id)).not.toContain(roomId)
    // Each player's view is of their own seat, and says who it is against.
    const [blue, red] = [w.lobby.view(ADA).you, w.lobby.view(BO).you]
    expect(blue).toMatchObject({ roomId, faction: Faction.Blue, phase: 'playing', against: 'Bo' })
    expect(red).toMatchObject({ roomId, faction: Faction.Red, phase: 'playing', against: 'Ada' })

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

describe('a meeting of two players of whom one is online', () => {
  test('tells the one who is there and has the AI play the other to their order, and both settle', async () => {
    const w = await world()
    await twoPlayers(w)
    const ada = await connect(w.lobby, ADA, null)
    const { roomId, blueJoinBy, redJoinBy } = await opened(w, meeting(ADA, BO, { red: 'evade' }))
    expect(blueJoinBy).toBe(START + ENCOUNTER.joinWindowMs)
    expect(redJoinBy).toBeNull()

    // Only the one who is here is told, and told who it is.
    expect(started(ada)).toEqual([{ roomId, against: 'Bo', joinBy: blueJoinBy, at: START, place }])
    expect(w.lobby.view(ADA).you).toEqual({
      roomId,
      faction: Faction.Blue,
      phase: 'playing',
      control: 'reserved',
      joinBy: blueJoinBy,
      against: 'Bo',
    })
    // The other's seat is the AI's already, and is not theirs to take.
    expect(w.lobby.view(BO).you).toEqual({
      roomId,
      faction: Faction.Red,
      phase: 'playing',
      control: 'ai',
      joinBy: null,
      against: 'Ada',
    })
    expect(w.taken).toEqual([])

    const seated = await ada.request('tictac/api/room/enter', { intent: { kind: 'resume', roomId } })
    expect(seated).toMatchObject({ roomId, faction: Faction.Blue, phase: 'playing' })
    expect(w.taken).toEqual([`${roomId}|${ADA.id}`])

    // She plays Blue's first turn through the referee; Bo's squad, told to
    // evade, answers by getting out.
    const host = new MatchHost(ada.of('log')[0]!.header)
    let heard = 0
    for (let round = 0; round < 6 && winnerOf(host.squads) === null; round++) {
      if (host.activeFaction === Faction.Blue) playTurn(ada, host)
      await w.finish()
      heard = hear(ada, host, heard)
    }

    expect(w.verdicts).toEqual([])
    const fight = await w.fought(roomId)
    expect(fight.winner).toBe(Faction.Blue)
    expect(retreats(fight, Faction.Red)).toBe(1)
    expect(retreats(fight, Faction.Blue)).toBe(0)
    await expectBothSettled(w, roomId)
    expect(w.logs.filter((line) => line.includes('the AI takes'))).toEqual([])
  }, 60_000)

  test('stand fights it out, to the end, against the player who is there', async () => {
    const w = await world()
    await twoPlayers(w)
    const ada = await connect(w.lobby, ADA, null)
    const { roomId } = await opened(w, meeting(ADA, BO, { red: 'stand' }))
    await ada.request('tictac/api/room/enter', { intent: { kind: 'resume', roomId } })

    const host = new MatchHost(ada.of('log')[0]!.header)
    let heard = 0
    for (let round = 0; round < 60 && winnerOf(host.squads) === null; round++) {
      if (host.activeFaction === Faction.Blue) playTurn(ada, host)
      await w.finish()
      heard = hear(ada, host, heard)
    }

    const fight = await w.fought(roomId)
    expect(fight.winner).not.toBeNull()
    expect(retreats(fight, Faction.Red)).toBe(0)
    await expectBothSettled(w, roomId)
  }, 120_000)
})

describe('a meeting of two players who are both online', () => {
  test('is announced to both, taken by both inside the window, and played through the referee, a turn each, with no AI in either seat', async () => {
    const w = await world()
    await twoPlayers(w)
    const ada = await connect(w.lobby, ADA, null)
    const bo = await connect(w.lobby, BO, null)
    const { roomId, blueJoinBy, redJoinBy } = await opened(w, meeting(ADA, BO))
    expect([blueJoinBy, redJoinBy]).toEqual([START + ENCOUNTER.joinWindowMs, START + ENCOUNTER.joinWindowMs])

    expect(started(ada)).toEqual([{ roomId, against: 'Bo', joinBy: blueJoinBy, at: START, place }])
    expect(started(bo)).toEqual([{ roomId, against: 'Ada', joinBy: redJoinBy, at: START, place }])
    expect(w.lobby.view(ADA).you).toMatchObject({ faction: Faction.Blue, control: 'reserved', against: 'Bo' })
    expect(w.lobby.view(BO).you).toMatchObject({ faction: Faction.Red, control: 'reserved', against: 'Ada' })

    await ada.request('tictac/api/room/enter', { intent: { kind: 'resume', roomId } })
    await bo.request('tictac/api/room/enter', { intent: { kind: 'resume', roomId } })
    expect(w.taken.sort()).toEqual([`${roomId}|${ADA.id}`, `${roomId}|${BO.id}`])
    expect(w.lobby.view(ADA).you).toMatchObject({ control: 'player', joinBy: null })
    expect(w.lobby.view(BO).you).toMatchObject({ control: 'player', joinBy: null })

    const hostA = new MatchHost(ada.of('log')[0]!.header)
    const hostB = new MatchHost(bo.of('log')[0]!.header)
    // Blue's turn, then Red's: each window plays its own, and applies what the
    // other's did as the referee relays it.
    playTurn(ada, hostA)
    await w.finish()
    hear(bo, hostB, 0)
    expect(hostB.activeFaction).toBe(Faction.Red)
    const heard = bo.received.length
    playTurn(bo, hostB)
    await w.finish()
    hear(bo, hostB, heard)
    hear(ada, hostA, 0)

    const room = w.lobby.room(roomId)!
    expect(hostA.activeFaction).toBe(Faction.Blue)
    expect(hostB.activeFaction).toBe(Faction.Blue)
    expect(hostA.digest()).toEqual(hostB.digest())
    expect(room.digest()).toEqual(hostA.digest())
    expect(ada.of('endTurn').map((message) => message.faction)).toEqual([Faction.Red])
    expect(w.verdicts).toEqual([])

    await w.clock.advance(ENCOUNTER.joinWindowMs + 1)
    expect([room.controlOf(Faction.Blue), room.controlOf(Faction.Red)]).toEqual(['player', 'player'])
    expect(w.logs.filter((line) => line.includes('the AI takes'))).toEqual([])
  }, 60_000)

  test('a seat whose window lapses is the AI’s, to its player’s order, while the other player keeps theirs', async () => {
    const w = await world({ manual: true })
    await twoPlayers(w)
    await connect(w.lobby, ADA, null)
    const bo = await connect(w.lobby, BO, null)
    const { roomId } = await opened(w, meeting(ADA, BO, { blue: 'evade' }))

    // Bo takes his; Ada's window runs out, and her squad is told to get out.
    await bo.request('tictac/api/room/enter', { intent: { kind: 'resume', roomId } })
    w.fire(ENCOUNTER.joinWindowMs)
    expect(w.lobby.view(ADA).you).toMatchObject({ control: 'ai', joinBy: null, against: 'Bo' })
    expect(w.lobby.view(BO).you).toMatchObject({ control: 'player', joinBy: null, against: 'Ada' })

    // Blue, played by the AI, walks to the way out and calls the retreat; Bo
    // answers from his window and sees the match through the referee.
    const host = new MatchHost(bo.of('log')[0]!.header)
    let heard = 0
    for (let round = 0; round < 8 && winnerOf(host.squads) === null; round++) {
      await w.finish()
      heard = hear(bo, host, heard)
      if (host.activeFaction === Faction.Red && winnerOf(host.squads) === null) playTurn(bo, host)
    }
    await w.finish()

    expect(w.verdicts).toEqual([])
    const fight = await w.fought(roomId)
    expect(fight.winner).toBe(Faction.Red)
    expect(retreats(fight, Faction.Blue)).toBe(1)
    await expectBothSettled(w, roomId)
    expect(w.taken).toEqual([`${roomId}|${BO.id}`])
  }, 60_000)

  test('a player who drops and does not come back within the grace loses the seat to the AI, and the other is not disturbed', async () => {
    const w = await world({ manual: true })
    await twoPlayers(w)
    const ada = await connect(w.lobby, ADA, null)
    const bo = await connect(w.lobby, BO, null)
    const { roomId } = await opened(w, meeting(ADA, BO, { red: 'evade' }))
    await ada.request('tictac/api/room/enter', { intent: { kind: 'resume', roomId } })
    await bo.request('tictac/api/room/enter', { intent: { kind: 'resume', roomId } })

    bo.close()
    expect(w.lobby.view(BO).you).toMatchObject({ control: 'player', joinBy: null })
    w.fire(GRACE)
    expect(w.lobby.view(BO).you).toMatchObject({ control: 'ai' })
    expect(w.lobby.view(ADA).you).toMatchObject({ control: 'player' })

    const host = new MatchHost(ada.of('log')[0]!.header)
    playTurn(ada, host)
    await w.finish()
    hear(ada, host, 0)
    await w.finish()

    expect(w.logs).toContain(`room ${roomId}: the AI takes Bo's seat`)
    expect(w.logs.filter((line) => line.includes('aborting room'))).toEqual([])
    expect(w.verdicts).toEqual([])
    const fight = await w.fought(roomId)
    expect(retreats(fight, Faction.Red)).toBe(1)
    await expectBothSettled(w, roomId)
  }, 60_000)
})

describe('a meeting that does not happen', () => {
  test('is passed by when either player already holds a seat, and nothing opens', async () => {
    for (const busy of [ADA, BO]) {
      const w = await world()
      await twoPlayers(w)
      await w.enlist(CY)
      const holder = await connect(w.lobby, busy, { kind: 'open' })
      expect(holder.of('seated')).toHaveLength(1)

      expect(await w.lobby.openMeeting(meeting(ADA, BO))).toEqual({ opened: false, passedFor: 'busy' } satisfies MeetingOpened)
      expect(w.lobby.view(null).rooms).toHaveLength(1)
      expect(await w.persistence.rooms.live()).toHaveLength(1)
      // The other player is not seated anywhere for it.
      expect(w.lobby.view(busy === ADA ? BO : ADA).you).toBeNull()
    }
  })

  test('is passed by while either is in a fight, until it is settled, and is the one match each player has', async () => {
    const w = await world()
    await twoPlayers(w)
    await w.enlist(CY, SQUAD_SIZE, 7)
    await connect(w.lobby, ADA, null)
    const first = await opened(w, meeting(ADA, BO))

    // Ada is in it; Bo, offline, is in it too: neither can be met by Cy.
    expect(await w.lobby.openMeeting(meeting(CY, BO, {}, { at: START + 1 }))).toEqual({ opened: false, passedFor: 'busy' })
    expect(await w.lobby.openMeeting(meeting(ADA, CY, {}, { at: START + 1 }))).toEqual({ opened: false, passedFor: 'busy' })
    expect(await w.persistence.rooms.live()).toHaveLength(1)

    // Let it play out (Ada's window lapses): they are free for the next.
    await w.clock.advance(ENCOUNTER.joinWindowMs)
    await w.finish()
    expect(await w.persistence.rooms.live()).toEqual([])
    expect(w.lobby.room(first.roomId)).toBeUndefined()
    const next = await w.lobby.openMeeting(meeting(ADA, CY, {}, { at: START + 2 }))
    expect(next.opened || next.passedFor === 'nobodyFit').toBe(true)
  }, 60_000)

  test.each([
    ['Blue', ADA],
    ['Red', BO],
  ] as const)('is passed by when %s has nobody fit to field, and no room is opened', async (_side, empty) => {
    const w = await world()
    await twoPlayers(w)
    await w.persistence.db.query`UPDATE roster SET downtime = 1 WHERE player_id = ${empty.id}`

    expect(await w.lobby.openMeeting(meeting(ADA, BO))).toEqual({ opened: false, passedFor: 'nobodyFit' })
    expect(await w.persistence.rooms.live()).toEqual([])
    expect(await w.persistence.db.query`SELECT id FROM matches`).toEqual([])
  })

  test('fields the first four fit members of each roster by slot', async () => {
    const w = await world()
    await twoPlayers(w)
    await w.persistence.rosters.recruit(BO.id)
    await w.persistence.rosters.recruit(BO.id)
    const roster = await w.roster(BO)
    expect(roster).toHaveLength(SQUAD_SIZE + 2)
    // Slots 0 and 3 are in the medical bay: Bo's party is 1, 2, 4, 5.
    await w.persistence.db.query`UPDATE roster SET downtime = 2 WHERE player_id = ${BO.id} AND (slot = 0 OR slot = 3)`

    const fight = await opened(w, meeting(ADA, BO))
    const header = (await w.persistence.matches.header(fight.roomId))!
    expect(header.squads[Faction.Red].map((d) => d.characterId)).toEqual([1, 2, 4, 5].map((slot) => roster[slot]!.character_id))
    expect(header.squads[Faction.Blue]).toHaveLength(SQUAD_SIZE)
    await w.finish()
    expect(w.verdicts).toEqual([])
  })
})

describe('a meeting and a server that restarts', () => {
  test('is restored with each seat as it was, and the AI re-attached to the order it plays to', async () => {
    const w = await world()
    await twoPlayers(w)
    await connect(w.lobby, ADA, null)
    const { roomId, blueJoinBy } = await opened(w, meeting(ADA, BO, { blue: 'cautious', red: 'evade' }))
    await w.stop()

    expect(await w.persistence.db.query`SELECT blue_control, red_control, blue_standing, red_standing, encounter FROM rooms`).toEqual([
      { blue_control: 'reserved', red_control: 'ai', blue_standing: 'cautious', red_standing: 'evade', encounter: 1 },
    ])

    // A server back thirty seconds later: Ada still has time, Bo's seat is the AI's.
    await w.clock.advance(30_000)
    const second = await w.serve()
    const room = second.room(roomId)!
    expect([room.controlOf(Faction.Blue), room.controlOf(Faction.Red)]).toEqual(['reserved', 'ai'])
    expect(room.joinByOf(Faction.Blue)).toBe(blueJoinBy!)
    expect(second.view(ADA).you).toEqual({
      roomId,
      faction: Faction.Blue,
      phase: 'playing',
      control: 'reserved',
      joinBy: blueJoinBy!,
      against: 'Bo',
    })
    expect(second.view(BO).you).toMatchObject({ control: 'ai', against: 'Ada' })

    // She takes the fight on the new server and plays; Bo's squad, re-attached
    // to evade, gets out as it would have.
    const back = await connect(second, ADA, null)
    await back.request('tictac/api/room/enter', { intent: { kind: 'resume', roomId } })
    const host = new MatchHost(back.of('log')[0]!.header)
    let heard = 0
    for (let round = 0; round < 6 && winnerOf(host.squads) === null; round++) {
      if (host.activeFaction === Faction.Blue) playTurn(back, host)
      await w.finish()
      heard = hear(back, host, heard)
    }
    await w.finish()

    expect(w.verdicts).toEqual([])
    const fight = await w.fought(roomId)
    expect(retreats(fight, Faction.Red)).toBe(1)
    expect(fight.winner).toBe(Faction.Blue)
    await expectBothSettled(w, roomId)
  }, 60_000)

  test('a seat kept past the window it had goes to the AI as the server sits down, to the order its player set', async () => {
    const w = await world()
    await twoPlayers(w)
    await connect(w.lobby, ADA, null)
    await connect(w.lobby, BO, null)
    const { roomId } = await opened(w, meeting(ADA, BO, { blue: 'evade', red: 'stand' }))
    await w.stop()

    // Away for the whole window: both seats are the AI's as the server comes back.
    await w.clock.advance(ENCOUNTER.joinWindowMs * 2)
    await w.serve()
    await w.finish()

    expect(w.logs.filter((line) => line.includes('the AI takes'))).toHaveLength(2)
    expect(w.verdicts).toEqual([])
    const fight = await w.fought(roomId)
    expect(retreats(fight, Faction.Blue)).toBe(1)
    expect(fight.winner).toBe(Faction.Red)
    await expectBothSettled(w, roomId)
  }, 60_000)

  test('holds the seat of each player who took theirs, and carries the match on from where it was', async () => {
    const w = await world()
    await twoPlayers(w)
    const ada = await connect(w.lobby, ADA, null)
    const bo = await connect(w.lobby, BO, null)
    const { roomId } = await opened(w, meeting(ADA, BO))
    const keys = {
      ada: (await ada.request('tictac/api/room/enter', { intent: { kind: 'resume', roomId } })).seatKey!,
      bo: (await bo.request('tictac/api/room/enter', { intent: { kind: 'resume', roomId } })).seatKey!,
    }
    const hostA = new MatchHost(ada.of('log')[0]!.header)
    playTurn(ada, hostA)
    await w.finish()

    await w.stop()
    const second = await w.serve()
    const room = second.room(roomId)!
    expect(room.judged).toBe(true)
    expect([room.controlOf(Faction.Blue), room.controlOf(Faction.Red)]).toEqual(['player', 'player'])
    expect(second.view(ADA).you).toEqual({ roomId, faction: Faction.Blue, phase: 'playing', control: 'player', joinBy: null, against: 'Bo' })
    expect(second.view(BO).you).toEqual({ roomId, faction: Faction.Red, phase: 'playing', control: 'player', joinBy: null, against: 'Ada' })

    // Both come back with their keys, to the match as it stood: Red answers.
    const backA = await connect(second, null, { kind: 'resume', roomId, seatKey: keys.ada })
    const backB = await connect(second, null, { kind: 'resume', roomId, seatKey: keys.bo })
    const hostB = new MatchHost(backB.of('log')[0]!.header)
    for (const event of backB.of('log')[0]!.events) hostB.apply(event.command)
    expect(hostB.digest()).toEqual(hostA.digest())
    expect(hostB.activeFaction).toBe(Faction.Red)
    const heard = backA.received.length
    playTurn(backB, hostB)
    await w.finish()
    hear(backA, hostA, heard)
    expect(second.room(roomId)!.digest()).toEqual(hostB.digest())
    expect(w.verdicts).toEqual([])

    // And when both go for good the AI plays out the rest, and both settle.
    backA.close()
    backB.close()
    await w.clock.advance(GRACE)
    await w.finish()
    expect(w.verdicts).toEqual([])
    await expectBothSettled(w, roomId)
  }, 120_000)
})

describe('two squads on the road, end to end', () => {
  const HOUR = 3_600_000
  const north = (from: LatLng, km: number): LatLng => ({ lat: from.lat + km / 111.2, lng: from.lng })
  const ORIGIN: LatLng = { lat: 48.1, lng: 11.5 }

  /** Two registered players, both with a window open, walking at each other; the real lobby opens what they meet. */
  async function road() {
    const persistence = await freshPersistence(':memory:')
    const clock = handClock()
    const marks: Promise<void>[] = []
    const server = rpcServer(persistence, undefined, {
      openMeeting: 'lobby',
      lobby: {
        schedule: (fn, ms) => clock.schedule(fn, ms),
        mapSeed: () => 3,
        graceMs: GRACE,
        onEncounterTaken: (roomId, playerId) => marks.push(persistence.encounters.markTaken(roomId, playerId)),
      },
    })
    const ada = await registerAt(server, persistence, 'Ada', ORIGIN)
    const bo = await registerAt(server, persistence, 'Bo', north(ORIGIN, 20))
    const middle = north(ORIGIN, 10)
    for (const who of [ada, bo]) {
      const sent = await who.window.call('tictac/api/squad/order', { order: { kind: 'goHere', to: middle, pace: 'normal' } })
      expect(sent.code).toBeNull()
    }
    const squads = await Promise.all([ada, bo].map((who) => persistence.squads.of(who.id)))
    const found = firstContact(squads[0]!.waypoints, squads[1]!.waypoints, server.now, ENCOUNTER.meetingRangeKm)!
    expect(found).not.toBeNull()
    const feed = async (who: typeof ada) => (await who.window.call('tictac/api/encounter/feed')).result.entries as EncounterEntry[]
    const finish = async () => {
      await clock.advance(0)
      await Promise.all(marks)
      await server.lobby.idle()
    }
    const pushes = (who: typeof ada) =>
      who.window.pushes.filter((push) => push.method === 'tictac/api/encounter/started').map((push) => push.params)
    return { persistence, clock, server, ada, bo, found, feed, finish, pushes }
  }

  test('a meeting found by the schedule is fought by the AI when nobody takes it, and each player’s feed and recording tell how it went for them', async () => {
    const r = await road()
    r.server.now = r.found.at
    await r.server.wake()
    await r.server.lobby.idle()

    // Both are online: both are told, by name, and both have the window.
    const rooms = await r.persistence.rooms.live()
    expect(rooms).toHaveLength(1)
    const roomId = rooms[0]!.id
    const joinBy = r.found.at + ENCOUNTER.joinWindowMs
    expect(r.pushes(r.ada)).toEqual([{ roomId, against: 'Bo', joinBy, at: r.found.at, place: r.found.place }])
    expect(r.pushes(r.bo)).toEqual([{ roomId, against: 'Ada', joinBy, at: r.found.at, place: r.found.place }])
    for (const [who, other] of [
      [r.ada, 'Bo'],
      [r.bo, 'Ada'],
    ] as const) {
      expect(await r.feed(who)).toMatchObject([{ result: 'inProgress', against: other, matchId: roomId, aliens: 0 }])
    }

    // Neither comes: the window passes and the AI plays both, to a result.
    await r.clock.advance(ENCOUNTER.joinWindowMs)
    await r.finish()
    const [result] = await r.persistence.db.query<{ winner: number; blue_player: string; red_player: string }>`
      SELECT winner, blue_player, red_player FROM match_results WHERE match_id = ${roomId}`
    expect([result!.blue_player, result!.red_player].sort()).toEqual([r.ada.id, r.bo.id].sort())
    const winner = result!.winner === Faction.Blue ? result!.blue_player : result!.red_player

    // Won for the one who won and lost for the other, whichever side each had.
    const [adas, bos] = [await r.feed(r.ada), await r.feed(r.bo)]
    expect([adas[0]!.result, bos[0]!.result]).toEqual(winner === r.ada.id ? ['won', 'lost'] : ['lost', 'won'])
    expect([adas[0]!.playedBy, bos[0]!.playedBy]).toEqual(['ai', 'ai'])

    // Each can watch it back; somebody who was not in it cannot.
    for (const who of [r.ada, r.bo]) {
      const recording = await who.window.call('tictac/api/match/recording', { matchId: roomId })
      expect(recording.code).toBeNull()
      expect((recording.result.recording as { header: RecordingHeader }).header.controllers).toEqual({
        [Faction.Blue]: 'human',
        [Faction.Red]: 'human',
      })
    }
    const stranger = await registerAt(r.server, r.persistence, 'Cy', north(ORIGIN, 80))
    expect((await stranger.window.call('tictac/api/match/recording', { matchId: roomId })).code).toBe(RPC_ERRORS.notYours)

    // Both rosters were settled: every deployed member of both has the match.
    expect(await r.persistence.db.query`SELECT character_id FROM roster WHERE matches = 1`).toHaveLength(2 * SQUAD_SIZE)
    // And both squads stood where they met, which is where the fight was.
    for (const who of [r.ada, r.bo]) {
      const squad = (await r.persistence.squads.of(who.id))!
      expect(squad.waypoints.at(-1)).toMatchObject({ kind: 'past', arrival: r.found.at, departed: null })
    }
  }, 60_000)

  test('the player who takes their seat is recorded as having played it, and only that player', async () => {
    const r = await road()
    r.server.now = r.found.at
    await r.server.wake()
    await r.server.lobby.idle()
    const roomId = (await r.persistence.rooms.live())[0]!.id

    const taken = await r.ada.window.call('tictac/api/room/enter', { intent: { kind: 'resume', roomId } })
    expect(taken.code).toBeNull()
    await r.finish()
    expect(await r.feed(r.ada)).toMatchObject([{ playedBy: 'you', matchId: roomId }])
    expect(await r.feed(r.bo)).toMatchObject([{ playedBy: 'ai', matchId: roomId }])
    // Hers, then, and busy: another meeting at the same moment finds her held.
    expect(await r.server.lobby.openMeeting({
      blue: { player: { id: r.ada.id, name: 'Ada' }, squadId: r.ada.squadId, standing: 'stand' },
      red: { player: { id: r.bo.id, name: 'Bo' }, squadId: r.bo.squadId, standing: 'stand' },
      at: r.found.at + HOUR,
      place: r.found.place,
    })).toEqual({ opened: false, passedFor: 'busy' })
  }, 60_000)
})
