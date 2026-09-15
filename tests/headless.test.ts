import { describe, expect, test } from 'bun:test'
import { Faction, SQUAD_SIZE } from '../src/config'
import { AmmoId, ShotMode, WeaponId } from '../src/core/Arsenal'
import { NO_FX } from '../src/core/Combatant'
import { rollSquadSheets } from '../src/core/Characters'
import { Grid } from '../src/core/Grid'
import { Rng } from '../src/core/rng'
import { World } from '../src/ecs/World'
import { HealthComponent, StanceComponent } from '../src/ecs/components'
import { fireWeapon } from '../src/game/Combat'
import { Squads } from '../src/game/Squads'

/**
 * No canvas stub in this file, on purpose.
 *
 * Everything here used to be impossible: a soldier was a `three` scene node, so
 * building a squad meant having a scene, a glTF and a renderer. If any of these
 * tests starts needing `installCanvasStub` again, graphics have leaked back
 * into the rules and that is the regression to look for.
 */
function flatWorld(): { world: World; grid: Grid; squads: Squads } {
  const world = new World()
  const grid = new Grid(16)
  const spawns = {
    [Faction.Blue]: Array.from({ length: SQUAD_SIZE }, (_, i) => ({ x: 2 + i, y: 2 })),
    [Faction.Red]: Array.from({ length: SQUAD_SIZE }, (_, i) => ({ x: 2 + i, y: 6 })),
  }
  const sheets = {
    [Faction.Blue]: rollSquadSheets(new Rng(1)),
    [Faction.Red]: rollSquadSheets(new Rng(2)),
  }
  return { world, grid, squads: new Squads(world, grid, spawns, undefined, Faction.Blue, sheets) }
}

describe('A squad with no scene to stand in', () => {
  test('deploys both sides, with components, and no body', () => {
    const { squads } = flatWorld()

    expect(squads.soldiers).toHaveLength(SQUAD_SIZE * 2)
    for (const unit of squads.soldiers) {
      expect(unit.entityId).toBeGreaterThan(0)
      expect(unit.hp).toBe(unit.maxHp)
      expect(unit.ap).toBe(unit.maxAp)
      // The giveaway that it is data: no mesh, no mixer, nothing to draw.
      expect('instance' in unit).toBe(false)
      expect('animationMixer' in unit).toBe(false)
    }
  })

  test('its state lives in components, where replication can see it', () => {
    const { world, squads } = flatWorld()
    const unit = squads.soldiers[0]!

    expect(world.getComponent(unit.entityId, HealthComponent)?.hp).toBe(unit.hp)

    unit.hp -= 10
    expect(world.getComponent(unit.entityId, HealthComponent)?.hp).toBe(unit.maxHp - 10)

    unit.enterCover()
    expect(world.getComponent(unit.entityId, StanceComponent)?.isCrouching).toBe(true)
  })

  test('a shot resolves with nobody to draw it', () => {
    const { grid, squads } = flatWorld()
    const shooter = squads.byFaction[Faction.Blue][0]!
    const target = squads.byFaction[Faction.Red][0]!
    shooter.equip(WeaponId.Rifle, AmmoId.Standard)

    const before = target.hp
    // Every round lands, so the assertion is about the plumbing rather than
    // about the dice.
    const result = fireWeapon(
      grid,
      shooter,
      target,
      NO_FX,
      squads.soldiers,
      ShotMode.Aimed,
      [true, true, true],
    )

    expect(result).not.toBeNull()
    expect(result!.hit).toBe(true)
    expect(target.hp).toBeLessThan(before)
  })

  test('fog of war is state, so a target can be unseen without a renderer', () => {
    const { squads } = flatWorld()
    const unit = squads.byFaction[Faction.Red][0]!

    expect(unit.seen).toBe(true)
    unit.seen = false
    expect(unit.seen).toBe(false)
  })

  test('dying stops a unit where it stands', () => {
    const { world, squads } = flatWorld()
    const unit = squads.soldiers[0]!

    unit.hp = 0
    unit.halt()

    expect(unit.isDead).toBe(true)
    expect(world.getComponent(unit.entityId, StanceComponent)?.isMoving).toBe(false)
  })
})
