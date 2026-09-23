import { describe, expect, test } from 'bun:test'
import { WeaponId } from '../src/core/Arsenal'
import { isCommand } from '../src/ecs/systems/CommandSystem'
import { MatchHost } from '../src/sim/MatchHost'
import { SimMatch } from '../src/sim/SimMatch'
import { replay } from '../src/sim/Replay'

const STOCK = { weapons: [WeaponId.Rifle, WeaponId.Gatling, WeaponId.Sniper, WeaponId.Shotgun] }

/** A match the sweep played and wrote down. */
function recorded(seed: number) {
  const match = new SimMatch({ seed, blue: STOCK, red: STOCK, record: true })
  match.run()
  return match.recording!
}

/**
 * Frame times as a browser produces them: uneven, and never the host's fixed
 * step. Deterministic, so a failure is the same failure every run.
 */
const FRAMES = [1 / 60, 1 / 144, 1 / 30, 1 / 75, 1 / 20, 1 / 60, 1 / 240]

describe('A peer’s commands, as the network delivers them', () => {
  test('arriving all at once and walked at frame rate, they reach the world the replay reaches', () => {
    // The played game's path for the other player's moves: every frame of the
    // match lands in the queue before this side has animated any of it, and
    // the world is ticked with whatever the frame took. The only thing that
    // keeps a shot from being resolved while its shooter is still walking
    // here is the queue holding it until the walk is over.
    for (const seed of [4242, 7, 1003]) {
      const recording = recorded(seed)
      const settled = replay(recording)

      const live = new MatchHost(recording.header)
      const refused: string[] = []
      live.commands.onRefused = (command, refusal) => refused.push(`${command.type}: ${refusal.reason}`)

      const settledAt: { digest: number | null } = { digest: null }
      for (const event of recording.events) {
        if (isCommand(event.command)) live.commands.enqueue(event.command, 'peer')
      }
      // Queued behind everything: runs only once the last command has been
      // applied and walked, the moment a peer's digest is compared.
      live.commands.whenSettled(() => {
        settledAt.digest = live.digest().total
      })

      for (let frame = 0; frame < 200_000 && (live.commands.pending || live.commands.busy); frame++) {
        live.world.update(FRAMES[frame % FRAMES.length]!)
      }

      expect({ seed, refused }).toEqual({ seed, refused: [] })
      expect(live.commands.pending).toBe(false)
      expect({ seed, digest: settledAt.digest }).toEqual({ seed, digest: settled.digest.total })
    }
  })
})
