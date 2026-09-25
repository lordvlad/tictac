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
  /** Innate: gives nothing away under fire. */
  Inscrutable: 'inscrutable',
  /** Innate: wounds close on their own. */
  Hardy: 'hardy',
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
  /** Innate predisposition: morale rises when things are dire, and a break is a charge. */
  Daredevil: 'daredevil',
  /** Innate predisposition: steadied by a healthy squad, and steadies those near. */
  Teamplayer: 'teamplayer',
  /** Innate predisposition: untouched by what happens to squadmates, for good or ill. */
  Loner: 'loner',
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
  /** No hit on this unit can start it bleeding (`StatusKind.Bleeding`). */
  bleedImmune?: boolean
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
  /**
   * Being shot at does not give this unit's sheet away.
   *
   * The counterpart to `silenced` rather than a duplicate of it: one hides what
   * a unit *does*, this hides what it *is*. Shooting at someone normally tells
   * you how hard they were to hit; against this one it tells you nothing,
   * because there is nothing to read in how they took it.
   */
  unreadable?: boolean
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
  [TraitId.Inscrutable]: {
    id: TraitId.Inscrutable,
    name: 'Inscrutable',
    description: 'Gives nothing away: being shot at never reveals their sheet.',
    effects: { unreadable: true },
  },
  [TraitId.Hardy]: {
    id: TraitId.Hardy,
    name: 'Hardy',
    description: 'Wounds close on their own: never bleeds.',
    effects: { bleedImmune: true },
  },
  [TraitId.Nullweave]: {
    id: TraitId.Nullweave,
    name: 'Nullweave',
    // The weave that keeps a round from finding a vital keeps it from opening
    // one up too: the vest's case against a critical is its case against a bleed.
    description: 'Spreads the shock of a hit: no critical can land and no wound bleeds, but bulky.',
    effects: { critImmune: true, bleedImmune: true, evasion: -3 },
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
    description: 'Quiet: firing never gives the position away and is heard a quarter as far, but crits bite less.',
    effects: { silenced: true, critMultiplier: -0.3 },
  },
  [TraitId.Plated]: {
    id: TraitId.Plated,
    name: 'Plated',
    description:
      'Heavy plate: a sixth less damage taken and +6 armour, at the cost of speed and an action point.',
    // The AP bite is what the GDD means by heavy gear inflicting an action
    // penalty, and it is the half of a plate's cost that Strength is allowed
    // to answer: broad shoulders carry the weight, they do not make the
    // wearer a smaller target.
    effects: { armor: 9, damageTaken: -0.2, evasion: -4, moveCost: 0.15, maxAp: -1 },
  },
  // Predispositions: nothing a hit chance can express, so no effects here. What
  // they do is to how morale moves, and that is `core/Morale`'s.
  [TraitId.Daredevil]: {
    id: TraitId.Daredevil,
    name: 'Daredevil',
    description:
      'Craves the odds against them: morale rises when outnumbered or badly hurt, sags when winning easily, and a break is always a charge.',
    effects: {},
  },
  [TraitId.Teamplayer]: {
    id: TraitId.Teamplayer,
    name: 'Teamplayer',
    description: 'Steadier while the squad is whole, and steadies squadmates within two tiles every turn.',
    effects: {},
  },
  [TraitId.Loner]: {
    id: TraitId.Loner,
    name: 'Loner',
    description: 'Shrugs off squadmates falling or breaking, and takes nothing from their kills or their company.',
    effects: {},
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
  unreadable: boolean
  evasion: number
  critChance: number
  critMultiplier: number
  maxHp: number
  maxAp: number
  critImmune: boolean
  bleedImmune: boolean
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
  unreadable: false,
  evasion: 0,
  critChance: 0,
  critMultiplier: 0,
  maxHp: 0,
  maxAp: 0,
  critImmune: false,
  bleedImmune: false,
}

/**
 * Where a unit got a trait.
 *
 * The fold itself still does not care - that source-blindness is what lets a
 * vest and a bloodline grant the same modifier. This exists for the one rule
 * that genuinely must care: Strength cancels what *heavy gear* does to a
 * soldier, and cancelling a limp instead would be a different game.
 *
 * Three, not four: worn kit and a fitted attachment are both gear, and no rule
 * has ever wanted to tell a vest from a scope.
 */
