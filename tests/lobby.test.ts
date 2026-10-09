import { describe, expect, test } from 'bun:test'
import { Faction } from '../src/config'
import type { Player } from '../src/game/Rpc'
import { openPersistence } from '../src/server/db/BunSqlDb'
import { Lobby } from '../src/server/Lobby'
import { MY_VERSION } from '../src/version'
import { answered, connect, decisive, keyOf, roomOf, seatBoth } from './support/lobby'

/**
 * The lobby: many rooms on one server, and the two rules that span them — one
 * match per player, one live window per player.
 *
 * Driven over loopback transports in raw JSON-RPC, as a page's socket would
 * speak it, with the grace clock in the test's hands.
 */

const ADA: Player = { id: 'A', name: 'Ada' }
const BO: Player = { id: 'B', name: 'Bo' }
const CY: Player = { id: 'C', name: 'Cy' }

const WINDOW = 'You opened TicTac in another window; this one was disconnected.'
/** A match somebody won, played out once for every test that needs a room to reach its end. */
const RECORDING = decisive()

async function harness() {
  const persistence = await openPersistence()
  /** Every hold the lobby started, and whether it has been called off. */
  const holds: { fn: () => void; ms: number; cancelled: boolean }[] = []
  const lobby = new Lobby({
    matches: persistence.matches,
    rooms: persistence.rooms,
    log: () => {},
    graceMs: 5_000,
    schedule: (fn, ms) => {
      const hold = { fn, ms, cancelled: false }
      holds.push(hold)
      return () => {
        hold.cancelled = true
      }
    },
  })
  /** Let every hold still running run out. */
  const expire = (): void => {
    for (const hold of holds.splice(0)) if (!hold.cancelled) hold.fn()
  }
  return { persistence, lobby, holds, expire, recording: RECORDING }
}

describe('The lobby lists what can be joined and what can be watched', () => {
  test('rooms waiting, deploying and playing, newest first, and the asker’s own seat', async () => {
    const { lobby, recording } = await harness()
    const waiting = await connect(lobby, ADA, { kind: 'open' })
    const deploying = await seatBoth(lobby, null, BO)
    const playing = await seatBoth(lobby, CY, null)
    playing.blue.send({ type: 'matchHeader', header: recording.header })
    await connect(lobby, null, { kind: 'watch', roomId: playing.roomId })

    const view = lobby.view(null)
    expect(view.rooms.map((room) => [room.id, room.phase])).toEqual([
      [playing.roomId, 'playing'],
      [deploying.roomId, 'deploying'],
      [roomOf(waiting), 'waiting'],
    ])
    expect(view.rooms[0]).toMatchObject({
      blue: { name: 'Cy', connected: true },
      red: { name: null, connected: true },
      spectators: 1,
      turn: 1,
    })
    expect(view.rooms[1]).toMatchObject({ blue: { name: null }, red: { name: 'Bo' }, turn: null })
    expect(view.rooms[2]).toMatchObject({ blue: { name: 'Ada' }, red: null, spectators: 0 })
    expect(view.you).toBeNull()

    expect(lobby.view(ADA).you).toEqual({ roomId: roomOf(waiting), faction: Faction.Blue, phase: 'waiting', control: 'player', joinBy: null })
    expect(lobby.view(BO).you).toEqual({ roomId: deploying.roomId, faction: Faction.Red, phase: 'deploying', control: 'player', joinBy: null })
  })

  test('a room that is over is no longer listed, and its players are free', async () => {
    const { lobby, expire, recording } = await harness()
    const settled = await seatBoth(lobby, ADA, BO)
    const abandoned = await seatBoth(lobby, CY, null)

    settled.blue.send({ type: 'matchHeader', header: recording.header })
    for (const event of recording.events) settled.blue.send(event.command)
    abandoned.red.close()
    expire()

    expect(lobby.view(null).rooms).toEqual([])
    expect(lobby.view(ADA).you).toBeNull()
    expect(lobby.view(CY).you).toBeNull()
    // A settled match keeps its sockets: both ends finish on their own screens.
    expect(settled.blue.closed).toBe(false)
    expect(settled.red.of('abort')).toEqual([])
  })

  test('a second match can be played after the first one ends', async () => {
    // The server used to be one referee watching one match, forever.
    const { lobby, persistence, recording } = await harness()
    for (let round = 0; round < 2; round++) {
      const { blue, roomId } = await seatBoth(lobby, ADA, BO)
      blue.send({ type: 'matchHeader', header: recording.header })
      for (const event of recording.events) blue.send(event.command)
      await lobby.idle()
      expect(await persistence.matches.events(roomId)).toHaveLength(recording.events.length)
      expect(lobby.view(null).rooms).toEqual([])
    }
    expect(await persistence.matches.recent()).toHaveLength(2)
  })
})

