import { describe, expect, test } from 'bun:test'
import { Faction, RULES, SQUAD_SIZE } from '../src/config'
import { AmmoId, ShotMode, StatusKind, WeaponId } from '../src/core/Arsenal'
import { effectiveWeapon, resolveDamage } from '../src/core/Ballistics'
import { Grid } from '../src/core/Grid'
import { ATTACHMENTS, AttachmentId } from '../src/core/Attachments'
import { ITEMS, ItemId } from '../src/core/Items'
import { TraitId, TRAITS, resolveTraits } from '../src/core/Traits'
import { World } from '../src/ecs/World'
import { TraitsComponent } from '../src/ecs/components'
import { NO_FX } from '../src/core/Combatant'
import { applyStatus, calculateHitChance, fireWeapon } from '../src/game/Combat'
import { settleTurn } from '../src/game/Turn'
import { Squads } from '../src/game/Squads'
import { Faction as F } from '../src/config'

/** Body-worn kit: it goes in a pocket and belongs to the soldier. */
const WORN = [ItemId.NullweaveVest, ItemId.PlateCarrier] as const

/** Weapon kit: it bolts to a rail and belongs to the weapon. */
const FITTED = [AttachmentId.Scope, AttachmentId.Bipod, AttachmentId.Suppressor] as const

function squad(): { world: World; grid: Grid; squads: Squads } {
  const world = new World()
  const grid = new Grid(24)
  const spawns = {
    [Faction.Blue]: Array.from({ length: SQUAD_SIZE }, (_, i) => ({ x: 2 + i, y: 2 })),
    [Faction.Red]: Array.from({ length: SQUAD_SIZE }, (_, i) => ({ x: 2 + i, y: 18 })),
  }
  return { world, grid, squads: new Squads(world, grid, spawns) }
}

/** Put a piece of kit in a unit's pocket, as the loadout stamp does. */
function give(soldier: Squads['soldiers'][number], item: ItemId): void {
  soldier.items[item] = 1
  soldier.refreshTraits()
}

/** Bolt a mod onto the weapon in a unit's hands. */
function fit(soldier: Squads['soldiers'][number], id: AttachmentId): void {
  expect(soldier.fitAttachment(id)).toBe(true)
}

describe('Worn kit', () => {
  test('every worn piece is worn, not used, and grants something', () => {
    for (const id of WORN) {
      const spec = ITEMS[id]
      expect(spec.passive).toBe(true)
      // No action of its own: it would otherwise appear in the action panel as
      // a button that does nothing.
      expect(spec.effects).toEqual([])
      expect(spec.traits?.length ?? 0).toBeGreaterThan(0)
    }
  })
  test('nothing worn or fitted is unconditionally free', () => {
    // Every piece either costs something outright or only pays while the unit
    // is doing something particular. A flat, free bonus would make the choice
    // of what to carry no choice at all.
    const traitSets = [
      ...WORN.map((id) => ITEMS[id].traits ?? []),
      ...FITTED.map((id) => ATTACHMENTS[id].traits),
    ]
    for (const traits of traitSets) {
      const resolved = resolveTraits(traits)
      const helps =
        resolved.accuracy > 0 ||
        resolved.accuracyCrouched > 0 ||
        resolved.evasion > 0 ||
        resolved.evasionCrouched > 0 ||
        resolved.armor > 0 ||
        resolved.rangeFalloff < 0 ||
        resolved.critImmune ||
        resolved.silenced
      const costs =
        resolved.accuracy < 0 ||
        resolved.evasion < 0 ||
        resolved.moveCost > 0 ||
        resolved.critMultiplier < 0 ||
        resolved.maxAp < 0
      const conditional = resolved.accuracyCrouched > 0 || resolved.evasionCrouched > 0

      expect(helps).toBe(true)
      expect(costs || conditional).toBe(true)
    }
  })

  test('a trait can be reached from a person or from a pouch', () => {
    // The point of the whole mechanism: `Stoic` and the vest arrive at the
    // same place by different routes.
    expect(resolveTraits([TraitId.Stoic]).critImmune).toBe(true)
    expect(resolveTraits(ITEMS[ItemId.NullweaveVest].traits ?? []).critImmune).toBe(true)
  })
})

