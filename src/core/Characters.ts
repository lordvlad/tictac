import { CHARACTER, RULES, SQUAD_SIZE } from '../config'
import { WeaponId } from './Arsenal'
import { clamp } from './math'
import { Rng } from './rng'
import { PREDISPOSITIONS, Temperament } from './Morale'
import { TraitId, TRAITS } from './Traits'

/**
 * Training a character has that is not about guns.
 *
 * Separate from {@link Attributes} because it is learned rather than innate:
 * the GDD has these grow with use, while an attribute is closer to who someone
 * is. Each one scales exactly one thing, named on the field.
 */
export const UtilityId = {
  /** Healing this character applies to somebody else. */
  Medical: 'medical',
  /** Blast radius and armour shred of ordnance this character throws. */
  Demolitions: 'demolitions',
  /** Armour this character repairs, and what repairing costs them. */
  Mechanics: 'mechanics',
} as const
export type UtilityId = (typeof UtilityId)[keyof typeof UtilityId]

/**
 * The four numbers a character actually *is*.
 *
 * Everything tactical is derived from these by {@link derive} rather than
 * rolled beside them, so a sheet has one place a number can come from. Each
 * one has to pay for itself somewhere a player can feel: an attribute with no
 * consumer would be flavour text with a die attached.
 */
export interface Attributes {
  /** Physical resilience: hit points, and how well treatment takes. */
  health: number
  /** Reflexes and precision: action points, and how hard they are to hit. */
  agility: number
  /** Load and reach: how much kit they carry, and how far they throw it. */
  strength: number
  /** Technical literacy: what using a piece of kit costs them. */
  intelligence: number
}

/**
 * What one soldier is, as distinct from what they are carrying.
 *
 * Each peer rolls its own squad and sends the sheets in the start handshake.
 * They are not derived from the match seed: the seed is the host's map, and a
 * peer's people are its own business. The receiving side takes the sheets as
 * given — after {@link sanitizeSheet}, because they arrived off a wire.
 *
 * Note what is *not* here: no hit-point ceiling, no evasion, no carry limit.
 * Those are {@link DerivedStats}, computed on whichever side is asking. A peer
 * therefore cannot claim a ceiling at all, only four attributes inside a band
 * this build clamps — the envelope is unforgeable by construction rather than
 * by validation.
 */
export interface CharacterSheet {
  attributes: Attributes
  /** Accuracy this character adds, or loses, with each weapon class. */
  proficiency: Record<WeaponId, number>
  /** Percent each utility discipline adds to what it governs. */
  utility: Record<UtilityId, number>
  /** The class they trained on: the one carrying {@link CHARACTER.specialistBonus}. */
  specialism: WeaponId
  /** What they were born with. Gear grants more, separately. */
  traits: TraitId[]
  /** Which way they go when a break is more than a freeze (`core/Morale`). */
  temperament: Temperament
}

/**
 * The tactical numbers a sheet produces.
 *
 * Pure function of {@link Attributes} and nothing else — not of gear, not of
 * wounds, not of stance. Those are the trait fold's business, and they are
 * added on top of these by the unit that owns them.
 */
export interface DerivedStats {
  maxHp: number
  maxAp: number
  /** Percentage points off an attacker's hit chance. */
  evasion: number
  /** Tiles on top of a grenade's own throw range. */
  throwRange: number
  /** Consumables this character can carry into a match. */
  carrySlots: number
  /** Action points on top of an item's own price. */
  itemApDelta: number
  /** Percent on top of HP an item restores to them. */
  healBonus: number
  /** Percent on the distance this character hears anything at. */
  hearing: number
  /** Percent of gear's own movement and AP penalty this character shrugs off. */
  gearRelief: number
  /** Percentage points on landing a blow. */
  meleeSkill: number
  /** Percent on the damage a blow does. */
  meleePower: number
  /** Percent chance a shoulder to a locked door gives (`core/Doors`). */
  shoulder: number
}

/** Combat traits a character can be born with. `Nullweave` is a garment, not a person. */
const INNATE_TRAITS: readonly TraitId[] = [
  TraitId.Deadeye,
  TraitId.Nimble,
  TraitId.Juggernaut,
  TraitId.Fleet,
  TraitId.Stoic,
  TraitId.Inscrutable,
  TraitId.Hardy,
]

/**
 * Read an attribute onto the band a stat lives in.
 *
 * Linear and inclusive: the bottom of the scale is the bottom of the band and
 * the top is the top, so a band is described entirely by its two ends in
 * {@link CHARACTER} and no stat needs a curve of its own. Bands may run
 * backwards (`itemApDelta`), which is how an attribute can make something
 * cheaper as it rises.
 */
function band(attribute: number, range: { min: number; max: number }): number {
  const { min, max } = CHARACTER.attribute
  const t = (clamp(attribute, min, max) - min) / (max - min)
  return Math.round(range.min + t * (range.max - range.min))
}

/** Every tactical number a sheet implies. */
export function derive(sheet: CharacterSheet): DerivedStats {
  const { health, agility, strength, intelligence } = sheet.attributes
  return {
    maxHp: band(health, CHARACTER.hp),
    healBonus: band(health, CHARACTER.healBonus),
    maxAp: band(agility, CHARACTER.ap),
    evasion: band(agility, CHARACTER.evasion),
    throwRange: band(strength, CHARACTER.throwRange),
    carrySlots: band(strength, CHARACTER.carrySlots),
    itemApDelta: band(intelligence, CHARACTER.itemApDelta),
    hearing: band(intelligence, CHARACTER.hearing),
    gearRelief: band(strength, CHARACTER.gearRelief),
    meleeSkill: band(strength, CHARACTER.meleeSkill),
    meleePower: band(strength, CHARACTER.meleePower),
    shoulder: band(strength, CHARACTER.shoulder),
  }
}

