import { AIM, COVER, CRIT } from '../config'
import {
  type AmmoSpec,
  type GrenadeSpec,
  SHOT_MODES,
  STATUSES,
  type ShotMode,
  type StatusKind,
  Weapon,
} from './Arsenal'
import { CoverLevel } from './Walls'
import { clamp } from './math'

/** A live status on a unit. */
export interface StatusState {
  kind: StatusKind
  turnsLeft: number
  /**
   * How many times over it is in force, capped by the status's own
   * `maxStacks`. Every numeric effect scales with it, so one flash is one
   * flash and three rounds cracking past a unit's head are three.
   *
   * Optional because an unstacked status is the common case and because this
   * arrives off a wire: absent means one, never none.
   */
  stacks?: number
}

/** How many times a status is in force. Absent or nonsense counts as one. */
export function statusStacks(status: StatusState): number {
  return status.stacks !== undefined && status.stacks > 0 ? status.stacks : 1
}

/** The combat-relevant state of a unit, as the resolver sees it. */
export interface CombatantStats {
  hp: number
  maxHp: number
  armor: number
  isCrouching: boolean
  /** This unit's own weapon instance. */
  weapon: Weapon
  /** This unit's own loaded round. */
  ammo: AmmoSpec
  statuses: StatusState[]
  /**
   * Accuracy this unit adds with the weapon it is holding: its training on that
   * class, plus whatever its traits add to every shot.
   */
  proficiency: number
  /** Percentage points off an attacker's chance to hit this unit. */
  evasion: number
  /** No hit on this unit can be a critical. */
  critImmune: boolean
  /** Percentage points this unit's traits add to its own crit chance. */
  critChanceBonus: number
  /** What this unit's traits add to the multiplier its crits apply. */
  critMultiplierBonus: number
}

/** A weapon with its loaded ammo folded in. */
export interface EffectiveWeapon {
  weapon: Weapon
  apCost: number
  baseAccuracy: number
  accuracyPerMetre: number
  damage: number
  /** 0..1 fraction of armour ignored. */
  armorPen: number
  armorShred: number
  areaRadius: number
  maxRange: number
  /** Crit chance in percent, before the shot's own circumstances. */
  critChance: number
  critMultiplier: number
  critRangeBias: number
}

/**
 * Fold the loaded round's modifiers, and the holder's own traits, into its
 * weapon.
 *
 * The traits belong here rather than at the crit site because they are a
 * property of the shooter with this weapon in their hands, exactly like the
 * ammunition in it — so everything downstream reads one set of numbers and
 * never has to ask who is holding it.
 */
export function effectiveWeapon(stats: CombatantStats, mode: ShotMode): EffectiveWeapon {
  const weapon = stats.weapon
  const ammo = stats.ammo
  const modeSpec = SHOT_MODES[mode]

  return {
    weapon,
    apCost: Math.max(1, Math.round((weapon.apCost + ammo.apDelta) * modeSpec.apMul)),
    baseAccuracy: weapon.baseAccuracy,
    accuracyPerMetre: weapon.accuracyPerMetre * ammo.rangePenaltyMul,
    damage: weapon.damage * ammo.damageMul,
    armorPen: clamp(weapon.armorPen + ammo.armorPenBonus, 0, 1),
    armorShred: weapon.armorShred + ammo.armorShredBonus,
    areaRadius: weapon.areaRadius,
    maxRange: weapon.maxRange,
    critChance: weapon.critChance + stats.critChanceBonus,
    critMultiplier: Math.max(1, weapon.critMultiplier + stats.critMultiplierBonus),
    critRangeBias: weapon.critRangeBias,
  }
}

/** Accuracy the shooter loses, given the cover crossed and the target's stance. */
export function coverPenalty(level: CoverLevel, crouching: boolean): number {
  if (level === CoverLevel.Tall) return crouching ? COVER.tallCrouch : COVER.tallStand
  if (level === CoverLevel.Low) return crouching ? COVER.lowCrouch : COVER.lowStand
  return crouching ? COVER.openCrouch : 0
}

/**
 * The unit's action-point ceiling with live status effects folded in.
 *
 * A stim raises the ceiling rather than handing out points directly, so the
 * bonus lapses on its own when the status expires.
 */
export function effectiveMaxAp(maxAp: number, statuses: StatusState[]): number {
  let bonus = 0
  for (const status of statuses) {
    if (status.turnsLeft <= 0) continue
    bonus += (STATUSES[status.kind]?.apBonus ?? 0) * statusStacks(status)
  }
  // At least one point: a unit that can do nothing at all cannot even end its
  // own turn deliberately, and no status is meant to remove a unit from play.
  return Math.max(1, Math.round(maxAp * (1 + bonus)))
}

