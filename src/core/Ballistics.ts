import { AIM, BLEED, COVER, CRIT, LEVEL_HEIGHT } from '../config'
import {
  type AmmoSpec,
  type GrenadeSpec,
  SHOT_MODES,
  STATUSES,
  type ShotMode,
  type StatusKind,
  Weapon,
} from './Arsenal'
import { CoverLevel, WallKind } from './Walls'
import { LONG_GUN_PARRY, MELEE, type MeleeId } from './Melee'
import { clamp, distance, facingYaw, throwAngle } from './math'
import { Side, type Tile } from './Grid'

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
  /** No hit on this unit can start it bleeding. */
  bleedImmune: boolean
  /**
   * Extra fraction on the weapon's range falloff, from whatever this unit is
   * carrying. Negative is glass helping.
   */
  rangeFalloff: number
  /** Fraction added to incoming damage from this unit's own gear. Negative helps. */
  damageTaken: number
  /** Percentage points this unit's traits add to its own crit chance. */
  critChanceBonus: number
  /** What this unit's traits add to the multiplier its crits apply. */
  critMultiplierBonus: number
  /** What is in the sidearm slot; {@link MeleeId.Fists} when it is empty. */
  sidearm: MeleeId
  /** Percentage points Strength adds to landing a blow. */
  meleeSkill: number
  /** Percent Strength adds to the damage a blow does. */
  meleePower: number
}

/** A weapon with its loaded ammo folded in. */
export interface EffectiveWeapon {
  weapon: Weapon
  apCost: number
  /** Metres of error at no distance, the mode folded in. */
  sway: number
  /** Metres of error per metre, the mode, the round and the holder's glass folded in. */
  spread: number
  /** Projectiles per round. */
  pellets: number
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
  /** Chance, in percent, that a round or blow which lands starts a bleed, before armour. */
  bleedChance: number
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
    sway: weapon.sway * modeSpec.spreadMul,
    // Floored at nothing: gear may cancel spread, never invert it into a
    // weapon that shoots better the further away the target is.
    spread: Math.max(
      0,
      weapon.spread * modeSpec.spreadMul * ammo.rangePenaltyMul * (1 + stats.rangeFalloff),
    ),
    pellets: weapon.pellets,
    damage: weapon.damage * ammo.damageMul,
    armorPen: clamp(weapon.armorPen + ammo.armorPenBonus, 0, 1),
    armorShred: weapon.armorShred + ammo.armorShredBonus,
    areaRadius: weapon.areaRadius,
    maxRange: weapon.maxRange,
    critChance: weapon.critChance + stats.critChanceBonus,
    critMultiplier: Math.max(1, weapon.critMultiplier + stats.critMultiplierBonus),
    critRangeBias: weapon.critRangeBias,
    bleedChance: weapon.bleedChance,
  }
}

