import { describe, expect, test } from 'bun:test'
import { AmmoId, ShotMode, WeaponId } from '../src/core/Arsenal'
import { Faction } from '../src/config'
import type { CombatRecording } from '../src/game/Recording'
import { openPersistence } from '../src/server/db/BunSqlDb'
import type { Player } from '../src/game/Rpc'
import { Lobby } from '../src/server/Lobby'
import type { RefereeVerdict } from '../src/server/Room'
import { MatchHost } from '../src/sim/MatchHost'
import { replay } from '../src/sim/Replay'
import { SimMatch, type SquadPlan } from '../src/sim/SimMatch'
import { MY_VERSION } from '../src/version'
import { connect, seatBoth } from './support/lobby'

const STOCK: SquadPlan = {
  weapons: [WeaponId.Rifle, WeaponId.Gatling, WeaponId.Sniper, WeaponId.Shotgun],
  ammo: AmmoId.Standard,
  grenades: { frag: 1, flash: 0, smoke: 0 },
  items: {},
  attachments: [],
}

const ADA: Player = { id: 'A', name: 'Ada' }
const BO: Player = { id: 'B', name: 'Bo' }

/** A match somebody already played, to use as two clients' intents. */
function recorded(seed: number): CombatRecording {
  const match = new SimMatch({ seed, blue: STOCK, red: STOCK, turnCap: 40, record: true })
  match.run()
  const recording = match.recording
  expect(recording).not.toBeNull()
  return recording!
}

async function harness(seed = 4242) {
  const recording = recorded(seed)
  const persistence = await openPersistence()
  const verdicts: RefereeVerdict[] = []
  const lobby = new Lobby({
    matches: persistence.matches,
    rooms: persistence.rooms,
    onVerdict: (v) => verdicts.push(v),
    log: () => {},
    // A dropped seat is held on a clock nothing here ever runs out.
    schedule: () => () => {},
  })
  return { recording, store: persistence.matches, persistence, lobby, verdicts }
}

describe('A third recomputation of the same match', () => {
  test('a whole match is watched, recorded and refought', async () => {
    // Both clients are clients: they resolve their own intents, and the referee
    // resolves the same stream. What it ends up holding is not a copy of what
    // they told it — it is its own answer to the same question.
    const { recording, store, lobby } = await harness()
    const { blue, roomId } = await seatBoth(lobby, null, null)
    blue.send({ type: 'matchHeader', header: recording.header })

    for (const event of recording.events) blue.send(event.command)

    // The referee judges a frame the moment it arrives and writes afterwards,
    // so a reader of the log waits for the writes it already decided on. The
    // match is written under the room's own id.
    await lobby.idle()
    expect(await store.events(roomId)).toHaveLength(recording.events.length)

    // And the referee's own world is the match: the same survivors the players'
    // own run reached, from intents alone.
    const independent = replay(recording)
    expect(lobby.room(roomId)!.digest()!.total).toBe(independent.digest.total)
  })

  test('the log it keeps is a match somebody else can refight', async () => {
    // The persistence half. What is stored is the intent stream, so the stored
    // match is re-derivable rather than a summary that could disagree with it.
    const { recording, store, lobby } = await harness()
    const { blue, roomId } = await seatBoth(lobby, null, null)
    blue.send({ type: 'matchHeader', header: recording.header })
    for (const event of recording.events) blue.send(event.command)

    await lobby.idle()
    const stored = await store.match(roomId)
    expect(stored).not.toBeNull()

    const fromStore = replay(stored!)
    expect(fromStore.skipped).toEqual([])
    expect(fromStore.digest.total).toBe(lobby.room(roomId)!.digest()!.total)
  })

  test('intents reach the other seat and every spectator, and never echo back to the sender', async () => {
    // The referee relays as well as watches, which is what removes the
    // signalling broker from a refereed match. A frame coming back to its
    // sender would be applied twice.
    const { recording, lobby } = await harness()
    const { blue, red, roomId } = await seatBoth(lobby, null, null)
    const watcher = await connect(lobby, null, { kind: 'watch', roomId })
    blue.send({ type: 'matchHeader', header: recording.header })

    const first = recording.events[0]!.command
    blue.send(first)

    expect(red.received.map((m) => m.type)).toContain(first.type)
    expect(watcher.received.map((m) => m.type)).toContain(first.type)
    expect(blue.received.map((m) => m.type)).not.toContain(first.type)
  })

  test('a match cannot start before somebody has joined it', async () => {
    // The opening position is Blue's to state once both sides have deployed;
    // stated into a room with nobody in the other seat, it opens nothing.
    const { recording, store, lobby } = await harness()
    const blue = await connect(lobby, null, { kind: 'open' })
    blue.send({ type: 'matchHeader', header: recording.header })
    blue.send(recording.events[0]!.command)

    await lobby.idle()
    const roomId = blue.of('seated')[0]!.roomId
    expect(lobby.view(null).rooms[0]!.phase).toBe('waiting')
    expect(await store.header(roomId)).toBeNull()
  })
})

