import { describe, expect, test } from 'bun:test'
import { Faction, SQUAD_SIZE } from '../src/config'
import { AmmoId, GrenadeId, ShotMode, WeaponId } from '../src/core/Arsenal'
import { AttachmentId } from '../src/core/Attachments'
import { NO_FX } from '../src/core/Combatant'
import { Grid } from '../src/core/Grid'
import { World } from '../src/ecs/World'
import { SightedComponent } from '../src/ecs/components'
import { fireWeapon, throwGrenade } from '../src/game/Combat'
import { Squads } from '../src/game/Squads'
import { settleTurn } from '../src/game/Turn'

function field(): { world: World; grid: Grid; squads: Squads } {
  const world = new World()
  const grid = new Grid(24)
  const squads = new Squads(world, grid, {
    [Faction.Blue]: Array.from({ length: SQUAD_SIZE }, (_, i) => ({ x: 4 + i, y: 4 })),
    [Faction.Red]: Array.from({ length: SQUAD_SIZE }, (_, i) => ({ x: 4 + i, y: 7 })),
  })
  for (const unit of squads.soldiers) unit.equip(WeaponId.Rifle, AmmoId.Standard)
  return { world, grid, squads }
}

describe('What a unit gives away', () => {
  test('nobody starts read', () => {
    // The opening position: two squads that have not met. A sheet legible from
    // turn one is the thing this exists to stop.
    for (const unit of field().squads.soldiers) expect(unit.known).toBe(false)
  })

  test('shooting at someone reads them, hit or miss', () => {
    const { grid, squads } = field()
    const shooter = squads.byFaction[Faction.Blue][0]!
    const target = squads.byFaction[Faction.Red][0]!

    fireWeapon(grid, shooter, target, NO_FX, squads.soldiers, ShotMode.Snap, [false])

    // A miss still tells you how hard they were to hit.
    expect(target.known).toBe(true)
  })

  test('firing reads the shooter too', () => {
    // The other direction, and the one that matters defensively: pull a trigger
    // and you have shown the other side what you are.
    const { grid, squads } = field()
    const shooter = squads.byFaction[Faction.Blue][0]!
    const target = squads.byFaction[Faction.Red][0]!

    fireWeapon(grid, shooter, target, NO_FX, squads.soldiers, ShotMode.Snap, [true])

    expect(shooter.known).toBe(true)
  })

  test('a suppressed weapon does not give its holder away', () => {
    const { grid, squads } = field()
    const quiet = squads.byFaction[Faction.Blue][1]!
    const target = squads.byFaction[Faction.Red][1]!
    quiet.fitAttachment(AttachmentId.Suppressor)

    fireWeapon(grid, quiet, target, NO_FX, squads.soldiers, ShotMode.Snap, [true])

    expect(quiet.known).toBe(false)
    // The unit on the receiving end is read regardless: being shot at is being
    // measured, however quietly it was done.
    expect(target.known).toBe(true)
  })

  test('a grenade reads its thrower and everyone it catches', () => {
    const { grid, squads } = field()
    const thrower = squads.byFaction[Faction.Blue][0]!
    const caught = squads.byFaction[Faction.Red][0]!
    thrower.grenades[GrenadeId.Frag] = 1

    const result = throwGrenade(grid, thrower, caught.tile, GrenadeId.Frag, squads.soldiers)

    expect(result.thrown).toBe(true)
    // There is no quiet way to throw one, whatever is on the rifle.
    expect(thrower.known).toBe(true)
    expect(caught.known).toBe(true)
  })

  test('being read does not wear off at the handover', () => {
    // Unlike the muzzle flash, which is about position and expires: once you
    // know what a unit is, you know it for the match.
    const { grid, squads } = field()
    const shooter = squads.byFaction[Faction.Blue][0]!
    const target = squads.byFaction[Faction.Red][0]!
    fireWeapon(grid, shooter, target, NO_FX, squads.soldiers, ShotMode.Snap, [true])

    settleTurn(squads.soldiers, Faction.Red)
    settleTurn(squads.soldiers, Faction.Blue)

    expect(shooter.firedThisTurn).toBe(false)
    expect(shooter.known).toBe(true)
    expect(target.known).toBe(true)
  })

  test('bystanders stay unread', () => {
    // Only what was involved is revealed. A firefight on the left does not
    // explain the two units standing on the right.
    const { grid, squads } = field()
    const shooter = squads.byFaction[Faction.Blue][0]!
    const target = squads.byFaction[Faction.Red][0]!
    fireWeapon(grid, shooter, target, NO_FX, squads.soldiers, ShotMode.Snap, [true])

    expect(squads.byFaction[Faction.Red][2]!.known).toBe(false)
    expect(squads.byFaction[Faction.Blue][2]!.known).toBe(false)
  })

  test('it is knowledge, not state: each side keeps its own copy', () => {
    // Local, like fog. A peer is not told what this side has worked out, and
    // does not need to be.
    const { world, squads } = field()
    const unit = squads.soldiers[0]!
    const sighted = world.getComponent(unit.entityId, SightedComponent)!

    sighted.known = true
    expect(unit.known).toBe(true)
  })
})