describe('Taking a seat', () => {
  test('a second player takes the Red seat, and the setup frames pass between the two seats only', async () => {
    const { lobby } = await harness()
    const blue = await connect(lobby, ADA, { kind: 'open' })
    const roomId = roomOf(blue)
    const watcher = await connect(lobby, null, { kind: 'watch', roomId })
    const red = await connect(lobby, BO, { kind: 'join', roomId })

    const seated = { type: 'seated' as const, roomId, redirected: false, seatKey: expect.any(String) }
    expect(blue.of('seated')).toEqual([{ ...seated, faction: Faction.Blue, phase: 'waiting' }])
    expect(red.of('seated')).toEqual([{ ...seated, faction: Faction.Red, phase: 'deploying' }])
    // A seat's key is its own; a spectator has no seat to take back.
    expect(keyOf(red)).not.toBe(keyOf(blue))
    expect(watcher.of('seated')).toEqual([{ ...seated, faction: null, phase: 'waiting', seatKey: null }])

    // The joiner's `hello` reaches the host, whose answer reaches the joiner:
    // the same handshake two peers have, with the server in the middle.
    red.send({ type: 'hello', ...MY_VERSION })
    blue.send({ type: 'init', seed: 7, seedLabel: 'seven', ...MY_VERSION })
    blue.send({ type: 'ready', squad: [] })
    expect(blue.of('hello')).toHaveLength(1)
    expect(red.of('init')).toEqual([{ type: 'init', seed: 7, seedLabel: 'seven', ...MY_VERSION }])
    expect(red.of('ready')).toHaveLength(1)
    expect(watcher.received.map((m) => m.type)).toEqual(['seated'])
  })

  test('a room with two players, or one that is gone, cannot be joined', async () => {
    const { lobby } = await harness()
    const { roomId } = await seatBoth(lobby, ADA, BO)

    const late = await connect(lobby, CY, { kind: 'join', roomId })
    const lost = await connect(lobby, null, { kind: 'join', roomId: 'nowhere' })
    const blind = await connect(lobby, null, { kind: 'watch', roomId: 'nowhere' })

    expect(late.of('abort')[0]?.reason).toBe('That match already has two players — watch it instead.')
    // Turned down, not hung up on: the window tries something else on the same socket.
    expect(late.closed).toBe(false)
    expect(lost.of('abort')[0]?.reason).toBe('That match is gone.')
    expect(blind.of('abort')[0]?.reason).toBe('That match is gone.')
    // Turned away without displacing anybody.
    expect(lobby.view(CY).you).toBeNull()
    expect(lobby.view(null).rooms[0]).toMatchObject({ blue: { name: 'Ada' }, red: { name: 'Bo' } })
  })
})

describe('Watching', () => {
  test('a spectator is handed the log when the match starts, then every intent, and its own say nothing', async () => {
    const { lobby, persistence, recording } = await harness()
    const { blue, red, roomId } = await seatBoth(lobby, ADA, BO)
    const early = await connect(lobby, CY, { kind: 'watch', roomId })
    expect(early.of('log')).toEqual([])

    blue.send({ type: 'matchHeader', header: recording.header })
    const opened = early.of('log')
    expect(opened).toHaveLength(1)
    expect(opened[0]).toMatchObject({ matchId: roomId, events: [] })
    expect(opened[0]!.header.seed).toBe(recording.header.seed)

    const [first, second, third] = recording.events
    blue.send(first!.command)
    blue.send(second!.command)
    expect(early.received.slice(-2).map((m) => m.type)).toEqual([first!.command.type, second!.command.type])

    // A spectator's intent is nobody's: not recorded, not passed on.
    const heard = [blue.received.length, red.received.length]
    early.send(third!.command)
    await lobby.idle()
    expect(await persistence.matches.events(roomId)).toHaveLength(2)
    expect([blue.received.length, red.received.length]).toEqual(heard)

    // One who arrives later is handed the log so far, straight after its seat.
    const late = await connect(lobby, null, { kind: 'watch', roomId })
    expect(late.received.map((m) => m.type)).toEqual(['seated', 'log'])
    expect(late.of('log')[0]!.events.map((event) => event.seq)).toEqual([0, 1])
  })
})

