import { System } from '../System'
import type { World } from '../World'
import { StanceComponent } from '../components/StanceComponent'
import { FIRE, type Faction, RULES } from '../../config'
import { type GrenadeId, type ShotMode, STATUSES } from '../../core/Arsenal'
import { statusStacks } from '../../core/Ballistics'
import type { Tile } from '../../core/Grid'
import type { Grid } from '../../core/Grid'
import type { Soldier } from '../../entities/Soldier'
import type { Squads } from '../../game/Squads'
import { canWatch, reactToArrival, watchCost } from '../../game/Overwatch'
import { NO_FX, type CombatFx } from '../../core/Combatant'
import { MELEE } from '../../core/Melee'
import { type Noise, shotLoudness } from '../../core/Noise'
import { glassCrossed } from '../../core/Visibility'
import type { Roll } from '../../core/rng'
import { shake } from '../../core/Morale'
import { Awareness } from '../../core/Awareness'
import { fromBehind } from '../../core/Facing'
import { executeMelee,
  applyHitEffects,
  canShoot,
  fireWeapon,
  suppress,
  type GrenadeResult,
  type ResolvedHit,
  type ShotResult,
  throwGrenade,
} from '../../game/Combat'

/** Rounds of a shot that went past: what suppresses, and what shakes. */
function misses(result: ShotResult): number {
  let count = 0
  for (const landed of result.rolls) if (!landed) count++
  return count
}

/**
 * Whether `target` did not see an attack from `by` coming: not in the fight
 * yet, or hit from behind. Asked before the attack, which engages it.
 */
