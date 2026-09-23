import { describe, expect, test } from 'bun:test'
import { Faction, SQUAD_SIZE } from '../src/config'
import { AmmoId, GrenadeId, ShotMode, WeaponId } from '../src/core/Arsenal'
import { AttachmentId } from '../src/core/Attachments'
import { NO_FX } from '../src/core/Combatant'
import { Grid } from '../src/core/Grid'
import { World } from '../src/ecs/World'
import { SightedComponent, TraitsComponent } from '../src/ecs/components'
import { TraitId } from '../src/core/Traits'
import { fireWeapon, throwGrenade } from '../src/game/Combat'
import { Squads } from '../src/game/Squads'
import { settleTurn } from '../src/game/Turn'
import { matchDice } from '../src/core/rng'

function field(): { world: World; grid: Grid; squads: Squads } {
  const world = new World()
  const grid = new Grid(24)
  const squads = new Squads(world, grid, {
    [Faction.Blue]: Array.from({ length: SQUAD_SIZE }, (_, i) => ({ x: 4 + i, y: 4 })),
    [Faction.Red]: Array.from({ length: SQUAD_SIZE }, (_, i) => ({ x: 4 + i, y: 7 })),
  })
  for (const unit of squads.soldiers) {
    // Born traits are not the subject here, and one of them - `Inscrutable` -
    // deflects the very reveal these tests are about. Each test adds back what
    // it means to measure.
    unit.sheet.traits.length = 0
    unit.equip(WeaponId.Rifle, AmmoId.Standard)
  }
  return { world, grid, squads }
}

/** This file's dice: seeded, so a rolled shot is the same shot every run. */
const dice = matchDice(1)

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

    fireWeapon(grid, shooter, target, NO_FX, squads.soldiers, ShotMode.Snap, dice, [false])

    // A miss still tells you how hard they were to hit.
    expect(target.known).toBe(true)
  })

  test('firing reads the shooter too', () => {
    // The other direction, and the one that matters defensively: pull a trigger
    // and you have shown the other side what you are.
    const { grid, squads } = field()
    const shooter = squads.byFaction[Faction.Blue][0]!
    const target = squads.byFaction[Faction.Red][0]!

    fireWeapon(grid, shooter, target, NO_FX, squads.soldiers, ShotMode.Snap, dice, [true])

    expect(shooter.known).toBe(true)
  })

  test('a suppressed weapon does not give its holder away', () => {
    const { grid, squads } = field()
    const quiet = squads.byFaction[Faction.Blue][1]!
    const target = squads.byFaction[Faction.Red][1]!
    quiet.fitAttachment(AttachmentId.Suppressor)

    fireWeapon(grid, quiet, target, NO_FX, squads.soldiers, ShotMode.Snap, dice, [true])

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
    fireWeapon(grid, shooter, target, NO_FX, squads.soldiers, ShotMode.Snap, dice, [true])

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
    fireWeapon(grid, shooter, target, NO_FX, squads.soldiers, ShotMode.Snap, dice, [true])

    expect(squads.byFaction[Faction.Red][2]!.known).toBe(false)
    expect(squads.byFaction[Faction.Blue][2]!.known).toBe(false)
  })

  test('a unit that gives nothing away is not read by being shot at', () => {
    const { grid, squads } = field()
    const shooter = squads.byFaction[Faction.Blue][0]!
    const target = squads.byFaction[Faction.Red][0]!
    target.sheet.traits.push(TraitId.Inscrutable)
    target.refreshTraits()

    fireWeapon(grid, shooter, target, NO_FX, squads.soldiers, ShotMode.Snap, dice, [true])

    expect(target.known).toBe(false)
    // It hides what the unit *is*, not what it does: the shooter still gave
    // itself away, and the target is still perfectly visible.
    expect(shooter.known).toBe(true)
    expect(target.seen).toBe(true)
  })

  test('giving nothing away does not stop the unit revealing itself', () => {
    // The division of labour: `unreadable` answers being shot at, `silenced`
    // answers shooting. An inscrutable soldier who opens fire has still opened
    // fire.
    const { grid, squads } = field()
    const inscrutable = squads.byFaction[Faction.Blue][0]!
    const target = squads.byFaction[Faction.Red][0]!
    inscrutable.sheet.traits.push(TraitId.Inscrutable)
    inscrutable.refreshTraits()

    fireWeapon(grid, inscrutable, target, NO_FX, squads.soldiers, ShotMode.Snap, dice, [true])

    expect(inscrutable.known).toBe(true)
  })

  test('a blast reads whoever it catches, unless they give nothing away', () => {
    const { grid, squads } = field()
    const thrower = squads.byFaction[Faction.Blue][0]!
    const readable = squads.byFaction[Faction.Red][0]!
    const inscrutable = squads.byFaction[Faction.Red][1]!
    inscrutable.tile = { ...readable.tile }
    inscrutable.sheet.traits.push(TraitId.Inscrutable)
    inscrutable.refreshTraits()
    thrower.grenades[GrenadeId.Frag] = 1

    throwGrenade(grid, thrower, readable.tile, GrenadeId.Frag, squads.soldiers)

    expect(readable.known).toBe(true)
    expect(inscrutable.known).toBe(false)
  })

  test('deflecting the reveal is replicated, because the shooter reads the target', () => {
    // Same hole as evasion and plate: the side pulling the trigger decides what
    // it learned, and it is looking at a unit whose kit it only has a stock
    // copy of. Left local, an inscrutable opponent would be read anyway.
    const { world, grid, squads } = field()
    const shooter = squads.byFaction[Faction.Blue][0]!
    const target = squads.byFaction[Faction.Red][0]!
    const traits = world.getComponent(target.entityId, TraitsComponent)!

    // Standing in for a peer's update: the flag arrives, nothing local is
    // refolded, and the reveal still has to be deflected.
    traits.unreadable = true

    fireWeapon(grid, shooter, target, NO_FX, squads.soldiers, ShotMode.Snap, dice, [true])

    expect(target.known).toBe(false)
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
