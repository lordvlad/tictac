import type { Grid, Tile } from '../core/Grid'
import { shotCoverLevel } from '../core/Cover'
import {
  type CombatantStats,
  critBreakdown,
  type EffectiveWeapon,
  effectiveWeapon,
  grenadeDamageAt,
  type HitChanceBreakdown,
  hitChance,
  resolveDamage,
} from '../core/Ballistics'
import { type GrenadeId, ShotMode, STATUSES, type StatusKind } from '../core/Arsenal'
import type { Soldier } from '../entities/Soldier'
import type { Tracers } from '../render/Tracers'

export interface ShotResult {
  hit: boolean
  damage: number
  /** Armour points stripped from the target. */
  armorShred: number
  killed: boolean
  hitChance: number
  apSpent: number
  /** How many of the rounds that landed landed as criticals. */
  crits: number
  /** Per-victim breakdown, so a peer can replay this shot without recomputing. */
  hits: ResolvedHit[]
}

/** One unit's share of an attack, already resolved: a bullet hit or a blast hit. */
export interface ResolvedHit {
  soldier: Soldier
  damage: number
  armorShred: number
  killed: boolean
  status: StatusKind | null
  /** True when the crit multiplier was in this number. Display only — the
   *  damage has already been resolved with it. */
  crit: boolean
}

export interface GrenadeResult {
  thrown: boolean
  apSpent: number
  hits: ResolvedHit[]
}

/** Hit chance plus every term that produced it, for the HUD to explain. */
export function shotBreakdown(
  grid: Grid,
  shooter: Soldier,
  target: Soldier,
  mode: ShotMode = ShotMode.Snap,
): HitChanceBreakdown {
  return hitChance(
    shooter,
    target,
    grid.distance(shooter.tile, target.tile),
    shotCoverLevel(grid, shooter.tile, target.tile),
    mode,
  )
}

/** Just the percentage — the common case for lists and labels. */
export function calculateHitChance(
  grid: Grid,
  shooter: Soldier,
  target: Soldier,
  mode: ShotMode = ShotMode.Snap,
): number {
  return shotBreakdown(grid, shooter, target, mode).chance
}

/** AP a shot would cost, with the loaded round and shot mode folded in. */
export function shotApCost(shooter: Soldier, mode: ShotMode = ShotMode.Snap): number {
  return effectiveWeapon(shooter, mode).apCost
}

/** Can this shot legally be taken right now? */
export function canShoot(
  grid: Grid,
  shooter: Soldier,
  target: Soldier,
  mode: ShotMode = ShotMode.Snap,
): boolean {
  if (shooter.isDead || target.isDead) return false
  const eff = effectiveWeapon(shooter, mode)
  if (shooter.ap < eff.apCost) return false
  return grid.distance(shooter.tile, target.tile) <= eff.maxRange
}

/**
 * Fire at a target.
 *
 * Splash weapons resolve their blast through the same path grenades use, so a
 * weapon with `areaRadius > 0` damages everything near the point of impact.
 *
 * A crit is rolled per round that lands, against the chance the weapon, the
 * distance and the target's armour produce. It is never taken from
 * `overrideRolls`: those are the planner's hit dice, and the panel promises a
 * crit *chance*, not a crit. Splash damage off a critical round is ordinary —
 * the placement was on the body the bullet hit, not on the blast.
 */
export function executeShot(
  grid: Grid,
  shooter: Soldier,
  target: Soldier,
  tracers: Tracers,
  soldiers: readonly Soldier[],
  mode: ShotMode = ShotMode.Snap,
  overrideRolls?: boolean[],
): ShotResult {
  const eff = effectiveWeapon(shooter, mode)
  if (!canShoot(grid, shooter, target, mode)) {
    return {
      hit: false,
      damage: 0,
      armorShred: 0,
      killed: false,
      hitChance: 0,
      apSpent: 0,
      crits: 0,
      hits: [],
    }
  }

  shooter.ap = Math.max(0, shooter.ap - eff.apCost)

  const chance = calculateHitChance(grid, shooter, target, mode)
  const crit = critBreakdown(eff, target, grid.distance(shooter.tile, target.tile))
  const shooterWorld = grid.tileToWorld(shooter.tile)
  const targetWorld = grid.tileToWorld(target.tile)

  // Face the target. Same yaw convention as movement: forward = (sin y, cos y).
  const dx = targetWorld.x - shooterWorld.x
  const dz = targetWorld.z - shooterWorld.z
  if (Math.hypot(dx, dz) > 0.01) shooter.targetYaw = Math.atan2(dx, dz)

  const bullets = eff.weapon.bulletConsumption(mode)
  const hits: ResolvedHit[] = []
  let totalDamage = 0
  let totalArmorShred = 0
  let anyHit = false
  let killed = false
  let crits = 0

  for (let i = 0; i < bullets; i++) {
    const hit = overrideRolls ? (overrideRolls[i] ?? false) : Math.random() * 100 <= chance
    if (hit) anyHit = true

    tracers.spawnTracer(shooterWorld, targetWorld, hit)
    // Only the first tracer-spawn plays the sound/visual cue
    if (i === 0) shooter.playShoot()

    if (hit) {
      const critical = Math.random() * 100 <= crit.chance
      if (critical) crits++
      const primary = applyWeaponDamage(eff, target, 1, critical)
      hits.push(primary)
      totalDamage += primary.damage
      totalArmorShred += primary.armorShred
      if (target.isDead) killed = true

      if (eff.areaRadius > 0) {
        for (const other of soldiers) {
          if (other === target || other.isDead) continue
          const distance = grid.distance(target.tile, other.tile)
          if (distance > eff.areaRadius) continue
          const area = applyWeaponDamage(eff, other, 1 - distance / (eff.areaRadius + 1))
          hits.push(area)
          totalDamage += area.damage
          totalArmorShred += area.armorShred
          if (other.isDead) killed = true
        }
      }
    }
  }

  return {
    hit: anyHit,
    damage: totalDamage,
    armorShred: totalArmorShred,
    killed,
    hitChance: chance,
    apSpent: eff.apCost,
    crits,
    hits,
  }
}

