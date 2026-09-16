import { CHARACTER, RULES, SQUAD_SIZE } from '../config'
import { WeaponId } from './Arsenal'
import { clamp } from './math'
import { Rng } from './rng'
import { TraitId, TRAITS } from './Traits'

/**
 * What one soldier is, as distinct from what they are carrying.
 *
 * Each peer rolls its own squad and sends the sheets in the start handshake.
 * They are not derived from the match seed: the seed is the host's map, and a
 * peer's people are its own business. The receiving side takes the sheets as
 * given — after {@link sanitizeSheet}, because they arrived off a wire.
 */
export interface CharacterSheet {
  maxHp: number
  maxAp: number
  /** Percentage points off an attacker's hit chance. */
  evasion: number
  /** Accuracy this character adds, or loses, with each weapon class. */
  proficiency: Record<WeaponId, number>
  /** The class they trained on: the one carrying {@link CHARACTER.specialistBonus}. */
  specialism: WeaponId
  /** What they were born with. Gear grants more, separately. */
  traits: TraitId[]
}

/** Traits a character can be born with. `Nullweave` is a garment, not a person. */
const INNATE_TRAITS: readonly TraitId[] = [
  TraitId.Deadeye,
  TraitId.Nimble,
  TraitId.Juggernaut,
  TraitId.Fleet,
  TraitId.Stoic,
  TraitId.Inscrutable,
]

/** Roll one character. */
export function characterSheet(rng: Rng): CharacterSheet {
  const maxHp = rng.int(CHARACTER.hp.min, CHARACTER.hp.max)
  const maxAp = rng.int(CHARACTER.ap.min, CHARACTER.ap.max)
  const evasion = rng.int(CHARACTER.evasion.min, CHARACTER.evasion.max)

  const classes = Object.values(WeaponId)
  const proficiency = {} as Record<WeaponId, number>
  for (const id of classes) {
    proficiency[id] = rng.int(CHARACTER.proficiency.min, CHARACTER.proficiency.max)
  }

  const specialism = rng.pick(classes)
  proficiency[specialism] += CHARACTER.specialistBonus

  // Rolled last so adding a trait to the table cannot shift the stats above it.
  const traits = rng.chance(CHARACTER.traitChance) ? [rng.pick(INNATE_TRAITS)] : []

  return { maxHp, maxAp, evasion, proficiency, specialism, traits }
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
 * arrived claiming 10^9 HP, negative evasion or a trait this build has never
 * heard of would otherwise be handed straight to the resolver. Out-of-range
 * numbers are clamped to the same envelope a local roll draws from, and
 * anything missing falls back to the baseline.
 */
export function sanitizeSheet(raw: unknown): CharacterSheet {
  const fallback: CharacterSheet = {
    maxHp: RULES.maxHp,
    maxAp: RULES.maxAp,
    evasion: 0,
    proficiency: {} as Record<WeaponId, number>,
    specialism: WeaponId.Rifle,
    traits: [],
  }
  for (const id of Object.values(WeaponId)) fallback.proficiency[id] = 0
  if (!raw || typeof raw !== 'object') return fallback

  const sheet = raw as Partial<CharacterSheet>
  const number = (value: unknown, min: number, max: number, fall: number): number =>
    typeof value === 'number' && Number.isFinite(value) ? clamp(Math.round(value), min, max) : fall

  const proficiency = {} as Record<WeaponId, number>
  const profMax = CHARACTER.proficiency.max + CHARACTER.specialistBonus
  for (const id of Object.values(WeaponId)) {
    proficiency[id] = number(sheet.proficiency?.[id], CHARACTER.proficiency.min, profMax, 0)
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
    maxHp: number(sheet.maxHp, CHARACTER.hp.min, CHARACTER.hp.max, RULES.maxHp),
    maxAp: number(sheet.maxAp, CHARACTER.ap.min, CHARACTER.ap.max, RULES.maxAp),
    evasion: number(sheet.evasion, CHARACTER.evasion.min, CHARACTER.evasion.max, 0),
    proficiency,
    specialism:
      typeof sheet.specialism === 'string' &&
      (Object.values(WeaponId) as string[]).includes(sheet.specialism)
        ? (sheet.specialism as WeaponId)
        : WeaponId.Rifle,
    traits,
  }
}