function unseen(by: Soldier, target: Soldier): boolean {
  return target.awareness !== Awareness.Engaged || fromBehind(target, by.tile)
}

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
    readonly grid: Grid,
    private readonly squads: Squads,
    private readonly fx: CombatFx = NO_FX,
    /**
     * The match's dice. Required, not defaulted: a default is how a match ends
     * up drawing from a source the other side cannot reproduce. Readable by
     * the applier, which rolls the handover's morale from the same stream.
     */
    readonly roll: Roll,
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
   * Something an attack made audible: a shot, a loud blow, a grenade going
   * off. Owned by `CommandSystem`, which works out who heard it.
   */
  onNoise?: (noise: Noise) => void
  /**
   * A round or a throw by `faction` went through the glazing on `edge`. Owned
   * by `CommandSystem`, which breaks it: a wall is the wall system's to change.
   */
  onGlass?: (edge: number, faction: Faction) => void

  /** Everything glazed between two tiles, in the order a line from the first meets it. */
  private through(from: Tile, to: Tile, faction: Faction): void {
    for (const edge of glassCrossed(this.grid, from, to)) this.onGlass?.(edge, faction)
  }

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
    const quiet = unseen(shooter, target)
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
    shake(this.squads.soldiers, shooter, result.hits, target, misses(result))
    this.record(shooter, result.hits, 'gun', target, quiet)
    this.onNoise?.({ at: { ...shooter.tile }, loudness: shotLoudness(shooter), faction: shooter.faction })
    // Every round goes somewhere: through a window, it takes the window with it.
    this.through(shooter.tile, target.tile, shooter.faction)
    this.onShotResolved?.(shooter, target, result)
    return result
  }

  /**
   * Strike an adjacent enemy with the sidearm. Resolved from the match's dice,
   * like a shot, and reported through the same `onShotResolved`.
   */
  melee(attacker: Soldier, target: Soldier): ShotResult | null {
    const quiet = unseen(attacker, target)
    const result = executeMelee(this.grid, attacker, target, this.fx, this.roll)
    if (!result) return null
    shake(this.squads.soldiers, attacker, result.hits)
    this.record(attacker, result.hits, 'blow', target, quiet)
    const loudness = MELEE[attacker.sidearm].loudness
    if (loudness > 0) this.onNoise?.({ at: { ...attacker.tile }, loudness, faction: attacker.faction })
    this.onShotResolved?.(attacker, target, result)
    return result
  }

  throwGrenade(thrower: Soldier, at: Tile, kind: GrenadeId): GrenadeResult {
    const from = { ...thrower.tile }
    const result = throwGrenade(this.grid, thrower, at, kind, this.squads.soldiers, this.fx)
    if (!result.thrown) return result
    shake(this.squads.soldiers, thrower, result.hits)
    this.record(thrower, result.hits, 'blast')
    // A throw that meets a window breaks it on the way, then goes off — and is
    // heard — where it lands, not where it was thrown from.
    this.through(from, at, thrower.faction)
    this.onNoise?.({ at: { ...at }, loudness: thrower.grenadeSpecs[kind].loudness, faction: thrower.faction })
    return result
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
   *
   * @returns how many reactions the arrival drew.
   */
  reactTo(mover: Soldier): number {
    const fired = reactToArrival(this.grid, mover, this.squads.soldiers, this.roll, this.fx)
    for (const { watcher, result } of fired) {
      shake(this.squads.soldiers, watcher, result.hits, mover, misses(result))
      this.record(watcher, result.hits, 'gun', mover)
      this.onNoise?.({ at: { ...watcher.tile }, loudness: shotLoudness(watcher), faction: watcher.faction })
      this.through(watcher.tile, mover.tile, watcher.faction)
      this.onShotResolved?.(watcher, mover, result)
    }
    return fired.length
  }

  /**
   * Fire takes its toll of `unit`: the same damage however much plate it
   * wears, and the morale a wound costs. Nobody did it, so nobody is paid for
   * a death. Resolved by the rules on both peers, like a reaction.
   *
   * @returns the damage done; nought for a unit already dead.
   */
  burn(unit: Soldier): number {
    if (unit.isDead) return 0
    applyHitEffects(unit, FIRE.damage, 0, null, this.fx)
    const hits = [{ soldier: unit, damage: FIRE.damage, killed: unit.isDead, armorShred: 0, status: null, crit: false }]
    shake(this.squads.soldiers, null, hits)
    this.record(null, hits, null)
    return FIRE.damage
  }

  /**
   * What `unit`'s ailments cost it at the start of its own turn: every stack
   * of a status with `damagePerTurn` — a bleed, and poison when there is one —
   * armour or not, with the morale a wound costs. Nobody did it, as with fire.
   * Resolved by the rules on both peers from state both hold; no dice.
   *
   * @returns the damage done.
   */
  suffer(unit: Soldier): number {
    if (unit.isDead) return 0
    let damage = 0
    for (const state of unit.statuses) damage += STATUSES[state.kind].damagePerTurn * statusStacks(state)
    if (damage <= 0) return 0
    applyHitEffects(unit, damage, 0, null, this.fx)
    const hits = [{ soldier: unit, damage, killed: unit.isDead, armorShred: 0, status: null, crit: false }]
    shake(this.squads.soldiers, null, hits)
    this.record(null, hits, null)
    return damage
  }

  /**
   * Write an attack into the service records (`core/Progression`): what every
   * victim took, and what `by` landed and killed — with a gun, by class, or
   * with a blow. Friendly fire teaches nobody anything. `quiet` is whether
   * `target` did not see it coming, judged before the attack engaged it.
   */
  private record(
    by: Soldier | null,
    hits: readonly ResolvedHit[],
    how: 'gun' | 'blow' | 'blast' | null,
    target: Soldier | null = null,
    quiet = false,
  ): void {
    const killed = new Set<Soldier>()
    let landedOnTarget = false
    for (const hit of hits) {
      const victim = this.squads.soldiers.find((unit) => unit === hit.soldier)
      if (!victim) continue
      victim.deeds.wounds += hit.damage
      if (!by || victim.faction === by.faction) continue
      // Every round on a body already dead reports the death again.
      if (hit.killed) killed.add(victim)
      if (hit.damage <= 0) continue
      if (victim === target) landedOnTarget = true
      if (how === 'gun') {
        by.deeds.hits[by.weaponId] += 1
        if (hit.crit) by.deeds.crits[by.weaponId] += 1
      } else if (how === 'blow') {
        by.deeds.blows += 1
      }
    }
    if (!by) return
    by.deeds.kills += killed.size
    if (quiet && landedOnTarget) by.deeds.unseen += 1
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
