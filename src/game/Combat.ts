import type { Grid, Tile } from '../core/Grid'
import { shotCoverLevel } from '../core/Cover'
import {
  type CombatantStats,
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
}

/** One unit caught by an area effect. */
export interface BlastHit {
  soldier: Soldier
  damage: number
  armorShred: number
  killed: boolean
  status: StatusKind | null
}

export interface GrenadeResult {
  thrown: boolean
  apSpent: number
  hits: BlastHit[]
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
 */
export function executeShot(
  grid: Grid,
  shooter: Soldier,
  target: Soldier,
  tracers: Tracers,
  soldiers: readonly Soldier[],
  mode: ShotMode = ShotMode.Snap,
  overrideRolls?: boolean[],
  force = false,
): ShotResult {
  const eff = effectiveWeapon(shooter, mode)
  if (!force && !canShoot(grid, shooter, target, mode)) {
    return { hit: false, damage: 0, armorShred: 0, killed: false, hitChance: 0, apSpent: 0 }
  }

  shooter.ap = Math.max(0, shooter.ap - eff.apCost)

  const chance = calculateHitChance(grid, shooter, target, mode)
  const shooterWorld = grid.tileToWorld(shooter.tile)
  const targetWorld = grid.tileToWorld(target.tile)

  // Face the target. Same yaw convention as movement: forward = (sin y, cos y).
  const dx = targetWorld.x - shooterWorld.x
  const dz = targetWorld.z - shooterWorld.z
  if (Math.hypot(dx, dz) > 0.01) shooter.targetYaw = Math.atan2(dx, dz)

  const bullets = eff.weapon.bulletConsumption(mode)
  let totalDamage = 0
  let totalArmorShred = 0
  let anyHit = false
  let killed = false

  for (let i = 0; i < bullets; i++) {
    const hit = overrideRolls ? (overrideRolls[i] ?? false) : Math.random() * 100 <= chance
    if (hit) anyHit = true

    tracers.spawnTracer(shooterWorld, targetWorld, hit)
    // Only the first tracer-spawn plays the sound/visual cue
    if (i === 0) shooter.playShoot()

    if (hit) {
      const primary = applyWeaponDamage(eff, target)
      totalDamage += primary.damage
      totalArmorShred += primary.armorShred
      if (target.isDead) killed = true

      if (eff.areaRadius > 0) {
        for (const other of soldiers) {
          if (other === target || other.isDead) continue
          const distance = grid.distance(target.tile, other.tile)
          if (distance > eff.areaRadius) continue
          const area = applyWeaponDamage(eff, other, 1 - distance / (eff.areaRadius + 1))
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
  }
}

function applyWeaponDamage(
  eff: EffectiveWeapon,
  target: Soldier,
  falloff = 1,
): { damage: number; armorShred: number } {
  const result = resolveDamage(eff, target, falloff)
  target.armor = Math.max(0, target.armor - result.armorShred)
  target.hp = Math.max(0, target.hp - result.damage)
  if (target.isDead) target.playDeath()
  else target.playHit()
  return { damage: result.damage, armorShred: result.armorShred }
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
  force = false,
): GrenadeResult {
  const spec = thrower.grenadeSpecs[kind]
  if (!force) {
    if (thrower.isDead || thrower.ap < spec.apCost) return { thrown: false, apSpent: 0, hits: [] }
    if ((thrower.grenades[kind] ?? 0) <= 0) return { thrown: false, apSpent: 0, hits: [] }
    if (grid.distance(thrower.tile, at) > spec.throwRange) return { thrown: false, apSpent: 0, hits: [] }
  }

  thrower.ap = Math.max(0, thrower.ap - spec.apCost)
  thrower.grenades[kind] -= 1
  thrower.playShoot()

  const hits: BlastHit[] = []
  for (const soldier of soldiers) {
    if (soldier.isDead) continue
    const distance = grid.distance(at, soldier.tile)
    if (distance > spec.areaRadius) continue

    const result = grenadeDamageAt(spec, distance, soldier)
    soldier.armor = Math.max(0, soldier.armor - result.armorShred)
    if (result.damage > 0) {
      soldier.hp = Math.max(0, soldier.hp - result.damage)
      if (soldier.isDead) soldier.playDeath()
      else soldier.playHit()
    }
    if (spec.applies) applyStatus(soldier, spec.applies)

    hits.push({
      soldier,
      damage: result.damage,
      armorShred: result.armorShred,
      killed: soldier.isDead,
      status: spec.applies,
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

/** Count down every unit's statuses by one turn and drop the expired ones. */
export function tickStatuses(soldiers: readonly Soldier[]): void {
  for (const soldier of soldiers) {
    if (soldier.statuses.length === 0) continue
    for (const status of soldier.statuses) status.turnsLeft -= 1
    soldier.statuses = soldier.statuses.filter((s) => s.turnsLeft > 0)
  }
}
