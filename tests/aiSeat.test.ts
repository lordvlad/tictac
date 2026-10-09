import { describe, expect, test } from 'bun:test'
import { Faction } from '../src/config'
import { rollSquadSheets } from '../src/core/Characters'
import { Rng } from '../src/core/rng'
import { isCommand } from '../src/ecs/systems/CommandSystem'
import { frameOf, messageOf, type JsonRpcNotification } from '../src/game/JsonRpc'
import { defaultLoadout } from '../src/game/Loadout'
import { winnerOf } from '../src/game/MatchEnd'
import type { NetworkMessage } from '../src/game/NetworkManager'
import { compareDigests } from '../src/game/StateDigest'
import { RECORDING_VERSION, type Deployment, type RecordedEvent, type RecordingHeader } from '../src/game/Recording'
import { loopback } from '../src/game/Transport'
import { AiSeat } from '../src/server/AiSeat'
import { MatchHost } from '../src/sim/MatchHost'

/**
 * The AI in a seat of a room (`ITEM-048`), against a room that is only a
 * referee: one world that applies everything the seat sends, relays what the
 * other side says, and compares every fingerprint the seat states with its own.
 * What is under test is the seat — it learns a match from the log, plays its
 * side when it is that side's turn, and its intents and fingerprints are the
 * ones an independent application of them gives.
 */

function squad(seed: number): Deployment[] {
  const sheets = rollSquadSheets(new Rng(seed))
  const kit = defaultLoadout(sheets.length)
  return sheets.map((sheet, i) => ({ sheet, loadout: kit[i]! }))
}

function headerFor(seed: number): RecordingHeader {
  return {
    version: RECORDING_VERSION,
    seed,
    seedLabel: String(seed),
    source: 'live',
    createdAt: new Date(0).toISOString(),
    turnCap: null,
    squads: { [Faction.Blue]: squad(seed), [Faction.Red]: squad(seed + 1000) },
  }
}

/** Every continuation queued so far, chains included: the whole of a turn the AI plays. */
function settled(): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>()
  setImmediate(resolve)
  return promise
}

function room(faction: Faction, seed: number, options: { turnLimit?: number } = {}) {
  const header = headerFor(seed)
  const [roomEnd, seatEnd] = loopback()
  const lines: string[] = []
  const stuck: string[] = []
  const seat = new AiSeat(faction, seatEnd, { log: (line) => lines.push(line), stuck: (problem) => stuck.push(problem), ...options })
  /** The referee's own world: only ever told what the seat sent or what the other side did. */
  const referee = new MatchHost(header)
  const sent: NetworkMessage[] = []
  const disagreements: string[] = []
  roomEnd.onFrame((frame) => {
    const message = messageOf((frame as JsonRpcNotification).method, (frame as JsonRpcNotification).params)
    if (!message) return
    sent.push(message)
    if (message.type === 'digest') {
      for (const found of compareDigests(referee.digest(), message.digest, (id) => `#${id}`)) {
        disagreements.push(JSON.stringify(found))
      }
    } else if (isCommand(message)) {
      const applied = referee.apply(message)
      if (!applied.applied) disagreements.push(`${message.type} refused: ${applied.reason}`)
    }
  })
  return {
    seat,
    referee,
    sent,
    disagreements,
    lines,
    stuck,
    /** The room stating the match so far to a seat that has just sat down. */
    log(events: RecordedEvent[] = []): void {
      roomEnd.send(frameOf({ type: 'log', matchId: 'room', header, events }))
    },
    /** The other side's move, relayed. */
    relay(message: NetworkMessage): void {
      referee.apply(message)
      roomEnd.send(frameOf(message))
    },
    abort(): void {
      roomEnd.send(frameOf({ type: 'abort', reason: 'over', side: null }))
    },
  }
}

const other = (faction: Faction): Faction => (faction === Faction.Blue ? Faction.Red : Faction.Blue)

