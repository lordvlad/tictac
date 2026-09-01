import { NetworkManager, type NetworkMessage } from './NetworkManager'
import { Raycaster, Vector2 } from 'three'
import type { EngineContext } from '../engine'
import { Faction, RULES } from '../config'
import { clientToNdc } from '../core/screen'
import type { Tile } from '../core/Grid'
import type { Soldier } from '../entities/Soldier'
import type { OrbitRig } from '../camera/OrbitRig'
import { GroundPicker } from '../camera/GroundPicker'
import type { Hud } from '../hud/Hud'
import { buildHudModel, type HudIntent } from '../hud/HudModel'
import { calculateHitChance, tickStatuses } from './Combat'
import type { OffscreenPortraits } from '../render/Portraits'
import type { Battlefield } from './Battlefield'
import { FogOfWar } from './FogOfWar'
import { MovementPlanner } from './MovementPlanner'
import { DebugPanel } from '../hud/DebugPanel'
import { GrenadePlanner } from './GrenadePlanner'
import { ShootPlanner } from './ShootPlanner'
import { Effects } from '../render/Effects'
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
  network: NetworkManager | null = null
  private readonly planner: MovementPlanner
  private readonly shoot: ShootPlanner
  private readonly grenade: GrenadePlanner
  private readonly debug: DebugPanel
  private readonly fog: FogOfWar
  private readonly xray: WallXray
  private readonly effects: Effects
  // Hover state (mouse only — touch has no hover phase).
  private hoveredTile: Tile | null = null
  private hoveredEnemy: Soldier | null = null

  private readonly raycaster = new Raycaster()
  private readonly picker: GroundPicker
  private readonly ndc = new Vector2()
  /** Where the right button went down, to tell a facing click from an orbit drag. */
  private readonly rightDownPos = new Vector2()

  constructor(
    private readonly battlefield: Battlefield,
    private readonly squads: Squads,
    private readonly turnManager: TurnManager,
    private readonly rig: OrbitRig,
    private readonly hud: Hud,
    private readonly portraits: OffscreenPortraits,
    private readonly seedLabel: string,
    tracers: Tracers,
    private readonly engine: EngineContext,
  ) {
    this.effects = new Effects(engine)
    this.planner = new MovementPlanner(battlefield.grid, squads, engine)
    this.shoot = new ShootPlanner(battlefield.grid, squads, tracers, engine)
    this.grenade = new GrenadePlanner(battlefield.grid, squads, this.effects, rig, engine)
    this.debug = new DebugPanel(
      () => {
        // Live edits can change reach, cost and visibility, so everything the
        // player is looking at has to be recomputed, not just the panels.
        this.recomputeVisibility()
        this.renderOverlay()
        this.battlefield.flush()
        this.refreshHud()
      },
      () => this.turnManager.selectedSoldier,
    )
    this.fog = new FogOfWar(battlefield.grid, battlefield.ground, battlefield.blocks)
    this.xray = new WallXray(rig, squads, battlefield.blocks)
    this.picker = new GroundPicker(engine.camera)

    this.grenade.onThrowResolved = () => {
      this.recomputeVisibility()
      this.renderOverlay()
      this.refreshHud()
    }

    this.shoot.onShotResolved = () => {
      this.recomputeVisibility()
      this.renderOverlay()
      this.refreshHud()
    }

    const canvas = this.engine.canvas
    canvas.addEventListener('pointerdown', this.onPointerDown)
    canvas.addEventListener('pointerup', this.onPointerUp)
    canvas.addEventListener('pointermove', this.onPointerMove)
    canvas.addEventListener('click', this.onClick)
    window.addEventListener('keydown', this.onKeyDown)

    turnManager.onSelectionChanged = () => {
      this.debug.refresh()
      this.planner.clear()
      this.renderOverlay()
      this.battlefield.flush()
      this.refreshHud()
    }

    this.recomputeVisibility()
    this.refreshHud()
  }

  /** Re-project game state into the HUD. The HUD reads nothing on its own. */
  private refreshHud(): void {
    const shooter = this.turnManager.selectedSoldier
    this.hud.render(
      buildHudModel({
        turnManager: this.turnManager,
        squads: this.squads,
        rig: this.rig,
        portraits: this.portraits,
        seedLabel: this.seedLabel,
        shootActive: this.shoot.active,
        waypointActive: this.planner.waypointMode,
        shoot:
          this.shoot.active && shooter
            ? {
                targets: this.shoot.availableTargets(shooter).map((soldier) => ({
                  soldier,
                  hitChance: calculateHitChance(this.battlefield.grid, shooter, soldier),
                })),
                pending: this.shoot.pending(shooter),
              }
            : null,
        grenade: { armed: this.grenade.armed, pending: this.grenade.pending(shooter) },
        networkMode: this.network?.mode ?? 'local',
        myFaction: this.network?.myFaction ?? Faction.Blue,
      }),
    )
  }

  /** Single place where a HUD press becomes a change to the game. */
  handleIntent(intent: HudIntent, isFromNetwork = false): void {
    if (!isFromNetwork && this.network && !this.network.isMyTurn(this.turnManager.activeFaction)) {
      return
    }
    if (!isFromNetwork && this.network && this.network.mode !== 'local') {
      this.network.send({ type: 'hudIntent', intent })
    }

    switch (intent.type) {
      case 'selectUnit': {
        const soldier = this.squads.byFaction[this.turnManager.activeFaction][intent.index]
        if (soldier && !soldier.isDead) {
          this.turnManager.selectSoldier(soldier)
          this.exitShootMode()
        }
        break
      }
      case 'shoot':
        this.enterShootMode()
        break
      case 'cancelShoot':
        this.exitShootMode()
        break
      case 'selectTarget': {
        const enemy = this.squads.byFaction[this.enemyFaction][intent.index]
        if (enemy && !enemy.isDead) this.shoot.selectTarget(enemy)
        this.renderOverlay()
        this.refreshHud()
        break
      }
      case 'fireShot': {
        const shooter = this.turnManager.selectedSoldier
        if (shooter) this.shoot.fire(shooter, intent.mode)
        break
      }
      case 'reload': {
        const selected = this.turnManager.selectedSoldier
        if (selected && !selected.isDead && selected.ap >= RULES.reloadApCost) {
          selected.ap -= RULES.reloadApCost
          selected.weapon.currentClip = selected.weapon.maxClip
          this.refreshHud()
        }
        break
      }
      case 'armGrenade': {
        const thrower = this.turnManager.selectedSoldier
        this.shoot.exit()
        if (this.grenade.armed === intent.kind) this.grenade.exit()
        else this.grenade.arm(intent.kind, thrower)
        this.planner.clear()
        this.renderOverlay()
        this.refreshHud()
        break
      }
      case 'confirmThrow': {
        const thrower = this.turnManager.selectedSoldier
        if (thrower) this.grenade.confirm(thrower)
        break
      }
      case 'cancelGrenade':
        this.grenade.exit()
        this.renderOverlay()
        this.refreshHud()
        break
      case 'openDebug':
        this.debug.toggle()
        break
      case 'toggleCover':
        this.toggleCover()
        break
      case 'toggleWaypoints':
        this.toggleWaypointMode()
        break
      case 'endUnitTurn': {
        const selected = this.turnManager.selectedSoldier
        if (selected) this.turnManager.finishSoldierTurn(selected)
        this.refreshHud()
        break
      }
      case 'requestTurnSwitch':
        this.hud.showTurnOverlay()
        break
      case 'confirmTurnSwitch':
        this.hud.hideTurnOverlay()
        this.turnManager.startNextTurn()
        this.onTurnSwitched()
        this.refreshHud()
        break
      case 'toggleFreelook':
        if (this.rig.isCharacterViewActive) this.rig.exitCharacterView()
        this.rig.toggleFreeLookMode()
        this.refreshHud()
        break
      case 'toggleUnitView': {
        const selected = this.turnManager.selectedSoldier
        if (!selected) break
        if (this.rig.isCharacterViewActive) {
          this.rig.exitCharacterView()
        } else {
          this.rig.enterCharacterView(selected.position, selected.currentYaw)
        }
        this.refreshHud()
        break
      }
    }
  }
  handleRemoteNetworkMessage(msg: NetworkMessage): void {
    switch (msg.type) {
      case 'hudIntent':
        this.handleIntent(msg.intent, true)
        break
      case 'clickTile':
        this.executeClickTile(msg.tile, msg.shiftKey)
        break
      case 'clickSoldier':
        this.executeClickSoldier(msg.soldierIndex, msg.faction)
        break
      case 'rightClickFacing':
        this.executeRightClickFacing(msg.x, msg.z)
        break
    }
  }

  dispose(): void {
    const canvas = this.engine.canvas
    canvas.removeEventListener('pointerdown', this.onPointerDown)
    canvas.removeEventListener('pointerup', this.onPointerUp)
    canvas.removeEventListener('pointermove', this.onPointerMove)
    canvas.removeEventListener('click', this.onClick)
    window.removeEventListener('keydown', this.onKeyDown)
    this.planner.dispose()
    this.shoot.dispose()
    this.grenade.dispose()
    this.debug.dispose()
    this.effects.dispose()
  }

  // ---------------------------------------------------------------------------
  // Mode transitions
  // ---------------------------------------------------------------------------

  enterShootMode(): void {
    if (!this.shoot.enter(this.turnManager.selectedSoldier)) return
    this.planner.clear()
    this.renderOverlay()
    this.refreshHud()
  }

  exitShootMode(): void {
    this.shoot.exit()
    this.grenade.exit()
    this.planner.clear()
    this.renderOverlay()
    this.refreshHud()
  }

  /** Hunker into / out of a crouch cover stance. Entering costs AP; standing is free. */
  toggleCover(): void {
    const soldier = this.turnManager.selectedSoldier
    if (!soldier || soldier.isDead || soldier.isMoving) return

    if (soldier.isCrouching) {
      soldier.exitCover()
    } else {
      if (soldier.ap < RULES.coverApCost) return
      soldier.ap -= RULES.coverApCost
      soldier.enterCover()
    }
    this.refreshHud()
  }

  toggleWaypointMode(): void {
    this.planner.toggleWaypointMode()
    this.renderOverlay()
    this.refreshHud()
  }

  onTurnSwitched(): void {
    if (this.rig.isCharacterViewActive) this.rig.exitCharacterView()
    this.exitShootMode()
    // Statuses and persistent smoke expire on the handover.
    tickStatuses(this.squads.soldiers)
    this.effects.tickTurn()
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
    if (this.network && !this.network.isMyTurn(this.turnManager.activeFaction)) return

    const travel = Math.hypot(
      event.clientX - this.rightDownPos.x,
      event.clientY - this.rightDownPos.y,
    )
    if (travel >= 6) return

    clientToNdc(this.engine.canvas, event.clientX, event.clientY, this.ndc)
    const pt = this.picker.fromNdc(this.ndc)
    if (!pt) return

    this.executeRightClickFacing(pt.x, pt.z)
    if (this.network && this.network.mode !== 'local') {
      this.network.send({ type: 'rightClickFacing', x: pt.x, z: pt.z })
    }
  }

  executeRightClickFacing(x: number, z: number): void {
    const selected = this.turnManager.selectedSoldier
    if (!selected || selected.isMoving || selected.isDead) return
    const dx = x - selected.position.x
    const dz = z - selected.position.z
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
    if (this.network && !this.network.isMyTurn(this.turnManager.activeFaction)) return

    const selected = this.turnManager.selectedSoldier

    // Tapping a friendly selects it.
    const friendly = this.pickSoldierUnderCursor(event, this.turnManager.activeFaction)
    if (friendly && friendly !== selected) {
      this.executeClickSoldier(friendly.squadIndex, friendly.faction)
      if (this.network && this.network.mode !== 'local') {
        this.network.send({ type: 'clickSoldier', soldierIndex: friendly.squadIndex, faction: friendly.faction })
      }
      return
    }

    if (!selected || selected.isDead) return
    const tile = this.tileFromEvent(event)
    if (!tile) return

    // With a grenade armed, a click aims the blast; the panel throws it.
    if (this.grenade.active) {
      this.grenade.aimAt(tile)
      this.renderOverlay()
      this.refreshHud()
      return
    }

    // In shoot mode a click on an enemy picks it as the target.
    if (this.shoot.active) {
      const enemy = this.pickSoldierUnderCursor(event, this.enemyFaction)
      if (enemy) {
        this.executeClickSoldier(enemy.squadIndex, enemy.faction)
        if (this.network && this.network.mode !== 'local') {
          this.network.send({ type: 'clickSoldier', soldierIndex: enemy.squadIndex, faction: enemy.faction })
        }
      }
      return
    }

    if (selected.isMoving || selected.ap <= 0) return
    const shiftKey = event.shiftKey
    const started = this.executeClickTile(tile, shiftKey)
    if (started && this.network && this.network.mode !== 'local') {
      this.network.send({ type: 'clickTile', tile: { x: tile.x, y: tile.y }, shiftKey })
    }
  }

  executeClickSoldier(soldierIndex: number, faction: Faction): void {
    const soldier = this.squads.byFaction[faction][soldierIndex]
    if (!soldier || soldier.isDead) return
    if (faction === this.turnManager.activeFaction) {
      this.turnManager.selectSoldier(soldier)
      this.exitShootMode()
    } else if (this.shoot.active) {
      this.shoot.selectTarget(soldier)
    }
    this.renderOverlay()
    this.refreshHud()
  }

  executeClickTile(tile: Tile, shiftKey: boolean): boolean {
    const selected = this.turnManager.selectedSoldier
    if (!selected || selected.isDead || selected.isMoving || selected.ap <= 0) return false
    const started = this.planner.handleClick(selected, tile, shiftKey)
    if (started) this.refreshHud()
    return started
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
    clientToNdc(this.engine.canvas, event.clientX, event.clientY, this.ndc)
    const groundPt = this.picker.fromNdc(this.ndc)
    if (!groundPt) return null
    const tile = this.battlefield.grid.worldToTile(groundPt.x, groundPt.z)
    return this.battlefield.grid.inBounds(tile.x, tile.y) ? tile : null
  }

  private pickSoldierUnderCursor(
    event: MouseEvent | PointerEvent,
    faction: Faction,
  ): Soldier | null {
    clientToNdc(this.engine.canvas, event.clientX, event.clientY, this.ndc)
    this.raycaster.setFromCamera(this.ndc, this.engine.camera)
    const hits = this.raycaster.intersectObjects(this.engine.scene.children, true)

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

    if (this.grenade.active) {
      this.planner.render(null)
      this.grenade.renderOverlay(this.battlefield.ground, selected, this.hoveredTile)
    } else if (this.shoot.active) {
      this.planner.render(null)
      this.shoot.renderOverlay(this.battlefield.ground, selected, this.hoveredEnemy)
    } else {
      this.planner.render(selected)
    }
  }

  update(delta: number): void {
    this.effects.update(delta)
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
        this.refreshHud()
      })

      if (!this.rig.isCharacterViewActive) this.rig.focusOn(selected.position)

      if (!moved) {
        this.recomputeVisibility()
        this.refreshHud()
      }
    }

    this.xray.update(this.engine.camera.position)
  }
}
