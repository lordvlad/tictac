import type { Grid } from '../core/Grid'
import type { Soldier } from '../entities/Soldier'
import { DamageIndicators } from '../render/DamageIndicators'
import type { Ground } from '../render/Ground'
import type { Tracers } from '../render/Tracers'
import { hasLineOfSight } from '../core/Visibility'
import { SHOT_MODES, ShotMode } from '../core/Arsenal'
import {
  effectiveWeapon,
  type HitChanceBreakdown,
  resolveDamage,
} from '../core/Ballistics'
import { calculateHitChance, canShoot, executeShot, shotApCost, shotBreakdown, type ShotResult } from './Combat'
import type { Squads } from './Squads'
import type { EngineContext } from '../engine'

const LOS_CLEAR = 0x79d98b
const LOS_BLOCKED = 0xe05c4f

/** One way of taking the shot, fully priced and rated. */
export interface ShotOption {
  mode: ShotMode
  name: string
  apCost: number
  bullets: number
  breakdown: HitChanceBreakdown
  /** Damage on a hit, after the target's armour. */
  damage: number
  armorShred: number
  /** Affordable and in range — i.e. this shot can actually be taken. */
  available: boolean
}

/** The target being aimed at, and every shot that could be taken at it. */
export interface PendingShot {
  target: Soldier
  weaponName: string
  ammoName: string
  currentClip: number
  maxClip: number
  /**
   * One entry per shot mode, so the panel can put each option on its own card
   * with its real numbers rather than making the player toggle to compare.
   */
  options: ShotOption[]
}

/**
 * Shoot mode: which enemies can be shot, which one is picked, and what that
 * shot would do — up to but not including pulling the trigger.
 *
 * Target choice and confirmation are two separate steps on purpose: picking a
 * target only previews it, so a mis-tap costs nothing.
 *
 * Firing changes the world, so the caller supplies `onShotResolved` to re-run
 * fog and refresh the HUD rather than this class reaching across the game.
 */
export class ShootPlanner {
  /** Called after a shot has been resolved. */
  onShotResolved?: () => void

  private readonly damageIndicators: DamageIndicators
  private activeOn = false
  private target: Soldier | null = null

  constructor(
    private readonly grid: Grid,
    private readonly squads: Squads,
    private readonly tracers: Tracers,
    engine: EngineContext,
  ) {
    this.damageIndicators = new DamageIndicators(engine)
  }

  get active(): boolean {
    return this.activeOn
  }

  get selectedTarget(): Soldier | null {
    return this.target
  }

  /**
   * Enemies this shooter may fire at: alive, actually rendered (fog of war must
   * not leak positions through the target list) and inside the weapon's range.
   *
   * Range is judged by the cheapest shot: if any mode can reach, the target is
   * worth offering.
   */
  availableTargets(shooter: Soldier): Soldier[] {
    if (shooter.isDead) return []
    return this.squads.soldiers.filter(
      (s) =>
        s.faction !== shooter.faction &&
        !s.isDead &&
        s.instance?.visible !== false &&
        canShoot(this.grid, shooter, s, ShotMode.Snap),
    )
  }

  /** @returns true when shoot mode was entered (the unit can still afford it). */
  enter(shooter: Soldier | null): boolean {
    if (!shooter || shooter.isDead) return false
    if (shooter.ap < shotApCost(shooter, ShotMode.Snap)) return false
    this.activeOn = true
    // Pre-select the best odds so the player usually only has to pick a card.
    const targets = this.availableTargets(shooter)
    this.target =
      targets.length === 0
        ? null
        : targets.reduce((best, s) =>
            shotBreakdown(this.grid, shooter, s, ShotMode.Snap).chance >
            shotBreakdown(this.grid, shooter, best, ShotMode.Snap).chance
              ? s
              : best,
          )
    return true
  }

  exit(): void {
    this.activeOn = false
    this.target = null
  }

  selectTarget(soldier: Soldier | null): void {
    this.target = soldier
  }

  /** The target being aimed at with every shot option, or null if none is. */
  pending(shooter: Soldier | null): PendingShot | null {
    if (!this.activeOn || !shooter || shooter.isDead) return null
    const target = this.target
    if (!target || target.isDead) return null

    const options: ShotOption[] = shooter.weapon.availableModes.map((mode) => {
      const apCost = shotApCost(shooter, mode)
      const breakdown = shotBreakdown(this.grid, shooter, target, mode)
      const preview = previewDamage(shooter, target, mode)
      const bullets = shooter.weapon.bulletConsumption(mode)
      return {
        mode,
        name: SHOT_MODES[mode].name,
        apCost,
        bullets,
        breakdown,
        damage: preview.damage,
        armorShred: preview.armorShred,
        available: shooter.ap >= apCost && !breakdown.outOfRange && shooter.weapon.currentClip >= bullets,
      }
    })

    return {
      target,
      weaponName: shooter.weapon.name,
      ammoName: shooter.ammo.name,
      currentClip: shooter.weapon.currentClip,
      maxClip: shooter.weapon.maxClip,
      options,
    }
  }
  /** Take the shot in `mode`. Returns target and hit rolls for P2P sync. */
  fire(shooter: Soldier, mode: ShotMode): { target: Soldier; rolls: boolean[] } | null {
    const pending = this.pending(shooter)
    if (!pending) return null
    const option = pending.options.find((o) => o.mode === mode)
    if (!option || !option.available) return null

    const target = pending.target
    const chance = calculateHitChance(this.grid, shooter, target, mode)
    const bullets = shooter.weapon.bulletConsumption(mode)
    const rolls: boolean[] = []
    for (let i = 0; i < bullets; i++) {
      rolls.push(Math.random() * 100 <= chance)
    }

    const result = this.executeShotWithRolls(shooter, target, mode, rolls)
    return result ? { target, rolls } : null
  }

  executeShotWithRolls(shooter: Soldier, target: Soldier, mode: ShotMode, rolls: boolean[], force = false): ShotResult | null {
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
    this.damageIndicators.spawn(target.position, result.hit, result.damage)
    if (target.isDead && this.target === target) this.target = null
    this.onShotResolved?.()
    return result
  }

  /** Paint reachable-by-bullet tiles, plus a bright marker on the current target. */
  renderOverlay(ground: Ground, shooter: Soldier, hoveredEnemy: Soldier | null): void {
    const size = this.grid.size
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const clear = hasLineOfSight(this.grid, shooter.tile, { x, y })
        ground.paintTile(x, y, clear ? LOS_CLEAR : LOS_BLOCKED, 0.15)
      }
    }

    const marked = this.target ?? hoveredEnemy
    if (marked) ground.paintTile(marked.tile.x, marked.tile.y, LOS_CLEAR, 0.8)
  }

  dispose(): void {
    this.damageIndicators.dispose()
  }
}

/**
 * What a hit would do, without touching anything. Uses the same resolver the
 * shot itself uses, so the number on the panel is the number that lands.
 */
function previewDamage(
  shooter: Soldier,
  target: Soldier,
  mode: ShotMode,
): { damage: number; armorShred: number } {
  const result = resolveDamage(effectiveWeapon(shooter, mode), target)
  return { damage: result.damage, armorShred: result.armorShred }
}
