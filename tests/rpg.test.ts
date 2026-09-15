import { describe, expect, test } from 'bun:test'
import { AMMO, AmmoId, Rifle, Shotgun, ShotMode, Sniper, WeaponId } from '../src/core/Arsenal'
import {
  type CombatantStats,
  critBreakdown,
  effectiveWeapon,
  hitChance,
  resolveDamage,
} from '../src/core/Ballistics'
import {
  type CharacterSheet,
  characterSheet,
  rollSquadSheets,
  sanitizeSheet,
} from '../src/core/Characters'
import { ITEMS, ItemId } from '../src/core/Items'
import {
  NO_TRAITS,
  type ResolvedTraits,
  TRAITS,
  TraitId,
  resolveTraits,
  resolveTraitsInto,
} from '../src/core/Traits'
import { Rng } from '../src/core/rng'
import { CoverLevel } from '../src/core/Walls'
import { AIM, CHARACTER, RULES, SQUAD_SIZE } from '../src/config'

/**
 * A combatant with every person-shaped modifier at zero, so a test only has to
 * name the one it is measuring.
 */
function combatant(overrides: Partial<CombatantStats> = {}): CombatantStats {
  return {
    hp: 100,
    maxHp: 100,
    armor: 0,
    isCrouching: false,
    weapon: new Rifle(),
    ammo: AMMO[AmmoId.Standard],
    statuses: [],
    proficiency: 0,
    evasion: 0,
    critImmune: false,
    rangeFalloff: 0,
    damageTaken: 0,
    critChanceBonus: 0,
    critMultiplierBonus: 0,
    ...overrides,
  }
}

/** Well inside a rifle's reach, so no clamp or range cut-off is in the way. */
const OPEN_RANGE = 10

function chanceOf(shooter: CombatantStats, target: CombatantStats): number {
  return hitChance(shooter, target, OPEN_RANGE, CoverLevel.None, ShotMode.Snap).chance
}

/**
 * Sheets from a fixed run of seeds. Wide enough that a per-character property
 * holding only *usually* — the specialist margin was once a one-in-fourteen
 * failure — cannot slip through, and still fully deterministic.
 */
function sampleSheets(count = 300): CharacterSheet[] {
  const sheets: CharacterSheet[] = []
  for (let seed = 0; seed < count; seed++) sheets.push(characterSheet(new Rng(seed)))
  return sheets
}

describe('Folding traits', () => {
  test('what several traits say about the same number adds up', () => {
    const folded = resolveTraits([TraitId.Deadeye, TraitId.Juggernaut, TraitId.Fleet])

    expect(folded.accuracy).toBe(8)
    expect(folded.critChance).toBe(6)
    expect(folded.maxHp).toBe(25)
    expect(folded.maxAp).toBe(2)
    // Juggernaut's -5 is the only opinion about evasion here, and it survives
    // the fold with its sign: traits are allowed to cost something.
    expect(folded.evasion).toBe(-5)
    expect(folded.critImmune).toBe(false)
  })

  test('one source is enough to make a unit uncrittable', () => {
    expect(resolveTraits([TraitId.Nimble]).critImmune).toBe(false)
    expect(resolveTraits([TraitId.Nimble, TraitId.Stoic]).critImmune).toBe(true)
    // Order must not matter: a flag is an OR, not the last word in.
    expect(resolveTraits([TraitId.Stoic, TraitId.Nimble]).critImmune).toBe(true)
  })

  test('a trait this build has never heard of is ignored', () => {
    const withJunk = resolveTraits(['ghost' as TraitId, TraitId.Deadeye])

    expect(withJunk).toEqual(resolveTraits([TraitId.Deadeye]))
  })

  test('the fold cannot be made to throw by what it is handed', () => {
    // The sanitiser is the door, but the fold is the thing that used to break:
    // `TRAITS.toString` is a truthy lookup with no `effects` on it, so a
    // prototype key reaching here once threw rather than being skipped.
    const inherited = ['toString' as TraitId, 'constructor' as TraitId, 'valueOf' as TraitId]
    expect(resolveTraits(inherited)).toEqual(NO_TRAITS)
    expect(resolveTraits(['toString' as TraitId, TraitId.Fleet])).toEqual(
      resolveTraits([TraitId.Fleet]),
    )
  })

  test('the reused destination is refilled, never added to', () => {
    const out: ResolvedTraits = { ...NO_TRAITS }

    resolveTraitsInto(out, [TraitId.Deadeye, TraitId.Juggernaut, TraitId.Stoic])
    const second = resolveTraitsInto(out, [TraitId.Fleet])

    // Nothing from the first fold may survive the second: this object is kept
    // across frames on the shot-preview path, so a missed reset would compound.
    expect(second).toBe(out)
    expect(out).toEqual({ ...NO_TRAITS, maxAp: 2 })
  })

  test('folding nothing is the neutral set', () => {
    expect(resolveTraits([])).toEqual(NO_TRAITS)
  })
})