describe('One match per player', () => {
  test('a player with a match in progress is put back in their seat, whatever they ask for', async () => {
    const { lobby, recording } = await harness()
    const { blue, red, roomId } = await seatBoth(lobby, ADA, BO)
    const other = await connect(lobby, CY, { kind: 'open' })
    blue.send({ type: 'matchHeader', header: recording.header })
    for (const event of recording.events.slice(0, 5)) blue.send(event.command)

    for (const intent of [
      { kind: 'open' } as const,
      { kind: 'join', roomId: roomOf(other) } as const,
      { kind: 'watch', roomId: roomOf(other) } as const,
    ]) {
      const elsewhere = await connect(lobby, BO, intent)
      expect(elsewhere.of('seated')).toEqual([
        {
          type: 'seated',
          roomId,
          faction: Faction.Red,
          phase: 'playing',
          redirected: true,
          seatKey: expect.any(String),
        },
      ])
      expect(elsewhere.of('log')[0]!.events).toHaveLength(5)
    }
    // Nothing was opened, joined or watched on Bo's behalf.
    expect(lobby.view(null).rooms.find((room) => room.id === roomOf(other))).toMatchObject({
      red: null,
      spectators: 0,
    })
    expect(lobby.view(null).rooms).toHaveLength(2)
    expect(red.of('abort')[0]?.reason).toBe(WINDOW)
  })
})

describe('One live window per player', () => {
  test('a new window takes over a seat in a match that is playing', async () => {
    const { lobby, persistence, recording } = await harness()
    const { blue, red, roomId } = await seatBoth(lobby, ADA, BO)
    blue.send({ type: 'matchHeader', header: recording.header })
    const played = recording.events.slice(0, 6)
    for (const event of played) blue.send(event.command)

    const window = await connect(lobby, ADA, { kind: 'resume' })

    // The old window is told why, and closed.
    expect(blue.of('abort')).toEqual([{ type: 'abort', reason: WINDOW, side: null }])
    expect(blue.closed).toBe(true)
    // The new one has the seat and the match so far.
    expect(window.of('seated')).toEqual([
      {
        type: 'seated',
        roomId,
        faction: Faction.Blue,
        phase: 'playing',
        redirected: false,
        seatKey: expect.any(String),
      },
    ])
    expect(window.of('log')[0]!.events).toHaveLength(played.length)
    // The opponent never noticed.
    expect(red.of('abort')).toEqual([])
    expect(lobby.view(null).rooms[0]!.blue).toEqual({ name: 'Ada', connected: true })

    // And what the new window says is the seat speaking.
    const next = recording.events[played.length]!.command
    window.send(next)
    await lobby.idle()
    expect(red.received.at(-1)?.type).toBe(next.type)
    expect(await persistence.matches.events(roomId)).toHaveLength(played.length + 1)

    // A new window gets a key of its own, and the one it replaced no longer
    // takes the seat back from under it.
    expect(keyOf(window)).not.toBe(keyOf(blue))
    const stale = await answered(await connect(lobby, null, { kind: 'resume', roomId, seatKey: keyOf(blue) }))
    expect(stale.of('abort')[0]?.reason).toBe('That seat is not yours.')
    expect(window.closed).toBe(false)
  })

  test('a new window abandons a match still being set up, and starts afresh', async () => {
    const { lobby } = await harness()
    const { blue, red, roomId } = await seatBoth(lobby, ADA, BO)
    const watcher = await connect(lobby, null, { kind: 'watch', roomId })

    const window = await connect(lobby, ADA, { kind: 'open' })

    expect(blue.of('abort')).toEqual([{ type: 'abort', reason: WINDOW, side: null }])
    expect(blue.closed).toBe(true)
    // Everybody else in the room is told who left, and the room is over.
    expect(red.of('abort')).toEqual([{ type: 'abort', reason: 'Ada left before the match began.', side: null }])
    expect(watcher.of('abort')[0]?.reason).toBe('Ada left before the match began.')
    // The player was free before the new window's intent was weighed: it got a room of its own.
    const fresh = window.of('seated')[0]!
    expect(fresh).toMatchObject({ faction: Faction.Blue, phase: 'waiting', redirected: false })
    expect(fresh.roomId).not.toBe(roomId)
    expect(lobby.view(null).rooms.map((room) => room.id)).toEqual([fresh.roomId])
    // Bo, abandoned, is free too.
    expect(lobby.view(BO).you).toBeNull()
  })

  test('a new window replaces one that was only watching', async () => {
    const { lobby } = await harness()
    const { roomId } = await seatBoth(lobby, ADA, BO)
    const first = await connect(lobby, CY, { kind: 'watch', roomId })

    const second = await connect(lobby, CY, { kind: 'watch', roomId })

    expect(first.of('abort')[0]?.reason).toBe(WINDOW)
    expect(second.of('seated')[0]).toMatchObject({ roomId, faction: null })
    expect(lobby.view(null).rooms[0]!.spectators).toBe(1)
  })

  test('anonymous sockets are nobody, so nothing replaces them', async () => {
    const { lobby } = await harness()
    const { blue, roomId } = await seatBoth(lobby, null, null)
    await connect(lobby, null, { kind: 'open' })
    await connect(lobby, null, { kind: 'watch', roomId })

    expect(blue.of('abort')).toEqual([])
    expect(lobby.view(null).rooms).toHaveLength(2)
  })
})

