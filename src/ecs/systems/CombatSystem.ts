import { System } from '../System'
import type { World } from '../World'
import { StanceComponent } from '../components/StanceComponent'
import { RULES } from '../../config'
import type { GrenadeId, ShotMode } from '../../core/Arsenal'
import type { Tile } from '../../core/Grid'
import type { Grid } from '../../core/Grid'
import type { Soldier } from '../../entities/Soldier'
import type { Squads } from '../../game/Squads'
import type { Tracers } from '../../render/Tracers'
import {
  canShoot,
  executeShot,
  type GrenadeResult,
  type ShotResult,
  throwGrenade,
} from '../../game/Combat'

/**
 * The single entry point for anything that spends AP to hurt someone.
 *
 * Resolution itself lives in {@link Combat} — cover, penetration, falloff and
 * status effects are one body of rules, and duplicating them here is how the
 * two copies drift. What this adds is that every path, local or replayed from
 * a peer, goes through the same door.
 */
export class CombatSystem extends System {
  constructor(
    private readonly grid: Grid,
    private readonly squads: Squads,
    private readonly tracers: Tracers,
  ) {
    super()
  }

  update(): void {
    // Combat is command driven; nothing to advance per tick.
  }
  canFire(shooter: Soldier, target: Soldier, mode: ShotMode): boolean {
    return canShoot(this.grid, shooter, target, mode)
  }

  /** Fired after a shot resolves, for damage numbers and target bookkeeping. */
  onShotResolved?: (shooter: Soldier, target: Soldier, result: ShotResult) => void

  /**
   * Fire at a target. `rolls` replays the shooter's dice on the other peer, so
   * both sides resolve the identical outcome; `force` skips the legality check
   * for a shot the originating peer already validated.
   */
  fireShot(
    shooter: Soldier,
    target: Soldier,
    mode: ShotMode,
    rolls?: boolean[],
    force = false,
  ): ShotResult | null {
    if (!force && !canShoot(this.grid, shooter, target, mode)) return null

    const consumption = shooter.weapon.bulletConsumption(mode)
    shooter.weapon.currentClip = Math.max(0, shooter.weapon.currentClip - consumption)

    const result = executeShot(
      this.grid,
      shooter,
      target,
      this.tracers,
      this.squads.soldiers,
      mode,
      rolls,
      force,
    )
    if (!result.apSpent) return null
    this.onShotResolved?.(shooter, target, result)
    return result
  }
  throwGrenade(thrower: Soldier, at: Tile, kind: GrenadeId, force = false): GrenadeResult {
    return throwGrenade(this.grid, thrower, at, kind, this.squads.soldiers, force)
  }

  reload(soldier: Soldier): boolean {
    if (soldier.isDead || soldier.ap < RULES.reloadApCost) return false
    if (soldier.weapon.currentClip >= soldier.weapon.maxClip) return false
    soldier.ap = Math.max(0, soldier.ap - RULES.reloadApCost)
    soldier.weapon.currentClip = soldier.weapon.maxClip
    return true
  }

  /**
   * Stand up (free) or hunker down (costs AP).
   *
   * @returns false when the unit cannot afford to take cover.
   */
  toggleCover(world: World, entityId: number): boolean {
    const soldier = this.squads.byEntityId(entityId)
    if (!soldier || soldier.isDead) return false
    const stance = world.getComponent(entityId, StanceComponent)
    if (!stance || stance.isMoving) return false

    if (stance.isCrouching) {
      soldier.exitCover()
      return true
    }
    if (soldier.ap < RULES.coverApCost) return false
    soldier.ap -= RULES.coverApCost
    soldier.enterCover()
    return true
  }
}