/** Roll one character. */
export function characterSheet(rng: Rng): CharacterSheet {
  const attribute = (): number => rng.int(CHARACTER.attribute.min, CHARACTER.attribute.max)
  const attributes: Attributes = {
    health: attribute(),
    agility: attribute(),
    strength: attribute(),
    intelligence: attribute(),
  }

  const classes = Object.values(WeaponId)
  const proficiency = {} as Record<WeaponId, number>
  for (const id of classes) {
    proficiency[id] = rng.int(CHARACTER.proficiency.min, CHARACTER.proficiency.max)
  }

  const utility = {} as Record<UtilityId, number>
  for (const id of Object.values(UtilityId)) {
    utility[id] = rng.int(CHARACTER.utility.min, CHARACTER.utility.max)
  }

  const specialism = rng.pick(classes)
  proficiency[specialism] += CHARACTER.specialistBonus

  // Rolled last so adding a trait to the table cannot shift the stats above it.
  const traits = rng.chance(CHARACTER.traitChance) ? [rng.pick(INNATE_TRAITS)] : []
  // And the person after the soldier, for the same reason.
  if (rng.chance(CHARACTER.predispositionChance)) traits.push(rng.pick(PREDISPOSITIONS))
  const temperament = rng.chance(0.5) ? Temperament.Hothead : Temperament.Skittish

  return { attributes, proficiency, utility, specialism, traits, temperament }
}

/**
 * Roll the squad this player commands.
 *
 * Seeded off the clock by default: two peers must *not* deal the same people,
 * and nothing about a squad needs to be reproducible from the match seed. Takes
 * an `Rng` so a test can pin it.
 */
export function rollSquadSheets(rng: Rng = new Rng(Date.now() >>> 0)): CharacterSheet[] {
  const sheets: CharacterSheet[] = []
  for (let i = 0; i < SQUAD_SIZE; i++) sheets.push(characterSheet(rng))
  return sheets
}

/**
 * A sheet this side can safely play against.
 *
 * Peer input, so every field is checked rather than trusted: a squad that
 * arrived claiming a trait this build has never heard of would otherwise be
 * handed straight to the resolver.
 *
 * There is markedly less to check than there used to be. A sheet no longer
 * states a hit-point ceiling, an evasion or a carry limit — it states four
 * attributes, and every ceiling is {@link derive}d from them on this side. A
 * peer claiming 10^9 HP is no longer a number to clamp; it is a field that
 * does not exist.
 *
 * A malformed sheet plays as an average soldier: the middle of the attribute
 * scale, no specialism bonus, no traits.
 */
export function sanitizeSheet(raw: unknown): CharacterSheet {
  const { min, max } = CHARACTER.attribute
  const average = Math.round((min + max) / 2)
  const fallback: CharacterSheet = {
    attributes: {
      health: average,
      agility: average,
      strength: average,
      intelligence: average,
    },
    proficiency: {} as Record<WeaponId, number>,
    utility: {} as Record<UtilityId, number>,
    specialism: WeaponId.Rifle,
    traits: [],
    temperament: Temperament.Skittish,
  }
  for (const id of Object.values(WeaponId)) fallback.proficiency[id] = 0
  for (const id of Object.values(UtilityId)) fallback.utility[id] = 0
  if (!raw || typeof raw !== 'object') return fallback

  const sheet = raw as Partial<CharacterSheet>
  const number = (value: unknown, low: number, high: number, fall: number): number =>
    typeof value === 'number' && Number.isFinite(value) ? clamp(Math.round(value), low, high) : fall

  const attributes = {} as Attributes
  for (const key of Object.keys(fallback.attributes) as (keyof Attributes)[]) {
    attributes[key] = number(sheet.attributes?.[key], min, max, average)
  }

  const proficiency = {} as Record<WeaponId, number>
  const profMax = CHARACTER.proficiency.max + CHARACTER.specialistBonus
  for (const id of Object.values(WeaponId)) {
    proficiency[id] = number(sheet.proficiency?.[id], CHARACTER.proficiency.min, profMax, 0)
  }

  const utility = {} as Record<UtilityId, number>
  for (const id of Object.values(UtilityId)) {
    utility[id] = number(sheet.utility?.[id], CHARACTER.utility.min, CHARACTER.utility.max, 0)
  }

  const traits: TraitId[] = []
  if (Array.isArray(sheet.traits)) {
    for (const id of sheet.traits) {
      // Unknown ids are dropped rather than defaulted: a trait this build does
      // not have is a modifier it cannot honour.
      //
      // `Object.hasOwn`, never `in`: `in` walks the prototype chain, so a peer
      // sending `'toString'` would pass the check, come back out of here as a
      // TraitId, and hand the resolver a spec with no `effects` on it.
      if (typeof id !== 'string' || !Object.hasOwn(TRAITS, id)) continue
      if (!traits.includes(id as TraitId)) traits.push(id as TraitId)
    }
  }

  return {
    attributes,
    proficiency,
    utility,
    specialism:
      typeof sheet.specialism === 'string' &&
      (Object.values(WeaponId) as string[]).includes(sheet.specialism)
        ? (sheet.specialism as WeaponId)
        : WeaponId.Rifle,
    traits,
    temperament: (Object.values(Temperament) as unknown[]).includes(sheet.temperament)
      ? (sheet.temperament as Temperament)
      : fallback.temperament,
  }
}