describe('A scope', () => {
  test('takes a share off what distance costs', () => {
    const { squads } = squad()
    const bare = squads.byFaction[F.Blue][0]!
    const scoped = squads.byFaction[F.Blue][1]!
    bare.equip(WeaponId.Rifle, AmmoId.Standard)
    scoped.equip(WeaponId.Rifle, AmmoId.Standard)
    fit(scoped, AttachmentId.Scope)

    const bareFalloff = effectiveWeapon(bare, ShotMode.Snap).accuracyPerMetre
    const scopedFalloff = effectiveWeapon(scoped, ShotMode.Snap).accuracyPerMetre

    expect(scopedFalloff).toBeLessThan(bareFalloff)
    expect(scopedFalloff).toBeGreaterThan(0)
  })

  test('is worth more the further the shot is', () => {
    // A flat accuracy bonus would be worth the same everywhere; glass is not,
    // and that is the distinction being tested.
    const { grid, squads } = squad()
    const bare = squads.byFaction[F.Blue][0]!
    const scoped = squads.byFaction[F.Blue][1]!
    const target = squads.byFaction[F.Red][0]!
    for (const unit of [bare, scoped]) unit.equip(WeaponId.Rifle, AmmoId.Standard)
    fit(scoped, AttachmentId.Scope)

    const gainAt = (distance: number): number => {
      target.tile = { x: bare.tile.x, y: bare.tile.y + distance }
      scoped.tile = { ...bare.tile }
      return (
        calculateHitChance(grid, scoped, target, ShotMode.Snap) -
        calculateHitChance(grid, bare, target, ShotMode.Snap)
      )
    }

    expect(gainAt(12)).toBeGreaterThan(gainAt(3))
  })

  test('cannot turn falloff into a bonus for being far away', () => {
    // Enough glass to cancel the penalty must floor at zero, not invert it.
    const { squads } = squad()
    const soldier = squads.byFaction[F.Blue][0]!
    soldier.equip(WeaponId.Rifle, AmmoId.Standard)
    // More glass than any rail would take; the maths still has to hold.
    soldier.sheet.traits.push(TraitId.Scoped, TraitId.Scoped, TraitId.Scoped)
    soldier.refreshTraits()

    expect(effectiveWeapon(soldier, ShotMode.Snap).accuracyPerMetre).toBe(0)
  })
})

describe('A bipod', () => {
  test('does nothing until the unit is down behind something', () => {
    const { squads } = squad()
    const soldier = squads.byFaction[F.Blue][0]!
    soldier.equip(WeaponId.Rifle, AmmoId.Standard)
    const standingAim = soldier.proficiency
    const standingEvasion = soldier.evasion

    fit(soldier, AttachmentId.Bipod)

    expect(soldier.proficiency).toBe(standingAim)
    expect(soldier.evasion).toBe(standingEvasion)

    soldier.enterCover()
    expect(soldier.proficiency).toBeGreaterThan(standingAim)
    expect(soldier.evasion).toBeGreaterThan(standingEvasion)
  })

  test('the bonus goes again when the unit stands up', () => {
    const { squads } = squad()
    const soldier = squads.byFaction[F.Blue][0]!
    soldier.equip(WeaponId.Rifle, AmmoId.Standard)
    fit(soldier, AttachmentId.Bipod)
    const standing = soldier.proficiency

    soldier.enterCover()
    soldier.exitCover()

    expect(soldier.proficiency).toBe(standing)
  })
})

describe('A suppressor', () => {
  test('keeps a position quiet and takes the bite off a crit', () => {
    const { squads } = squad()
    const bare = squads.byFaction[F.Blue][0]!
    const quiet = squads.byFaction[F.Blue][1]!
    for (const unit of [bare, quiet]) unit.equip(WeaponId.Sniper, AmmoId.Standard)
    fit(quiet, AttachmentId.Suppressor)

    expect(quiet.silenced).toBe(true)
    expect(bare.silenced).toBe(false)
    expect(effectiveWeapon(quiet, ShotMode.Snap).critMultiplier).toBeLessThan(
      effectiveWeapon(bare, ShotMode.Snap).critMultiplier,
    )
  })

  test('a crit multiplier never falls below doing nothing at all', () => {
    const { squads } = squad()
    const soldier = squads.byFaction[F.Blue][0]!
    soldier.equip(WeaponId.Gatling, AmmoId.Standard)
    soldier.sheet.traits.push(TraitId.Silenced, TraitId.Silenced, TraitId.Silenced)
    soldier.refreshTraits()

    // A multiplier under one would make a critical hit *weaker* than an
    // ordinary one, which is not a trade, it is a bug.
    expect(effectiveWeapon(soldier, ShotMode.Snap).critMultiplier).toBeGreaterThanOrEqual(1)
  })

  test('firing announces a position unless the weapon is quiet', () => {
    const { grid, squads } = squad()
    const loud = squads.byFaction[F.Blue][0]!
    const quiet = squads.byFaction[F.Blue][1]!
    const target = squads.byFaction[F.Red][0]!
    for (const unit of [loud, quiet]) {
      unit.equip(WeaponId.Rifle, AmmoId.Standard)
      unit.tile = { x: target.tile.x, y: target.tile.y - 3 }
    }
    fit(quiet, AttachmentId.Suppressor)

    fireWeapon(grid, loud, target, NO_FX, squads.soldiers, ShotMode.Snap, [false])
    fireWeapon(grid, quiet, target, NO_FX, squads.soldiers, ShotMode.Snap, [false])

    expect(loud.firedThisTurn).toBe(true)
    expect(quiet.firedThisTurn).toBe(false)
  })

  test('the announcement lasts until the unit\u2019s own next turn', () => {
    // Fog is recomputed from scratch on every action, so being seen for having
    // fired has to survive until the handover rather than being an event.
    const { grid, squads } = squad()
    const shooter = squads.byFaction[F.Blue][0]!
    const target = squads.byFaction[F.Red][0]!
    shooter.equip(WeaponId.Rifle, AmmoId.Standard)
    shooter.tile = { x: target.tile.x, y: target.tile.y - 3 }

    fireWeapon(grid, shooter, target, NO_FX, squads.soldiers, ShotMode.Snap, [false])
    expect(shooter.firedThisTurn).toBe(true)

    // The enemy's turn: still showing.
    settleTurn(squads.soldiers, F.Red)
    expect(shooter.firedThisTurn).toBe(true)

    // Its own turn comes round and the flash is forgotten.
    settleTurn(squads.soldiers, F.Blue)
    expect(shooter.firedThisTurn).toBe(false)
  })
})