/**
 * Apply an already-resolved hit. Takes numbers, never recomputes them.
 *
 * The one copy of the clamp-and-animate rule, shared by the local paths and by
 * a peer's replay — where the numbers arrive off the wire and the weapon that
 * produced them does not exist on this side.
 */
export function applyHitEffects(
  target: Soldier,
  damage: number,
  armorShred: number,
  status: StatusKind | null,
): void {
  target.armor = Math.max(0, target.armor - armorShred)
  if (damage > 0) target.hp = Math.max(0, target.hp - damage)
  if (status) applyStatus(target, status)
  if (target.isDead) target.playDeath()
  else if (damage > 0) target.playHit()
}

function applyWeaponDamage(
  eff: EffectiveWeapon,
  target: Soldier,
  falloff = 1,
  crit = false,
): ResolvedHit {
  const result = resolveDamage(eff, target, falloff, crit)
  applyHitEffects(target, result.damage, result.armorShred, null)
  return {
    soldier: target,
    damage: result.damage,
    armorShred: result.armorShred,
    killed: target.isDead,
    status: null,
    crit: result.crit,
  }
}

/**
 * Throw a grenade at a tile.
 *
 * Blast effects are resolved per unit by distance from the centre, and the
 * grenade's status (shredded / flashed / smoked) is applied to everyone caught —
 * including your own squad, because a frag does not check uniforms.
 */
export function throwGrenade(
  grid: Grid,
  thrower: Soldier,
  at: Tile,
  kind: GrenadeId,
  soldiers: readonly Soldier[],
): GrenadeResult {
  const spec = thrower.grenadeSpecs[kind]
  if (thrower.isDead || thrower.ap < spec.apCost) return { thrown: false, apSpent: 0, hits: [] }
  if ((thrower.grenades[kind] ?? 0) <= 0) return { thrown: false, apSpent: 0, hits: [] }
  if (grid.distance(thrower.tile, at) > spec.throwRange) return { thrown: false, apSpent: 0, hits: [] }

  thrower.ap = Math.max(0, thrower.ap - spec.apCost)
  thrower.grenades[kind] -= 1
  thrower.playShoot()

  const hits: ResolvedHit[] = []
  for (const soldier of soldiers) {
    if (soldier.isDead) continue
    const distance = grid.distance(at, soldier.tile)
    if (distance > spec.areaRadius) continue

    const result = grenadeDamageAt(spec, distance, soldier)
    applyHitEffects(soldier, result.damage, result.armorShred, spec.applies)

    hits.push({
      soldier,
      damage: result.damage,
      armorShred: result.armorShred,
      killed: soldier.isDead,
      status: spec.applies,
      crit: false,
    })
  }

  return { thrown: true, apSpent: spec.apCost, hits }
}

/** Apply (or refresh) a status on a unit. */
export function applyStatus(soldier: Soldier, kind: StatusKind): void {
  const spec = STATUSES[kind]
  const existing = soldier.statuses.find((s) => s.kind === kind)
  if (existing) existing.turnsLeft = spec.turns
  else soldier.statuses.push({ kind, turnsLeft: spec.turns })
}

/**
 * Count down every unit's statuses by one turn and drop the expired ones.
 *
 * A lapsed stim lowers the action-point ceiling, so anything held above the
 * new ceiling is given back rather than left as a permanent surplus.
 */
export function tickStatuses(soldiers: readonly Soldier[]): void {
  for (const soldier of soldiers) {
    if (soldier.statuses.length === 0) continue
    for (const status of soldier.statuses) status.turnsLeft -= 1
    soldier.statuses = soldier.statuses.filter((s) => s.turnsLeft > 0)
    soldier.ap = Math.min(soldier.ap, soldier.effectiveMaxAp)
  }
}