describe('Attribution, which is the only thing a third party adds', () => {
  test('a client whose state disagrees with the referee ends the match', async () => {
    // Two peers can notice a disagreement; neither can prove whose fault it is.
    // The referee is not asking whether the client agrees with its opponent —
    // it is asking whether it agrees with a recomputation neither player owns.
    const { recording, lobby, verdicts } = await harness()
    const { blue, red } = await seatBoth(lobby, null, null)
    blue.send({ type: 'matchHeader', header: recording.header })
    for (const event of recording.events.slice(0, 6)) blue.send(event.command)

    // A world that never happened: one unit's health moved on the client alone.
    const invented = new MatchHost(recording.header)
    const digest = invented.digest()
    const unitId = Object.keys(digest.units)[0]!
    digest.units[unitId]!.health = (digest.units[unitId]!.health ?? 0) + 1
    digest.total += 1

    blue.send({ type: 'digest', digest })

    expect(verdicts).toHaveLength(1)
    expect(verdicts[0]!.reason).toContain('disagrees with the referee')
    expect(verdicts[0]!.side).toBe(Faction.Blue)
    expect(verdicts[0]!.found.some((d) => d.what.startsWith('component'))).toBe(true)
    // Both seats are told, and the room is over.
    expect(blue.of('abort')).toHaveLength(1)
    expect(red.of('abort')).toHaveLength(1)
    expect(lobby.view(null).rooms).toEqual([])
  })

  test('an honest digest is silent, and reaches the other seat', async () => {
    const { recording, lobby, verdicts } = await harness()
    const { blue, red, roomId } = await seatBoth(lobby, null, null)
    blue.send({ type: 'matchHeader', header: recording.header })
    for (const event of recording.events.slice(0, 6)) blue.send(event.command)

    blue.send({ type: 'digest', digest: lobby.room(roomId)!.digest()! })

    expect(verdicts).toEqual([])
    expect(red.of('digest')).toHaveLength(1)
  })

  test('an intent the referee cannot carry out ends the match too', async () => {
    // A disagreement about what was *possible* is larger than a disagreement
    // about a number, so it is a verdict rather than a logged shrug.
    const { recording, lobby, verdicts } = await harness()
    const { blue, red } = await seatBoth(lobby, null, null)
    blue.send({ type: 'matchHeader', header: recording.header })

    blue.send({
      type: 'fireShot',
      shooterFaction: Faction.Blue,
      shooterIndex: 0,
      targetFaction: Faction.Red,
      targetIndex: 0,
      mode: ShotMode.Aimed,
    })
    // Nobody is in range at the opening position, so the rules refuse it.
    expect(verdicts).toHaveLength(1)
    expect(verdicts[0]!.reason).toContain('could not carry out')
    // Refused, so not passed on: the other seat hears why, not the shot.
    expect(red.of('fireShot')).toEqual([])
    expect(red.of('abort')).toHaveLength(1)
  })

  test('a client on another build is refused rather than accused, before it is placed anywhere', async () => {
    // The precondition for ever naming a side: this project deploys on every
    // push, so two builds diverge innocently and the first player a referee
    // accused would be somebody with a stale cache. Admitted to the server —
    // it may have a match of its own build to finish — but not to a new room.
    const { lobby, verdicts } = await harness()
    const stale = await connect(lobby, null, null, { version: { protocol: MY_VERSION.protocol, build: 'c0ffee1' } })

    const refusal = await stale.request('tictac/api/room/enter', { intent: { kind: 'open' } }).catch((e: Error) => e)

    expect(refusal).toBeInstanceOf(Error)
    expect((refusal as Error).message).toContain('c0ffee1')
    expect(stale.closed).toBe(false)
    // Refused, not judged: no verdict, and no room opened for it.
    expect(verdicts).toEqual([])
    expect(lobby.view(null).rooms).toEqual([])
  })

  test('a request for a room it cannot read is refused in words, and the window stays', async () => {
    const { lobby } = await harness()
    const lost = await connect(lobby, null, null)

    const refusal = await lost
      .request('tictac/api/room/enter', { intent: { kind: 'elsewhere' } as never })
      .catch((e: Error) => e)

    expect((refusal as Error).message).toMatch(/does not say which match/)
    expect(lost.closed).toBe(false)
  })
})

describe('Rejoining a match that outlived its tab', () => {
  test('a player who takes their seat back is handed the whole log, and it refights to the referee', async () => {
    const { recording, store, lobby } = await harness()
    const { blue, roomId } = await seatBoth(lobby, ADA, BO)
    // Part of a match, so it is still being played when Blue comes back.
    const played = recording.events.slice(0, 20)
    blue.send({ type: 'matchHeader', header: recording.header })
    for (const event of played) blue.send(event.command)
    blue.close()

    const returning = await connect(lobby, ADA, { kind: 'resume' })

    expect(returning.of('seated')).toEqual([
      {
        type: 'seated',
        roomId,
        faction: Faction.Blue,
        phase: 'playing',
        redirected: false,
        seatKey: expect.any(String),
      },
    ])
    // The log follows the seat immediately, without waiting on the database:
    // nothing relayed after it may arrive before it.
    expect(returning.received.map((m) => m.type)).toEqual(['seated', 'log'])
    const log = returning.of('log')[0]!
    expect(log.matchId).toBe(roomId)
    expect(log.events.map((event) => event.seq)).toEqual(played.map((_, i) => i))
    expect(log.events.map((event) => event.command)).toEqual(played.map((event) => event.command))

    // And replaying what it was handed reaches the referee's own world, which
    // is the whole claim: rejoin is replay. The store numbers the same log the
    // same way.
    const rebuilt = replay({ header: log.header, events: log.events })
    expect(rebuilt.digest.total).toBe(lobby.room(roomId)!.digest()!.total)
    await lobby.idle()
    expect(await store.events(roomId)).toEqual(log.events)
  })

  test('taking back a seat nobody holds is refused in words', async () => {
    const { lobby } = await harness()

    const anonymous = await connect(lobby, null, { kind: 'resume' })
    const signedIn = await connect(lobby, ADA, { kind: 'resume' })

    expect(anonymous.of('abort')[0]?.reason).toBe('You have no match in progress.')
    expect(signedIn.of('abort')[0]?.reason).toBe('You have no match in progress.')
  })
})
