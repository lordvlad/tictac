import { describe, expect, test } from 'bun:test'
import { Faction } from '../src/config'
import type { RecordedEvent, RecordingHeader } from '../src/game/Recording'
import type { Player } from '../src/game/Rpc'
import { openPersistence } from '../src/server/db/BunSqlDb'
import { Lobby } from '../src/server/Lobby'
import { hashSeatKey, type RefereeVerdict } from '../src/server/Room'
import { MatchHost } from '../src/sim/MatchHost'
import { MY_VERSION, OLDEST_SERVED_PROTOCOL, PROTOCOL_VERSION, type PeerVersion } from '../src/version'
import { answered, connect, decisive, enlistFor, keyOf, roomOf, seatBoth, type Connection } from './support/lobby'

/**
 * A server that stops and starts again over the same database — restarted,
 * evicted, or redeployed as a newer build — and the windows that were
 * playing on it, which reconnect to their own seats with their keys.
 *
 * Driven over loopback transports in raw JSON-RPC, as in `lobby.test.ts`,
 * with the grace clock in the test's hands.
 */

const ADA: Player = { id: 'A', name: 'Ada' }
const BO: Player = { id: 'B', name: 'Bo' }
const CY: Player = { id: 'C', name: 'Cy' }

/** The bundle browsers were running before a deploy, and the one it shipped. */
const OLD: PeerVersion = { protocol: PROTOCOL_VERSION, build: 'old' }
const NEW: PeerVersion = { protocol: PROTOCOL_VERSION, build: 'new' }

/** A match somebody won, played out once for every test that needs one. */
const RECORDING = decisive()
/** Far enough into the match that a restart interrupts it, short of anybody winning. */
const HALF = Math.floor(RECORDING.events.length / 2)

/** One database, and a way to start a server over it — again, and as whichever build a test likes. */
async function deployment() {
  const persistence = await openPersistence()
  const holds: { fn: () => void; ms: number; cancelled: boolean }[] = []
  const verdicts: RefereeVerdict[] = []
  const logs: string[] = []
  const serve = async (version: PeerVersion = MY_VERSION): Promise<Lobby> => {
    const lobby = new Lobby({
      matches: persistence.matches,
      rooms: persistence.rooms,
      rosters: persistence.rosters,
      onVerdict: (verdict) => verdicts.push(verdict),
      log: (message) => logs.push(message),
      graceMs: 5_000,
      schedule: (fn, ms) => {
        const hold = { fn, ms, cancelled: false }
        holds.push(hold)
        return () => {
          hold.cancelled = true
        }
      },
      version,
    })
    await lobby.restore()
    return lobby
  }
  /** Let every hold still running run out. */
  const expire = (): void => {
    for (const hold of holds.splice(0)) if (!hold.cancelled) hold.fn()
  }
  return { persistence, holds, verdicts, logs, serve, expire }
}

/** The window behind `dropped` reconnecting to its seat with its key, as a page on `version`. */
async function reconnect(lobby: Lobby, dropped: Connection, version: PeerVersion = MY_VERSION): Promise<Connection> {
  const intent = { kind: 'resume', roomId: roomOf(dropped), seatKey: keyOf(dropped) } as const
  return answered(await connect(lobby, null, intent, { version }))
}

/** The referee's world after `events`, computed by nobody in the room. */
function independent(header: RecordingHeader, events: readonly RecordedEvent[]): MatchHost {
  const host = new MatchHost(header)
  for (const event of events) host.apply(event.command)
  return host
}

