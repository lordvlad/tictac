import { describe, expect, test } from 'bun:test'
import { Faction, SQUAD_SIZE } from '../src/config'
import { AmmoId, WeaponId } from '../src/core/Arsenal'
import { critBreakdown, meleeChance, meleeWeapon, resolveDamage } from '../src/core/Ballistics'
import { type CharacterSheet, characterSheet } from '../src/core/Characters'
import { NO_FX } from '../src/core/Combatant'
import { Grid, Side } from '../src/core/Grid'
import { MELEE, MeleeId } from '../src/core/Melee'
import { matchDice, Rng, type Roll } from '../src/core/rng'
import { WallKind } from '../src/core/Walls'
import { World } from '../src/ecs/World'
import { createGlobalRules } from '../src/ecs/globals'
import type { Soldier } from '../src/entities/Soldier'
import { canMelee, executeMelee } from '../src/game/Combat'
import { Squads } from '../src/game/Squads'

function sheet(strength = 5): CharacterSheet {
  const base = characterSheet(new Rng(4))
  // Born traits move evasion and crits; they are noise here.
  return { ...base, traits: [], attributes: { ...base.attributes, strength, agility: 5 } }
}

/** Blue 0 at (5,5) and Red 0 beside it at (6,5); everyone else far away. */
function contact(
  blue: MeleeId = MeleeId.Fists,
  red: MeleeId = MeleeId.Fists,
  strength = 5,
): { grid: Grid; attacker: Soldier; defender: Soldier } {
  const world = new World()
  createGlobalRules(world)
  const grid = new Grid(24)
  const far = (y: number) => Array.from({ length: SQUAD_SIZE }, (_, i) => ({ x: 1 + i * 2, y }))
  const squads = new Squads(
    world,
    grid,
    { [Faction.Blue]: far(1), [Faction.Red]: far(22) },
    undefined,
    Faction.Blue,
    {
      [Faction.Blue]: Array.from({ length: SQUAD_SIZE }, () => sheet(strength)),
      [Faction.Red]: Array.from({ length: SQUAD_SIZE }, () => sheet()),
    },
  )
  const attacker = squads.byFaction[Faction.Blue][0]!
  const defender = squads.byFaction[Faction.Red][0]!
  for (const unit of [attacker, defender]) unit.equip(WeaponId.Rifle, AmmoId.Standard)
  attacker.sidearm = blue
  defender.sidearm = red
  attacker.tile = { x: 5, y: 5 }
  defender.tile = { x: 6, y: 5 }
  return { grid, attacker, defender }
}

/** A roll that always lands, counting how many numbers it was asked for. */
function counted(value: number): { roll: Roll; draws: () => number } {
  let n = 0
  return {
    roll: () => {
      n++
      return value
    },
    draws: () => n,
  }
}

describe('Who can reach whom', () => {
  test('a neighbour, diagonals included; two tiles is out of reach and costs nothing', () => {
    const { grid, attacker, defender } = contact()
    expect(canMelee(grid, attacker, defender)).toBe(true)
    defender.tile = { x: 6, y: 6 }
    expect(canMelee(grid, attacker, defender)).toBe(true)

    defender.tile = { x: 7, y: 5 }
    const ap = attacker.ap
    expect(executeMelee(grid, attacker, defender, NO_FX, matchDice(1))).toBeNull()
    expect(attacker.ap).toBe(ap)
  })

  test('a parapet between is no obstacle to a blow; a solid wall is', () => {
    // Cover is a term in a shot and not in melee: a chest-high wall that would
    // cost a rifleman a large share of his chance does not stop a knife.
    const { grid, attacker, defender } = contact()
    grid.setWall(5, 5, Side.East, WallKind.Parapet)
    expect(canMelee(grid, attacker, defender)).toBe(true)
    grid.setWall(5, 5, Side.East, WallKind.Solid)
    expect(canMelee(grid, attacker, defender)).toBe(false)
  })

  test('a unit without the points for its sidearm cannot swing it', () => {
    const { grid, attacker, defender } = contact(MeleeId.Club)
    attacker.ap = MELEE[MeleeId.Club].apCost - 1
    expect(canMelee(grid, attacker, defender)).toBe(false)
  })
})