describe('Rolling a character', () => {
  test('every stat lands inside the envelope it was drawn from', () => {
    for (const sheet of sampleSheets()) {
      expect(sheet.maxHp).toBeGreaterThanOrEqual(CHARACTER.hp.min)
      expect(sheet.maxHp).toBeLessThanOrEqual(CHARACTER.hp.max)
      expect(sheet.maxAp).toBeGreaterThanOrEqual(CHARACTER.ap.min)
      expect(sheet.maxAp).toBeLessThanOrEqual(CHARACTER.ap.max)
      expect(sheet.evasion).toBeGreaterThanOrEqual(CHARACTER.evasion.min)
      expect(sheet.evasion).toBeLessThanOrEqual(CHARACTER.evasion.max)
      expect(Object.values(WeaponId)).toContain(sheet.specialism)
    }
  })

  test('the specialism is the one class carrying the bonus', () => {
    for (const sheet of sampleSheets()) {
      for (const id of Object.values(WeaponId)) {
        // Strip the bonus off the specialism and every class is an ordinary
        // draw again — which is what pins the bonus to exactly one entry, and
        // to exactly one application of it.
        const drawn =
          id === sheet.specialism
            ? sheet.proficiency[id] - CHARACTER.specialistBonus
            : sheet.proficiency[id]
        expect(drawn).toBeGreaterThanOrEqual(CHARACTER.proficiency.min)
        expect(drawn).toBeLessThanOrEqual(CHARACTER.proficiency.max)
      }
    }
  })

  test('a specialist is the best their squad member has, by a clear margin', () => {
    for (const sheet of sampleSheets()) {
      const others = Object.values(WeaponId)
        .filter((id) => id !== sheet.specialism)
        .map((id) => sheet.proficiency[id])

      // The bonus has to outrun the whole draw span, or a character can be
      // worse with the class they are labelled a specialist in than with one
      // they never trained on — and the HUD says otherwise.
      expect(sheet.proficiency[sheet.specialism]).toBeGreaterThan(Math.max(...others))
      expect(sheet.proficiency[sheet.specialism]).toBeGreaterThan(CHARACTER.proficiency.max)
    }
  })

  test('a character is born with at most one trait, and always a known one', () => {
    for (const sheet of sampleSheets()) {
      expect(sheet.traits.length).toBeLessThanOrEqual(1)
      // Nullweave is a garment: nobody is born wearing one.
      expect(sheet.traits).not.toContain(TraitId.Nullweave)
      for (const id of sheet.traits) expect(TRAITS[id]).toBeDefined()
    }
  })

  test('a squad roll deals one sheet per squad slot', () => {
    expect(rollSquadSheets(new Rng(7))).toHaveLength(SQUAD_SIZE)
  })

  test('the same seed deals the same squad and a different seed does not', () => {
    // Squads are not derived from the match seed, so this is the only handle a
    // test — or a repro — has on which people turned up.
    expect(rollSquadSheets(new Rng(7))).toEqual(rollSquadSheets(new Rng(7)))
    expect(rollSquadSheets(new Rng(7))).not.toEqual(rollSquadSheets(new Rng(8)))
  })
})

