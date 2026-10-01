import { describe, expect, test } from 'bun:test'
import { Faction } from '../src/config'
import { rollSquadSheets } from '../src/core/Characters'
import { Rng } from '../src/core/rng'
import { isCommand } from '../src/ecs/systems/CommandSystem'
import { AiOpponent } from '../src/game/AiOpponent'
import { defaultLoadout } from '../src/game/Loadout'
import { NetworkManager, type NetworkMessage } from '../src/game/NetworkManager'
import { compareDigests } from '../src/game/StateDigest'
import { RECORDING_VERSION, type Deployment, type RecordingHeader } from '../src/game/Recording'
import { MatchHost } from '../src/sim/MatchHost'

/**
 * The player's end of a match against the AI, minus the scene: a hosting
 * `NetworkManager` and a {@link MatchHost} that resolves every intent it is
 * sent — which is all the played game's controller does with them.
 */
async function sitDown(seed: number) {
  const network = new NetworkManager()
  AiOpponent.join(network)
  network.hostMatch(seed, String(seed))

  const sheets = rollSquadSheets(new Rng(seed))
  const loadout = defaultLoadout(sheets.length)
  const squad: Deployment[] = sheets.map((sheet, i) => ({ sheet, loadout: loadout[i]! }))
  network.send({ type: 'ready', squad })
  const peer = await network.waitForPeerReady()

  const header: RecordingHeader = {
    version: RECORDING_VERSION,
    seed,
    seedLabel: String(seed),
    source: 'live',
    createdAt: new Date(0).toISOString(),
    turnCap: null,
    squads: { [Faction.Blue]: squad, [Faction.Red]: peer!.squad },
  }
  const host = new MatchHost(header)
  const received: NetworkMessage[] = []
  const disagreements: string[] = []
  /** Resolved each time the AI hands the turn back. */
  let handedBack = Promise.withResolvers<void>()
  network.onMessage = (message) => {
    received.push(message)
    if (message.type === 'digest') {
      for (const found of compareDigests(host.digest(), message.digest, (id) => `#${id}`)) {
        disagreements.push(JSON.stringify(found))
      }
    } else if (isCommand(message)) {
      const applied = host.apply(message)
      if (!applied.applied) disagreements.push(`${message.type} refused: ${applied.reason}`)
      if (message.type === 'endTurn') handedBack.resolve()
    }
  }
  network.send({ type: 'matchHeader', header })
  return {
    network,
    host,
    received,
    disagreements,
    /** Wait for the AI's next handover. */
    async turnBack(): Promise<void> {
      await handedBack.promise
      handedBack = Promise.withResolvers<void>()
    },
  }
}

describe('the AI as an opponent', () => {
  test('answers a handover with a whole turn of its own, and agrees about the result', async () => {
    const { network, host, received, disagreements, turnBack } = await sitDown(20260401)
    expect(host.activeFaction).toBe(Faction.Blue)

    for (let round = 1; round <= 3; round++) {
      const turn = host.turnNumber
      network.send({ type: 'digest', digest: host.digest() })
      network.send({ type: 'endTurn', faction: Faction.Blue })
      host.apply({ type: 'endTurn', faction: Faction.Blue })
      expect(host.activeFaction).toBe(Faction.Red)

      await turnBack()
      expect(host.activeFaction).toBe(Faction.Blue)
      expect(host.turnNumber).toBeGreaterThan(turn)
    }

    const acted = received.filter((m) => isCommand(m) && 'faction' in m && m.faction === Faction.Red)
    expect(acted.length).toBeGreaterThan(0)
    // Every intent it sent was one the player's rules accepted, and its
    // fingerprint at each handover was the player's.
    expect(disagreements).toEqual([])
    expect(received.filter((m) => m.type === 'digest').length).toBe(3)
    network.dispose()
  })
})