function statusTotals(statuses: StatusState[]): {
  accuracyPenalty: number
  defenceBonus: number
  damageTakenBonus: number
} {
  let accuracyPenalty = 0
  let defenceBonus = 0
  let damageTakenBonus = 0
  for (const status of statuses) {
    if (status.turnsLeft <= 0) continue
    const spec = STATUSES[status.kind]
    const stacks = statusStacks(status)
    accuracyPenalty += spec.accuracyPenalty * stacks
    defenceBonus += spec.defenceBonus * stacks
    damageTakenBonus += spec.damageTakenBonus * stacks
  }
  return { accuracyPenalty, defenceBonus, damageTakenBonus }
}

/** Every term that produced a hit chance, so the HUD can explain the number. */
export interface HitChanceBreakdown {
  /** Final clamped percentage. 0 means the shot is impossible. */
  chance: number
  base: number
  rangePenalty: number
  coverPenalty: number
  /** Lost to the shooter's own statuses (flashed). */
  shooterPenalty: number
  /** Lost to the target's statuses (smoke). */
  targetDefence: number
  /** What the shooter's training on this weapon class is worth. Signed. */
  proficiency: number
  /** Lost to the target being a hard thing to hit. */
  evasion: number
  modeMultiplier: number
  distance: number
  outOfRange: boolean
}

/**
 * Chance for `shooter` to hit `target`.
 *
 * Range is the term that distinguishes the weapons: it is the weapon's own
 * per-metre falloff scaled by the loaded round, not one global constant.
 *
 * Two of the terms are people rather than equipment. The shooter's proficiency
 * is what they are worth with the class of weapon in their hands, so the same
 * rifle is not the same rifle in every pair of hands. The target's evasion is
 * subtracted before the mode multiplier, so a hard target is hard to snap at
 * and hard to line up on alike.
 */
export function hitChance(
  shooter: CombatantStats,
  target: CombatantStats,
  distance: number,
  cover: CoverLevel,
  mode: ShotMode,
): HitChanceBreakdown {
  const eff = effectiveWeapon(shooter, mode)
  const shooterStatus = statusTotals(shooter.statuses)
  const targetStatus = statusTotals(target.statuses)
  const modeMultiplier = SHOT_MODES[mode].chanceMul

  const rangePenalty = distance * eff.accuracyPerMetre
  const cov = coverPenalty(cover, target.isCrouching)
  const outOfRange = distance > eff.maxRange
  const evasion = Math.max(0, target.evasion)

  const raw =
    (eff.baseAccuracy +
      AIM.globalBonus +
      shooter.proficiency -
      rangePenalty -
      cov -
      shooterStatus.accuracyPenalty -
      targetStatus.defenceBonus -
      evasion) *
    modeMultiplier

  return {
    chance: outOfRange ? 0 : clamp(Math.round(raw), AIM.min, AIM.max),
    base: eff.baseAccuracy + AIM.globalBonus,
    rangePenalty: Math.round(rangePenalty),
    coverPenalty: cov,
    shooterPenalty: shooterStatus.accuracyPenalty,
    targetDefence: targetStatus.defenceBonus,
    proficiency: shooter.proficiency,
    evasion,
    modeMultiplier,
    distance,
    outOfRange,
  }
}

/** Every term behind a crit chance, so the HUD can explain the number. */
export interface CritBreakdown {
  /** Final clamped percentage. */
  chance: number
  /** The weapon's own chance, plus what the shooter's traits add. */
  base: number
  /** What the distance did: negative outside the weapon's element. */
  rangeTerm: number
  /** What the target's armour took off, net of penetration. */
  armorTerm: number
  /** What a crit multiplies raw damage by. */
  multiplier: number
  /** The target cannot be crit at all, so none of the terms above apply. */
  immune: boolean
}

/**
 * Chance that a hit lands as a critical, and what one is worth.
 *
 * Three things decide it. The weapon — with the shooter's own traits already
 * folded in — sets the odds and the multiplier. The distance moves those odds
 * along the weapon's own bias, so a shotgun is at its worst across a street and
 * a sniper rifle at its worst in a doorway. The target's armour covers what a
 * crit needs to reach, and a round that penetrates armour keeps its chance at
 * it.
 *
 * A target that cannot be crit ends the question before it is asked: the
 * chance is zero whatever the weapon, the distance or the roll. That is one
 * property, and it does not care whether the unit was born unflappable or is
 * wearing something that spreads the shock.
 */