describe('Sanitising a sheet off the wire', () => {
  test('junk yields a sheet this side can still play against', () => {
    for (const junk of [null, undefined, {}, 'not a sheet', 42, []]) {
      const sheet = sanitizeSheet(junk)

      expect(sheet.maxHp).toBe(RULES.maxHp)
      expect(sheet.maxAp).toBe(RULES.maxAp)
      expect(sheet.evasion).toBe(0)
      expect(sheet.traits).toEqual([])
      expect(Object.values(WeaponId)).toContain(sheet.specialism)
      // Every class present, so the resolver never reads an undefined.
      for (const id of Object.values(WeaponId)) expect(sheet.proficiency[id]).toBe(0)
    }
  })

  test('numbers outside the envelope are pulled back into it', () => {
    const sheet = sanitizeSheet({ maxHp: 1e9, maxAp: -40, evasion: -12 })

    expect(sheet.maxHp).toBe(CHARACTER.hp.max)
    expect(sheet.maxAp).toBe(CHARACTER.ap.min)
    expect(sheet.evasion).toBe(CHARACTER.evasion.min)
  })

  test('a number that is not one falls back rather than poisoning the maths', () => {
    // NaN survives every clamp, so it has to be refused at the door: one NaN
    // hit chance is a shot nobody can take.
    const sheet = sanitizeSheet({ maxHp: NaN, maxAp: Infinity, evasion: '9' })

    expect(sheet.maxHp).toBe(RULES.maxHp)
    expect(sheet.maxAp).toBe(RULES.maxAp)
    expect(sheet.evasion).toBe(0)
  })

  test('unknown traits are dropped and known ones survive', () => {
    const sheet = sanitizeSheet({
      traits: [TraitId.Stoic, 'ghost', 7, null, TraitId.Fleet, TraitId.Stoic],
    })

    expect(sheet.traits).toEqual([TraitId.Stoic, TraitId.Fleet])
    expect(resolveTraits(sheet.traits).critImmune).toBe(true)
  })

  test('a key off the prototype is not a trait', () => {
    // Regression pin. `id in TRAITS` let `'toString'` through as a TraitId,
    // and the resolver then read `effects` off a function and threw — a crash
    // any peer could post through the `ready` handshake.
    const sheet = sanitizeSheet({ traits: ['toString', TraitId.Stoic, 'constructor'] })

    expect(sheet.traits).toEqual([TraitId.Stoic])
  })

  test('a bogus specialism falls back to a real weapon class', () => {
    expect(sanitizeSheet({ specialism: 'crossbow' }).specialism).toBe(WeaponId.Rifle)
    expect(sanitizeSheet({ specialism: 3 }).specialism).toBe(WeaponId.Rifle)
    expect(sanitizeSheet({ specialism: WeaponId.Gatling }).specialism).toBe(WeaponId.Gatling)
  })

  test('the proficiency ceiling leaves room for the specialist bonus and no more', () => {
    const ceiling = CHARACTER.proficiency.max + CHARACTER.specialistBonus
    const sheet = sanitizeSheet({
      proficiency: {
        [WeaponId.Rifle]: ceiling,
        [WeaponId.Shotgun]: ceiling + 1,
        [WeaponId.Sniper]: 900,
      },
    })

    // A real specialist reaches the ceiling, so clamping any lower would
    // quietly demote every peer's best class.
    expect(sheet.proficiency[WeaponId.Rifle]).toBe(ceiling)
    expect(sheet.proficiency[WeaponId.Shotgun]).toBe(ceiling)
    expect(sheet.proficiency[WeaponId.Sniper]).toBe(ceiling)
    expect(sheet.proficiency[WeaponId.Gatling]).toBe(0)
  })

  test('a locally rolled sheet passes through sanitising unchanged', () => {
    for (const sheet of sampleSheets(20)) {
      expect(sanitizeSheet(sheet)).toEqual(sheet)
    }
  })
})

describe('Who is holding the weapon', () => {
  test('training with the class in hand moves the shot either way', () => {
    const plain = chanceOf(combatant(), combatant())

    expect(chanceOf(combatant({ proficiency: 10 }), combatant())).toBe(plain + 10)
    expect(chanceOf(combatant({ proficiency: -10 }), combatant())).toBe(plain - 10)
  })

  test('a hard target is a harder shot', () => {
    const plain = chanceOf(combatant(), combatant())

    expect(chanceOf(combatant(), combatant({ evasion: 10 }))).toBe(plain - 10)
  })

  test('evasion below zero is no gift to the attacker', () => {
    // A Juggernaut folds to -5 evasion. Being slow must not make them easier to
    // hit than an average soldier, only less able to dodge than a nimble one.
    const plain = chanceOf(combatant(), combatant())

    expect(chanceOf(combatant(), combatant({ evasion: -5 }))).toBe(plain)
  })

  test('training and evasion of the same size cancel', () => {
    const plain = chanceOf(combatant(), combatant())

    expect(chanceOf(combatant({ proficiency: 12 }), combatant({ evasion: 12 }))).toBe(plain)
  })

  test('the breakdown reports both terms so the HUD can explain them', () => {
    const shown = hitChance(
      combatant({ proficiency: -7 }),
      combatant({ evasion: 9 }),
      OPEN_RANGE,
      CoverLevel.None,
      ShotMode.Snap,
    )

    expect(shown.proficiency).toBe(-7)
    expect(shown.evasion).toBe(9)
    // The base is the weapon's, untouched by either: the HUD draws them as
    // separate rows and must not double-count.
    expect(shown.base).toBe(new Rifle().baseAccuracy + AIM.globalBonus)
  })

  test('the clamps hold however lopsided the people are', () => {
    expect(chanceOf(combatant({ proficiency: 500 }), combatant())).toBe(AIM.max)
    expect(chanceOf(combatant({ proficiency: -500 }), combatant())).toBe(AIM.min)
    expect(chanceOf(combatant(), combatant({ evasion: 500 }))).toBe(AIM.min)
  })
})

