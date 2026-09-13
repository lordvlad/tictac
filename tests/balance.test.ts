import { describe, expect, test } from 'bun:test'
import { Faction, SQUAD_SIZE } from '../src/config'
import { AmmoId, WeaponId } from '../src/core/Arsenal'
import { ItemId } from '../src/core/Items'
import { TraitId } from '../src/core/Traits'
import { sweep, formatReport } from '../src/sim/Balance'
import { SimMatch, simulate, type SquadPlan } from '../src/sim/SimMatch'

const STOCK: SquadPlan = {
  weapons: [WeaponId.Rifle, WeaponId.Gatling, WeaponId.Sniper, WeaponId.Shotgun],
}

describe('A simulated match is a function of its setup', () => {
  /**
   * The whole point of the harness: a number that moved has to mean the rules
   * moved. Every die, the map and the sheets come off one seeded stream, so the
   * same setup must replay exactly — including the tallies, which is where a
   * stray `Math.random` in the resolvers would show up.
   */
  test('the same seed plays out identically', () => {
    const setup = { seed: 77, blue: STOCK, red: STOCK }
    expect(simulate(setup)).toEqual(simulate(setup))
  })

  test('a different seed plays out differently', () => {
    // Not a strict requirement of any one pair, but over a handful of seeds a
    // harness that ignored its seed would be caught here.
    const outcomes = [11, 12, 13, 14, 15].map((seed) => simulate({ seed, blue: STOCK, red: STOCK }))
    const shapes = new Set(outcomes.map((outcome) => JSON.stringify(outcome)))
    expect(shapes.size).toBeGreaterThan(1)
  })

  test('a sweep is reproducible, and its seeds are consecutive', () => {
    const options = { seed: 5, matches: 6 }
    expect(sweep(options)).toEqual(sweep(options))
    expect(sweep(options).matches).toBe(6)
    // Overlapping sweeps must agree about the matches they share, or the report
    // depends on how many matches were asked for rather than on the game.
    const long = sweep({ seed: 5, matches: 12 })
    const short = sweep({ seed: 5, matches: 6 })
    expect(long.turns.min).toBeLessThanOrEqual(short.turns.min)
  })
})

describe('A simulated match obeys the rules it is measuring', () => {
  test('the turn cap ends it', () => {
    // A cap of 2 cannot decide many fights, so most must come back as draws
    // rather than running on.
    const outcomes = Array.from({ length: 10 }, (_, i) =>
      simulate({ seed: 200 + i, blue: STOCK, red: STOCK, turnCap: 2 }),
    )
    for (const outcome of outcomes) expect(outcome.turns).toBeLessThanOrEqual(3)
    expect(outcomes.some((outcome) => outcome.winner === null)).toBe(true)
  })

  test('a decided match really is decided', () => {
    for (let seed = 300; seed < 320; seed++) {
      const outcome = simulate({ seed, blue: STOCK, red: STOCK })
      if (outcome.winner === null) continue
      const loser = outcome.winner === Faction.Blue ? Faction.Red : Faction.Blue
      expect(outcome.survivors[loser]).toBe(0)
      expect(outcome.survivors[outcome.winner]).toBeGreaterThan(0)
    }
  })

  test('nobody ends up below zero, or above their own ceiling', () => {
    const match = new SimMatch({ seed: 41, blue: STOCK, red: STOCK })
    match.run()
    for (const unit of match.units) {
      expect(unit.hp).toBeGreaterThanOrEqual(0)
      expect(unit.hp).toBeLessThanOrEqual(unit.maxHp)
      expect(unit.ap).toBeGreaterThanOrEqual(0)
      expect(unit.ap).toBeLessThanOrEqual(unit.effectiveMaxAp)
    }
  })

  test('both squads deploy, at their own spawns', () => {
    const match = new SimMatch({ seed: 42, blue: STOCK, red: STOCK })
    expect(match.byFaction[Faction.Blue]).toHaveLength(SQUAD_SIZE)
    expect(match.byFaction[Faction.Red]).toHaveLength(SQUAD_SIZE)
    // Blue deploys along the low-Y edge and Red along the high-Y edge, so the
    // two squads must not start on top of each other.
    const blueY = match.byFaction[Faction.Blue].map((unit) => unit.tile.y)
    const redY = match.byFaction[Faction.Red].map((unit) => unit.tile.y)
    expect(Math.max(...blueY)).toBeLessThan(Math.min(...redY))
  })

  test('only the weapons that deployed are tallied', () => {
    const outcome = simulate({
      seed: 9,
      blue: { weapons: [WeaponId.Rifle] },
      red: { weapons: [WeaponId.Rifle] },
    })
    expect(Object.keys(outcome.byWeapon).every((weapon) => weapon === WeaponId.Rifle)).toBe(true)
  })

  test('a squad carries the gear its plan gave it, traits and all', () => {
    const match = new SimMatch({
      seed: 3,
      blue: { weapons: [WeaponId.Rifle], items: { [ItemId.NullweaveVest]: 1 }, ammo: AmmoId.ArmorPiercing },
      red: { weapons: [WeaponId.Rifle] },
    })

    for (const unit of match.byFaction[Faction.Blue]) {
      expect(unit.items.nullweave).toBe(1)
      expect(unit.ammo.id).toBe(AmmoId.ArmorPiercing)
      // The vest grants its trait out here exactly as it does in a match: no
      // hit on these four can be critical.
      expect(unit.critImmune).toBe(true)
    }
    for (const unit of match.byFaction[Faction.Red]) {
      expect(unit.items.nullweave).toBe(0)
      // Without the vest the only way to be immune is to have been born it,
      // which is the point: the two sources are interchangeable and this is
      // where that shows.
      expect(unit.critImmune).toBe(unit.sheet.traits.includes(TraitId.Stoic))
    }
    expect(match.run().traits[Faction.Blue]).toContain('nullweave')
  })
})

describe('The report says what happened', () => {
  test('wins, draws and turn statistics add up', () => {
    const report = sweep({ seed: 1, matches: 20 })
    expect(report.wins.blue + report.wins.red + report.wins.draw).toBe(20)
    expect(report.turns.min).toBeLessThanOrEqual(report.turns.median)
    expect(report.turns.median).toBeLessThanOrEqual(report.turns.max)
    expect(report.drawRate).toBeCloseTo(report.wins.draw / 20, 3)
  })

  test('a weapon that never fired cannot have hit anything', () => {
    const report = sweep({ seed: 1, matches: 10 })
    for (const weapon of report.weapons) {
      expect(weapon.hits).toBeLessThanOrEqual(weapon.shots)
      expect(weapon.rounds).toBeGreaterThanOrEqual(weapon.shots)
      if (weapon.shots === 0) expect(weapon.hitRate).toBe(0)
    }
  })

  /**
   * A trait on both sides says nothing about the trait, so those matches are
   * excluded. Counting them would drag every common trait towards an even
   * split whatever it actually does.
   */
  test('a trait is only judged where one side alone had it', () => {
    const report = sweep({ seed: 1, matches: 30 })
    for (const trait of report.traits) {
      expect(trait.decided).toBeGreaterThan(0)
      expect(trait.wins).toBeLessThanOrEqual(trait.decided)
      expect(trait.winRate).toBeCloseTo(trait.wins / trait.decided, 3)
    }
  })

  test('the human-readable form carries the headline numbers', () => {
    const report = sweep({ seed: 1, matches: 5 })
    const text = formatReport(report)
    expect(text).toContain('5 matches, seeds 1..5')
    expect(text).toContain('weapon')
    expect(text).toContain(`blue ${report.wins.blue}`)
  })
})
