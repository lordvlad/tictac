import { Raycaster, Vector2, Vector3 } from 'three'
import Game from '@mavonengine/core/Game'
import { COVER_AP_COST, Faction, SHOOT_AP_COST } from '../config'
import { findChainedPath } from '../core/Pathfinding'
import { computeFactionVisibility, hasLineOfSight } from '../core/Visibility'
import { type Tile, tileEquals, tileKey } from '../core/Grid'
import type { Soldier } from '../entities/Soldier'
import type { OrbitRig } from '../camera/OrbitRig'
import type { Hud } from '../hud/Hud'
import type { Battlefield } from './Battlefield'
import { calculateHitChance, executeShot } from './Combat'
import type { Squads } from './Squads'
import type { TurnManager } from './TurnManager'
import type { Tracers } from '../render/Tracers'
import { PathMarker } from '../render/PathMarker'
import { DamageIndicators } from '../render/DamageIndicators'

export const enum ControllerMode {
  Move = 0,
  Shoot = 1,
}

export class InteractionController {
  mode: ControllerMode = ControllerMode.Move

  private readonly battlefield: Battlefield
  private readonly squads: Squads
  private readonly turnManager: TurnManager
  private readonly rig: OrbitRig
  private readonly hud: Hud
  private readonly tracers: Tracers
  private readonly pathMarker = new PathMarker()
  private readonly damageIndicators = new DamageIndicators()

  // Path planning state
  private waypoints: Tile[] = []
  private currentGoal: Tile | null = null
  private activePath: Tile[] = []
  /** Whether `activePath` is actually affordable/reachable. Never move when false. */
  private activePathValid = false

  // Hover state
  private hoveredTile: Tile | null = null
  private hoveredEnemy: Soldier | null = null

  // Faction visibility state (784 bytes per faction)
  private readonly visibilityMaps: Record<Faction, Uint8Array>

  private readonly raycaster = new Raycaster()
  private readonly ndc = new Vector2()

  // Right-click turn tracking
  private rightDownPos = new Vector2()

  constructor(
    battlefield: Battlefield,
    squads: Squads,
    turnManager: TurnManager,
    rig: OrbitRig,
    hud: Hud,
    tracers: Tracers,
    visibilityMaps: Record<Faction, Uint8Array>,
  ) {
    this.battlefield = battlefield
    this.squads = squads
    this.turnManager = turnManager
    this.rig = rig
    this.hud = hud
    this.tracers = tracers
    this.visibilityMaps = visibilityMaps

    const canvas = Game.instance().canvas
    canvas.addEventListener('pointerdown', this.onPointerDown)
    canvas.addEventListener('pointerup', this.onPointerUp)
    canvas.addEventListener('pointermove', this.onPointerMove)
    canvas.addEventListener('click', this.onClick)
    window.addEventListener('keydown', this.onKeyDown)

    // Connect callbacks
    hud.onShootRequested = () => this.enterShootMode()
    hud.onCancelShootRequested = () => this.exitShootMode()
    hud.onTurnSwitched = () => this.onTurnSwitched()
    hud.onToggleCoverRequested = () => this.toggleCover()

    turnManager.onSelectionChanged = () => {
      this.clearPlannerState()
      this.renderOverlay()
      this.battlefield.flush()
      this.hud.update()
    }

    this.recomputeVisibility()
  }

  // ---------------------------------------------------------------------------
  // Mode transitions
  // ---------------------------------------------------------------------------

  enterShootMode(): void {
    const active = this.turnManager.selectedSoldier
    if (!active || active.ap < SHOOT_AP_COST) return

    this.mode = ControllerMode.Shoot
    this.hud.isShootModeActive = true
    this.hud.update()
    this.hud.hideContextMenu()
    this.clearPlannerState()
  }