export function critBreakdown(
  eff: EffectiveWeapon,
  target: CombatantStats,
  distance: number,
): CritBreakdown {
  if (target.critImmune) {
    return { chance: 0, base: eff.critChance, rangeTerm: 0, armorTerm: 0, multiplier: 1, immune: true }
  }

  // -1 at the muzzle, +1 at the edge of the weapon's reach.
  const reach = eff.maxRange > 0 ? clamp(distance / eff.maxRange, 0, 1) : 0
  const rangeTerm = CRIT.rangeSwing * eff.critRangeBias * (2 * reach - 1)
  const armorTerm = -CRIT.armorResist * Math.max(0, target.armor) * (1 - eff.armorPen)

  return {
    chance: clamp(Math.round(eff.critChance + rangeTerm + armorTerm), CRIT.min, CRIT.max),
    base: eff.critChance,
    // `|| 0` folds the negative zero `Math.round` keeps from a negative term
    // that rounds away: a term of nothing is nothing, and the HUD tests each
    // for `!== 0` before it draws a row.
    rangeTerm: Math.round(rangeTerm) || 0,
    armorTerm: Math.round(armorTerm) || 0,
    multiplier: eff.critMultiplier,
    immune: false,
  }
}

/** What a hit actually does once armour has had its say. */
export interface DamageResult {
  /** HP removed. */
  damage: number
  /** Armour points stripped. */
  armorShred: number
  /** Damage stopped by armour, for display. */
  absorbed: number
  /** Whether the crit multiplier was applied. */
  crit: boolean
}

/**
 * Resolve damage against armour.
 *
 * Armour subtracts flat damage, and penetration decides how much of it counts:
 * armour-piercing rounds bypass it entirely, buckshot barely dents it. A hit
 * always does at least `AIM.minDamage`, so armour can blunt a weapon but never
 * makes a unit immune to it.
 *
 * A crit multiplies the round before armour subtracts, so plate blunts a
 * critical hit exactly as it blunts an ordinary one rather than being bypassed
 * by it.
 */
export function resolveDamage(
  eff: EffectiveWeapon,
  target: CombatantStats,
  falloff = 1,
  crit = false,
): DamageResult {
  const status = statusTotals(target.statuses)
  const multiplier = crit ? eff.critMultiplier : 1
  const raw = eff.damage * falloff * multiplier * (1 + status.damageTakenBonus)
  const armorInPlay = Math.max(0, target.armor) * (1 - eff.armorPen)
  const damage = Math.max(AIM.minDamage, raw - armorInPlay)

  return {
    damage: Math.round(damage),
    armorShred: Math.round(eff.armorShred * falloff),
    absorbed: Math.round(Math.min(armorInPlay, raw - AIM.minDamage < 0 ? 0 : raw - damage)),
    crit,
  }
}

/**
 * Blast strength at `distance` tiles from the centre of a `radius` blast:
 * full at the centre, tapering linearly to a quarter at the rim, zero outside.
 */
export function blastFalloff(distance: number, radius: number): number {
  if (radius <= 0) return distance === 0 ? 1 : 0
  if (distance > radius) return 0
  return clamp(1 - (distance / radius) * 0.75, 0.25, 1)
}

/**
 * Damage a grenade does at `distance` tiles from its centre.
 *
 * A blast never crits: there is no vital to aim a shockwave at, and falloff
 * already decides what being close was worth.
 */
export function grenadeDamageAt(spec: GrenadeSpec, distance: number, target: CombatantStats): DamageResult {
  const falloff = blastFalloff(distance, spec.areaRadius)
  if (falloff === 0) return { damage: 0, armorShred: 0, absorbed: 0, crit: false }
  const status = statusTotals(target.statuses)
  // Explosives ignore worn armour far more than bullets do: the blast wave gets
  // through regardless, so only a quarter of armour applies.
  const armorInPlay = Math.max(0, target.armor) * 0.25
  const raw = spec.damage * falloff * (1 + status.damageTakenBonus)
  return {
    damage: spec.damage === 0 ? 0 : Math.max(AIM.minDamage, Math.round(raw - armorInPlay)),
    armorShred: Math.round(spec.armorShred * falloff),
    absorbed: Math.round(Math.min(armorInPlay, raw)),
    crit: false,
  }
}