describe('the AI in a seat of a room', () => {
  test('plays whichever side it is seated at, whenever its turn comes, and agrees with the referee at every handover', async () => {
    for (const faction of [Faction.Blue, Faction.Red]) {
      const { referee, relay, log, sent, disagreements, lines } = room(faction, 20260401 + faction)
      log()
      await settled()
      for (let round = 0; round < 60 && winnerOf(referee.squads) === null; round++) {
        if (referee.activeFaction !== faction) relay({ type: 'endTurn', faction: other(faction) })
        await settled()
      }
      // The opposition only ever handed over, so it was beaten — by the AI.
      expect(winnerOf(referee.squads)).toBe(faction)
      expect(disagreements).toEqual([])
      expect(lines).toEqual([])
      const acted = sent.filter((message) => isCommand(message) && 'faction' in message && message.faction === faction)
      expect(acted.length).toBeGreaterThan(0)
      // Every turn it handed over ended with the fingerprint of its world.
      expect(sent.filter((message) => message.type === 'digest').length).toBeGreaterThan(0)
      // And it never moved for the side that was not its own.
      expect(sent.filter((message) => isCommand(message) && 'faction' in message && message.faction === other(faction))).toEqual([])
    }
  }, 60_000)

  test('sits down in the middle of a match, from the log, and plays on at once if it is its turn', async () => {
    const { referee, relay, log, sent, disagreements } = room(Faction.Red, 77)
    // Blue has already moved and handed over: what a restarted server or a
    // player who has left hands the AI.
    const handover: NetworkMessage = { type: 'endTurn', faction: Faction.Blue }
    relay(handover)
    sent.length = 0
    log([{ seq: 0, turn: 1, faction: Faction.Blue, command: handover }])
    expect(referee.activeFaction).toBe(Faction.Red)
    await settled()

    expect(referee.activeFaction).toBe(Faction.Blue)
    expect(sent.at(-1)).toMatchObject({ type: 'endTurn', faction: Faction.Red })
    expect(disagreements).toEqual([])
  })

  test('does nothing before it is told the match, and nothing out of turn', async () => {
    const { relay, sent, log } = room(Faction.Red, 5)
    relay({ type: 'endTurn', faction: Faction.Blue })
    await settled()
    expect(sent).toEqual([])

    log([{ seq: 0, turn: 1, faction: Faction.Blue, command: { type: 'endTurn', faction: Faction.Blue } }])
    await settled()
    const played = sent.length
    expect(played).toBeGreaterThan(0)
    await settled()
    expect(sent).toHaveLength(played)
  })

  test('stops for good when the room ends, and says nothing more', async () => {
    const { relay, log, abort, sent, referee } = room(Faction.Red, 9)
    log()
    await settled()
    relay({ type: 'endTurn', faction: Faction.Blue })
    abort()
    await settled()
    // The abort came in the same turn as the handover it would have answered.
    expect(sent).toEqual([])
    expect(referee.activeFaction).toBe(Faction.Red)
  })

  test('says so when it cannot learn the match, so the room can call the fight off, and plays nothing', async () => {
    const { log, sent, stuck, lines } = room(Faction.Red, 41)
    // A log whose first intent is one nobody could have made: a soldier who is not in the squad.
    const nobody: NetworkMessage = { type: 'endUnitTurn', faction: Faction.Blue, squadIndex: 99 }
    log([{ seq: 0, turn: 1, faction: Faction.Blue, command: nobody }])
    await settled()

    expect(stuck).toHaveLength(1)
    expect(lines).toHaveLength(1)
    expect(sent).toEqual([])
  })

  test('a fight it is hopelessly past the limit of is given up, and the room told so', async () => {
    // A limit of zero is a fight already at twice its turn limit as it begins:
    // what a side that cannot get out of a stalemate comes to.
    const { log, sent, stuck } = room(Faction.Blue, 31, { turnLimit: 0 })
    log()
    await settled()
    expect(stuck).toHaveLength(1)
    expect(sent).toEqual([])
  })

  test('past its turn limit it gets out of a stalemate: the side retreats, and the match ends', async () => {
    const { referee, relay, log, sent, disagreements } = room(Faction.Blue, 31, { turnLimit: 1 })
    log()
    await settled()
    for (let round = 0; round < 40 && winnerOf(referee.squads) === null; round++) {
      if (referee.activeFaction === Faction.Red) relay({ type: 'endTurn', faction: Faction.Red })
      await settled()
    }
    expect(sent.some((message) => message.type === 'retreat')).toBe(true)
    expect(winnerOf(referee.squads)).toBe(Faction.Red)
    expect(disagreements).toEqual([])
  }, 60_000)
})