export const TraitSource = {
  /** Born with it. */
  Innate: 'innate',
  /** Earned by being hurt. */
  Wound: 'wound',
  /** Carried, worn or fitted. */
  Gear: 'gear',
} as const
export type TraitSource = (typeof TraitSource)[keyof typeof TraitSource]

/** A trait together with where the unit got it. */
export interface SourcedTrait {
  id: TraitId
  source: TraitSource
}

/** Reset every number and flag to neutral. */
function clearTraits(out: ResolvedTraits): void {
  out.accuracy = 0
  out.moveCost = 0
  out.rangeFalloff = 0
  out.accuracyCrouched = 0
  out.evasionCrouched = 0
  out.armor = 0
  out.damageTaken = 0
  out.silenced = false
  out.unreadable = false
  out.evasion = 0
  out.critChance = 0
  out.critMultiplier = 0
  out.maxHp = 0
  out.maxAp = 0
  out.critImmune = false
  out.bleedImmune = false
}

/**
 * Add one trait's opinion to a fold.
 *
 * The single place that knows how each field combines: numbers sum, flags OR.
 * Both folds below go through here, so a new field cannot be honoured by one
 * of them and silently dropped by the other.
 */
function addEffects(out: ResolvedTraits, e: TraitEffects): void {
  out.accuracy += e.accuracy ?? 0
  out.moveCost += e.moveCost ?? 0
  out.rangeFalloff += e.rangeFalloff ?? 0
  out.accuracyCrouched += e.accuracyCrouched ?? 0
  out.evasionCrouched += e.evasionCrouched ?? 0
  out.armor += e.armor ?? 0
  out.damageTaken += e.damageTaken ?? 0
  out.silenced = out.silenced || (e.silenced ?? false)
  out.unreadable = out.unreadable || (e.unreadable ?? false)
  out.evasion += e.evasion ?? 0
  out.critChance += e.critChance ?? 0
  out.critMultiplier += e.critMultiplier ?? 0
  out.maxHp += e.maxHp ?? 0
  out.maxAp += e.maxAp ?? 0
  out.critImmune = out.critImmune || (e.critImmune ?? false)
  out.bleedImmune = out.bleedImmune || (e.bleedImmune ?? false)
}

/**
 * Fold every trait in `ids` into `out`, which is reset first.
 *
 * Takes its destination so the callers on the shot-preview path — which runs
 * per frame while the panel is open — can keep one object and refill it rather
 * than allocating a fresh set of modifiers each time.
 */
export function resolveTraitsInto(out: ResolvedTraits, ids: Iterable<TraitId>): ResolvedTraits {
  clearTraits(out)
  for (const id of ids) {
    // `Object.hasOwn` rather than a truthiness check on the lookup: `TRAITS`
    // inherits `toString` and friends, and one of those as an id would find a
    // truthy "spec" with no `effects` on it. Ids reaching here have been
    // sanitised, but the fold is cheap to make unable to throw.
    if (!Object.hasOwn(TRAITS, id)) continue
    addEffects(out, TRAITS[id].effects)
  }
  return out
}

/**
 * The same fold over source-tagged traits, optionally of one source only.
 *
 * With no `source` it is exactly {@link resolveTraitsInto}. With one, it
 * answers "what is gear alone doing to this unit?" - which is the question a
 * rule has to ask before it can cancel gear's share of a penalty and leave a
 * wound's share standing.
 */
export function resolveSourcedInto(
  out: ResolvedTraits,
  traits: Iterable<SourcedTrait>,
  source?: TraitSource,
): ResolvedTraits {
  clearTraits(out)
  for (const trait of traits) {
    if (source !== undefined && trait.source !== source) continue
    if (!Object.hasOwn(TRAITS, trait.id)) continue
    addEffects(out, TRAITS[trait.id].effects)
  }
  return out
}

/** The same fold, for callers that are not on a hot path. */
export function resolveTraits(ids: Iterable<TraitId>): ResolvedTraits {
  return resolveTraitsInto({ ...NO_TRAITS }, ids)
}
