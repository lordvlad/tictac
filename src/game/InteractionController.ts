import { Raycaster, Vector2 } from 'three'
import Game from '@mavonengine/core/Game'
import { COVER_AP_COST, Faction } from '../config'
import { clientToNdc } from '../core/screen'
import type { Tile } from '../core/Grid'
import type { Soldier } from '../entities/Soldier'
import type { OrbitRig } from '../camera/OrbitRig'
import type { Hud } from '../hud/Hud'
import type { Battlefield } from './Battlefield'
import { FogOfWar } from './FogOfWar'
import { MovementPlanner } from './MovementPlanner'
import { ShootPlanner } from './ShootPlanner'
import { WallXray } from './WallXray'
import type { Squads } from './Squads'
import type { TurnManager } from './TurnManager'
import type { Tracers } from '../render/Tracers'

/**
 * Routes player input to the subsystem that owns the decision, and keeps the
 * HUD in step with it.
 *
 * Everything with rules of its own lives elsewhere: {@link MovementPlanner}
 * (route planning), {@link ShootPlanner} (shooting), {@link FogOfWar}
 * (visibility) and {@link WallXray} (occlusion fading). What is left here is
 * genuinely about input: listeners, picking, and per-frame orchestration.
 */
export class InteractionController {
  private readonly planner: MovementPlanner
  private readonly shoot: ShootPlanner
  private readonly fog: FogOfWar
  private readonly xray: WallXray

  // Hover state (mouse only — touch has no hover phase).
  private hoveredTile: Tile | null = null
  private hoveredEnemy: Soldier | null = null

  private readonly raycaster = new Raycaster()
  private readonly ndc = new Vector2()
  /** Where the right button went down, to tell a facing click from an orbit drag. */
  private readonly rightDownPos = new Vector2()

  constructor(
    private readonly battlefield: Battlefield,
    private readonly squads: Squads,
    private readonly turnManager: TurnManager,
    private readonly rig: OrbitRig,
    private readonly hud: Hud,
    tracers: Tracers,
  ) {
    this.planner = new MovementPlanner(battlefield.grid, squads)
    this.shoot = new ShootPlanner(battlefield.grid, hud, tracers)
    this.fog = new FogOfWar(battlefield.grid, battlefield.ground, battlefield.blocks)
    this.xray = new WallXray(rig, squads, battlefield.blocks)

    this.shoot.onShotResolved = () => {
      this.recomputeVisibility()
      this.renderOverlay()
      this.hud.isShootModeActive = false
      this.hud.update()
    }

    const canvas = Game.instance().canvas
    canvas.addEventListener('pointerdown', this.onPointerDown)
    canvas.addEventListener('pointerup', this.onPointerUp)
    canvas.addEventListener('pointermove', this.onPointerMove)
    canvas.addEventListener('click', this.onClick)
    window.addEventListener('keydown', this.onKeyDown)

    hud.onShootRequested = () => this.enterShootMode()
    hud.onCancelShootRequested = () => this.exitShootMode()
    hud.onTurnSwitched = () => this.onTurnSwitched()
    hud.onToggleCoverRequested = () => this.toggleCover()
    hud.onToggleWaypointsRequested = () => this.toggleWaypointMode()

    turnManager.onSelectionChanged = () => {
      this.planner.clear()
      this.renderOverlay()
      this.battlefield.flush()
      this.hud.update()
    }

    this.recomputeVisibility()
  }

  dispose(): void {
    const canvas = Game.instance().canvas
    canvas.removeEventListener('pointerdown', this.onPointerDown)
    canvas.removeEventListener('pointerup', this.onPointerUp)
    canvas.removeEventListener('pointermove', this.onPointerMove)
    canvas.removeEventListener('click', this.onClick)
    window.removeEventListener('keydown', this.onKeyDown)
    this.planner.dispose()
    this.shoot.dispose()
  }

  // ---------------------------------------------------------------------------
  // Mode transitions
  // ---------------------------------------------------------------------------

  enterShootMode(): void {
    if (!this.shoot.enter(this.turnManager.selectedSoldier)) return
    this.planner.clear()
    this.hud.isShootModeActive = true
    this.hud.update()
    this.renderOverlay()
  }

  exitShootMode(): void {
    this.shoot.exit()
    this.planner.clear()
    this.hud.isShootModeActive = false
    this.hud.update()
    this.renderOverlay()
  }

  /** Hunker into / out of a crouch cover stance. Entering costs AP; standing is free. */
  toggleCover(): void {
    const soldier = this.turnManager.selectedSoldier
    if (!soldier || soldier.isDead || soldier.isMoving) return

    if (soldier.isCrouching) {
      soldier.exitCover()
    } else {
      if (soldier.ap < COVER_AP_COST) return
      soldier.ap -= COVER_AP_COST
      soldier.enterCover()
    }
    this.hud.update()
  }

  toggleWaypointMode(): void {
    this.hud.isWaypointModeActive = this.planner.toggleWaypointMode()
    this.renderOverlay()
    this.hud.update()
  }

  onTurnSwitched(): void {
    if (this.rig.isCharacterViewActive) this.rig.exitCharacterView()
    this.exitShootMode()
    this.recomputeVisibility()
  }

  recomputeVisibility(): void {
    this.fog.recompute(this.turnManager.activeFaction, this.squads)
  }

  // ---------------------------------------------------------------------------
  // Input
  // ---------------------------------------------------------------------------

  private readonly onPointerDown = (event: PointerEvent): void => {
    if (event.button === 2) this.rightDownPos.set(event.clientX, event.clientY)
  }