/** Share of the body still showing, given the cover crossed and the target's stance. */
export function visibleShare(level: CoverLevel, crouching: boolean): number {
  if (level === CoverLevel.Tall) return crouching ? COVER.tallCrouch : COVER.tallStand
  if (level === CoverLevel.Low) return crouching ? COVER.lowCrouch : COVER.lowStand
  return crouching ? COVER.openCrouch : 1
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

/** What a round is likely to do: the only numbers a player is shown. */
export interface ShotOdds {
  /** Percent chance the round lands at all — any of its projectiles. 0 when out of range. */
  chance: number
  /** Percent chance one projectile lands. The same as `chance` for a single bullet. */
  projectile: number
  /** Projectiles expected to land, given that the round does. */
  landed: number
  distance: number
  outOfRange: boolean
}

/**
 * The odds of `shooter`'s round landing on `target`.
 *
 * One straight line per projectile, missing by `e = (sway + spread × d) ×
 * tighten`, onto a body of half-width `w = targetSize × visible share ×
 * (1 − evasion)`. A line lands with probability `w² / (w² + e²)`. Training
 * tightens the error and a status penalty widens it; cover and stance hide
 * body, and evasion or a status's defence hide a little more.
 *
 * From behind, evasion and defence count for nothing: dodging is something
 * you do about a shot you can see coming. Cover still counts — a wall does
 * not care which way the man behind it is facing.
 *
 * A round of several projectiles lands if any of them does, so a shotgun's
 * chance to land *something* stays high across a room while what lands falls
 * off — which is its damage falling with distance, with no rule of its own.
 */
export function hitChance(
  shooter: CombatantStats,
  target: CombatantStats,
  distance: number,
  cover: CoverLevel,
  mode: ShotMode,
  fromBehind = false,
): ShotOdds {
  const eff = effectiveWeapon(shooter, mode)
  if (distance > eff.maxRange) {
    return { chance: 0, projectile: 0, landed: 0, distance, outOfRange: true }
  }
  const shooterStatus = statusTotals(shooter.statuses)
  const targetStatus = statusTotals(target.statuses)

  const hidden = fromBehind ? 0 : AIM.evasionShrink * (Math.max(0, target.evasion) + targetStatus.defenceBonus)
  const w = AIM.targetSize * visibleShare(cover, target.isCrouching) * Math.max(0.05, 1 - hidden)
  const tighten = clamp(
    1 - AIM.trainingTighten * (shooter.proficiency - shooterStatus.accuracyPenalty),
    0.2,
    3,
  )
  const e = (eff.sway + eff.spread * distance) * tighten
  // The ceiling holds for every line — nothing is certain — but the floor is
  // the round's: nine pellets each forced up to five percent would make a
  // shell across the map land a third of the time.
  const one = Math.min((w * w) / (w * w + e * e), AIM.max / 100)

  // Repeated multiplication rather than a power: it has to agree bit for bit
  // on both peers, and there are at most a handful of pellets.
  let allMiss = 1
  for (let i = 0; i < eff.pellets; i++) allMiss *= 1 - one
  const floor = AIM.min / 100
  const any = Math.max(1 - allMiss, floor)
  // A single line forced up to the floor has to roll against the floor too.
  const line = eff.pellets === 1 ? any : one

  return {
    chance: Math.round(any * 100),
    projectile: Math.round(line * 100),
    landed: Math.max(1, (eff.pellets * line) / any),
    distance,
    outOfRange: false,
  }
}

/**
 * Damage one round can be expected to do: the chance it lands, times what it
 * does when it does — for buckshot, with the pellets expected to land at that
 * distance. The one estimate the planner's panel and every AI weighs a round
 * by, so a shotgun is never priced as if all nine pellets landed every time.
 */
export function expectedRoundDamage(eff: EffectiveWeapon, target: CombatantStats, odds: ShotOdds): number {
  if (odds.outOfRange || odds.chance === 0) return 0
  return (odds.chance / 100) * resolveDamage(eff, target, 1, false, Math.max(1, odds.landed)).damage
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

/**
 * The chance, in percent, that a round or blow which lands starts `target`
 * bleeding (`StatusKind.Bleeding`).
 *
 * Built like a critical's (`critBreakdown`): the weapon sets the odds, the
 * target's armour covers what a wound needs to reach — unless the round goes
 * through it — and a target that cannot bleed ends the question. No distance
 * term: a round opens a wound wherever it was fired from.
 */
export function bleedChance(eff: EffectiveWeapon, target: CombatantStats): number {
  if (target.bleedImmune || eff.bleedChance <= 0) return 0
  const armorTerm = BLEED.armorResist * Math.max(0, target.armor) * (1 - eff.armorPen)
  return clamp(Math.round(eff.bleedChance - armorTerm), 0, BLEED.max)
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
  /**
   * Projectiles of the round that landed. Armour is taken off the round's
   * total once, not off each projectile, and the floor is per round: buckshot
   * is impact, so plate that would stop any one pellet blunts a full shell and
   * does not zero it.
   */
  landed = 1,
): DamageResult {
  const status = statusTotals(target.statuses)
  const multiplier = crit ? eff.critMultiplier : 1
  // Gear and statuses pull on the same number, so they add rather than
  // compounding: a plated unit under a shred takes both.
  const raw =
    eff.damage *
    landed *
    falloff *
    multiplier *
    Math.max(0, 1 + status.damageTakenBonus + target.damageTaken)
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
export function grenadeDamageAt(
  spec: GrenadeSpec,
  distance: number,
  target: CombatantStats,
  cover: CoverLevel = CoverLevel.None,
): DamageResult {
  const falloff = blastFalloff(distance, spec.areaRadius)
  if (falloff === 0) return { damage: 0, armorShred: 0, absorbed: 0, crit: false }
  const status = statusTotals(target.statuses)

  // Walls and cover shield against the blast wave, but fragments and pressure still deal partial damage
  // Tall cover (solid wall) shields 50% damage; Low cover (half-block/parapet) shields 25%
  const coverMultiplier = cover === CoverLevel.Tall ? 0.5 : cover === CoverLevel.Low ? 0.75 : 1.0

  // Explosives ignore worn armour far more than bullets do: the blast wave gets
  // through regardless, so only a quarter of armour applies.
  const armorInPlay = Math.max(0, target.armor) * 0.25
  const raw = spec.damage * falloff * coverMultiplier * (1 + status.damageTakenBonus)
  return {
    damage: spec.damage === 0 ? 0 : Math.max(AIM.minDamage, Math.round(raw - armorInPlay)),
    armorShred: Math.round(spec.armorShred * falloff * coverMultiplier),
    absorbed: Math.round(Math.min(armorInPlay, raw)),
    crit: false,
  }
}

/** Every term behind a melee chance, so the HUD can explain the number. */
export interface MeleeBreakdown {
  /** Final clamped percentage. */
  chance: number
  /** The sidearm's own chance. */
  base: number
  /** What the attacker's Strength added. */
  skill: number
  /** What the defender's hands took off: sidearm parry plus primary weapon handling. */
  parry: number
  /** The defender's own evasion. */
  evasion: number
  attackerPenalty: number
  defenderBonus: number
}

/**
 * Chance a blow lands.
 *
 * A contest folded into one roll: the attacker's weapon and Strength against
 * the defender's Agility and what they are holding. Deliberately missing are
 * the terms a shot is mostly made of — no range, no cover, no ammunition —
 * because there is no space between the two people for any of them to act on.
 * That absence is what melee is *for*: a soldier in good cover is close to
 * unshootable and completely reachable.
 *
 * From behind, the defender has no say at all: no parry, no dodge, no status
 * to brace with. Only the attacker's own condition still counts.
 *
 * One number drawn from the match stream rather than two opposed rolls: the
 * same shape of answer for half the dice.
 */
export function meleeChance(attacker: CombatantStats, defender: CombatantStats, fromBehind = false): MeleeBreakdown {
  const spec = MELEE[attacker.sidearm]
  const attackerStatus = statusTotals(attacker.statuses)
  const defenderStatus = statusTotals(defender.statuses)
  const parry = fromBehind ? 0 : MELEE[defender.sidearm].parry + LONG_GUN_PARRY[defender.weapon.id]
  const evasion = fromBehind ? 0 : Math.max(0, defender.evasion)
  const defenderBonus = fromBehind ? 0 : defenderStatus.defenceBonus
  const raw = spec.accuracy + attacker.meleeSkill - parry - evasion - attackerStatus.accuracyPenalty - defenderBonus
  return {
    chance: clamp(Math.round(raw), AIM.min, AIM.max),
    base: spec.accuracy,
    skill: attacker.meleeSkill,
    parry,
    evasion,
    attackerPenalty: attackerStatus.accuracyPenalty,
    defenderBonus,
  }
}

/**
 * A sidearm in the shape damage and crits are resolved in.
 *
 * Melee changes the terms feeding the damage arithmetic, not the arithmetic:
 * armour subtracts and penetration decides how much of it counts, a crit
 * multiplies before armour, exactly as for a round. Reach and range bias are
 * zero, so the crit chance has no distance term; the unit's own crit traits
 * apply, because they are about where the unit puts its blows. A blow from
 * behind is multiplied by the sidearm's own `fromBehind`.
 */
export function meleeWeapon(attacker: CombatantStats, fromBehind = false): EffectiveWeapon {
  const spec = MELEE[attacker.sidearm]
  return {
    weapon: attacker.weapon,
    apCost: spec.apCost,
    sway: 0,
    spread: 0,
    pellets: 1,
    damage: spec.damage * (1 + attacker.meleePower / 100) * (fromBehind ? spec.fromBehind : 1),
    armorPen: spec.armorPen,
    armorShred: spec.armorShred,
    areaRadius: 0,
    maxRange: 0,
    critChance: spec.critChance > 0 ? spec.critChance + attacker.critChanceBonus : 0,
    critMultiplier: Math.max(1, spec.critMultiplier + (spec.critChance > 0 ? attacker.critMultiplierBonus : 0)),
    critRangeBias: 0,
    bleedChance: spec.bleedChance,
  }
}

/** The continuous path and landing tile of a thrown projectile. */
export interface ThrowPath {
  /** Continuous 2D coordinates of the trajectory keypoints (start, bounce vertices, end). */
  points: { x: number; y: number }[]
  /** Tiles the grenade passes through in order. */
  path: Tile[]
  /** The final resting tile. */
  end: Tile
}

/** Grid interface subset needed by trajectory raycasting. */
export interface TrajectoryGrid {
  wallAt(x: number, y: number, side: Side): WallKind
  wallTop(x: number, y: number, side: Side): number
  levelAt(x: number, y: number): number
  roofAt?(x: number, y: number): number
  inBounds(x: number, y: number): boolean
}

/**
 * Cast a 3D parabolic ray for a grenade throw, reflecting off walls when flight height is below the wall top.
 *
 * The throw travels along `angleRad` for up to `distance` (capped at `maxRange`),
 * with vertical arc height `1.2 + sin(progress * PI) * arcHeight`.
 * A wall collision triggers a bounce only if `currentFlightY < wallTop`.
 * If flight height clears the wall, it sails over (e.g. onto roofs/upper floors).
 */
export function castThrowTrajectory(
  grid: TrajectoryGrid,
  from: Tile,
  angleRad: number,
  distance: number,
  maxRange: number,
  observerFloorY: number,
): ThrowPath {
  const totalDist = Math.min(Math.max(0, distance), maxRange)
  let distLeft = totalDist
  if (distLeft <= 0) {
    return {
      points: [{ x: from.x + 0.5, y: from.y + 0.5 }],
      path: [{ ...from }],
      end: { ...from },
    }
  }

  const fromRoof = grid.roofAt ? grid.roofAt(from.x, from.y) : 0
  const fromFloor = grid.levelAt(from.x, from.y)
  const throwerIndoors = fromRoof > fromFloor

  // When indoors, ceiling restricts the arc to a low throw (e.g. 0.2m) under the roof
  const arcHeight = throwerIndoors
    ? Math.min(0.25, Math.max(0.1, totalDist * 0.05))
    : Math.min(2.5, Math.max(0.6, totalDist * 0.25))

  let vx = Math.cos(angleRad)
  let vy = Math.sin(angleRad)
  let px = from.x + 0.5
  let py = from.y + 0.5
  let cx = from.x
  let cy = from.y

  const points: { x: number; y: number }[] = [{ x: px, y: py }]
  const path: Tile[] = [{ x: cx, y: cy }]
  let steps = 0

  while (distLeft > 1e-4 && steps < 100) {
    steps++
    const progress = totalDist > 0 ? (totalDist - distLeft) / totalDist : 0
    const currentFlightY = observerFloorY + 1.2 + Math.sin(progress * Math.PI) * arcHeight

    const tileX = Math.floor(px)
    const tileY = Math.floor(py)
    const roofLevel = grid.roofAt ? grid.roofAt(tileX, tileY) : 0
    const floorLevel = grid.levelAt(tileX, tileY)
    // If thrower is outdoors and tile is roofed, surface is the roof; if thrower is indoors, surface is the room floor
    const surfaceHeight = (!throwerIndoors && roofLevel > 0 ? Math.max(roofLevel, floorLevel) : floorLevel) * LEVEL_HEIGHT

    // If descending (past arc midpoint progress > 0.5) and the flight height has reached the surface
    if (progress > 0.5 && currentFlightY <= surfaceHeight + 0.05) {
      distLeft = 0
      break
    }

    const tNextX = Math.abs(vx) > 1e-6 ? (vx > 0 ? cx + 1 - px : px - cx) / Math.abs(vx) : Infinity
    const tNextY = Math.abs(vy) > 1e-6 ? (vy > 0 ? cy + 1 - py : py - cy) / Math.abs(vy) : Infinity
    const tNext = Math.min(tNextX, tNextY)

    if (tNext > distLeft) {
      px += vx * distLeft
      py += vy * distLeft
      distLeft = 0
      break
    }

    px += vx * tNext
    py += vy * tNext
    distLeft -= tNext

    const nextProgress = totalDist > 0 ? (totalDist - distLeft) / totalDist : 0
    const nextFlightY = observerFloorY + 1.2 + Math.sin(nextProgress * Math.PI) * arcHeight

    let bounceX = false
    let bounceY = false

    if (Math.abs(tNext - tNextX) < 1e-6) {
      const nextCx = cx + Math.sign(vx)
      const side = vx > 0 ? Side.East : Side.West
      const kind = grid.wallAt(cx, cy, side)
      const top = grid.wallTop(cx, cy, side)
      if (kind !== WallKind.None && kind !== WallKind.DoorOpen && kind !== WallKind.Glass && nextFlightY < top) {
        bounceX = true
      } else {
        cx = nextCx
      }
    }

    if (Math.abs(tNext - tNextY) < 1e-6) {
      const nextCy = cy + Math.sign(vy)
      const side = vy > 0 ? Side.South : Side.North
      const kind = grid.wallAt(cx, cy, side)
      const top = grid.wallTop(cx, cy, side)
      if (kind !== WallKind.None && kind !== WallKind.DoorOpen && kind !== WallKind.Glass && nextFlightY < top) {
        bounceY = true
      } else {
        cy = nextCy
      }
    }

    if (bounceX || bounceY) {
      // Record exact continuous collision / bounce vertex
      points.push({ x: px, y: py })
    }

    if (bounceX) {
      vx = -vx
      px += vx * 1e-4
    }
    if (bounceY) {
      vy = -vy
      py += vy * 1e-4
    }

    const last = path[path.length - 1]
    if (!last || last.x !== cx || last.y !== cy) {
      path.push({ x: cx, y: cy })
    }
  }

  // Add final continuous landing point
  points.push({ x: px, y: py })

  // Final tile is determined by floor coordinate Math.floor(p)
  const finalTile = {
    x: Math.floor(px),
    y: Math.floor(py),
  }

  return {
    points,
    path,
    end: finalTile,
  }
}

/**
 * Calculate intended throw trajectory from `from` towards `target`.
 */
export function calculateIntendedThrow(
  grid: TrajectoryGrid,
  from: Tile,
  target: Tile,
  maxRange: number,
): ThrowPath {
  const dx = target.x - from.x
  const dy = target.y - from.y
  const dist = distance(dx, dy)
  if (dist <= 0) return { points: [{ x: from.x + 0.5, y: from.y + 0.5 }], path: [{ ...from }], end: { ...from } }
  const angle = throwAngle(dy, dx)
  const floorY = grid.levelAt(from.x, from.y) * LEVEL_HEIGHT
  return castThrowTrajectory(grid, from, angle, dist, maxRange, floorY)
}