describe('What the three families are for', () => {
  test('against plate: fists do almost nothing, a club keeps its damage and strips the plate', () => {
    const { defender } = contact()
    defender.armor = 30
    const blow = (id: MeleeId) => {
      const { attacker } = contact(id)
      return resolveDamage(meleeWeapon(attacker), defender)
    }
    const fists = blow(MeleeId.Fists)
    const knife = blow(MeleeId.Knife)
    const club = blow(MeleeId.Club)

    expect(club.damage).toBeGreaterThan(knife.damage)
    expect(knife.damage).toBeGreaterThan(fists.damage)
    expect(club.armorShred).toBeGreaterThan(0)
    expect(knife.armorShred).toBe(0)
  })

  test('a knife is where criticals live; a club has nothing to place', () => {
    const { defender } = contact()
    const crit = (id: MeleeId) => critBreakdown(meleeWeapon(contact(id).attacker), defender, 0).chance
    expect(crit(MeleeId.Knife)).toBeGreaterThan(crit(MeleeId.Fists))
    expect(crit(MeleeId.Club)).toBe(0)
  })

  test('what the defender holds is part of the contest', () => {
    const odds = (defending: MeleeId, weapon: WeaponId) => {
      const { attacker, defender } = contact(MeleeId.Knife, defending)
      defender.equip(weapon, AmmoId.Standard)
      return meleeChance(attacker, defender).chance
    }
    // A blade in hand parries better than an open palm.
    expect(odds(MeleeId.Knife, WeaponId.Rifle)).toBeLessThan(odds(MeleeId.Fists, WeaponId.Rifle))
    // And a scoped rifle held across you is worse than having nothing.
    expect(odds(MeleeId.Fists, WeaponId.Sniper)).toBeGreaterThan(odds(MeleeId.Fists, WeaponId.Rifle))
  })

  test('Strength is what a blow is made of', () => {
    const weak = meleeWeapon(contact(MeleeId.Fists, MeleeId.Fists, 1).attacker)
    const strong = meleeWeapon(contact(MeleeId.Fists, MeleeId.Fists, 10).attacker)
    expect(strong.damage).toBeGreaterThan(weak.damage)
  })
})

describe('A blow, resolved', () => {
  test('a miss draws one number; a knife that lands draws three; a club that lands draws two', () => {
    // The order and count of draws is what keeps two peers on the same stream:
    // the blow, the crit if the sidearm can crit, the bleed if it can bleed.
    const miss = counted(0.999)
    const knife = contact(MeleeId.Knife)
    executeMelee(knife.grid, knife.attacker, knife.defender, NO_FX, miss.roll)
    expect(miss.draws()).toBe(1)

    const hitKnife = counted(0)
    const again = contact(MeleeId.Knife)
    executeMelee(again.grid, again.attacker, again.defender, NO_FX, hitKnife.roll)
    expect(hitKnife.draws()).toBe(3)

    const hitClub = counted(0)
    const club = contact(MeleeId.Club)
    executeMelee(club.grid, club.attacker, club.defender, NO_FX, hitClub.roll)
    expect(hitClub.draws()).toBe(2)

    // Fists cannot open a wound, so a punch that lands is the blow and the crit.
    const hitFists = counted(0)
    const fists = contact(MeleeId.Fists)
    executeMelee(fists.grid, fists.attacker, fists.defender, NO_FX, hitFists.roll)
    expect(hitFists.draws()).toBe(2)
  })

  test('a landed blow hurts, spends the sidearm’s points, and suppresses nobody', () => {
    const { grid, attacker, defender } = contact(MeleeId.Knife)
    const hp = defender.hp
    const ap = attacker.ap
    const result = executeMelee(grid, attacker, defender, NO_FX, counted(0.5).roll)!

    expect(result.hit).toBe(true)
    expect(defender.hp).toBe(hp - result.damage)
    expect(attacker.ap).toBe(ap - MELEE[MeleeId.Knife].apCost)
    expect(defender.statuses).toEqual([])
  })

  test('a club gives the attacker away; a knife does not', () => {
    const quiet = contact(MeleeId.Knife)
    executeMelee(quiet.grid, quiet.attacker, quiet.defender, NO_FX, counted(0.999).roll)
    expect(quiet.attacker.firedThisTurn).toBe(false)

    const loud = contact(MeleeId.Club)
    executeMelee(loud.grid, loud.attacker, loud.defender, NO_FX, counted(0.999).roll)
    expect(loud.attacker.firedThisTurn).toBe(true)
  })
})