describe('A plate carrier', () => {
  test('adds plate and takes agility', () => {
    const { squads } = squad()
    const soldier = squads.byFaction[F.Blue][0]!
    const bareEvasion = soldier.evasion
    const bareStep = soldier.moveCostMul

    give(soldier, ItemId.PlateCarrier)

    expect(soldier.maxArmor).toBe(RULES.maxArmor + TRAITS[TraitId.Plated].effects.armor!)
    expect(soldier.armor).toBe(soldier.maxArmor)
    expect(soldier.evasion).toBeLessThanOrEqual(bareEvasion)
    expect(soldier.moveCostMul).toBeGreaterThan(bareStep)
  })

  /**
   * The reason plate reduces damage proportionally rather than only adding
   * points: armour subtracts flat, per round, and every hit has a floor. The
   * base twenty points already floors the small rounds of a burst, so more
   * points would have bought nothing against exactly the fire plate is for.
   */
  test('takes a share off every round, which armour points alone cannot', () => {
    const { squads } = squad()
    const shooter = squads.byFaction[F.Blue][0]!
    const bare = squads.byFaction[F.Red][0]!
    const plated = squads.byFaction[F.Red][1]!
    shooter.equip(WeaponId.Gatling, AmmoId.Standard)
    give(plated, ItemId.PlateCarrier)

    const eff = effectiveWeapon(shooter, ShotMode.Snap)
    expect(resolveDamage(eff, plated).damage).toBeLessThan(resolveDamage(eff, bare).damage)
  })

  test('plate and a shredded armour plate pull on the same number', () => {
    // Adding rather than compounding: a plated unit under a shred takes both,
    // and the two cannot multiply into something neither intended.
    const { squads } = squad()
    const shooter = squads.byFaction[F.Blue][0]!
    const plated = squads.byFaction[F.Red][0]!
    shooter.equip(WeaponId.Rifle, AmmoId.Standard)
    give(plated, ItemId.PlateCarrier)

    const eff = effectiveWeapon(shooter, ShotMode.Snap)
    const calm = resolveDamage(eff, plated).damage
    applyStatus(plated, StatusKind.Shredded)

    expect(resolveDamage(eff, plated).damage).toBeGreaterThan(calm)
  })

  test('taking the plate off cannot leave a unit over its own ceiling', () => {
    const { squads } = squad()
    const soldier = squads.byFaction[F.Blue][0]!
    give(soldier, ItemId.PlateCarrier)

    soldier.items[ItemId.PlateCarrier] = 0
    soldier.refreshTraits()

    expect(soldier.maxArmor).toBe(RULES.maxArmor)
    expect(soldier.armor).toBeLessThanOrEqual(soldier.maxArmor)
  })
})

describe('What an enemy has to be able to read', () => {
  /**
   * The hole this closes: a shooter asks the *target* how hard it is to hit and
   * how much damage it takes. For an enemy unit the local trait fold is over
   * this side's stock copy of their kit, so reading the fold would ignore a
   * bipod they are braced on and plate they are wearing. Both have to come off
   * the replicated component.
   */
  test('a braced target\u2019s crouched evasion travels', () => {
    const { world, squads } = squad()
    const soldier = squads.byFaction[F.Red][0]!
    fit(soldier, AttachmentId.Bipod)

    const traits = world.getComponent(soldier.entityId, TraitsComponent)!
    expect(traits.evasionCrouched).toBeGreaterThan(0)

    // Standing in for a peer's update: the number arrives, nothing local is
    // refolded, and the unit still has to report it.
    soldier.enterCover()
    const own = soldier.evasion
    traits.evasionCrouched += 5
    expect(soldier.evasion).toBe(own + 5)
  })

  test('a plated target\u2019s damage reduction travels', () => {
    const { world, squads } = squad()
    const soldier = squads.byFaction[F.Red][0]!
    give(soldier, ItemId.PlateCarrier)

    const traits = world.getComponent(soldier.entityId, TraitsComponent)!
    expect(traits.damageTaken).toBeLessThan(0)

    traits.damageTaken = -0.5
    expect(soldier.damageTaken).toBe(-0.5)
  })
})
