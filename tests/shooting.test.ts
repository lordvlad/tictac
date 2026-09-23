import { describe, expect, test } from 'bun:test'
import { Scene, Vector3 } from 'three'
import { Grid } from '../src/core/Grid'
import { matchDice } from '../src/core/rng'
import { AMMO, AmmoId, WEAPONS, WeaponId } from '../src/core/Arsenal'
import { meleeChance } from '../src/core/Ballistics'
import { MeleeId } from '../src/core/Melee'
import { Faction } from '../src/config'
import { shotApCost, type ShotResult } from '../src/game/Combat'
import { ShootPlanner } from '../src/game/ShootPlanner'
import type { Squads } from '../src/game/Squads'
import type { CombatSystem } from '../src/ecs/systems/CombatSystem'
import type { EngineContext } from '../src/engine'
import type { Soldier } from '../src/entities/Soldier'
import type { Tile } from '../src/core/Grid'
import { installCanvasStub } from './support/dom'
import { headlessSoldier } from './support/soldier'

// Render code is under test here (canvas-backed textures), so the stub is
// this suite's own business - it must not rely on another file installing it.
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
    // Fog of war used to be read off the mesh, where a stub had none and so
    // counted as visible. It is state now, and shoot mode only offers targets
    // the active side can see.
    seen: true,
    statuses: [],
    weapon: WEAPONS[WeaponId.Rifle],
    ammo: AMMO[AmmoId.Standard],
    position: new Vector3(tile.x, 0, tile.y),
    // Shoot mode asks whether a blow is in reach before it lets go of a
    // target, so the slot has to be there even on a unit that never swings.
    sidearm: MeleeId.Fists,
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
    // Seeded: a planner that rolls its own hit dice must roll the same ones
    // every run, or a preview test measures the weather.
    matchDice(1),
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
  rolls: [true],
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
  rolls: [true],
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

describe('A blow is offered beside the shots, in reach only', () => {
  /** A real soldier on the planner's floor, visible to the other side. */
  function fighter(faction: Faction, tile: Tile, sidearm: MeleeId = MeleeId.Fists): Soldier {
    const soldier = headlessSoldier({ faction, tile, sidearm })
    soldier.seen = true
    return soldier
  }

  test('an adjacent enemy can be struck; one two tiles away cannot', () => {
    const attacker = fighter(Faction.Blue, { x: 4, y: 4 }, MeleeId.Knife)
    const beside = fighter(Faction.Red, { x: 5, y: 5 })
    const across = fighter(Faction.Red, { x: 6, y: 4 })
    const shoot = harness([attacker, beside, across])
    shoot.enter(attacker)

    shoot.selectTarget(beside)
    const strike = shoot.pending(attacker)?.strike
    expect(strike?.sidearm).toBe(MeleeId.Knife)
    expect(strike?.name).toBe('Knife')
    // The number on the row is the number the resolver rolls against.
    expect(strike?.breakdown.chance).toBe(meleeChance(attacker, beside).chance)

    shoot.selectTarget(across)
    const pending = shoot.pending(attacker)
    // Still a target for the rifle, so the panel is up — with no blow on it.
    expect(pending?.options.length).toBeGreaterThan(0)
    expect(pending?.strike).toBeNull()

    shoot.dispose()
  })

  test('points for a blow but not a round still open the aim, only with someone in reach', () => {
    const attacker = fighter(Faction.Blue, { x: 4, y: 4 })
    const enemy = fighter(Faction.Red, { x: 7, y: 4 })
    const shoot = harness([attacker, enemy])
    attacker.ap = 3
    expect(shotApCost(attacker)).toBeGreaterThan(attacker.ap)

    expect(shoot.canEnter(attacker)).toBe(false)
    expect(shoot.enter(attacker)).toBe(false)

    enemy.tile = { x: 5, y: 4 }
    expect(shoot.enter(attacker)).toBe(true)
    expect(shoot.selectedTarget).toBe(enemy)
    expect(shoot.pending(attacker)?.strike?.sidearm).toBe(MeleeId.Fists)

    shoot.dispose()
  })
})
