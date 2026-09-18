import { describe, expect, test } from 'bun:test'
import { Faction, SQUAD_SIZE } from '../src/config'
import { AmmoId, GrenadeId, ShotMode, WeaponId } from '../src/core/Arsenal'
import { NO_FX } from '../src/core/Combatant'
import { Grid } from '../src/core/Grid'
import { ItemId } from '../src/core/Items'
import { executeShot, type ResolvedHit } from '../src/game/Combat'
import { shadowShot, shadowThrow } from '../src/game/Divergence'
import type { WireHit } from '../src/game/NetworkManager'
import { Squads } from '../src/game/Squads'
import { World } from '../src/ecs/World'
import { createGlobalRules } from '../src/ecs/globals'
import { TraitsComponent } from '../src/ecs/components'
import { rollSquadSheets } from '../src/core/Characters'
import { matchDice, Rng } from '../src/core/rng'

/** A world with two squads in line of sight, no engine and no canvas. */
function field() {
  const world = new World()
  createGlobalRules(world)
  const grid = new Grid(24)
  const squads = new Squads(
    world,
    grid,
    { [Faction.Blue]: [{ x: 4, y: 4 }], [Faction.Red]: [{ x: 4, y: 9 }] },
    undefined,
    Faction.Blue,
    {
      [Faction.Blue]: rollSquadSheets(new Rng(11)),
      [Faction.Red]: rollSquadSheets(new Rng(12)),
    },
  )
  for (const [i, unit] of squads.soldiers.entries()) {
    unit.sheet.traits.length = 0
    unit.refreshTraits()
    unit.equip(WeaponId.Rifle, AmmoId.Standard)
    unit.tile =
      unit.faction === Faction.Blue
        ? { x: 4 + (i % SQUAD_SIZE), y: 4 }
        : { x: 4 + (i % SQUAD_SIZE), y: 9 }
  }
  return { world, grid, squads }
}

/** What the acting side would have put on the wire for this shot. */
function wire(hits: readonly ResolvedHit[]): WireHit[] {
  return hits.map((hit) => ({
    faction: hit.soldier.faction,
    index: hit.soldier.squadIndex,
    damage: hit.damage,
    armorShred: hit.armorShred,
    status: hit.status,
    crit: hit.crit,
  }))
}

/** This file's dice: seeded, so a resolved shot is the same shot every run. */
const dice = matchDice(1)

describe("Checking a peer's arithmetic by doing it again", () => {
  test('a shot both sides resolve the same way is silent', () => {
    const { grid, squads } = field()
    const shooter = squads.byFaction[Faction.Blue][0]!
    const target = squads.byFaction[Faction.Red][0]!

    // Resolve it exactly as the acting peer would, then hand this side the
    // numbers and the dice that produced them.
    const before = { hp: target.hp, armor: target.armor }
    const result = executeShot(grid, shooter, target, NO_FX, squads.soldiers, ShotMode.Snap, dice, [true])
    // Put the target back: the shadow has to see the state the shot was fired
    // at, which is what the receiving side holds before it applies anything.
    target.hp = before.hp
    target.armor = before.armor

    const found = shadowShot(
      grid,
      shooter,
      target,
      squads.soldiers,
      ShotMode.Snap,
      result.rolls,
      wire(result.hits),
      result.hitChance,
    )

    expect(found).toEqual([])
  })

  test('a defensive property the shooter could not see is reported', () => {
    // The whole reason this exists. The three bugs of this class were all a
    // shooter reading its own stock copy of the target's kit; here the target's
    // replicated damage reduction says one thing and the sender's numbers say
    // another, which is exactly what those bugs looked like on the wire.
    const { world, grid, squads } = field()
    const shooter = squads.byFaction[Faction.Blue][0]!
    const target = squads.byFaction[Faction.Red][0]!

    const before = { hp: target.hp, armor: target.armor }
    const result = executeShot(grid, shooter, target, NO_FX, squads.soldiers, ShotMode.Snap, dice, [true])
    target.hp = before.hp
    target.armor = before.armor
    expect(result.damage).toBeGreaterThan(0)

    // The plate the sender did not know about, arriving the way it really does.
    const traits = world.getComponent(target.entityId, TraitsComponent)!
    traits.damageTaken = -0.5

    const found = shadowShot(
      grid,
      shooter,
      target,
      squads.soldiers,
      ShotMode.Snap,
      result.rolls,
      wire(result.hits),
      result.hitChance,
    )

    expect(found.some((d) => d.what === 'damage')).toBe(true)
    expect(found.find((d) => d.what === 'damage')?.unit).toBe(target.name)
  })

  test('a miss is checked through the chance, since it carries no damage', () => {
    // A missed shot has nothing in it to compare — unless the sender says what
    // it was shooting against, which is the term every bug of this class moved.
    const { grid, squads } = field()
    const shooter = squads.byFaction[Faction.Blue][0]!
    const target = squads.byFaction[Faction.Red][0]!

    const honest = shadowShot(
      grid, shooter, target, squads.soldiers, ShotMode.Snap, [false], [], undefined,
    )
    expect(honest).toEqual([])

    const lying = shadowShot(
      grid, shooter, target, squads.soldiers, ShotMode.Snap, [false], [], 99,
    )
    expect(lying.map((d) => d.what)).toContain('hitChance')
  })

  test('a victim only one side has in the blast is reported as a victim', () => {
    // The worst disagreement available: the two sides do not even agree about
    // who was standing in it.
    const { grid, squads } = field()
    const thrower = squads.byFaction[Faction.Blue][0]!
    const victim = squads.byFaction[Faction.Red][0]!
    thrower.grenades[GrenadeId.Frag] = 1
    victim.tile = { x: thrower.tile.x, y: thrower.tile.y + 2 }

    const found = shadowThrow(
      grid,
      thrower,
      victim.tile,
      GrenadeId.Frag,
      squads.soldiers,
      // The peer claims the blast caught nobody at all.
      [],
    )

    expect(found.some((d) => d.what === 'victim')).toBe(true)
  })

  test('the check applies nothing and spends nothing', () => {
    // Observation only: the applied outcome is still the sender's, so a shadow
    // that healed, killed or spent anything would be a bug of its own.
    const { grid, squads } = field()
    const shooter = squads.byFaction[Faction.Blue][0]!
    const target = squads.byFaction[Faction.Red][0]!
    shooter.items[ItemId.StimPack] = 1

    const snapshot = squads.soldiers.map((unit) => ({
      hp: unit.hp,
      armor: unit.armor,
      ap: unit.ap,
      clip: unit.weapon.currentClip,
      statuses: unit.statuses.length,
      known: unit.known,
      fired: unit.firedThisTurn,
    }))

    shadowShot(
      grid,
      shooter,
      target,
      squads.soldiers,
      ShotMode.Burst,
      [true, true, true],
      [{ faction: Faction.Red, index: 0, damage: 1, armorShred: 0, status: null, crit: false }],
      50,
    )

    for (const [i, unit] of squads.soldiers.entries()) {
      const was = snapshot[i]!
      expect({
        hp: unit.hp,
        armor: unit.armor,
        ap: unit.ap,
        clip: unit.weapon.currentClip,
        statuses: unit.statuses.length,
        known: unit.known,
        fired: unit.firedThisTurn,
      }).toEqual(was)
    }
  })
})
