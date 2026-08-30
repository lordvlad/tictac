import { AIM, BULLET_DAMAGE, COVER, SHOOT_AP_COST } from '../config'
import type { Grid } from '../core/Grid'
import { CoverLevel, shotCoverLevel } from '../core/Cover'
import { clamp } from '../core/math'
import type { Soldier } from '../entities/Soldier'
import type { Tracers } from '../render/Tracers'

export interface ShotResult {
  hit: boolean
  damage: number
  killed: boolean
  hitChance: number
}

/** Accuracy the shooter loses, given the cover crossed and the target's stance. */
export function coverPenalty(level: CoverLevel, crouching: boolean): number {
  if (level === CoverLevel.Tall) return crouching ? COVER.tallCrouch : COVER.tallStand
  if (level === CoverLevel.Low) return crouching ? COVER.lowCrouch : COVER.lowStand
  return crouching ? COVER.openCrouch : 0
}

/**
 * Calculate hit percentage (5% - 95%). Cover is taken from the side of the
 * target the bullet actually crosses (see {@link shotCoverLevel}).
 */
export function calculateHitChance(grid: Grid, shooter: Soldier, target: Soldier): number {
  const dist = grid.distance(shooter.tile, target.tile)
  const rangePenalty = dist * AIM.perMetre
  const level = shotCoverLevel(grid, shooter.tile, target.tile)

  const rawChance = AIM.base - rangePenalty - coverPenalty(level, target.isCrouching)
  return clamp(Math.round(rawChance), AIM.min, AIM.max)
}

/**
 * Execute a shot action.
 */
export function executeShot(
  grid: Grid,
  shooter: Soldier,
  target: Soldier,
  tracers: Tracers,
): ShotResult {
  if (shooter.ap < SHOOT_AP_COST) {
    return { hit: false, damage: 0, killed: false, hitChance: 0 }
  }

  shooter.ap -= SHOOT_AP_COST

  const hitChance = calculateHitChance(grid, shooter, target)
  const roll = Math.random() * 100
  const hit = roll <= hitChance

  const shooterWorld = grid.tileToWorld(shooter.tile)
  const targetWorld = grid.tileToWorld(target.tile)

  // Face the target. Same yaw convention as movement: forward = (sin y, cos y).
  const dx = targetWorld.x - shooterWorld.x
  const dz = targetWorld.z - shooterWorld.z
  if (Math.hypot(dx, dz) > 0.01) {
    shooter.targetYaw = Math.atan2(dx, dz)
  }

  tracers.spawnTracer(shooterWorld, targetWorld, hit)

  let damage = 0
  let killed = false

  shooter.playShoot()

  if (hit) {
    damage = BULLET_DAMAGE
    target.hp = Math.max(0, target.hp - damage)
    killed = target.isDead

    if (killed) {
      target.playDeath()
    } else {
      target.playHit()
    }
  }

  return { hit, damage, killed, hitChance }
}
