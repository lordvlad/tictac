import { System } from '../System'
import type { World } from '../World'
import { StanceComponent } from '../components/StanceComponent'
import { RULES } from '../../config'
import type { GrenadeId, ShotMode } from '../../core/Arsenal'
import type { Tile } from '../../core/Grid'
import type { Grid } from '../../core/Grid'
import type { Soldier } from '../../entities/Soldier'
import type { Squads } from '../../game/Squads'
import { NO_FX, type CombatFx } from '../../core/Combatant'
import type { Roll } from '../../core/rng'
import {
  applyHitEffects,
  canShoot,
  fireWeapon,
  type GrenadeResult,
  type ResolvedHit,
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
    private readonly fx: CombatFx = NO_FX,
    private readonly roll: Roll = Math.random,
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
   * Fire at a target this side owns. `rolls` are the shooter's dice, pre-rolled
   * by the planner so the HUD and the resolution agree on the same outcome.
   *
   * A peer's shot never comes through here — it arrives already resolved and
   * goes to {@link replayShot}.
   */
  fireShot(shooter: Soldier, target: Soldier, mode: ShotMode, rolls?: boolean[]): ShotResult | null {
    const result = fireWeapon(
      this.grid,
      shooter,
      target,
      this.fx,
      this.squads.soldiers,
      mode,
      rolls,
      this.roll,
    )
    if (!result) return null
    this.onShotResolved?.(shooter, target, result)
    return result
  }

  /**
   * Replay a peer's shot.
   *
   * The peer resolved it against its own loadout and sent the outcome, so
   * nothing here is recomputed: this side holds only the stock copy of that
   * weapon and must not consult it. The shooter's clip and AP arrive by
   * component replication, not from these numbers.
   */
  replayShot(
    shooter: Soldier,
    target: Soldier,
    rolls: readonly boolean[],
    hits: readonly ResolvedHit[],
  ): ShotResult {
    const from = this.grid.tileToWorld(shooter.tile)
    const to = this.grid.tileToWorld(target.tile)

    for (let i = 0; i < rolls.length; i++) {
      this.fx.tracer(from, to, rolls[i] ?? false)
      if (i === 0) this.fx.shoot(shooter)
    }

    let damage = 0
    let armorShred = 0
    for (const hit of hits) {
      applyHitEffects(hit.soldier, hit.damage, hit.armorShred, hit.status, this.fx)
      damage += hit.damage
      armorShred += hit.armorShred
    }

    const result: ShotResult = {
      hit: rolls.some(Boolean),
      damage,
      armorShred,
      killed: hits.some((hit) => hit.soldier.isDead),
      hitChance: 0,
      apSpent: 0,
      // Read off the peer's hits, never re-rolled: the crit is in the damage
      // they already resolved.
      crits: hits.filter((hit) => hit.crit).length,
      hits: [...hits],
    }
    // Same door as a local shot, so damage numbers and the HUD refresh follow.
    this.onShotResolved?.(shooter, target, result)
    return result
  }
  throwGrenade(thrower: Soldier, at: Tile, kind: GrenadeId): GrenadeResult {
    return throwGrenade(this.grid, thrower, at, kind, this.squads.soldiers, this.fx)
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
