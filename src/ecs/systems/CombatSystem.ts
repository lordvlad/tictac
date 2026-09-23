import { System } from '../System'
import type { World } from '../World'
import { StanceComponent } from '../components/StanceComponent'
import { RULES } from '../../config'
import type { GrenadeId, ShotMode } from '../../core/Arsenal'
import type { Tile } from '../../core/Grid'
import type { Grid } from '../../core/Grid'
import type { Soldier } from '../../entities/Soldier'
import type { Squads } from '../../game/Squads'
import { canWatch, reactToArrival, watchCost } from '../../game/Overwatch'
import { NO_FX, type CombatFx } from '../../core/Combatant'
import type { Roll } from '../../core/rng'
import {
  applyHitEffects,
  canShoot,
  fireWeapon,
  suppress,
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
    /**
     * The match's dice. Required, not defaulted: a default is how a match ends
     * up drawing from a source the other side cannot reproduce.
     */
    private readonly roll: Roll,
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
   * Fire at a target.
   *
   * One door for both sides now. A peer's shot used to arrive already resolved
   * and go through a second path that applied its numbers verbatim; under
   * [ADR-0004](../../../docs/design/adr/0004-full-knowledge-lockstep.md) the
   * wire carries the *intent* and both peers resolve it, from the same seeded
   * stream, against state they both hold. There is nothing left for a second
   * path to do, and nothing left for an attacker to get wrong about its target.
   *
   * `rolls` remains for a test that wants a shot to land, and for nothing else:
   * neither the planner nor the wire supplies it any more.
   */
  fireShot(shooter: Soldier, target: Soldier, mode: ShotMode, rolls?: boolean[]): ShotResult | null {
    const result = fireWeapon(
      this.grid,
      shooter,
      target,
      this.fx,
      this.squads.soldiers,
      mode,
      this.roll,
      rolls,
    )
    if (!result) return null
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
   * Hold this unit's fire for the other side's turn.
   *
   * The points are spent now rather than when the reaction fires: a watch
   * nobody walks past still cost something, or holding one would be strictly
   * better than ending a turn.
   *
   * @returns false when the unit cannot afford the shot it is reserving.
   */
  overwatch(soldier: Soldier): boolean {
    if (!canWatch(soldier)) return false
    soldier.ap = Math.max(0, soldier.ap - watchCost(soldier))
    soldier.watching = true
    return true
  }

  /**
   * Fire whatever a unit's arrival has provoked.
   *
   * Wired to `MovementSystem.onStep` by whoever owns the match — the
   * controller in a live game, `MatchHost` in a replay or a referee — so a
   * reaction is a consequence of the movement intent rather than something a
   * client announces.
   */
  reactTo(mover: Soldier): void {
    const fired = reactToArrival(this.grid, mover, this.squads.soldiers, this.roll, this.fx)
    for (const { watcher, result } of fired) this.onShotResolved?.(watcher, mover, result)
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