describe('A restart loses no room', () => {
  test('a waiting, a deploying and a playing room come back, and the match is finished on the new server', async () => {
    const { persistence, holds, verdicts, serve } = await deployment()
    const first = await serve()
    // A millisecond apart, so that newest-first is an order the store can
    // restore rather than a tie.
    const waiting = await connect(first, ADA, { kind: 'open' })
    await Bun.sleep(2)
    const deploying = await seatBoth(first, null, BO)
    await Bun.sleep(2)
    const playing = await seatBoth(first, null, null)
    playing.blue.send({ type: 'matchHeader', header: RECORDING.header })
    for (const event of RECORDING.events.slice(0, HALF)) playing.blue.send(event.command)
    await first.idle()
    const accepted = await persistence.matches.events(playing.roomId)

    await first.dispose()
    // To a window this is a dropped connection, not the end of anything.
    const before = [waiting, deploying.blue, deploying.red, playing.blue, playing.red]
    expect(before.every((socket) => socket.closed)).toBe(true)
    expect(before.flatMap((socket) => socket.of('abort'))).toEqual([])
    // What survived it is the hash of every key, never a key.
    const rows = JSON.stringify(await persistence.db.query`SELECT * FROM rooms`)
    for (const socket of before) {
      expect(rows).not.toContain(keyOf(socket))
      expect(rows).toContain(await hashSeatKey(keyOf(socket)))
    }

    const second = await serve()

    // Listed as they were, newest first, with every seat held for its window.
    const turn = independent(RECORDING.header, accepted).turnNumber
    expect(second.view(null).rooms.map((room) => [room.id, room.phase, room.turn])).toEqual([
      [playing.roomId, 'playing', turn],
      [deploying.roomId, 'deploying', null],
      [roomOf(waiting), 'waiting', null],
    ])
    for (const room of second.view(null).rooms) {
      expect(room.blue.connected).toBe(false)
      if (room.red) expect(room.red.connected).toBe(false)
    }
    expect(second.view(null).rooms[1]).toMatchObject({ blue: { name: null }, red: { name: 'Bo' } })
    expect(second.view(ADA).you).toEqual({ roomId: roomOf(waiting), faction: Faction.Blue, phase: 'waiting' })
    expect(second.view(BO).you).toEqual({ roomId: deploying.roomId, faction: Faction.Red, phase: 'deploying' })
    expect(holds.filter((hold) => !hold.cancelled).map((hold) => hold.ms)).toEqual([5_000, 5_000, 5_000, 5_000, 5_000])

    // Each window reconnects with its key: same room, same side, same key, same phase.
    const after = await Promise.all(before.map((socket) => reconnect(second, socket)))
    for (const [i, socket] of after.entries()) {
      const was = before[i]!.of('seated')[0]!
      expect(socket.of('seated')).toEqual([{ ...was, phase: i < 1 ? 'waiting' : i < 3 ? 'deploying' : 'playing' }])
    }
    expect(holds.every((hold) => hold.cancelled)).toBe(true)
    const [, deployingBlue, deployingRed, playingBlue, playingRed] = after

    // A room being set up carries on where it was: the restatement reaches the other seat.
    deployingBlue!.send({ type: 'init', seed: 7, seedLabel: 'seven', ...MY_VERSION })
    expect(deployingRed!.of('init')).toHaveLength(1)
    // And a room waiting for an opponent can still get one.
    expect((await connect(second, CY, { kind: 'join', roomId: roomOf(waiting) })).of('seated')[0]).toMatchObject({
      faction: Faction.Red,
      phase: 'deploying',
    })

    // A seat in the match being played is handed exactly what was accepted before the restart.
    for (const socket of [playingBlue!, playingRed!]) {
      expect(socket.received.map((m) => m.type)).toEqual(['seated', 'log'])
      expect(socket.of('log')[0]!.events).toEqual(accepted)
    }

    // The match goes on, refereed: relayed, recorded, checked against the
    // referee's own world, and settled when somebody wins.
    const rest = RECORDING.events.slice(HALF)
    for (const event of rest.slice(0, 4)) playingBlue!.send(event.command)
    expect(playingRed!.received.slice(-4).map((m) => m.type)).toEqual(rest.slice(0, 4).map((e) => e.command.type))
    const honest = independent(RECORDING.header, RECORDING.events.slice(0, HALF + 4)).digest()
    expect(second.room(playing.roomId)!.digest()).toEqual(honest)
    playingBlue!.send({ type: 'digest', digest: honest })
    expect(playingRed!.of('digest')).toHaveLength(1)
    for (const event of rest.slice(4)) playingBlue!.send(event.command)
    await second.idle()

    expect(verdicts).toEqual([])
    expect(second.room(playing.roomId)!.over).toBe(true)
    expect([playingBlue!, playingRed!].flatMap((socket) => socket.of('abort'))).toEqual([])
    expect(second.view(null).rooms.map((room) => room.id)).not.toContain(playing.roomId)
    expect(await persistence.matches.events(playing.roomId)).toHaveLength(RECORDING.events.length)
    expect((await persistence.rooms.live()).map((room) => room.id)).not.toContain(playing.roomId)
  })

  test('a seat nobody takes back after a restart ends its room once the grace runs out', async () => {
    const { persistence, verdicts, serve, expire } = await deployment()
    const header = await enlistFor(persistence, RECORDING.header, ADA, BO)
    const first = await serve()
    const { blue, red, roomId } = await seatBoth(first, ADA, BO)
    blue.send({ type: 'matchHeader', header })
    for (const event of RECORDING.events.slice(0, 4)) blue.send(event.command)
    const waiting = await connect(first, CY, { kind: 'open' })
    await first.dispose()

    const second = await serve()
    await reconnect(second, red)
    // One match per player holds for a restored room: whatever Bo's new
    // window asks for, it is put back in his own seat.
    const window = await connect(second, BO, { kind: 'open' })
    expect(window.of('seated')[0]).toMatchObject({ roomId, faction: Faction.Red, redirected: true })
    expect(window.of('log')[0]!.events).toHaveLength(4)

    expire()

    expect(window.of('abort')[0]?.reason).toBe('Ada left the match.')
    expect(second.view(null).rooms).toEqual([])
    expect(second.view(ADA).you).toBeNull()
    expect(second.view(CY).you).toBeNull()
    expect((await reconnect(second, blue)).of('abort')[0]?.reason).toBe('That match is gone.')
    expect((await reconnect(second, waiting)).of('abort')[0]?.reason).toBe('That match is gone.')
    await second.idle()
    expect(await persistence.rooms.live()).toEqual([])
    // A player walking out is nobody's foul.
    expect(verdicts).toEqual([])
  })
})

