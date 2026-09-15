import { WOUNDS } from '../config'

/**
 * Traits: named bundles of combat modifiers that a unit can pick up from
 * anywhere.
 *
 * A trait never says *where* it came from. A character is born with some, a
 * piece of gear grants others while it is carried, and a future source can hand
 * out the same ones without anything here changing — which is the point of
 * keeping the effects in one flat, additive shape.
 */

export const TraitId = {
  Deadeye: 'deadeye',
  Nimble: 'nimble',
  Juggernaut: 'juggernaut',
  Fleet: 'fleet',
  /** Innate: nothing rattles this one enough to hit a vital. */
  Stoic: 'stoic',
  /** Worn: a weave that spreads the shock of a hit out of any one place. */
  Nullweave: 'nullweave',
  /** Wounded: hurt enough to slow down and tire early. */
  Limping: 'limping',
  /** Wounded badly: cannot shoot or dodge straight. */
  Concussed: 'concussed',
  /** Worn: glass that makes distance matter less. */
  Scoped: 'scoped',
  /** Worn: legs to rest the weapon on, once the unit is down behind something. */
  Braced: 'braced',
  /** Worn: quiet, at the price of the shot's bite. */
  Silenced: 'silenced',
  /** Worn: plate, at the price of moving freely. */
  Plated: 'plated',
} as const
export type TraitId = (typeof TraitId)[keyof typeof TraitId]

/**
 * Everything a trait is allowed to change.
 *
 * Every field is optional: an absent field is a trait with no opinion about
 * that number, which is what lets several traits stack without any of them
 * knowing about the others. Numbers add; flags are true if any source says so.
 */
export interface TraitEffects {
  /** Percentage points on this unit's own hit chance. */
  accuracy?: number
  /** Percentage points off an attacker's chance to hit this unit. */
  evasion?: number
  /** Percentage points on this unit's own crit chance. */
  critChance?: number
  /** Added to the multiplier a crit by this unit applies. */
  critMultiplier?: number
  maxHp?: number
  maxAp?: number
  /** No hit on this unit can be a critical, whatever the attacker rolled. */
  critImmune?: boolean
  /**
   * Extra fraction added to every step this unit takes: 0.5 is half again.
   *
   * A fraction rather than a multiplier because the fold adds, and adding
   * multipliers is not how multipliers work. Two sources of 0.5 mean twice as
   * expensive, which is the answer a player would expect.
   */
  moveCost?: number
  /**
   * Extra fraction on the weapon's range falloff: -0.35 loses a third of it.
   *
   * Scales with distance by construction, which is what glass is worth — it
   * does nothing at point blank and a great deal across a street.
   */
  rangeFalloff?: number
  /** Accuracy that applies only while the unit is crouched. */
  accuracyCrouched?: number
  /** Evasion that applies only while the unit is crouched. */
  evasionCrouched?: number
  /** Armour points, added to the unit's own plate. */
  armor?: number
  /**
   * Fraction added to the damage this unit takes: -0.15 is a sixth less.
   *
   * Plate needs this rather than more armour points. Armour subtracts flat,
   * per round, and every hit has a floor of `AIM.minDamage` - so against the
   * many small rounds of a burst, the base twenty points already floors them
   * and anything on top is spent on nothing.
   */
  damageTaken?: number
  /** Firing does not give this unit's position away. */
  silenced?: boolean
}

export interface TraitSpec {
  id: TraitId
  name: string
  /** One line, as the HUD shows it. */
  description: string
  effects: TraitEffects
}

export const TRAITS: Record<TraitId, TraitSpec> = {
  [TraitId.Deadeye]: {
    id: TraitId.Deadeye,
    name: 'Deadeye',
    description: 'Shoots straighter and finds the gaps: +8 accuracy, +6 crit.',
    effects: { accuracy: 8, critChance: 6 },
  },
  [TraitId.Nimble]: {
    id: TraitId.Nimble,
    name: 'Nimble',
    description: 'Hard to lead: -10 to anyone shooting at them.',
    effects: { evasion: 10 },
  },
  [TraitId.Juggernaut]: {
    id: TraitId.Juggernaut,
    name: 'Juggernaut',
    description: 'Carries more and takes more: +25 HP, but slower to dodge.',
    effects: { maxHp: 25, evasion: -5 },
  },
  [TraitId.Fleet]: {
    id: TraitId.Fleet,
    name: 'Fleet',
    description: 'One more action every turn: +2 AP.',
    effects: { maxAp: 2 },
  },
  [TraitId.Stoic]: {
    id: TraitId.Stoic,
    name: 'Stoic',
    description: 'Never caught unready: hits on them are never critical.',
    effects: { critImmune: true },
  },
  [TraitId.Nullweave]: {
    id: TraitId.Nullweave,
    name: 'Nullweave',
    description: 'Spreads the shock of a hit: no critical can land, but bulky.',
    effects: { critImmune: true, evasion: -3 },
  },
  [TraitId.Limping]: {
    id: TraitId.Limping,
    name: 'Limping',
    description: 'Hurt: every step costs half again, and 2 AP less to spend.',
    effects: { moveCost: 0.5, maxAp: -2 },
  },
  [TraitId.Concussed]: {
    id: TraitId.Concussed,
    name: 'Concussed',
    description: 'Badly hurt: -8 accuracy and harder to keep out of the way.',
    effects: { accuracy: -8, evasion: -4 },
  },
  [TraitId.Scoped]: {
    id: TraitId.Scoped,
    name: 'Scoped',
    description: 'Glass: -5 accuracy up close, a third less lost to distance.',
    // The flat penalty is what makes it a choice rather than an upgrade: eye
    // to the scope, a target in your face is harder to find, and one across
    // the street is much easier.
    effects: { rangeFalloff: -0.35, accuracy: -5 },
  },
  [TraitId.Braced]: {
    id: TraitId.Braced,
    name: 'Braced',
    description: 'Bipod: +10 accuracy and +6 evasion, but only while crouched.',
    effects: { accuracyCrouched: 10, evasionCrouched: 6 },
  },
  [TraitId.Silenced]: {
    id: TraitId.Silenced,
    name: 'Silenced',
    description: 'Quiet: firing never gives the position away, but crits bite less.',
    effects: { silenced: true, critMultiplier: -0.3 },
  },
  [TraitId.Plated]: {
    id: TraitId.Plated,
    name: 'Plated',
    description: 'Heavy plate: a sixth less damage taken and +6 armour, at the cost of speed.',
    effects: { armor: 6, damageTaken: -0.15, evasion: -4, moveCost: 0.15 },
  },
}

