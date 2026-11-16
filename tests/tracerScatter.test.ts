import { afterEach, describe, expect, test } from 'bun:test'
import { Vector3 } from 'three'
import { Faction } from '../src/config'
import { ShotMode } from '../src/core/Arsenal'
import { NO_FX, type CombatFx } from '../src/core/Combatant'
import { Grid } from '../src/core/Grid'
import { Rng } from '../src/core/rng'
import { executeShot } from '../src/game/Combat'
import { drawnImpact } from '../src/render/Tracers'
import { headlessSoldier } from './support/soldier'

/**
 * A tracer's scatter is the picture of a miss, not part of it.
 *
 * `Tracers` draws a missed round beside the point the rules resolved, from
 * `Math.random`. That is only allowed because nothing the rules read ever
 * sees it; this pins that, by firing the same seeded fight with the
 * presentation's randomness stubbed to opposite extremes and requiring the
 * same fight to come out.
 */

const realRandom = Math.random
afterEach(() => {
  Math.random = realRandom
})

interface Fought {
  /** Everything the rules decided: each shot's result and what it left on the target. */
  outcome: string
  /** The resolved points as the fx was handed them, after the picture drew from them. */
  resolved: number[][]
  drawn: Vector3[]
  /** Whether each announced round landed. */
  hits: boolean[]
}

function fight(random: () => number): Fought {
  Math.random = random
  const dice = new Rng(2026)
  const grid = new Grid(16)
  const resolved: number[][] = []
  const drawn: Vector3[] = []
  const hits: boolean[] = []
  const fx: CombatFx = {
    ...NO_FX,
    tracer: (_from, to, hit) => {
      // What the scene does with the announcement, on the point it was handed.
      drawn.push(drawnImpact(to, hit, Math.random))
      resolved.push([to.x, to.y, to.z])
      hits.push(hit)
    },
  }
  const outcomes: unknown[] = []
  for (let i = 0; i < 40; i++) {
    const shooter = headlessSoldier({ tile: { x: 4, y: 4 } })
    const target = headlessSoldier({ faction: Faction.Red, tile: { x: 4, y: 9 } })
    const result = executeShot(grid, shooter, target, fx, [shooter, target], ShotMode.Snap, () => dice.next())
    outcomes.push({ result, hp: target.hp, armor: target.armor, ap: shooter.ap })
  }
  return { outcome: JSON.stringify(outcomes), resolved, drawn, hits }
}

describe('A tracer draws a miss from presentation randomness only', () => {
  test('the fight is the same whatever Math.random says', () => {
    const low = fight(() => 0)
    const high = fight(() => 0.999999)
    const real = fight(realRandom)

    expect(low.hits.some((hit) => !hit)).toBe(true)
    expect(low.hits.some((hit) => hit)).toBe(true)
    expect(high.outcome).toBe(low.outcome)
    expect(real.outcome).toBe(low.outcome)
    expect(high.resolved).toEqual(low.resolved)
  })

  test('the scatter moves the drawn point, never the resolved one', () => {
    const low = fight(() => 0)
    const high = fight(() => 0.999999)

    low.drawn.forEach((point, i) => {
      const [x, , z] = low.resolved[i]!
      if (low.hits[i]) {
        expect([point.x, point.z]).toEqual([x!, z!])
      } else {
        // The extremes of the scatter, either side of where the rules put the round.
        expect(point.x).toBeCloseTo(x! - 0.75)
        expect(high.drawn[i]!.x).toBeCloseTo(x! + 0.75, 3)
      }
    })
  })

  test('a drawn impact is a new point: the one it was drawn from is left alone', () => {
    const resolved = new Vector3(3, 1, 5)
    const drawn = drawnImpact(resolved, false, () => 1)

    expect(resolved.toArray()).toEqual([3, 1, 5])
    expect(drawn).not.toBe(resolved)
    expect(drawn.y).toBe(1)
    expect(drawnImpact(resolved, true, () => 1).toArray()).toEqual([3, 1, 5])
  })
})
