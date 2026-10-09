import { describe, expect, test } from 'bun:test'
import { ENCOUNTER, Faction } from '../src/config'
import { rollSquadSheets } from '../src/core/Characters'
import { Rng } from '../src/core/rng'
import { defaultLoadout } from '../src/game/Loadout'
import { RECORDING_VERSION, type Deployment, type RecordingHeader } from '../src/game/Recording'
import { AiPlayer } from '../src/sim/AiPlayer'
import { MatchHost } from '../src/sim/MatchHost'

/**
 * Two AIs, each with a world of its own, each told what the other did and
 * nothing else: the fight an encounter nobody is present for is. They are
 * wired straight to each other, so what is under test is the play and not the
 * room — that the two worlds agree at every handover, and that a fight does
 * not go on for ever.
 */

function squad(seed: number): Deployment[] {
  const sheets = rollSquadSheets(new Rng(seed))
  const kit = defaultLoadout(sheets.length)
  return sheets.map((sheet, i) => ({ sheet, loadout: kit[i]! }))
}

async function duel(seed: number, turnLimit: number | undefined, untilTurn: number) {
  const header: RecordingHeader = {
    version: RECORDING_VERSION,
    seed,
    seedLabel: String(seed),
    source: 'live',
    createdAt: new Date(0).toISOString(),
    turnCap: null,
    squads: { [Faction.Blue]: squad(seed), [Faction.Red]: squad(seed + 1000) },
  }
  const hosts = { [Faction.Blue]: new MatchHost(header), [Faction.Red]: new MatchHost(header) }
  const problems: string[] = []
  const players = {} as Record<Faction, AiPlayer>
  for (const faction of [Faction.Blue, Faction.Red]) {
    const opposite = faction === Faction.Blue ? Faction.Red : Faction.Blue
    players[faction] = new AiPlayer(hosts[faction], {
      faction,
      turnLimit,
      send: (message) => players[opposite].hear(message),
      diverged: (what) => problems.push(what),
      failed: (problem) => problems.push(problem),
    })
  }
  players[Faction.Blue].consider()

  const decided = () => hosts[Faction.Blue].living[Faction.Blue] === 0 || hosts[Faction.Blue].living[Faction.Red] === 0
  // The fight is the microtask queue's, and this loop is one more continuation in it:
  // each pass lets the fight take a step, and it can stop a fight that never ends,
  // which waiting for the queue to drain (`setImmediate`) could not.
  for (let steps = 0; steps < 100_000 && !decided() && hosts[Faction.Blue].turnNumber <= untilTurn; steps++) {
    await Promise.resolve()
  }
  // A fight that is not over would go on in the queue for ever, and the event
  // loop with it.
  for (const player of Object.values(players)) player.stop()
  return { turns: hosts[Faction.Blue].turnNumber, decided: decided(), problems }
}

describe('two AIs', () => {
  test('play a fight to its end and agree about every handover on the way', async () => {
    for (const seed of [1, 2, 3]) {
      const fight = await duel(seed, ENCOUNTER.turnLimit, 200)
      expect(fight).toMatchObject({ decided: true, problems: [] })
    }
  }, 60_000)

  test('do not wait out a stalemate for ever: these fights never end of themselves, and end at the turn limit', async () => {
    // Seeds found by running a few hundred fights: in about one in a hundred
    // neither squad will come out to the other, however long it is left.
    for (const seed of [67, 203]) {
      const left = await duel(seed, undefined, 60)
      expect(left).toMatchObject({ decided: false, problems: [] })

      const limited = await duel(seed, ENCOUNTER.turnLimit, 200)
      expect(limited).toMatchObject({ decided: true, problems: [] })
      expect(limited.turns).toBeGreaterThan(ENCOUNTER.turnLimit)
    }
  }, 120_000)
})