describe('A rolling update', () => {
  test('a match started on the previous build is finished on it, judged and kept, by a server on the next', async () => {
    const { persistence, verdicts, serve } = await deployment()
    const header = await enlistFor(persistence, RECORDING.header, ADA, BO)
    const old = await serve(OLD)
    const { blue, red, roomId } = await seatBoth(old, ADA, BO, { version: OLD })
    blue.send({ type: 'matchHeader', header })
    for (const event of RECORDING.events.slice(0, HALF)) blue.send(event.command)
    const lonely = await connect(old, CY, { kind: 'open' }, { version: OLD })
    await old.dispose()

    const fresh = await serve(NEW)

    // The pages still running the old bundle reconnect to their own seats.
    const [ada, bo] = await Promise.all([reconnect(fresh, blue, OLD), reconnect(fresh, red, OLD)])
    expect(ada.of('seated')[0]).toMatchObject({ roomId, faction: Faction.Blue, phase: 'playing', seatKey: keyOf(blue) })
    expect(bo.of('log')[0]!.events).toHaveLength(HALF)

    // But they can start nothing on the new server: that takes its build.
    const refusal = 'Build mismatch: the match server is running build new, this page is running build old.'
    for (const intent of [
      { kind: 'open' } as const,
      { kind: 'join', roomId } as const,
      { kind: 'watch', roomId } as const,
    ]) {
      expect((await connect(fresh, null, intent, { version: OLD })).of('abort')[0]?.reason).toStartWith(refusal)
    }
    // And a page on the new build can neither join nor watch a room of the old one…
    for (const intent of [{ kind: 'join', roomId } as const, { kind: 'watch', roomId } as const]) {
      expect((await connect(fresh, null, intent, { version: NEW })).of('abort')[0]?.reason).toBe(
        'That match was started on another version of TicTac, and only its own players can finish it.',
      )
    }
    // …nor carry a player's match on in a new window — which leaves the
    // window that can carry it on alone.
    const reloaded = await connect(fresh, ADA, { kind: 'resume' }, { version: NEW })
    expect(reloaded.of('abort')[0]?.reason).toBe(
      'That match was started on another version of TicTac (build old; this page is running build new), ' +
        'so this page cannot carry it on.',
    )
    expect(ada.closed).toBe(false)
    // A room of the old build still waiting for an opponent could never get
    // one, so it was not taken up.
    expect((await reconnect(fresh, lonely, OLD)).of('abort')[0]?.reason).toBe('That match is gone.')
    expect(fresh.view(null).rooms.map((room) => room.id)).toEqual([roomId])

    // The rules did not change, so the new server still judges the match…
    const rest = RECORDING.events.slice(HALF)
    for (const event of rest.slice(0, 2)) ada.send(event.command)
    ada.send({ type: 'digest', digest: independent(header, RECORDING.events.slice(0, HALF + 2)).digest() })
    for (const event of rest.slice(2)) ada.send(event.command)
    await fresh.idle()

    expect(fresh.room(roomId)!.judged).toBe(true)
    expect(verdicts).toEqual([])
    expect([ada, bo].flatMap((socket) => socket.of('abort'))).toEqual([])
    // …and settles it onto both rosters, as if nothing had been deployed.
    expect(await persistence.db.query`SELECT match_id FROM match_results`).toEqual([{ match_id: roomId }])
    expect(await persistence.rooms.live()).toEqual([])
  })

  test('a room of the previous build that disagrees with the new rules is witnessed, not aborted', async () => {
    const { persistence, verdicts, logs, serve } = await deployment()
    const header = await enlistFor(persistence, RECORDING.header, ADA, BO)
    const rostersBefore = [await persistence.rosters.active('A'), await persistence.rosters.active('B')]
    const old = await serve(OLD)
    const { blue, red, roomId } = await seatBoth(old, ADA, BO, { version: OLD })
    blue.send({ type: 'matchHeader', header })
    for (const event of RECORDING.events.slice(0, HALF)) blue.send(event.command)
    await old.dispose()

    const fresh = await serve(NEW)
    const [ada, bo] = await Promise.all([reconnect(fresh, blue, OLD), reconnect(fresh, red, OLD)])

    // A state the new server's rules say the match is not in. From a server
    // on the room's own build that is a foul; from this one it could as well
    // be a rules change, and it cannot tell which.
    const invented = independent(header, RECORDING.events.slice(0, HALF)).digest()
    const unitId = Object.keys(invented.units)[0]!
    invented.units[unitId]!.health = (invented.units[unitId]!.health ?? 0) + 1
    invented.total += 1
    ada.send({ type: 'digest', digest: invented })

    expect(verdicts).toEqual([])
    expect([ada, bo].flatMap((socket) => socket.of('abort'))).toEqual([])
    expect(bo.of('digest')).toHaveLength(1)
    expect(fresh.room(roomId)!.judged).toBe(false)
    expect(logs.filter((line) => line.includes('stops judging'))).toHaveLength(1)
    // Said once: the next disagreement is not judged at all.
    ada.send({ type: 'digest', digest: invented })
    expect(logs.filter((line) => line.includes('stops judging'))).toHaveLength(1)

    // Witnessed survives the next restart too.
    await fresh.dispose()
    const again = await serve(NEW)
    expect(again.room(roomId)!.judged).toBe(false)
    const [ada2, bo2] = await Promise.all([reconnect(again, ada, OLD), reconnect(again, bo, OLD)])

    // Play goes on, relayed and recorded exactly as before…
    const rest = RECORDING.events.slice(HALF)
    for (const event of rest) ada2.send(event.command)
    await again.idle()
    expect(bo2.received.slice(-rest.length).map((m) => m.type)).toEqual(rest.map((e) => e.command.type))
    expect(await persistence.matches.events(roomId)).toHaveLength(RECORDING.events.length)
    expect([ada2, bo2].flatMap((socket) => socket.of('abort'))).toEqual([])
    // …but keeps nobody's squad: an unwatched match keeps nothing either.
    expect(again.room(roomId)!.over).toBe(true)
    expect(await persistence.db.query`SELECT match_id FROM match_results`).toEqual([])
    expect([await persistence.rosters.active('A'), await persistence.rosters.active('B')]).toEqual(rostersBefore)
    expect(verdicts).toEqual([])
  })

  test('a protocol older than the server still serves is refused, even to take a seat back', async () => {
    const { serve } = await deployment()
    const lobby = await serve()
    const { blue, red, roomId } = await seatBoth(lobby, null, null)
    red.close()
    const ancient: PeerVersion = { protocol: OLDEST_SERVED_PROTOCOL - 1, build: MY_VERSION.build }
    const refusal =
      `Protocol mismatch: the match server speaks protocol ${PROTOCOL_VERSION}, ` +
      `this page speaks protocol ${ancient.protocol}.`

    const opening = await connect(lobby, null, { kind: 'open' }, { version: ancient })
    const returning = await reconnect(lobby, red, ancient)

    expect(opening.of('abort')[0]?.reason).toStartWith(refusal)
    expect(returning.of('abort')[0]?.reason).toStartWith(refusal)
    expect(returning.of('seated')).toEqual([])
    // The seat is still held for a page that can take it.
    expect(lobby.view(null).rooms.find((room) => room.id === roomId)!.red).toEqual({ name: null, connected: false })
    expect(blue.of('abort')).toEqual([])
    expect((await reconnect(lobby, red)).of('seated')).toHaveLength(1)
  })
})
