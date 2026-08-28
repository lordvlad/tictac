import { AIM, BULLET_DAMAGE, SHOOT_AP_COST } from '../config'
import { Block, type Grid, type Tile } from '../core/Grid'
import type { Soldier } from '../entities/Soldier'
import type { Tracers } from '../render/Tracers'

export interface ShotResult {
  hit: boolean
  damage: number
  killed: boolean
  hitChance: number
}

/**
 * Determine cover penalty for a target relative to a shooter.
 */
export function getCoverPenalty(grid: Grid, shooterTile: Tile, targetTile: Tile): { penalty: number; coverType: 'none' | 'half' | 'full' } {
  const dx = Math.sign(shooterTile.x - targetTile.x)
  const dy = Math.sign(shooterTile.y - targetTile.y)

  // Check adjacent tiles to target in shooter direction
  const adjX = targetTile.x + dx
  const adjY = targetTile.y + dy

  let bestCover: Block = Block.None
  if (grid.inBounds(adjX, targetTile.y)) {
    const b = grid.blockAt(adjX, targetTile.y)
    if (b > bestCover) bestCover = b
  }
  if (grid.inBounds(targetTile.x, adjY)) {
    const b = grid.blockAt(targetTile.x, adjY)
    if (b > bestCover) bestCover = b
  }

  if (bestCover === Block.Full) {
    return { penalty: AIM.fullCoverPenalty, coverType: 'full' }
  } else if (bestCover === Block.Half) {
    return { penalty: AIM.halfCoverPenalty, coverType: 'half' }
  }

  return { penalty: 0, coverType: 'none' }
}

/**
 * Calculate hit percentage (5% - 95%).
 */
export function calculateHitChance(grid: Grid, shooter: Soldier, target: Soldier): number {
  const dist = grid.distance(shooter.tile, target.tile)
  const rangePenalty = dist * AIM.perMetre
  const cover = getCoverPenalty(grid, shooter.tile, target.tile)

  const crouchPenalty = target.isCrouching ? AIM.crouchPenalty : 0
  const rawChance = AIM.base - rangePenalty - cover.penalty - crouchPenalty
  return Math.max(AIM.min, Math.min(AIM.max, Math.round(rawChance)))
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