/**
 * The wounds a unit's condition has earned it.
 *
 * Derived from current health rather than stamped on when a threshold is
 * crossed. That means a peer needs to be told nothing - hit points already
 * replicate, so both sides reach the same answer - there is no threshold
 * hysteresis to get wrong, and patching a soldier up genuinely helps rather
 * than leaving them limping at full health.
 */
export function woundTraits(hp: number, maxHp: number): readonly TraitId[] {
  if (maxHp <= 0 || hp <= 0) return []
  const share = hp / maxHp
  if (share <= WOUNDS.concussed) return WOUNDED_BADLY
  if (share <= WOUNDS.limping) return WOUNDED
  return []
}

const WOUNDED: readonly TraitId[] = [TraitId.Limping]
const WOUNDED_BADLY: readonly TraitId[] = [TraitId.Limping, TraitId.Concussed]

/** Every trait's opinion, added up. The shape combat reads. */
export interface ResolvedTraits {
  accuracy: number
  moveCost: number
  rangeFalloff: number
  accuracyCrouched: number
  evasionCrouched: number
  armor: number
  damageTaken: number
  silenced: boolean
  evasion: number
  critChance: number
  critMultiplier: number
  maxHp: number
  maxAp: number
  critImmune: boolean
}

export const NO_TRAITS: ResolvedTraits = {
  accuracy: 0,
  moveCost: 0,
  rangeFalloff: 0,
  accuracyCrouched: 0,
  evasionCrouched: 0,
  armor: 0,
  damageTaken: 0,
  silenced: false,
  evasion: 0,
  critChance: 0,
  critMultiplier: 0,
  maxHp: 0,
  maxAp: 0,
  critImmune: false,
}

/**
 * Fold every trait in `ids` into `out`, which is reset first.
 *
 * Takes its destination so the callers on the shot-preview path — which runs
 * per frame while the panel is open — can keep one object and refill it rather
 * than allocating a fresh set of modifiers each time.
 */
export function resolveTraitsInto(out: ResolvedTraits, ids: Iterable<TraitId>): ResolvedTraits {
  out.accuracy = 0
  out.moveCost = 0
  out.rangeFalloff = 0
  out.accuracyCrouched = 0
  out.evasionCrouched = 0
  out.armor = 0
  out.damageTaken = 0
  out.silenced = false
  out.evasion = 0
  out.critChance = 0
  out.critMultiplier = 0
  out.maxHp = 0
  out.maxAp = 0
  out.critImmune = false

  for (const id of ids) {
    // `Object.hasOwn` rather than a truthiness check on the lookup: `TRAITS`
    // inherits `toString` and friends, and one of those as an id would find a
    // truthy "spec" with no `effects` on it. Ids reaching here have been
    // sanitised, but the fold is cheap to make unable to throw.
    if (!Object.hasOwn(TRAITS, id)) continue
    const e = TRAITS[id].effects
    out.accuracy += e.accuracy ?? 0
    out.moveCost += e.moveCost ?? 0
    out.rangeFalloff += e.rangeFalloff ?? 0
    out.accuracyCrouched += e.accuracyCrouched ?? 0
    out.evasionCrouched += e.evasionCrouched ?? 0
    out.armor += e.armor ?? 0
    out.damageTaken += e.damageTaken ?? 0
    out.silenced = out.silenced || (e.silenced ?? false)
    out.evasion += e.evasion ?? 0
    out.critChance += e.critChance ?? 0
    out.critMultiplier += e.critMultiplier ?? 0
    out.maxHp += e.maxHp ?? 0
    out.maxAp += e.maxAp ?? 0
    out.critImmune = out.critImmune || (e.critImmune ?? false)
  }

  return out
}

/** The same fold, for callers that are not on a hot path. */
export function resolveTraits(ids: Iterable<TraitId>): ResolvedTraits {
  return resolveTraitsInto({ ...NO_TRAITS }, ids)
}