describe('Leaving', () => {
  test('a seat dropping before the match began is held, and the room ends only if nobody comes back', async () => {
    // Every dropped seat is held, in every phase and whoever holds it: to the
    // window at the other end a dropped connection is a stall, not a choice.
    const { lobby, holds, expire } = await harness()
    const named = await seatBoth(lobby, ADA, BO)
    const anonymous = await seatBoth(lobby, CY, null)
    const waiting = await connect(lobby, null, { kind: 'open' })

    named.red.close()
    anonymous.red.close()
    waiting.close()

    expect(holds.map((hold) => hold.ms)).toEqual([5_000, 5_000, 5_000])
    expect(named.blue.of('abort')).toEqual([])
    expect(anonymous.blue.of('abort')).toEqual([])
    expect(lobby.view(null).rooms.map((room) => [room.phase, room.blue.connected, room.red?.connected])).toEqual([
      ['waiting', false, undefined],
      ['deploying', true, false],
      ['deploying', true, false],
    ])
    expect(lobby.view(BO).you).toEqual({ roomId: named.roomId, faction: Faction.Red, phase: 'deploying', control: 'player', joinBy: null })

    expire()

    expect(named.blue.of('abort')[0]?.reason).toBe('Bo left before the match began.')
    expect(anonymous.blue.of('abort')[0]?.reason).toBe('The other player left before the match began.')
    expect(lobby.view(null).rooms).toEqual([])
    // Everybody is free to open another.
    expect(lobby.view(ADA).you).toBeNull()
    expect(lobby.view(BO).you).toBeNull()
    expect(roomOf(await connect(lobby, CY, { kind: 'open' }))).not.toBe(anonymous.roomId)
  })

  test('an anonymous seat dropping mid-match is held like any other', async () => {
    const { lobby, holds, expire, recording } = await harness()
    const { blue, red } = await seatBoth(lobby, ADA, null)
    blue.send({ type: 'matchHeader', header: recording.header })

    red.close()

    expect(holds.map((hold) => hold.ms)).toEqual([5_000])
    expect(blue.of('abort')).toEqual([])
    expect(lobby.view(null).rooms[0]!.red).toEqual({ name: null, connected: false })

    expire()

    expect(blue.of('abort')[0]?.reason).toBe('The other player left the match.')
    expect(lobby.view(null).rooms).toEqual([])
  })

  test('a signed-in seat is held for its player, who can take it back', async () => {
    const { lobby, holds, expire, persistence, recording } = await harness()
    const { blue, red, roomId } = await seatBoth(lobby, ADA, BO)
    blue.send({ type: 'matchHeader', header: recording.header })
    for (const event of recording.events.slice(0, 4)) blue.send(event.command)

    blue.close()

    expect(holds.map((hold) => hold.ms)).toEqual([5_000])
    expect(red.of('abort')).toEqual([])
    expect(lobby.view(null).rooms[0]!.blue).toEqual({ name: 'Ada', connected: false })
    expect(lobby.view(ADA).you).toEqual({ roomId, faction: Faction.Blue, phase: 'playing', control: 'player', joinBy: null })

    const back = await connect(lobby, ADA, { kind: 'resume' })
    expect(back.of('seated')[0]).toMatchObject({ roomId, faction: Faction.Blue, redirected: false })
    expect(back.of('log')[0]!.events).toHaveLength(4)

    // The hold is called off: running the clock out now ends nothing.
    expect(holds[0]!.cancelled).toBe(true)
    expire()
    expect(red.of('abort')).toEqual([])
    back.send(recording.events[4]!.command)
    await lobby.idle()
    expect(await persistence.matches.events(roomId)).toHaveLength(5)
  })

  test('a held seat nobody comes back to ends the match, and frees the player', async () => {
    const { lobby, expire, recording } = await harness()
    const { blue, red } = await seatBoth(lobby, ADA, BO)
    const watcher = await connect(lobby, CY, { kind: 'watch', roomId: roomOf(blue) })
    blue.send({ type: 'matchHeader', header: recording.header })

    blue.close()
    expire()

    expect(red.of('abort')[0]?.reason).toBe('Ada left the match.')
    expect(watcher.of('abort')[0]?.reason).toBe('Ada left the match.')
    expect(lobby.view(null).rooms).toEqual([])
    expect((await connect(lobby, ADA, { kind: 'resume' })).of('abort')[0]?.reason).toBe('You have no match in progress.')
  })

  test('a spectator leaving changes nothing but the count', async () => {
    const { lobby } = await harness()
    const { blue, roomId } = await seatBoth(lobby, ADA, BO)
    const watcher = await connect(lobby, null, { kind: 'watch', roomId })

    watcher.close()

    expect(blue.of('abort')).toEqual([])
    expect(lobby.view(null).rooms[0]).toMatchObject({ phase: 'deploying', spectators: 0 })
  })
})