  exitShootMode(): void {
    this.mode = ControllerMode.Move
    this.hud.isShootModeActive = false
    this.hud.update()
    this.hud.hideContextMenu()
    this.clearPlannerState()
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

  private clearPlannerState(): void {
    this.waypoints = []
    this.currentGoal = null
    this.activePath = []
    this.activePathValid = false
    this.battlefield.ground.clearOverlay()
    this.pathMarker.clear()
  }

  onTurnSwitched(): void {
    if (this.rig.isCharacterViewActive) {
      this.rig.exitCharacterView()
    }
    this.exitShootMode()
    this.recomputeVisibility()
  }

  // ---------------------------------------------------------------------------
  // Visibility & Fog
  // ---------------------------------------------------------------------------

  recomputeVisibility(): void {
    const activeFaction = this.turnManager.activeFaction
    const living = this.squads.getLiving(activeFaction)
    const tiles = living.map((s) => s.tile)

    const visMap = computeFactionVisibility(
      this.battlefield.grid,
      tiles,
      this.visibilityMaps[activeFaction],
    )

    this.battlefield.ground.setFogFromVisibility(visMap)
    this.battlefield.blocks.applyVisibility(visMap)

    // Hide/show enemies based on whether their tile is visible. Corpses stay
    // rendered so the death clip's final frame reads as a body on the ground;
    // enemy corpses are still subject to fog of war.
    for (const soldier of this.squads.soldiers) {
      if (soldier.faction !== activeFaction) {
        const tileVis = visMap[this.battlefield.grid.index(soldier.tile.x, soldier.tile.y)] ?? 0
        if (soldier.instance) {
          soldier.instance.visible = tileVis === 2
        }
      } else {
        if (soldier.instance) {
          soldier.instance.visible = true
        }
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Input Listeners
  // ---------------------------------------------------------------------------

  private readonly onPointerDown = (event: PointerEvent): void => {
    if (event.button === 2) {
      this.rightDownPos.set(event.clientX, event.clientY)
    }
  }

  private readonly onPointerUp = (event: PointerEvent): void => {
    if (event.button === 2) {
      const dist = Math.hypot(event.clientX - this.rightDownPos.x, event.clientY - this.rightDownPos.y)
      // If right-click was a click rather than a camera orbit drag (< 6px movement)
      if (dist < 6) {
        const selected = this.turnManager.selectedSoldier
        if (selected && !selected.isMoving && !selected.isDead) {
          const rect = Game.instance().canvas.getBoundingClientRect()
          this.ndc.set(
            ((event.clientX - rect.left) / rect.width) * 2 - 1,
            -(((event.clientY - rect.top) / rect.height) * 2 - 1),
          )
          const pt = this.rig.screenToGround(this.ndc)
          if (pt) {
            const dx = pt.x - selected.position.x
            const dz = pt.z - selected.position.z
            if (Math.hypot(dx, dz) > 0.01) {
              selected.targetYaw = Math.atan2(dx, dz)
            }
          }
        }
      }
    }
  }

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (event.code === 'Escape') {
      this.exitShootMode()
      this.hud.hideContextMenu()
    }
  }

  private readonly onPointerMove = (event: PointerEvent): void => {
    if (this.rig.isDragging) return

    const rect = Game.instance().canvas.getBoundingClientRect()
    this.ndc.set(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -(((event.clientY - rect.top) / rect.height) * 2 - 1),
    )

    const groundPt = this.rig.screenToGround(this.ndc)
    if (groundPt) {
      const tile = this.battlefield.grid.worldToTile(groundPt.x, groundPt.z)
      if (this.battlefield.grid.inBounds(tile.x, tile.y)) {
        this.hoveredTile = tile
      } else {
        this.hoveredTile = null
      }
    } else {
      this.hoveredTile = null
    }

    // Check enemy hover
    this.hoveredEnemy = this.pickEnemyUnderCursor(event)

    this.renderOverlay()
  }

  private readonly onClick = (event: MouseEvent): void => {
    if (this.rig.isDragging) return

    const selected = this.turnManager.selectedSoldier

    // Check if clicked on a friendly unit to select them
    const friendly = this.pickFriendlyUnderCursor(event)
    if (friendly && friendly !== selected) {
      this.turnManager.selectSoldier(friendly)
      this.exitShootMode()
      this.hud.update()
      return
    }

    if (this.mode === ControllerMode.Shoot) {
      this.handleShootClick(event)
    } else {
      this.handleMoveClick(event)
    }
  }

  // ---------------------------------------------------------------------------
  // Move Mode Execution
  // ---------------------------------------------------------------------------

  private handleMoveClick(event: MouseEvent): void {
    const selected = this.turnManager.selectedSoldier
    if (!selected || selected.isMoving || selected.ap <= 0 || !this.hoveredTile) return

    if (event.shiftKey) {
      // Shift-click toggles/adds waypoint
      if (!this.waypoints.some((w) => tileEquals(w, this.hoveredTile))) {
        this.waypoints.push(this.hoveredTile)
      }
      this.renderOverlay()
      return
    }

    if (this.currentGoal === null) {
      // First click on map tile -> set goal and show path to target
      this.currentGoal = this.hoveredTile
      this.renderOverlay()
      return
    }

    // A target tile was already selected
    if (tileEquals(this.currentGoal, this.hoveredTile)) {
      // Second click on SAME tile -> confirm, but ONLY if the path is actually
      // reachable within the unit's remaining AP. An unreachable (red) target
      // must never be walkable just because it was clicked twice.
      if (this.activePathValid && this.activePath.length > 1) {
        const path = [...this.activePath]
        this.clearPlannerState()
        selected.startMovement(path)
      } else {
        this.clearPlannerState()
      }
    } else {
      // Click on DIFFERENT tile -> reset to no path/target selected
      this.clearPlannerState()
    }
  }

  // ---------------------------------------------------------------------------
  // Shoot Mode Execution
  // ---------------------------------------------------------------------------

  private handleShootClick(event: MouseEvent): void {
    const selected = this.turnManager.selectedSoldier
    if (!selected || selected.ap < SHOOT_AP_COST) return

    const enemy = this.pickEnemyUnderCursor(event)

    if (enemy) {
      // Open enemy shoot menu
      const hitChance = calculateHitChance(this.battlefield.grid, selected, enemy)
      this.hud.showContextMenu(event.clientX, event.clientY, [
        {
          label: `Shoot (${hitChance}% hit)`,
          detail: '4 AP',
          danger: true,
          action: () => {
            const result = executeShot(this.battlefield.grid, selected, enemy, this.tracers)
            this.damageIndicators.spawn(enemy.position, result.hit, result.damage)
            this.hud.update()
            this.recomputeVisibility()
            this.exitShootMode()
          },
        },
        {
          label: 'Cancel',
          action: () => this.hud.hideContextMenu(),
        },
      ])
    } else if (this.hoveredTile) {
      // Environment click -> show placeholder effects menu
      this.hud.showContextMenu(event.clientX, event.clientY, [
        {
          label: 'Environmental Effects',
          detail: 'None',
          action: () => {},
        },
        {
          label: 'Cancel',
          action: () => this.hud.hideContextMenu(),
        },
      ])
    }
  }

  // ---------------------------------------------------------------------------
  // Raycast Picking
  // ---------------------------------------------------------------------------

  private pickFriendlyUnderCursor(event: MouseEvent): Soldier | null {
    return this.pickSoldierUnderCursor(event, this.turnManager.activeFaction)
  }

  private pickEnemyUnderCursor(event: MouseEvent | PointerEvent): Soldier | null {
    const activeFaction = this.turnManager.activeFaction
    const enemyFaction = activeFaction === Faction.Blue ? Faction.Red : Faction.Blue
    return this.pickSoldierUnderCursor(event, enemyFaction)
  }

  private pickSoldierUnderCursor(event: MouseEvent | PointerEvent, faction: Faction): Soldier | null {
    const rect = Game.instance().canvas.getBoundingClientRect()
    this.ndc.set(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -(((event.clientY - rect.top) / rect.height) * 2 - 1),
    )

    this.raycaster.setFromCamera(this.ndc, Game.instance().camera.instance)
    const hits = this.raycaster.intersectObjects(Game.instance().scene.children, true)

    for (const hit of hits) {
      let obj = hit.object
      while (obj) {
        if (obj.userData.type === 'soldier' && obj.userData.soldier) {
          const soldier = obj.userData.soldier as Soldier
          if (!soldier.isDead && soldier.faction === faction && soldier.instance?.visible) {
            return soldier
          }
        }
        obj = obj.parent as any
      }
    }

    return null
  }

  // ---------------------------------------------------------------------------
  // Overlay Rendering
  // ---------------------------------------------------------------------------

  private renderOverlay(): void {
    const ground = this.battlefield.ground
    ground.clearOverlay()
    this.pathMarker.clear()

    const selected = this.turnManager.selectedSoldier
    if (!selected || selected.isDead) return

    if (this.mode === ControllerMode.Shoot) {
      this.renderShootOverlay()
    } else {
      this.renderMoveOverlay()
    }
  }

  private renderMoveOverlay(): void {
    const selected = this.turnManager.selectedSoldier!
    const grid = this.battlefield.grid

    // Green foot circle marking the selected unit.
    this.pathMarker.showSelection(grid.tileToWorld(selected.tile))

    // Only render path if a target goal tile has been clicked (no path on hover)
    if (this.currentGoal && !tileEquals(selected.tile, this.currentGoal)) {
      const occupied = new Set<number>()
      for (const s of this.squads.soldiers) {
        if (!s.isDead) occupied.add(this.battlefield.grid.index(s.tile.x, s.tile.y))
      }

      const result = findChainedPath(
        this.battlefield.grid,
        selected.tile,
        this.currentGoal,
        this.waypoints,
        selected.ap,
        occupied,
      )

      this.activePath = result.path
      this.activePathValid = result.valid

      const pathPoints = result.path.map((t) => grid.tileToWorld(t))
      const waypointPoints = this.waypoints.map((t) => grid.tileToWorld(t))
      const goalPoint = grid.tileToWorld(this.currentGoal)
      this.pathMarker.show(pathPoints, waypointPoints, goalPoint, result.valid)
    }
  }

  private renderShootOverlay(): void {
    const ground = this.battlefield.ground
    const selected = this.turnManager.selectedSoldier!

    // Paint LOS tiles
    const size = this.battlefield.grid.size
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const targetTile = { x, y }
        const los = hasLineOfSight(this.battlefield.grid, selected.tile, targetTile)
        if (los) {
          ground.paintTile(x, y, 0x79d98b, 0.15)
        } else {
          ground.paintTile(x, y, 0xe05c4f, 0.15)
        }
      }
    }

    if (this.hoveredEnemy) {
      ground.paintTile(this.hoveredEnemy.tile.x, this.hoveredEnemy.tile.y, 0x79d98b, 0.8)
    }
  }

  // ---------------------------------------------------------------------------
  // Frame Update (rAF)
  // ---------------------------------------------------------------------------

  update(delta: number): void {
    this.pathMarker.update(delta)
    const selected = this.turnManager.selectedSoldier

    if (this.rig.isCharacterViewActive) {
      if (selected && !selected.isDead) {
        // Hide selected soldier's own mesh while in first-person eye view so body doesn't occlude camera
        if (selected.instance) selected.instance.visible = false
        this.rig.updateCharacterView(selected.position, selected.currentYaw)
      } else {
        this.rig.exitCharacterView()
      }
    } else {
      // Ensure living selected soldier mesh is visible in orbit view
      if (selected && !selected.isDead && selected.instance) {
        selected.instance.visible = true
      }
    }

    if (selected && selected.isMoving) {
      const moved = selected.updateMovement(
        delta,
        this.battlefield.grid,
        (_tile) => {
          this.recomputeVisibility()
          this.hud.update()
        },
      )

      // Camera follows moving soldier
      if (!this.rig.isCharacterViewActive) {
        this.rig.focusOn(selected.position)
      }

      if (!moved) {
        // Movement completed
        this.recomputeVisibility()
        this.hud.update()
      }
    }
  }
}
