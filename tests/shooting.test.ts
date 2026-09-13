import { describe, expect, test } from 'bun:test'
import { Scene, Vector3 } from 'three'
import { Grid } from '../src/core/Grid'
import { AMMO, AmmoId, WEAPONS, WeaponId } from '../src/core/Arsenal'
import { Faction } from '../src/config'
import type { ShotResult } from '../src/game/Combat'
import { ShootPlanner } from '../src/game/ShootPlanner'
import type { Squads } from '../src/game/Squads'
import type { CombatSystem } from '../src/ecs/systems/CombatSystem'
import type { EngineContext } from '../src/engine'
import type { Soldier } from '../src/entities/Soldier'
import type { Tile } from '../src/core/Grid'
import { installCanvasStub } from './support/dom'

installCanvasStub()

/**
 * Just enough of a soldier for shoot mode: where it stands, what it can spend,
 * and what it shoots with. A real `Soldier` needs a loaded glTF and an engine.
 */
function unit(faction: Faction, tile: Tile, ap = 12) {
  const soldier = {
    faction,
    tile,
    ap,
    hp: 100,
    maxHp: 100,
    armor: 0,
    isDead: false,
    isCrouching: false,
    statuses: [],
    weapon: WEAPONS[WeaponId.Rifle],
    ammo: AMMO[AmmoId.Standard],
    position: new Vector3(tile.x, 0, tile.y),
  }
  // Structurally the surface shoot mode uses; the rest of Soldier is graphics.
  return soldier as unknown as Soldier & typeof soldier
}

function harness(soldiers: Soldier[]): ShootPlanner {
  return new ShootPlanner(
    new Grid(12),
    { soldiers } as unknown as Squads,
    {} as unknown as CombatSystem,
    { scene: new Scene() } as unknown as EngineContext,
  )
}

const KILLED: ShotResult = {
  hit: true,
  damage: 100,
  armorShred: 0,
  killed: true,
  hitChance: 80,
  apSpent: 4,
  crits: 1,
  hits: [],
}
const GRAZED: ShotResult = {
  hit: true,
  damage: 10,
  armorShred: 0,
  killed: false,
  hitChance: 80,
  apSpent: 4,
  crits: 0,
  hits: [],
}

describe('Shoot mode ends when the shot does', () => {
  test('killing the only target closes shoot mode', () => {
    const shooter = unit(Faction.Blue, { x: 1, y: 1 })
    const enemy = unit(Faction.Red, { x: 4, y: 1 })
    const shoot = harness([shooter, enemy])

    expect(shoot.enter(shooter)).toBe(true)
    expect(shoot.selectedTarget).toBe(enemy)

    // The shot lands and the combat system marks the target dead before the
    // planner is told about it, exactly as CombatSystem.fireShot does.
    enemy.isDead = true
    shooter.ap -= 4
    shoot.reportShot(shooter, enemy, KILLED)

    expect(shoot.active).toBe(false)
    expect(shoot.selectedTarget).toBeNull()

    shoot.dispose()
  })

  test('killing one of two targets re-aims instead of dropping out', () => {
    const shooter = unit(Faction.Blue, { x: 1, y: 1 })
    const near = unit(Faction.Red, { x: 3, y: 1 })
    const far = unit(Faction.Red, { x: 6, y: 1 })
    const shoot = harness([shooter, near, far])

    shoot.enter(shooter)
    shoot.selectTarget(near)
    near.isDead = true
    shooter.ap -= 4
    shoot.reportShot(shooter, near, KILLED)

    expect(shoot.active).toBe(true)
    expect(shoot.selectedTarget).toBe(far)

    shoot.dispose()
  })

  test('spending the last AP closes shoot mode even when the target lives', () => {
    const shooter = unit(Faction.Blue, { x: 1, y: 1 }, 4)
    const enemy = unit(Faction.Red, { x: 4, y: 1 })
    const shoot = harness([shooter, enemy])

    shoot.enter(shooter)
    shooter.ap = 0
    shoot.reportShot(shooter, enemy, GRAZED)

    expect(shoot.active).toBe(false)

    shoot.dispose()
  })

  test('a surviving target with AP to spare keeps the same aim', () => {
    const shooter = unit(Faction.Blue, { x: 1, y: 1 })
    const near = unit(Faction.Red, { x: 3, y: 1 })
    const far = unit(Faction.Red, { x: 6, y: 1 })
    const shoot = harness([shooter, near, far])

    shoot.enter(shooter)
    // Deliberately aim at the worse odds: settling must not re-pick for us.
    shoot.selectTarget(far)
    shooter.ap -= 4
    shoot.reportShot(shooter, far, GRAZED)

    expect(shoot.active).toBe(true)
    expect(shoot.selectedTarget).toBe(far)

    shoot.dispose()
  })

  test('a shot resolved elsewhere leaves this shoot mode alone', () => {
    const shooter = unit(Faction.Blue, { x: 1, y: 1 })
    const enemy = unit(Faction.Red, { x: 4, y: 1 })
    const other = unit(Faction.Red, { x: 7, y: 1 })
    const shoot = harness([shooter, enemy, other])

    shoot.enter(shooter)
    shoot.selectTarget(enemy)
    other.isDead = true
    shoot.reportShot(other, other, KILLED)

    expect(shoot.active).toBe(true)
    expect(shoot.selectedTarget).toBe(enemy)

    shoot.dispose()
  })
})
