import { AIM, COVER } from '../config'
import {
  type AmmoSpec,
  type GrenadeSpec,
  SHOT_MODES,
  STATUSES,
  type ShotMode,
  type StatusKind,
  Weapon,
} from './Arsenal'
import { CoverLevel } from './Cover'
import { clamp } from './math'

/** A live status on a unit. */
export interface StatusState {
  kind: StatusKind
  turnsLeft: number
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
}

/** Fold the loaded round's modifiers into its weapon. */
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
  }
}

/** Accuracy the shooter loses, given the cover crossed and the target's stance. */
export function coverPenalty(level: CoverLevel, crouching: boolean): number {
  if (level === CoverLevel.Tall) return crouching ? COVER.tallCrouch : COVER.tallStand
  if (level === CoverLevel.Low) return crouching ? COVER.lowCrouch : COVER.lowStand
  return crouching ? COVER.openCrouch : 0
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
    accuracyPenalty += spec.accuracyPenalty
    defenceBonus += spec.defenceBonus
    damageTakenBonus += spec.damageTakenBonus
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
  modeMultiplier: number
  distance: number
  outOfRange: boolean
}

/**
 * Chance for `shooter` to hit `target`.
 *
 * Range is the term that distinguishes the weapons: it is the weapon's own
 * per-metre falloff scaled by the loaded round, not one global constant.
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

  const raw =
    (eff.baseAccuracy +
      AIM.globalBonus -
      rangePenalty -
      cov -
      shooterStatus.accuracyPenalty -
      targetStatus.defenceBonus) *
    modeMultiplier

  return {
    chance: outOfRange ? 0 : clamp(Math.round(raw), AIM.min, AIM.max),
    base: eff.baseAccuracy + AIM.globalBonus,
    rangePenalty: Math.round(rangePenalty),
    coverPenalty: cov,
    shooterPenalty: shooterStatus.accuracyPenalty,
    targetDefence: targetStatus.defenceBonus,
    modeMultiplier,
    distance,
    outOfRange,
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
}

/**
 * Resolve damage against armour.
 *
 * Armour subtracts flat damage, and penetration decides how much of it counts:
 * armour-piercing rounds bypass it entirely, buckshot barely dents it. A hit
 * always does at least `AIM.minDamage`, so armour can blunt a weapon but never
 * makes a unit immune to it.
 */
export function resolveDamage(
  eff: EffectiveWeapon,
  target: CombatantStats,
  falloff = 1,
): DamageResult {
  const status = statusTotals(target.statuses)
  const raw = eff.damage * falloff * (1 + status.damageTakenBonus)
  const armorInPlay = Math.max(0, target.armor) * (1 - eff.armorPen)
  const damage = Math.max(AIM.minDamage, raw - armorInPlay)

  return {
    damage: Math.round(damage),
    armorShred: Math.round(eff.armorShred * falloff),
    absorbed: Math.round(Math.min(armorInPlay, raw - AIM.minDamage < 0 ? 0 : raw - damage)),
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

/** Damage a grenade does at `distance` tiles from its centre. */
export function grenadeDamageAt(spec: GrenadeSpec, distance: number, target: CombatantStats): DamageResult {
  const falloff = blastFalloff(distance, spec.areaRadius)
  if (falloff === 0) return { damage: 0, armorShred: 0, absorbed: 0 }
  const status = statusTotals(target.statuses)
  // Explosives ignore worn armour far more than bullets do: the blast wave gets
  // through regardless, so only a quarter of armour applies.
  const armorInPlay = Math.max(0, target.armor) * 0.25
  const raw = spec.damage * falloff * (1 + status.damageTakenBonus)
  return {
    damage: spec.damage === 0 ? 0 : Math.max(AIM.minDamage, Math.round(raw - armorInPlay)),
    armorShred: Math.round(spec.armorShred * falloff),
    absorbed: Math.round(Math.min(armorInPlay, raw)),
  }
}
