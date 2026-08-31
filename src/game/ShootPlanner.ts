import type { Grid } from '../core/Grid'
import type { Soldier } from '../entities/Soldier'
import { DamageIndicators } from '../render/DamageIndicators'
import type { Ground } from '../render/Ground'
import type { Tracers } from '../render/Tracers'
import { hasLineOfSight } from '../core/Visibility'
import { ShotMode } from '../core/Arsenal'
import {
  effectiveWeapon,
  type HitChanceBreakdown,
  resolveDamage,
} from '../core/Ballistics'
import { canShoot, executeShot, shotApCost, shotBreakdown } from './Combat'
import type { Squads } from './Squads'
import type { EngineContext } from '../engine'

const LOS_CLEAR = 0x79d98b
const LOS_BLOCKED = 0xe05c4f

/** Everything the HUD needs to render one shot before it is taken. */
export interface PendingShot {
  target: Soldier
  mode: ShotMode
  apCost: number
  affordable: boolean
  breakdown: HitChanceBreakdown
  /** Damage the shot would do on a hit, after the target's armour. */
  damage: number
  armorShred: number
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
  private mode: ShotMode = ShotMode.Snap

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

  get shotMode(): ShotMode {
    return this.mode
  }

  /**
   * Enemies this shooter may fire at: alive, actually rendered (fog of war must
   * not leak positions through the target list) and inside the weapon's range.
   */
  availableTargets(shooter: Soldier): Soldier[] {
    if (shooter.isDead) return []
    return this.squads.soldiers.filter(
      (s) =>
        s.faction !== shooter.faction &&
        !s.isDead &&
        s.instance?.visible !== false &&
        canShoot(this.grid, shooter, s, this.mode),
    )
  }

  /** @returns true when shoot mode was entered (the unit can still afford it). */
  enter(shooter: Soldier | null): boolean {
    if (!shooter || shooter.isDead) return false
    if (shooter.ap < shotApCost(shooter, this.mode)) return false
    this.activeOn = true
    // Pre-select the best odds so a single confirm is enough in the common case.
    const targets = this.availableTargets(shooter)
    this.target =
      targets.length === 0
        ? null
        : targets.reduce((best, s) =>
            shotBreakdown(this.grid, shooter, s, this.mode).chance >
            shotBreakdown(this.grid, shooter, best, this.mode).chance
              ? s
              : best,
          )
    return true
  }

  exit(): void {
    this.activeOn = false
    this.target = null
    this.mode = ShotMode.Snap
  }

  selectTarget(soldier: Soldier | null): void {
    this.target = soldier
  }

  setShotMode(mode: ShotMode): void {
    this.mode = mode
  }

  /** The shot currently lined up, or null when there is nothing to confirm. */
  pending(shooter: Soldier | null): PendingShot | null {
    if (!this.activeOn || !shooter || shooter.isDead) return null
    const target = this.target
    if (!target || target.isDead) return null

    const breakdown = shotBreakdown(this.grid, shooter, target, this.mode)
    const apCost = shotApCost(shooter, this.mode)
    const preview = previewDamage(shooter, target, this.mode)

    return {
      target,
      mode: this.mode,
      apCost,
      affordable: shooter.ap >= apCost && !breakdown.outOfRange,
      breakdown,
      damage: preview.damage,
      armorShred: preview.armorShred,
    }
  }

  /** Pull the trigger on the lined-up shot. */
  confirm(shooter: Soldier): boolean {
    const pending = this.pending(shooter)
    if (!pending || !pending.affordable) return false

    const result = executeShot(
      this.grid,
      shooter,
      pending.target,
      this.tracers,
      this.squads.soldiers,
      this.mode,
    )
    if (!result.apSpent) return false

    this.damageIndicators.spawn(pending.target.position, result.hit, result.damage)
    // Keep the target if it survived and can still be shot; otherwise fall back
    // so the panel never points at a corpse.
    if (pending.target.isDead) this.target = null
    this.mode = ShotMode.Snap
    this.onShotResolved?.()
    return true
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