describe('Taking a seat back with its key', () => {
  test('a dropped anonymous seat is taken back by its key, in every phase', async () => {
    const { lobby, holds, recording } = await harness()
    const waiting = await connect(lobby, null, { kind: 'open' })
    const deploying = await seatBoth(lobby, null, null)
    const playing = await seatBoth(lobby, null, null)
    playing.blue.send({ type: 'matchHeader', header: recording.header })
    for (const event of recording.events.slice(0, 3)) playing.blue.send(event.command)

    waiting.close()
    deploying.red.close()
    playing.red.close()
    const back = await Promise.all(
      [waiting, deploying.red, playing.red].map(async (dropped) =>
        answered(await connect(lobby, null, { kind: 'resume', roomId: roomOf(dropped), seatKey: keyOf(dropped) })),
      ),
    )

    const seated = back.map((socket) => socket.of('seated')[0])
    // The same seat, in the phase it was left in, under the same key.
    expect(seated.map((frame) => [frame?.roomId, frame?.faction, frame?.phase, frame?.seatKey])).toEqual([
      [roomOf(waiting), Faction.Blue, 'waiting', keyOf(waiting)],
      [deploying.roomId, Faction.Red, 'deploying', keyOf(deploying.red)],
      [playing.roomId, Faction.Red, 'playing', keyOf(playing.red)],
    ])
    expect(seated.every((frame) => frame?.redirected === false)).toBe(true)
    // A seat in a match being played gets the log, exactly as a new window would.
    expect(back[2]!.of('log')[0]!.events.map((event) => event.command)).toEqual(
      recording.events.slice(0, 3).map((event) => event.command),
    )
    // Every hold is called off, and nobody else noticed anything.
    expect(holds.every((hold) => hold.cancelled)).toBe(true)
    expect([deploying.blue, playing.blue].flatMap((socket) => socket.of('abort'))).toEqual([])
    expect(lobby.view(null).rooms.every((room) => room.blue.connected && room.red?.connected !== false)).toBe(true)

    // And it is the seat again: what it says is relayed and recorded.
    back[2]!.send(recording.events[3]!.command)
    expect(playing.blue.received.at(-1)?.type).toBe(recording.events[3]!.command.type)
  })

  test('a reconnection is not a new window: a seat being set up comes back without abandoning the room', async () => {
    const { lobby } = await harness()
    const { blue, red, roomId } = await seatBoth(lobby, ADA, BO)
    blue.close()

    // No ticket: the key is the proof, and the socket becomes Ada's.
    const back = await answered(await connect(lobby, null, { kind: 'resume', roomId, seatKey: keyOf(blue) }))

    expect(back.of('seated')[0]).toMatchObject({ roomId, faction: Faction.Blue, phase: 'deploying' })
    expect(red.of('abort')).toEqual([])
    expect(lobby.view(ADA).you).toEqual({ roomId, faction: Faction.Blue, phase: 'deploying', control: 'player', joinBy: null })
    // The reconnected window restates its opening, which the other seat hears
    // as it heard the first one.
    back.send({ type: 'hello', ...MY_VERSION })
    back.send({ type: 'init', seed: 7, seedLabel: 'seven', ...MY_VERSION })
    expect(red.of('hello')).toHaveLength(1)
    expect(red.of('init')).toEqual([{ type: 'init', seed: 7, seedLabel: 'seven', ...MY_VERSION }])

    // A new window of Ada's, by contrast, is a new window — of the socket
    // that just reconnected, which is now hers.
    await connect(lobby, ADA, { kind: 'open' })
    expect(back.of('abort')[0]?.reason).toBe(WINDOW)
    expect(red.of('abort')[0]?.reason).toBe('Ada left before the match began.')
  })

  test('a reconnection the server had not noticed was needed retires the socket it replaces', async () => {
    // The usual shape of a dropped connection: the window gives up on its
    // socket and reconnects before the server has seen the old one close.
    const { lobby, recording } = await harness()
    const { blue, red, roomId } = await seatBoth(lobby, null, null)
    blue.send({ type: 'matchHeader', header: recording.header })

    const back = await answered(await connect(lobby, null, { kind: 'resume', roomId, seatKey: keyOf(red) }))

    expect(back.of('seated')[0]).toMatchObject({ faction: Faction.Red, phase: 'playing' })
    expect(red.of('abort')[0]?.reason).toBe('This seat was taken back by another connection.')
    // Out of the room, still on the server: the socket is the window, not the seat.
    expect(red.closed).toBe(false)
    expect(blue.of('abort')).toEqual([])
    blue.send(recording.events[0]!.command)
    expect(back.received.at(-1)?.type).toBe(recording.events[0]!.command.type)
  })

  test('a key that fits no seat is refused, and a room that is over is gone', async () => {
    const { lobby, expire } = await harness()
    const first = await seatBoth(lobby, null, null)
    const second = await seatBoth(lobby, null, null)
    first.red.close()

    const wrong = await answered(await connect(lobby, null, { kind: 'resume', roomId: first.roomId, seatKey: 'not-a-key' }))
    // A real key, for another room.
    const elsewhere = await answered(
      await connect(lobby, null, { kind: 'resume', roomId: first.roomId, seatKey: keyOf(second.red) }),
    )
    expect(wrong.of('abort')[0]?.reason).toBe('That seat is not yours.')
    expect(elsewhere.of('abort')[0]?.reason).toBe('That seat is not yours.')
    expect(wrong.closed).toBe(false)
    expect(first.blue.of('abort')).toEqual([])

    expire()
    const late = await answered(
      await connect(lobby, null, { kind: 'resume', roomId: first.roomId, seatKey: keyOf(first.red) }),
    )
    expect(late.of('abort')[0]?.reason).toBe('That match is gone.')
  })
})
