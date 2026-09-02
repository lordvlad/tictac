import { NetworkManager, type NetworkMessage } from './NetworkManager'
import { Raycaster, Vector2, Vector3 } from 'three'
import type { EngineContext } from '../engine'
import { CAM, Faction } from '../config'
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
import { GLOBAL_ENTITY_ID, type World } from '../ecs/World'
import { MovementSystem, CombatSystem, ItemSystem, RenderSystem } from '../ecs/systems'
import type { ItemId } from '../core/Items'

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
  private readonly grenade: GrenadePlanner
  private readonly debug: DebugPanel
  private readonly fog: FogOfWar
  private readonly xray: WallXray
  private readonly effects: Effects
  readonly movementSystem: MovementSystem
  readonly combatSystem: CombatSystem
  readonly itemSystem: ItemSystem
  readonly renderSystem: RenderSystem
  // Hover state (mouse only — touch has no hover phase).
  private hoveredTile: Tile | null = null
  private hoveredEnemy: Soldier | null = null

  private readonly raycaster = new Raycaster()
  private readonly picker: GroundPicker
  private readonly ndc = new Vector2()
  /** The player asked for unit view. Aiming borrows the same camera on its own. */
  private unitViewRequested = false
  private selectedLevelFilter: number = 0
  /** Scratch aim point for the shoulder camera, to avoid a per-frame allocation. */
  private readonly aimPoint = new Vector3()
  /** Where the right button went down, to tell a facing click from an orbit drag. */
  private readonly rightDownPos = new Vector2()

  constructor(
    readonly world: World,
    private readonly battlefield: Battlefield,
    private readonly squads: Squads,
    private readonly turnManager: TurnManager,
    private readonly rig: OrbitRig,
    private readonly hud: Hud,
    private readonly portraits: OffscreenPortraits,
    private readonly seedLabel: string,
    tracers: Tracers,
    private readonly engine: EngineContext,
    public network: NetworkManager | null = null,
  ) {
    this.effects = new Effects(engine)

    this.movementSystem = new MovementSystem(battlefield.grid)
    this.combatSystem = new CombatSystem(battlefield.grid, squads, tracers)
    this.itemSystem = new ItemSystem()
    this.renderSystem = new RenderSystem()

    this.world.addSystem(this.movementSystem)
    this.world.addSystem(this.combatSystem)
    this.world.addSystem(this.itemSystem)
    this.world.addSystem(turnManager.turns)
    this.world.addSystem(this.renderSystem)

    this.itemSystem.onItemUsed = () => {
      this.recomputeVisibility()
      this.renderOverlay()
      this.refreshHud()
      this.debug.refresh()
    }

    for (const soldier of squads.soldiers) this.renderSystem.bind(soldier)

    this.movementSystem.onStep = () => {
      this.recomputeVisibility()
      this.refreshHud()
    }
    this.movementSystem.onArrived = () => {
      this.recomputeVisibility()
      this.refreshHud()
    }

    if (network && network.mode !== 'local') {
      // Each side owns its own squad; the host additionally owns the shared
      // rule tables, which live on the global entity.
      network.bindWorld(this.world, (entityId) => {
        if (entityId === GLOBAL_ENTITY_ID) return network.mode !== 'join'
        return squads.byEntityId(entityId)?.faction === network.myFaction
      })
      // Peer state landed in components; the view has to catch up with it.
      network.onComponentUpdate = () => {
        this.recomputeVisibility()
        this.renderOverlay()
        this.battlefield.flush()
        this.refreshHud()
        this.debug.refresh()
      }
    }

    this.planner = new MovementPlanner(battlefield.grid, squads, engine)
    this.shoot = new ShootPlanner(battlefield.grid, squads, this.combatSystem, engine)
    this.combatSystem.onShotResolved = (_shooter, target, result) => {
      this.shoot.reportShot(target, result)
    }
    this.planner.onMovementStarted = (soldier, path) => {
      this.movementSystem.startMovement(this.world, soldier.entityId, path)
      if (this.network && this.network.isMyTurn(soldier.faction)) {
        this.network.send({
          type: 'moveUnit',
          faction: soldier.faction,
          squadIndex: soldier.squadIndex,
          path: path.map((t) => ({ x: t.x, y: t.y })),
        })
      }
    }
    this.grenade = new GrenadePlanner(battlefield.grid, squads, this.combatSystem, this.effects, rig, engine)
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

    this.battlefield.blocks.setLevelFilter(0)

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
        selectedLevelFilter: this.selectedLevelFilter,
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
        unitViewRequested: this.unitViewRequested,
        networkMode: this.network?.mode ?? 'local',
        myFaction: this.network?.myFaction ?? Faction.Blue,
      }),
    )
  }

  /** Single place where a HUD press becomes a change to the game. */
  handleIntent(intent: HudIntent): void {
    if (this.network && !this.network.isMyTurn(this.turnManager.activeFaction)) {
      return
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
        if (shooter) {
          const shotData = this.shoot.fire(shooter, intent.mode)
          if (shotData && this.network && this.network.mode !== 'local') {
            this.network.send({
              type: 'fireShot',
              shooterFaction: shooter.faction,
              shooterIndex: shooter.squadIndex,
              targetFaction: shotData.target.faction,
              targetIndex: shotData.target.squadIndex,
              mode: intent.mode,
              rolls: shotData.rolls,
            })
          }
        }
        break
      }
      case 'reload': {
        const selected = this.turnManager.selectedSoldier
        if (selected && this.combatSystem.reload(selected)) {
          this.refreshHud()
          this.network?.send({
            type: 'reload',
            faction: selected.faction,
            squadIndex: selected.squadIndex,
          })
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
      case 'useItem':
        this.useItem(intent.itemId)
        break
      case 'confirmThrow':
        this.confirmThrow()
        break
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
        if (selected && !selected.isDead) {
          this.turnManager.finishSoldierTurn(selected)
          this.refreshHud()
          if (this.network && this.network.mode !== 'local') {
            this.network.send({
              type: 'endUnitTurn',
              faction: selected.faction,
              squadIndex: selected.squadIndex,
            })
          }
        }
        break
      }
      case 'requestTurnSwitch':
        if (this.network && this.network.mode !== 'local') {
          this.network.send({ type: 'endTurn', faction: this.turnManager.activeFaction })
          this.turnManager.startNextTurn()
          this.onTurnSwitched()
          this.refreshHud()
        } else {
          this.hud.showTurnOverlay()
        }
        break
      case 'confirmTurnSwitch':
        this.hud.hideTurnOverlay()
        if (this.network && this.network.mode !== 'local') {
          this.network.send({ type: 'endTurn', faction: this.turnManager.activeFaction })
        }
        this.turnManager.startNextTurn()
        this.onTurnSwitched()
        this.refreshHud()
        break
      case 'selectLevel':
        this.selectedLevelFilter = intent.level
        this.battlefield.blocks.setLevelFilter(intent.level)
        this.rig.setFocusLevel(intent.level)
        this.renderOverlay()
        this.refreshHud()
        break
      case 'toggleFreelook':
        this.unitViewRequested = false
        if (this.rig.isShoulderViewActive) this.rig.exitShoulderView()
        this.rig.toggleFreeLookMode()
        this.refreshHud()
        break
      case 'toggleUnitView':
        if (!this.turnManager.selectedSoldier) break
        this.unitViewRequested = !this.unitViewRequested
        this.refreshHud()
        break
    }
  }
  handleRemoteNetworkMessage(msg: NetworkMessage): void {
    switch (msg.type) {
      case 'moveUnit': {
        const soldier = this.squads.byFaction[msg.faction][msg.squadIndex]
        if (!soldier || soldier.isDead) break
        this.planner.clear()
        this.movementSystem.startMovement(this.world, soldier.entityId, msg.path)
        this.refreshHud()
        break
      }
      case 'fireShot': {
        const shooter = this.squads.byFaction[msg.shooterFaction][msg.shooterIndex]
        const target = this.squads.byFaction[msg.targetFaction][msg.targetIndex]
        if (!shooter || !target) break
        this.combatSystem.fireShot(shooter, target, msg.mode, msg.rolls, true)
        this.afterCombat()
        break
      }
      case 'throwGrenade': {
        const shooter = this.squads.byFaction[msg.shooterFaction][msg.shooterIndex]
        if (!shooter) break
        this.grenade.executeThrowAt(shooter, msg.kind, msg.targetTile, true)
        this.afterCombat()
        break
      }
      case 'reload': {
        const soldier = this.squads.byFaction[msg.faction][msg.squadIndex]
        if (!soldier) break
        this.combatSystem.reload(soldier)
        this.refreshHud()
        break
      }
      case 'toggleCover': {
        const soldier = this.squads.byFaction[msg.faction][msg.squadIndex]
        if (!soldier) break
        this.combatSystem.toggleCover(this.world, soldier.entityId)
        this.refreshHud()
        break
      }
      case 'endUnitTurn': {
        const soldier = this.squads.byFaction[msg.faction][msg.squadIndex]
        if (!soldier || soldier.isDead) break
        this.turnManager.finishSoldierTurn(soldier)
        this.refreshHud()
        break
      }
      case 'endTurn': {
        this.turnManager.startNextTurn()
        this.onTurnSwitched()
        this.refreshHud()
        break
      }
      case 'rightClickFacing': {
        const soldier = this.squads.byFaction[msg.faction][msg.squadIndex]
        if (!soldier || soldier.isDead) break
        const dx = msg.x - soldier.position.x
        const dz = msg.z - soldier.position.z
        if (Math.hypot(dx, dz) > 0.01) soldier.targetYaw = Math.atan2(dx, dz)
        break
      }
      case 'useItem': {
        const soldier = this.squads.byFaction[msg.faction][msg.squadIndex]
        if (!soldier) break
        this.itemSystem.use(soldier, msg.itemId, true)
        this.refreshHud()
        break
      }
      case 'init':
        break
    }
  }

  /** Shared post-combat refresh: damage can reveal, kill, and re-cover. */
  private afterCombat(): void {
    this.recomputeVisibility()
    this.renderOverlay()
    this.refreshHud()
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

  /** Throw the armed grenade at the aimed tile, and tell the peer. */
  confirmThrow(): void {
    const thrower = this.turnManager.selectedSoldier
    if (!thrower) return
    const thrown = this.grenade.confirm(thrower)
    if (!thrown) return
    this.network?.send({
      type: 'throwGrenade',
      shooterFaction: thrower.faction,
      shooterIndex: thrower.squadIndex,
      kind: thrown.kind,
      targetTile: thrown.targetTile,
    })
  }

  /** Use a carried consumable on the selected unit, and tell the peer. */
  useItem(itemId: ItemId): void {
    const soldier = this.turnManager.selectedSoldier
    if (!soldier) return
    if (!this.itemSystem.use(soldier, itemId)) return
    this.network?.send({
      type: 'useItem',
      faction: soldier.faction,
      squadIndex: soldier.squadIndex,
      itemId,
    })
  }

  /** Hunker into / out of a crouch cover stance. Entering costs AP; standing is free. */
  toggleCover(): void {
    const soldier = this.turnManager.selectedSoldier
    if (!soldier) return
    if (!this.combatSystem.toggleCover(this.world, soldier.entityId)) return
    this.refreshHud()
    this.network?.send({
      type: 'toggleCover',
      faction: soldier.faction,
      squadIndex: soldier.squadIndex,
    })
  }

  toggleWaypointMode(): void {
    this.planner.toggleWaypointMode()
    this.renderOverlay()
    this.refreshHud()
  }

  onTurnSwitched(): void {
    this.unitViewRequested = false
    if (this.rig.isShoulderViewActive) this.rig.exitShoulderView()
    this.exitShootMode()
    // Statuses and persistent smoke expire on the handover.
    tickStatuses(this.squads.soldiers)
    this.effects.tickTurn()

    if (this.network && this.network.mode !== 'local') {
      const myFaction = this.network.myFaction
      if (this.turnManager.activeFaction === myFaction) {
        const living = this.squads.getLiving(myFaction)
        if (living.length > 0) this.turnManager.selectSoldier(living[0]!)
      } else {
        this.turnManager.selectSoldier(null)
      }
    }

    this.recomputeVisibility()
  }

  recomputeVisibility(): void {
    const fogFaction =
      this.network && this.network.mode !== 'local'
        ? this.network.myFaction
        : this.turnManager.activeFaction
    this.fog.recompute(fogFaction, this.squads)
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

    const selected = this.turnManager.selectedSoldier
    if (!selected || selected.isMoving || selected.isDead) return

    clientToNdc(this.engine.canvas, event.clientX, event.clientY, this.ndc)
    const pt = this.picker.fromNdc(this.ndc)
    if (!pt) return

    this.executeRightClickFacing(selected.squadIndex, selected.faction, pt.x, pt.z)
    if (this.network && this.network.mode !== 'local') {
      this.network.send({
        type: 'rightClickFacing',
        faction: selected.faction,
        squadIndex: selected.squadIndex,
        x: pt.x,
        z: pt.z,
      })
    }
  }

  executeRightClickFacing(squadIndex: number, faction: Faction, x: number, z: number): void {
    const soldier = this.squads.byFaction[faction][squadIndex]
    if (!soldier || soldier.isMoving || soldier.isDead) return
    const dx = x - soldier.position.x
    const dz = z - soldier.position.z
    if (Math.hypot(dx, dz) > 0.01) soldier.targetYaw = Math.atan2(dx, dz)
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
      // Selecting friendly unit is local-only
      return
    }

    if (!selected || selected.isDead) return
    const tile = this.tileFromEvent(event)
    if (!tile) return

    // A grenade is armed: the first tap aims the blast, a second tap on the
    // same tile throws it. Tapping elsewhere re-aims instead of committing, so
    // a mis-tap costs nothing.
    if (this.grenade.active) {
      if (this.grenade.isAimedAt(tile)) this.confirmThrow()
      else this.grenade.aimAt(tile)
      this.renderOverlay()
      this.refreshHud()
      return
    }

    // In shoot mode a click on an enemy picks it as the target.
    if (this.shoot.active) {
      const enemy = this.pickSoldierUnderCursor(event, this.enemyFaction)
      if (enemy) {
        this.executeClickSoldier(enemy.squadIndex, enemy.faction)
      }
      return
    }

    if (selected.isMoving || selected.ap <= 0) return
    const shiftKey = event.shiftKey
    this.executeClickTile(tile, shiftKey)
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
    // Systems advance the simulation; every mutation lands in a component.
    this.world.update(delta)
    this.effects.update(delta)
    this.planner.update(delta)

    this.updateShoulderCamera()

    const selected = this.turnManager.selectedSoldier
    if (selected && !selected.isDead && selected.instance) {
      selected.instance.visible = true
      if (selected.isMoving && !this.rig.isShoulderViewActive) this.rig.focusOn(selected.position)
    }

    this.xray.update(this.engine.camera.position)

    // One pass at the end: whatever changed this tick — from input, combat,
    // a system or the debug panel — replicates from here and nowhere else.
    this.world.syncDirty()
  }

  /**
   * Decide whether the shoulder camera is up this frame, and where it looks.
   *
   * Two things ask for it — the unit-view toggle, and lining up a shot — so
   * the question is answered in one place rather than by enter/exit calls
   * scattered across the input handlers.
   */
  private updateShoulderCamera(): void {
    const selected = this.turnManager.selectedSoldier
    const alive = selected !== null && !selected.isDead
    const aimTarget = this.shoot.active ? this.shoot.selectedTarget : null
    const wanted = alive && (this.unitViewRequested || aimTarget !== null)

    if (!wanted) {
      if (this.rig.isShoulderViewActive) this.rig.exitShoulderView()
      return
    }

    const shooter = selected!
    let yaw = shooter.currentYaw
    let lookAt: Vector3 | undefined

    if (aimTarget) {
      const dx = aimTarget.position.x - shooter.position.x
      const dz = aimTarget.position.z - shooter.position.z
      if (Math.hypot(dx, dz) > 0.01) {
        // Stand behind the shot line and centre the target's chest in frame.
        yaw = Math.atan2(dx, dz)
        lookAt = this.aimPoint
          .copy(aimTarget.position)
          .setY(aimTarget.position.y + CAM.shoulderAimHeight)
      }
    }

    if (this.rig.isShoulderViewActive) this.rig.updateShoulderView(shooter.position, yaw, lookAt)
    else this.rig.enterShoulderView(shooter.position, yaw, lookAt)
  }
}
