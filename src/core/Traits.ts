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
}

/** Every trait's opinion, added up. The shape combat reads. */
export interface ResolvedTraits {
  accuracy: number
  evasion: number
  critChance: number
  critMultiplier: number
  maxHp: number
  maxAp: number
  critImmune: boolean
}

export const NO_TRAITS: ResolvedTraits = {
  accuracy: 0,
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