describe('A target that cannot be crit', () => {
  test('immunity ends the question whatever the weapon, the range or the plate', () => {
    for (const weapon of [new Rifle(), new Shotgun(), new Sniper()]) {
      const eff = effectiveWeapon(combatant({ weapon }), ShotMode.Snap)

      for (const distance of [0, weapon.maxRange / 2, weapon.maxRange]) {
        for (const armor of [0, 20]) {
          const shown = critBreakdown(eff, combatant({ armor, critImmune: true }), distance)

          expect(shown).toEqual({
            chance: 0,
            base: eff.critChance,
            rangeTerm: 0,
            armorTerm: 0,
            multiplier: 1,
            immune: true,
          })
        }
      }
    }
  })

  test('a target that is otherwise identical can still be crit', () => {
    const eff = effectiveWeapon(combatant({ weapon: new Sniper() }), ShotMode.Snap)
    const ordinary = critBreakdown(eff, combatant(), 12)

    expect(ordinary.immune).toBe(false)
    expect(ordinary.chance).toBeGreaterThan(0)
    expect(ordinary.multiplier).toBe(new Sniper().critMultiplier)
  })

  test('immunity stops the roll, not what a crit would have been worth', () => {
    const eff = effectiveWeapon(combatant(), ShotMode.Snap)

    // `resolveDamage` is told whether the shot crit; the roll that decides it
    // happens in `executeShot`, off the back of `critBreakdown`. So immunity
    // never reaches here, and a forced crit against an immune target resolves
    // exactly like one against anybody else. This is the boundary, asserted so
    // a future caller does not assume the check is in both places.
    const immune = resolveDamage(eff, combatant({ armor: 10, critImmune: true }), 1, true)
    const ordinary = resolveDamage(eff, combatant({ armor: 10 }), 1, true)

    expect(immune.crit).toBe(true)
    expect(immune.damage).toBe(ordinary.damage)
  })
})

describe('Traits in the weapon', () => {
  test("a shooter's crit traits land in the weapon they are holding", () => {
    const rifle = new Rifle()
    const eff = effectiveWeapon(
      combatant({ weapon: rifle, critChanceBonus: 6, critMultiplierBonus: 0.5 }),
      ShotMode.Snap,
    )

    expect(eff.critChance).toBe(rifle.critChance + 6)
    expect(eff.critMultiplier).toBe(rifle.critMultiplier + 0.5)
    // And the folded chance is what the shot is actually resolved against.
    expect(critBreakdown(eff, combatant(), rifle.maxRange / 2).chance).toBe(rifle.critChance + 6)
  })

  test('the crit multiplier never falls below one', () => {
    // A multiplier under 1 would make a critical hit *weaker* than an ordinary
    // one, which no combination of traits is allowed to produce.
    const eff = effectiveWeapon(combatant({ critMultiplierBonus: -99 }), ShotMode.Snap)

    expect(eff.critMultiplier).toBe(1)
    expect(resolveDamage(eff, combatant(), 1, true).damage).toBe(
      resolveDamage(eff, combatant(), 1, false).damage,
    )
  })
})

describe('Gear grants traits', () => {
  test('the nullweave vest is worn rather than used', () => {
    const vest = ITEMS[ItemId.NullweaveVest]

    expect(vest.passive).toBe(true)
    expect(vest.effects).toEqual([])
    expect(vest.apCost).toBe(0)
    expect(vest.traits).toContain(TraitId.Nullweave)
  })

  test('carrying one delivers what a stoic is born with', () => {
    const worn = resolveTraits(ITEMS[ItemId.NullweaveVest].traits ?? [])
    const innate = resolveTraits([TraitId.Stoic])

    // The whole point of the trait layer: combat never asks where a modifier
    // came from, so a crate item and a birth roll reach it by the same route.
    expect(worn.critImmune).toBe(innate.critImmune)
    expect(worn.critImmune).toBe(true)

    const eff = effectiveWeapon(combatant({ weapon: new Sniper() }), ShotMode.Snap)
    expect(critBreakdown(eff, combatant({ critImmune: worn.critImmune }), 12).immune).toBe(true)
  })
})
