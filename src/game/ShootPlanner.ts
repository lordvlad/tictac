import { SHOOT_AP_COST } from '../config'
import type { Grid } from '../core/Grid'
import type { Soldier } from '../entities/Soldier'
import { DamageIndicators } from '../render/DamageIndicators'
import type { Ground } from '../render/Ground'
import type { Tracers } from '../render/Tracers'
import { hasLineOfSight } from '../core/Visibility'
import { calculateHitChance, executeShot } from './Combat'

/** What the shoot planner needs from the HUD — nothing more than a menu. */
export interface ContextMenuHost {
  showContextMenu(
    x: number,
    y: number,
    items: { label: string; detail?: string; danger?: boolean; action: () => void }[],
  ): void
  hideContextMenu(): void
}

const LOS_CLEAR = 0x79d98b
const LOS_BLOCKED = 0xe05c4f

/**
 * Shoot mode: the line-of-sight overlay and the confirm-a-shot menu.
 *
 * Firing is the only action here that changes the world, so the caller supplies
 * `onShotResolved` to re-run fog and refresh the HUD rather than this class
 * reaching across the game to do it.
 */
export class ShootPlanner {
  /** Called after a shot has been resolved. */
  onShotResolved?: () => void

  private readonly damageIndicators = new DamageIndicators()
  private activeOn = false

  constructor(
    private readonly grid: Grid,
    private readonly menu: ContextMenuHost,
    private readonly tracers: Tracers,
  ) {}

  get active(): boolean {
    return this.activeOn
  }

  /** @returns true when shoot mode was entered (the unit can still afford it). */
  enter(shooter: Soldier | null): boolean {
    if (!shooter || shooter.ap < SHOOT_AP_COST) return false
    this.activeOn = true
    this.menu.hideContextMenu()
    return true
  }

  exit(): void {
    this.activeOn = false
    this.menu.hideContextMenu()
  }

  /** A click while in shoot mode: on an enemy it offers the shot, elsewhere the (placeholder) environment menu. */
  handleClick(
    clientX: number,
    clientY: number,
    shooter: Soldier,
    enemy: Soldier | null,
    onTile: boolean,
  ): void {
    if (shooter.ap < SHOOT_AP_COST) return

    if (enemy) {
      const hitChance = calculateHitChance(this.grid, shooter, enemy)
      this.menu.showContextMenu(clientX, clientY, [
        {
          label: `Shoot (${hitChance}% hit)`,
          detail: `${SHOOT_AP_COST} AP`,
          danger: true,
          action: () => {
            const result = executeShot(this.grid, shooter, enemy, this.tracers)
            this.damageIndicators.spawn(enemy.position, result.hit, result.damage)
            this.exit()
            this.onShotResolved?.()
          },
        },
        { label: 'Cancel', action: () => this.menu.hideContextMenu() },
      ])
      return
    }

    if (!onTile) return
    this.menu.showContextMenu(clientX, clientY, [
      { label: 'Environmental Effects', detail: 'None', action: () => {} },
      { label: 'Cancel', action: () => this.menu.hideContextMenu() },
    ])
  }

  /** Paint reachable-by-bullet tiles, plus a bright marker on the hovered enemy. */
  renderOverlay(ground: Ground, shooter: Soldier, hoveredEnemy: Soldier | null): void {
    const size = this.grid.size
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const clear = hasLineOfSight(this.grid, shooter.tile, { x, y })
        ground.paintTile(x, y, clear ? LOS_CLEAR : LOS_BLOCKED, 0.15)
      }
    }

    if (hoveredEnemy) {
      ground.paintTile(hoveredEnemy.tile.x, hoveredEnemy.tile.y, LOS_CLEAR, 0.8)
    }
  }

  dispose(): void {
    this.damageIndicators.dispose()
  }
}
