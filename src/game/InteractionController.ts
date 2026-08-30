import { Raycaster, Vector2, Vector3 } from 'three'
import Game from '@mavonengine/core/Game'
import { COVER_AP_COST, Faction, SHOOT_AP_COST, WALL_XRAY } from '../config'
import { findChainedPath } from '../core/Pathfinding'
import { computeFactionVisibility, hasLineOfSight, VisState } from '../core/Visibility'
import { directionalCover } from '../core/Cover'
import { smoothstep } from '../core/math'
import { clientToNdc } from '../core/screen'
import { type Tile, tileEquals } from '../core/Grid'
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
  /**
   * Waypoint planning mode. Off, a tap sets the target directly; on, each tap
   * drops a waypoint and re-tapping walks it up to target and then to a
   * confirmed move — the shift-click route without a keyboard.
   */
  private waypointMode = false

  // Hover state
  private hoveredTile: Tile | null = null
  private hoveredEnemy: Soldier | null = null

  // Faction visibility state (784 bytes per faction)
  private readonly visibilityMaps: Record<Faction, Uint8Array>

  private readonly raycaster = new Raycaster()
  private readonly ndc = new Vector2()

  /** Scratch target for the wall x-ray rays (a character's feet). */
  private readonly xrayTarget = new Vector3()

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
    hud.onToggleWaypointsRequested = () => this.toggleWaypointMode()

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

  /**
   * Toggle waypoint planning. Switching it off abandons the plan outright: the
   * half-built route belongs to that mode and silently keeping it would leave a
   * stale target armed for the next single tap.
   */
  toggleWaypointMode(): void {
    this.waypointMode = !this.waypointMode
    if (!this.waypointMode) {
      this.clearPlannerState()
      this.renderOverlay()
    }
    this.hud.isWaypointModeActive = this.waypointMode
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
          soldier.instance.visible = tileVis === VisState.Visible
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
          clientToNdc(Game.instance().canvas, event.clientX, event.clientY, this.ndc)
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

    clientToNdc(Game.instance().canvas, event.clientX, event.clientY, this.ndc)

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

  /**
   * Tile under a click/tap, resolved from the event itself.
   *
   * `hoveredTile` is mouse-only: it is filled in by `pointermove`, which touch
   * never sends before a tap (and which is suppressed mid-drag anyway), so a
   * tap must project its own coordinates or it hits nothing.
   */
  private tileFromEvent(event: MouseEvent | PointerEvent): Tile | null {
    clientToNdc(Game.instance().canvas, event.clientX, event.clientY, this.ndc)
    const groundPt = this.rig.screenToGround(this.ndc)
    if (!groundPt) return null
    const tile = this.battlefield.grid.worldToTile(groundPt.x, groundPt.z)
    return this.battlefield.grid.inBounds(tile.x, tile.y) ? tile : null
  }

  private handleMoveClick(event: MouseEvent): void {
    const selected = this.turnManager.selectedSoldier
    if (!selected || selected.isMoving || selected.ap <= 0) return

    const tile = this.tileFromEvent(event)
    if (!tile) return

    // Shift-click stays a desktop shortcut for adding a waypoint outright.
    if (event.shiftKey) {
      this.addWaypoint(tile)
      return
    }

    if (this.waypointMode) {
      this.handleWaypointModeClick(selected, tile)
      return
    }

    if (this.currentGoal === null) {
      // First click on map tile -> set goal and show path to target
      this.currentGoal = tile
      this.renderOverlay()
      return
    }

    // A target tile was already selected
    if (tileEquals(this.currentGoal, tile)) {
      // Second click on SAME tile -> confirm, but ONLY if the path is actually
      // reachable within the unit's remaining AP. An unreachable (red) target
      // must never be walkable just because it was clicked twice.
      this.confirmPath(selected)
    } else {
      // Click on DIFFERENT tile -> reset to no path/target selected
      this.clearPlannerState()
    }
  }

  /**
   * Waypoint mode promotes the same tile one step per tap:
   * waypoint -> target -> confirmed move. Tapping a fresh tile appends another
   * waypoint, so a route is chained by tapping each corner in turn.
   */
  private handleWaypointModeClick(selected: Soldier, tile: Tile): void {
    if (this.currentGoal && tileEquals(this.currentGoal, tile)) {
      this.confirmPath(selected)
      return
    }

    const existing = this.waypoints.findIndex((w) => tileEquals(w, tile))
    if (existing >= 0) {
      // Second tap on a waypoint promotes it to the target.
      this.waypoints.splice(existing, 1)
      this.currentGoal = tile
      this.renderOverlay()
      return
    }

    this.addWaypoint(tile)
  }

  private addWaypoint(tile: Tile): void {
    if (!this.waypoints.some((w) => tileEquals(w, tile))) {
      this.waypoints.push(tile)
    }
    this.renderOverlay()
  }

  /** Execute the planned path, but only while it is actually affordable. */
  private confirmPath(selected: Soldier): void {
    const path = this.activePathValid && this.activePath.length > 1 ? [...this.activePath] : null
    this.clearPlannerState()
    if (path) selected.startMovement(path)
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
    } else if (this.tileFromEvent(event)) {
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
    clientToNdc(Game.instance().canvas, event.clientX, event.clientY, this.ndc)

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

    // Without a target, the newest waypoint stands in as a provisional endpoint
    // so the route stays visible while it is still being tapped out.
    const provisional = this.currentGoal === null
    const endpoint = this.currentGoal ?? this.waypoints[this.waypoints.length - 1] ?? null
    const via = provisional ? this.waypoints.slice(0, -1) : this.waypoints

    if (endpoint && !tileEquals(selected.tile, endpoint)) {
      const occupied = new Set<number>()
      for (const s of this.squads.soldiers) {
        if (!s.isDead) occupied.add(this.battlefield.grid.index(s.tile.x, s.tile.y))
      }

      const result = findChainedPath(
        this.battlefield.grid,
        selected.tile,
        endpoint,
        via,
        selected.ap,
        occupied,
      )

      // A provisional endpoint is not a target: no tap may confirm it.
      this.activePath = provisional ? [] : result.path
      this.activePathValid = provisional ? false : result.valid

      const pathPoints = result.path.map((t) => grid.tileToWorld(t))
      const waypointPoints = (provisional ? this.waypoints : via).map((t) => grid.tileToWorld(t))
      const goalPoint = grid.tileToWorld(endpoint)
      const coverLevels = provisional
        ? undefined
        : directionalCover(this.battlefield.grid, endpoint)
      this.pathMarker.show(pathPoints, waypointPoints, goalPoint, result.valid, coverLevels)
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

    this.updateWallFade()
  }

  // ---------------------------------------------------------------------------
  // Wall x-ray fade
  // ---------------------------------------------------------------------------

  /**
   * Fade walls between the camera and any character — friend or foe — once the
   * camera tilts below `WALL_XRAY.fadeStart`. Opacity eases from 1 at
   * `fadeStart` down to `minOpacity` at `fadeEnd`, so zooming reads as a smooth
   * dissolve rather than a snap.
   *
   * Only rendered characters contribute. An enemy hidden by fog of war must
   * never fade the wall in front of it: that would betray a position the player
   * has not spotted.
   */
  private updateWallFade(): void {
    const blocks = this.battlefield.blocks

    const tilt = this.rig.tilt
    const eased = smoothstep(
      (tilt - WALL_XRAY.fadeEnd) / (WALL_XRAY.fadeStart - WALL_XRAY.fadeEnd),
    )
    const opacity = WALL_XRAY.minOpacity + (1 - WALL_XRAY.minOpacity) * eased

    if (opacity >= 1) {
      blocks.clearOcclusionFade()
      return
    }

    const cameraPos = Game.instance().camera.instance.position
    blocks.beginOcclusionFade()
    for (const soldier of this.squads.soldiers) {
      if (soldier.isDead) continue
      if (soldier.instance && !soldier.instance.visible) continue
      // Target the character's feet: a wall fades as soon as it hides ANY part
      // of the body, not just the head.
      this.xrayTarget.copy(soldier.position)
      blocks.addOcclusionRay(cameraPos, this.xrayTarget)
    }
    blocks.commitOcclusionFade(opacity)
  }
}