  /** Right-click (not right-drag) turns the selected unit to face the cursor. */
  private readonly onPointerUp = (event: PointerEvent): void => {
    if (event.button !== 2) return
    const travel = Math.hypot(
      event.clientX - this.rightDownPos.x,
      event.clientY - this.rightDownPos.y,
    )
    if (travel >= 6) return

    const selected = this.turnManager.selectedSoldier
    if (!selected || selected.isMoving || selected.isDead) return

    clientToNdc(Game.instance().canvas, event.clientX, event.clientY, this.ndc)
    const pt = this.rig.screenToGround(this.ndc)
    if (!pt) return

    const dx = pt.x - selected.position.x
    const dz = pt.z - selected.position.z
    if (Math.hypot(dx, dz) > 0.01) selected.targetYaw = Math.atan2(dx, dz)
  }

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (event.code === 'Escape') this.exitShootMode()
  }

  private readonly onPointerMove = (event: PointerEvent): void => {
    if (this.rig.isDragging) return

    this.hoveredTile = this.tileFromEvent(event)
    this.hoveredEnemy = this.pickSoldierUnderCursor(event, this.enemyFaction)
    this.renderOverlay()
  }

  private readonly onClick = (event: MouseEvent): void => {
    if (this.rig.isDragging) return

    const selected = this.turnManager.selectedSoldier

    // Tapping a friendly selects it.
    const friendly = this.pickSoldierUnderCursor(event, this.turnManager.activeFaction)
    if (friendly && friendly !== selected) {
      this.turnManager.selectSoldier(friendly)
      this.exitShootMode()
      this.hud.update()
      return
    }

    if (!selected || selected.isDead) return
    const tile = this.tileFromEvent(event)

    if (this.shoot.active) {
      const enemy = this.pickSoldierUnderCursor(event, this.enemyFaction)
      this.shoot.handleClick(event.clientX, event.clientY, selected, enemy, tile !== null)
      return
    }

    if (!tile || selected.isMoving || selected.ap <= 0) return
    // Shift-click stays a desktop shortcut for adding a waypoint outright.
    const started = this.planner.handleClick(selected, tile, event.shiftKey)
    if (started) this.hud.update()
  }

  // ---------------------------------------------------------------------------
  // Picking
  // ---------------------------------------------------------------------------

  private get enemyFaction(): Faction {
    return this.turnManager.activeFaction === Faction.Blue ? Faction.Red : Faction.Blue
  }

  /**
   * Tile under a click/tap, resolved from the event itself.
   *
   * `hoveredTile` is mouse-only: `pointermove` never fires before a tap on
   * touch (and is suppressed mid-drag anyway), so a tap must project its own
   * coordinates or it hits nothing.
   */
  private tileFromEvent(event: MouseEvent | PointerEvent): Tile | null {
    clientToNdc(Game.instance().canvas, event.clientX, event.clientY, this.ndc)
    const groundPt = this.rig.screenToGround(this.ndc)
    if (!groundPt) return null
    const tile = this.battlefield.grid.worldToTile(groundPt.x, groundPt.z)
    return this.battlefield.grid.inBounds(tile.x, tile.y) ? tile : null
  }

  private pickSoldierUnderCursor(
    event: MouseEvent | PointerEvent,
    faction: Faction,
  ): Soldier | null {
    clientToNdc(Game.instance().canvas, event.clientX, event.clientY, this.ndc)
    this.raycaster.setFromCamera(this.ndc, Game.instance().camera.instance)
    const hits = this.raycaster.intersectObjects(Game.instance().scene.children, true)

    for (const hit of hits) {
      let obj: typeof hit.object | null = hit.object
      while (obj) {
        const soldier = obj.userData.soldier as Soldier | undefined
        if (obj.userData.type === 'soldier' && soldier) {
          if (!soldier.isDead && soldier.faction === faction && soldier.instance?.visible) {
            return soldier
          }
        }
        obj = obj.parent
      }
    }

    return null
  }

  // ---------------------------------------------------------------------------
  // Rendering & frame update
  // ---------------------------------------------------------------------------

  private renderOverlay(): void {
    this.battlefield.ground.clearOverlay()

    const selected = this.turnManager.selectedSoldier
    if (!selected || selected.isDead) {
      this.planner.render(null)
      return
    }

    if (this.shoot.active) {
      this.planner.render(null)
      this.shoot.renderOverlay(this.battlefield.ground, selected, this.hoveredEnemy)
    } else {
      this.planner.render(selected)
    }
  }

  update(delta: number): void {
    this.planner.update(delta)

    const selected = this.turnManager.selectedSoldier
    if (this.rig.isCharacterViewActive) {
      if (selected && !selected.isDead) {
        // Hide the selected unit's own mesh in first person so it cannot occlude the camera.
        if (selected.instance) selected.instance.visible = false
        this.rig.updateCharacterView(selected.position, selected.currentYaw)
      } else {
        this.rig.exitCharacterView()
      }
    } else if (selected && !selected.isDead && selected.instance) {
      selected.instance.visible = true
    }

    if (selected && selected.isMoving) {
      const moved = selected.updateMovement(delta, this.battlefield.grid, () => {
        this.recomputeVisibility()
        this.hud.update()
      })

      if (!this.rig.isCharacterViewActive) this.rig.focusOn(selected.position)

      if (!moved) {
        this.recomputeVisibility()
        this.hud.update()
      }
    }

    this.xray.update(Game.instance().camera.instance.position)
  }
}
