import { NetworkManager, type NetworkMessage } from './NetworkManager'
import { Raycaster, Vector2, Vector3 } from 'three'
import type { EngineContext } from '../engine'
import { CAM, Faction, LEVEL_HEIGHT } from '../config'
import { clientToNdc } from '../core/screen'
import type { Tile } from '../core/Grid'
import type { Soldier } from '../entities/Soldier'
import type { OrbitRig } from '../camera/OrbitRig'
import { GroundPicker } from '../camera/GroundPicker'
import type { Hud } from '../hud/Hud'
import { buildHudModel, type HudIntent } from '../hud/HudModel'
import { calculateHitChance } from './Combat'
import { compareDigests, digestWorld, reportDivergence, type StateDigest } from './StateDigest'
import { RpcMethods } from './JsonRpc'
import type { Roll } from '../core/rng'
import { Recorder, type RecordingHeader } from './Recording'
import type { OffscreenPortraits } from '../render/Portraits'
import type { Battlefield } from './Battlefield'
import { FogOfWar } from './FogOfWar'
import { MovementPlanner } from './MovementPlanner'
import { DebugPanel, type RecordingControls } from '../hud/DebugPanel'
import { downloadJson } from '../hud/download'
import { DebugMap } from '../hud/DebugMap'
import { GrenadePlanner } from './GrenadePlanner'
import { ShootPlanner } from './ShootPlanner'
import { Effects } from '../render/Effects'
import { SceneCombatFx } from '../render/SceneCombatFx'
import { SquadViews } from '../render/SquadViews'
import { WallXray } from './WallXray'
import type { Squads } from './Squads'
import type { TurnManager } from './TurnManager'
import type { Tracers } from '../render/Tracers'
import { GLOBAL_ENTITY_ID, type World } from '../ecs/World'
import { MovementSystem, CombatSystem, CommandSystem, ItemSystem, RenderSystem, WallSystem } from '../ecs/systems'
import { type Carried, type Command, type CommandOrigin, isCommand } from '../ecs/systems/CommandSystem'
import { ITEMS, type ItemId, itemTargetsAlly } from '../core/Items'
import { distance, facingYaw } from '../core/math'

/**
 * The intents a spectator may still press.
 *
 * Everything here changes only what is on screen — which storey is drawn, where
 * the camera stands, which panel is open. Nothing here spends a point or moves
 * a unit, because in a replay the file is the only authority over that.
 */
/**
 * How far a soldier can reach to work on a squadmate, in tiles.
 *
 * One tile means orthogonally or diagonally adjacent, which is what handing
 * somebody a dressing actually takes. Anything longer and a medic treats
 * across a room; anything shorter and only the unit itself qualifies.
 */
const ITEM_REACH = 1

const SPECTATOR_INTENTS: Partial<Record<HudIntent['type'], true>> = {
  openDebug: true,
  toggleDebugMap: true,
  selectLevel: true,
  toggleFreelook: true,
  toggleUnitView: true,
  selectUnit: true,
}

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
  private readonly debugMap = new DebugMap()
  private readonly fog: FogOfWar
  private readonly xray: WallXray
  private readonly effects: Effects
  readonly movementSystem: MovementSystem
  readonly combatSystem: CombatSystem
  /**
   * The one door for anything that changes the world — this player's clicks,
   * the other player's messages and a replay's file alike. See
   * {@link CommandSystem} for why there is only one.
   */
  readonly commands: CommandSystem
  readonly itemSystem: ItemSystem
  readonly renderSystem: RenderSystem
  readonly wallSystem: WallSystem
  // Hover state (mouse only — touch has no hover phase).
  /**
   * The item waiting for a patient, and the squadmate picked for it.
   *
   * Held here rather than in a planner because there is no rule to plan: the
   * item's own effects decide what it does, and who gets it is pure input.
   */
  private aimedItem: ItemId | null = null
  private itemTarget: Soldier | null = null

  private hoveredTile: Tile | null = null
  private hoveredEnemy: Soldier | null = null

  private readonly raycaster = new Raycaster()
  private readonly picker: GroundPicker
  private readonly ndc = new Vector2()
  /** The player asked for unit view. Aiming borrows the same camera on its own. */
  private unitViewRequested = false
  private selectedLevelFilter: number = 0
  /** Highest storey this map has; the level selector offers one button each. */
  private readonly topLevel: number
  /** Scratch aim point for the shoulder camera, to avoid a per-frame allocation. */
  private readonly aimPoint = new Vector3()
  /** Scratch for tile picking, to avoid a per-event allocation. */
  private readonly pickPoint = new Vector3()
  /** Where the right button went down, to tell a facing click from an orbit drag. */
  private readonly rightDownPos = new Vector2()
  /** The squad's bodies. Everything needing a mesh asks this, and only this. */
  private readonly views: SquadViews
  /**
   * Watching a recording rather than commanding a match.
   *
   * Two things change: nothing is hidden, because the point of a replay is to
   * watch both sides; and input cannot move a unit, because the only authority
   * over what happens is the file.
   */
  spectating = false
  /** A recording was armed once this match, so it cannot be armed again. */
  private recordingStarted = false
  /**
   * Every command the world applied while armed, from either side. Fed by the
   * applier rather than by the network's send, which only ever saw this side.
   * Null unless the debug panel armed it.
   */
  private recorder: Recorder | null = null

  constructor(
    readonly world: World,
    private readonly battlefield: Battlefield,
    private readonly squads: Squads,
    private readonly turnManager: TurnManager,
    private readonly rig: OrbitRig,
    private readonly hud: Hud,
    private readonly portraits: OffscreenPortraits,
    private readonly seedLabel: string,
    /**
     * The match's dice.
     *
     * Passed in from the seed rather than reached for, so that both peers, a
     * replay and a sweep all resolve the same fight from the same stream. The
     * one rule about it: only the rules may draw from it — a tracer's scatter
     * or a puff of smoke takes its own randomness, because a draw here moves
     * every later roll in the match.
     */
    private readonly dice: Roll,
    tracers: Tracers,
    private readonly engine: EngineContext,
    public network: NetworkManager | null = null,
    /** The match's opening position, for a recording armed from the debug panel. */
    private readonly recordingHeader: RecordingHeader | null = null,
  ) {
    this.effects = new Effects(engine)
    this.topLevel = battlefield.grid.maxLevel

    this.movementSystem = new MovementSystem(battlefield.grid)
    this.itemSystem = new ItemSystem()
    this.renderSystem = new RenderSystem()
    // Bodies before the systems that announce to them.
    this.views = new SquadViews(engine, squads, this.renderSystem)
    this.combatSystem = new CombatSystem(
      battlefield.grid,
      squads,
      new SceneCombatFx(tracers, this.views),
      dice,
    )
    this.wallSystem = new WallSystem(battlefield.grid)
    this.commands = new CommandSystem(
      world,
      squads,
      turnManager,
      this.movementSystem,
      this.combatSystem,
      this.itemSystem,
    )

    // First, so a queued command is applied before the tick that walks it.
    this.world.addSystem(this.commands)
    this.world.addSystem(this.movementSystem)
    this.world.addSystem(this.combatSystem)
    this.world.addSystem(this.itemSystem)
    this.world.addSystem(turnManager.turns)
    this.world.addSystem(this.renderSystem)
    this.world.addSystem(this.wallSystem)

    // One entity per wall, so the map's boundaries are state the systems and
    // the network can reach like any other.
    this.wallSystem.spawnFromGrid(this.world)
    this.wallSystem.onWallsChanged = () => {
      this.battlefield.blocks.rebuildWalls()
      this.recomputeVisibility()
      this.renderOverlay()
      this.battlefield.flush()
    }

    this.itemSystem.onItemUsed = () => {
      this.recomputeVisibility()
      this.renderOverlay()
      this.refreshHud()
      this.debug.refresh()
    }


    // Reactions are the applier's, resolved before this is called: the fog
    // and the HUD show the result of a watcher's shot, not the moment before.
    this.commands.onStep = () => {
      this.recomputeVisibility()
      this.refreshHud()
    }
    this.commands.onBeforeApply = (command, origin) => {
      // The fingerprint is of the world as this side hands it over, so it is
      // taken at the last moment the handover has not happened yet.
      if (command.type === 'endTurn' && origin === 'local') this.sendStateDigest()
    }
    this.commands.onApplied = (command, result, origin) => {
      // Everything that happened, from either side, is what a recording is
      // of; a replay's own commands are already on file.
      if (origin !== 'record') this.recorder?.record(command)
      // Only this side's own decisions travel, and only once the rules took
      // them: a refusal spent nothing here and would be refused there too.
      if (origin === 'local') this.network?.send(command)
      this.present(command, result, origin)
    }
    this.commands.onRefused = (command, refusal, origin) => {
      // From the player, a refusal is a click the rules turned down. From a
      // peer or a file it means two sides disagree about what was possible.
      if (origin !== 'local') {
        console.error(`[commands] ${origin} ${command.type} refused: ${refusal.reason}`, command)
      }
    }
    this.movementSystem.onArrived = () => {
      this.recomputeVisibility()
      this.refreshHud()
    }

    if (network && network.mode !== 'local') {
      // Each side owns its own squad. The host additionally owns everything
      // shared: the rule tables on the global entity, and the terrain. Walls
      // belong to no faction, so without naming an authority neither peer
      // would ever replicate a change to one.
      const wallEntities = new Set(this.wallSystem.entityIds)
      network.bindWorld(this.world, (entityId) => {
        if (entityId === GLOBAL_ENTITY_ID) return network.mode !== 'join'
        if (wallEntities.has(entityId)) return network.mode !== 'join'
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
    this.shoot = new ShootPlanner(battlefield.grid, squads, engine)
    this.combatSystem.onShotResolved = (shooter, target, result) => {
      this.shoot.reportShot(shooter, target, result)
    }
    this.planner.onMovementStarted = (soldier, path) => {
      this.commands.apply(
        {
          type: 'moveUnit',
          faction: soldier.faction,
          squadIndex: soldier.squadIndex,
          path: path.map((t) => ({ x: t.x, y: t.y })),
        },
        'local',
      )
    }
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
      this.recordingControls(),
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
        shootReady: this.shoot.canEnter(shooter),
        waypointActive: this.planner.waypointMode,
        selectedLevelFilter: this.selectedLevelFilter,
        topLevel: this.topLevel,
        debugMapOpen: this.debugMap.isOpen,
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
        item:
          this.aimedItem !== null && shooter
            ? {
                itemId: this.aimedItem,
                candidates: this.itemCandidates(shooter),
                target: this.itemTarget,
              }
            : null,
        unitViewRequested: this.unitViewRequested,
        networkMode: this.network?.mode ?? 'local',
        myFaction: this.network?.myFaction ?? Faction.Blue,
      }),
    )
  }

  /**
   * The recorder, as the debug panel is allowed to touch it.
   *
   * Arming is refused once the match has issued a command, because a stream
   * that does not begin at the opening position cannot be replayed at all:
   * playback rebuilds state by re-running the rules over the commands, from
   * the start. Better to say so than to write a file that desynchronises.
   */
  private recordingControls(): RecordingControls | null {
    if (!this.recordingHeader) return null
    return {
      isRecording: () => this.recorder !== null,
      canArm: () => !this.recordingStarted && this.turnManager.turnNumber === 1,
      eventCount: () => this.recorder?.eventCount ?? 0,
      setRecording: (on) => {
        const header = this.recordingHeader
        if (!header) return
        if (!on) {
          this.recorder = null
          return
        }
        if (this.recordingStarted) return
        this.recorder = new Recorder(header, () => ({
          turn: this.turnManager.turnNumber,
          faction: this.turnManager.activeFaction,
        }))
        this.recordingStarted = true
      },
      export: () => {
        const recorder = this.recorder
        if (!recorder || recorder.eventCount === 0) return
        downloadJson(recorder.filename(), recorder.toJSON())
      },
    }
  }

  /**
   * Apply a recorded command as a spectator.
   *
   * Through the same door as the player's own clicks and the peer's messages.
   * Playback paces itself on {@link anyUnitMoving}, so the command is applied
   * at once rather than queued.
   */
  applyRecordedCommand(command: NetworkMessage): void {
    if (isCommand(command)) this.commands.apply(command, 'record')
  }

  /** True while a unit is still walking, which is what paces a replay. */
  get anyUnitMoving(): boolean {
    return this.commands.busy
  }

  /** Single place where a HUD press becomes a change to the game. */
  handleIntent(intent: HudIntent): void {
    if (this.network && !this.network.isMyTurn(this.turnManager.activeFaction)) {
      return
    }
    // A replay is not commanded. Only the view controls answer: the panels that
    // would spend a unit's points are hidden, and this is what makes that a rule
    // rather than a consequence of the layout.
    if (this.spectating && !SPECTATOR_INTENTS[intent.type]) return

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
        const target = shooter ? this.shoot.choose(shooter, intent.mode) : null
        if (!shooter || !target) break
        this.commands.apply(
          {
            type: 'fireShot',
            shooterFaction: shooter.faction,
            shooterIndex: shooter.squadIndex,
            targetFaction: target.faction,
            targetIndex: target.squadIndex,
            mode: intent.mode,
          },
          'local',
        )
        break
      }
      case 'meleeAttack': {
        const attacker = this.turnManager.selectedSoldier
        const target = this.shoot.selectedTarget
        if (!attacker || !target) break
        this.commands.apply(
          {
            type: 'meleeAttack',
            attackerFaction: attacker.faction,
            attackerIndex: attacker.squadIndex,
            targetFaction: target.faction,
            targetIndex: target.squadIndex,
          },
          'local',
        )
        break
      }
      case 'reload': {
        const selected = this.turnManager.selectedSoldier
        if (selected) this.commands.apply({ type: 'reload', faction: selected.faction, squadIndex: selected.squadIndex }, 'local')
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
      case 'confirmItem':
        this.confirmItem()
        break
      case 'cancelItem':
        this.exitItemMode()
        break
      case 'cancelGrenade':
        this.grenade.exit()
        this.renderOverlay()
        this.refreshHud()
        break
      case 'openDebug':
        this.debug.toggle()
        break
      case 'toggleDebugMap':
        this.debugMap.toggle()
        this.debugMap.refresh(this.battlefield.grid, this.squads, this.selectedLevelFilter, this.seedLabel)
        this.refreshHud()
        break
      case 'overwatch': {
        const soldier = this.turnManager.selectedSoldier
        if (soldier) this.commands.apply({ type: 'overwatch', faction: soldier.faction, squadIndex: soldier.squadIndex }, 'local')
        break
      }
      case 'toggleCover':
        this.toggleCover()
        break
      case 'toggleWaypoints':
        this.toggleWaypointMode()
        break
      case 'endUnitTurn': {
        const selected = this.turnManager.selectedSoldier
        if (selected) {
          this.commands.apply({ type: 'endUnitTurn', faction: selected.faction, squadIndex: selected.squadIndex }, 'local')
        }
        break
      }
      case 'requestTurnSwitch':
        // Hot seat asks the next player to take the chair first; a networked
        // match has nobody to hand the screen to.
        if (this.network && this.network.mode !== 'local') {
          this.commands.apply({ type: 'endTurn', faction: this.turnManager.activeFaction }, 'local')
        } else {
          this.hud.showTurnOverlay()
        }
        break
      case 'confirmTurnSwitch':
        this.hud.hideTurnOverlay()
        this.commands.apply({ type: 'endTurn', faction: this.turnManager.activeFaction }, 'local')
        break
      case 'selectLevel':
        this.selectedLevelFilter = intent.level
        this.battlefield.blocks.setLevelFilter(intent.level)
        this.rig.setFocusLevel(intent.level)
        this.renderOverlay()
        if (this.debugMap.isOpen) this.debugMap.refresh(this.battlefield.grid, this.squads, this.selectedLevelFilter, this.seedLabel)
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
  /**
   * A frame from the other player.
   *
   * Commands wait their turn in the applier's queue rather than being applied
   * on arrival: the network delivers faster than this side animates, and a
   * shot resolved while its shooter's move is still being walked here would be
   * resolved from somewhere the peer never stood.
   */
  handleRemoteNetworkMessage(msg: NetworkMessage): void {
    if (isCommand(msg)) {
      this.commands.enqueue(msg, 'peer')
      return
    }
    if (msg.type === 'digest') {
      // Compared once everything the peer sent before it has been applied and
      // has stopped moving, because that is the state the sender
      // fingerprinted: immediately before it handed over.
      const digest = msg.digest
      this.commands.whenSettled(() =>
        reportDivergence(
          `state at the end of turn ${digest.turn}`,
          compareDigests(this.localDigest(), digest, (entityId) => this.unitName(entityId)),
        ),
      )
    }
  }

  /**
   * What the player sees change once a command has been carried out.
   *
   * Presentation only — every rule has already run. The shot and blow cases
   * have next to nothing to do because `CombatSystem.onShotResolved` already
   * drew the damage and settled shoot mode; a throw has to be drawn here
   * because the blast is the result's, not the planner's.
   */
  private present(command: Command, result: Carried, origin: CommandOrigin): void {
    switch (command.type) {
      case 'moveUnit':
        // A peer's route replaces whatever this side was previewing.
        if (origin !== 'local') this.planner.clear()
        this.refreshHud()
        return
      case 'throwGrenade': {
        const thrower = this.squads.byFaction[command.shooterFaction][command.shooterIndex]
        if (thrower && result.grenade) {
          this.grenade.replayThrow(
            command.kind,
            command.targetTile,
            thrower.grenadeSpecs[command.kind].areaRadius,
            result.grenade.hits,
          )
        }
        this.afterCombat()
        return
      }
      case 'fireShot':
      case 'meleeAttack':
      case 'useItem':
        this.afterCombat()
        return
      case 'endTurn':
        this.onTurnSwitched()
        // The played game picks the incoming side's first unit for the player;
        // a replay does it so the camera follows whoever acts next.
        if (origin === 'record') this.turnManager.autoSelectFirst()
        this.refreshHud()
        return
      case 'reload':
      case 'toggleCover':
      case 'overwatch':
      case 'endUnitTurn':
      case 'rightClickFacing':
        this.refreshHud()
        return
    }
  }

  /**
   * This side's fingerprint of the world, as of now.
   *
   * The soldiers are named in detail because they are what a match moves; the
   * terrain and the rule tables fold into a number each, which is enough to say
   * *that* they differ.
   */
  private localDigest(): StateDigest {
    return digestWorld(
      this.world,
      this.squads.soldiers.map((unit) => unit.entityId),
      this.turnManager.turnNumber,
    )
  }

  private unitName(entityId: number): string {
    return this.squads.soldiers.find((unit) => unit.entityId === entityId)?.name ?? `#${entityId}`
  }

  /**
   * Publish the fingerprint, then hand over.
   *
   * Past the recorder deliberately: a digest is a claim about state, and a
   * replay rebuilds state from the intents rather than checking it. Recording
   * it would put a number in the log that the log itself has to reproduce.
   *
   * With outcomes off the wire, this is the only thing that notices two peers
   * drifting apart — which is why it runs every handover rather than on demand.
   */
  private sendStateDigest(): void {
    if (!this.network || this.network.mode === 'local') return
    this.network.sendRpc({
      jsonrpc: '2.0',
      method: RpcMethods.digest,
      params: { digest: this.localDigest() },
    })
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
    this.debugMap.dispose()
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

  /** Throw the armed grenade at the aimed tile. */
  confirmThrow(): void {
    const thrower = this.turnManager.selectedSoldier
    const aimed = thrower ? this.grenade.aimed(thrower) : null
    if (!thrower || !aimed) return
    this.commands.apply(
      {
        type: 'throwGrenade',
        shooterFaction: thrower.faction,
        shooterIndex: thrower.squadIndex,
        kind: aimed.kind,
        targetTile: aimed.targetTile,
      },
      'local',
    )
  }

  /**
   * Press an item row.
   *
   * Kit one soldier can administer to another starts by picking who gets it,
   * the way a shot starts by picking what is being shot at: target choice and
   * commitment are separate taps, so choosing wrongly costs nothing. Pressing
   * the same row again puts it away, as arming a grenade twice does.
   * Everything else is used where it stands, exactly as before.
   */
  useItem(itemId: ItemId): void {
    const soldier = this.turnManager.selectedSoldier
    if (!soldier) return
    if (!Object.hasOwn(ITEMS, itemId)) return

    if (!itemTargetsAlly(ITEMS[itemId])) {
      this.applyItem(soldier, itemId, soldier)
      return
    }

    if (this.aimedItem === itemId) {
      this.exitItemMode()
      return
    }
    this.shoot.exit()
    this.grenade.exit()
    this.planner.clear()
    this.aimedItem = itemId
    this.itemTarget = this.neediestNearby(soldier, itemId)
    this.renderOverlay()
    this.refreshHud()
  }

  /** Aim the item being held at a squadmate, if they are one it can reach. */
  private selectItemTarget(soldier: Soldier): void {
    const user = this.turnManager.selectedSoldier
    if (!user || this.aimedItem === null) return
    if (!this.itemCandidates(user).includes(soldier)) return
    this.itemTarget = soldier
    this.renderOverlay()
    this.refreshHud()
  }

  /** Use the item being held on the squadmate picked for it. */
  confirmItem(): void {
    const user = this.turnManager.selectedSoldier
    const itemId = this.aimedItem
    const target = this.itemTarget
    if (!user || itemId === null || !target) return
    this.exitItemMode()
    this.applyItem(user, itemId, target)
  }

  private exitItemMode(): void {
    this.aimedItem = null
    this.itemTarget = null
    this.renderOverlay()
    this.refreshHud()
  }

  /**
   * Squadmates `user` can put their hands on: alive, on their side and within
   * arm's reach — themselves included, since treating yourself is still a use.
   */
  private itemCandidates(user: Soldier): Soldier[] {
    return this.squads.byFaction[user.faction].filter(
      (mate) => !mate.isDead && this.battlefield.grid.distance(user.tile, mate.tile) <= ITEM_REACH,
    )
  }

  /**
   * Who in reach is worst off in whatever the item restores, so the common
   * case is one tap — the same favour shoot mode does by pre-picking the best
   * odds. Nobody is pre-picked when nobody needs it: spending a kit on a unit
   * at full health should take a deliberate tap.
   */
  private neediestNearby(user: Soldier, itemId: ItemId): Soldier | null {
    const effects = ITEMS[itemId].effects
    const treats = effects.some((e) => e.kind === 'restoreHp')
    const repairs = effects.some((e) => e.kind === 'restoreArmor')
    let best: Soldier | null = null
    let worst = 0
    for (const mate of this.itemCandidates(user)) {
      const need =
        (treats ? mate.maxHp - mate.hp : 0) + (repairs ? mate.maxArmor - mate.armor : 0)
      if (need > worst) {
        worst = need
        best = mate
      }
    }
    return best
  }

  /**
   * Spend the item.
   *
   * Only the target travels: both sides hold both squads' real sheets, so how
   * much a trained medic heals is derived identically on each.
   */
  private applyItem(user: Soldier, itemId: ItemId, target: Soldier): void {
    // Self-use names nobody, exactly as it did before there was anyone to name.
    const aimed = target === user ? null : target
    this.commands.apply(
      {
        type: 'useItem',
        faction: user.faction,
        squadIndex: user.squadIndex,
        itemId,
        targetFaction: aimed?.faction,
        targetIndex: aimed?.squadIndex,
      },
      'local',
    )
  }

  /** Hunker into / out of a crouch cover stance. Entering costs AP; standing is free. */
  toggleCover(): void {
    const soldier = this.turnManager.selectedSoldier
    if (soldier) this.commands.apply({ type: 'toggleCover', faction: soldier.faction, squadIndex: soldier.squadIndex }, 'local')
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
    // A replay is watched, not played: hiding half the fight from the only
    // person in the room would be hiding it from nobody's advantage.
    if (this.spectating) {
      this.battlefield.ground.revealAll()
      this.battlefield.blocks.revealAll()
      for (const soldier of this.squads.soldiers) soldier.seen = true
      return
    }

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
    if (this.spectating) return
    if (this.network && !this.network.isMyTurn(this.turnManager.activeFaction)) return

    const travel = distance(
      event.clientX - this.rightDownPos.x,
      event.clientY - this.rightDownPos.y,
    )
    if (travel >= 6) return

    const selected = this.turnManager.selectedSoldier
    if (!selected || selected.isMoving || selected.isDead) return

    clientToNdc(this.engine.canvas, event.clientX, event.clientY, this.ndc)
    const pt = this.picker.fromNdc(this.ndc)
    if (!pt) return

    this.commands.apply(
      { type: 'rightClickFacing', faction: selected.faction, squadIndex: selected.squadIndex, x: pt.x, z: pt.z },
      'local',
    )
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

    // Watching: picking a unit to inspect is welcome, ordering it anywhere is
    // not. Selection is view state — `selectSoldier` refuses a unit whose side
    // is not up, so this cannot desynchronise the replay either.
    if (this.spectating) {
      const picked =
        this.pickSoldierUnderCursor(event, this.turnManager.activeFaction) ??
        this.pickSoldierUnderCursor(event, this.enemyFaction)
      if (picked) this.executeClickSoldier(picked.squadIndex, picked.faction)
      return
    }

    const selected = this.turnManager.selectedSoldier

    // An item is aimed: a tap is for choosing who gets it and nothing else,
    // the selected unit included — treating yourself is a use like any other.
    if (this.aimedItem !== null) {
      const mate = this.pickSoldierUnderCursor(event, this.turnManager.activeFaction)
      if (mate) this.executeClickSoldier(mate.squadIndex, mate.faction)
      return
    }

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
    if (this.aimedItem !== null && faction === this.turnManager.activeFaction) {
      this.selectItemTarget(soldier)
    } else if (faction === this.turnManager.activeFaction) {
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
   *
   * Storeys are tried from the one being viewed downwards, and a hit only
   * counts when the tile it lands on really sits at that height. Projecting
   * everything onto the ground would put an upper-floor tap a tile or two from
   * where the player aimed, because a tilted camera sees a raised floor offset
   * from the ground beneath it.
   */
  private tileFromEvent(event: MouseEvent | PointerEvent): Tile | null {
    clientToNdc(this.engine.canvas, event.clientX, event.clientY, this.ndc)
    const grid = this.battlefield.grid

    for (let level = this.selectedLevelFilter; level >= 0; level--) {
      const hit = this.picker.fromNdc(this.ndc, this.pickPoint, level * LEVEL_HEIGHT)
      if (hit === null) continue
      const tile = grid.worldToTile(hit.x, hit.z)
      if (!grid.inBounds(tile.x, tile.y)) continue
      if (grid.levelAt(tile.x, tile.y) === level) return tile
    }

    // Nothing at any storey lined up — fall back to the ground so a tap on a
    // roof or a wall still resolves to somewhere rather than nowhere.
    const ground = this.picker.fromNdc(this.ndc, this.pickPoint)
    if (ground === null) return null
    const tile = grid.worldToTile(ground.x, ground.z)
    return grid.inBounds(tile.x, tile.y) ? tile : null
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
          if (!soldier.isDead && soldier.faction === faction && soldier.seen) {
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
    if (selected && !selected.isDead) {
      selected.seen = true
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
    const shooterBody = this.views.viewOf(shooter)
    const shooterAt = shooterBody?.renderPosition ?? shooter.position
    const targetAt = aimTarget ? (this.views.viewOf(aimTarget)?.renderPosition ?? aimTarget.position) : null
    let yaw = shooterBody?.facing ?? shooter.targetYaw
    let lookAt: Vector3 | undefined

    if (targetAt) {
      const dx = targetAt.x - shooterAt.x
      const dz = targetAt.z - shooterAt.z
      if (distance(dx, dz) > 0.01) {
        // Stand behind the shot line and centre the target's chest in frame.
        yaw = facingYaw(dx, dz)
        lookAt = this.aimPoint.copy(targetAt).setY(targetAt.y + CAM.shoulderAimHeight)
      }
    }

    if (this.rig.isShoulderViewActive) this.rig.updateShoulderView(shooterAt, yaw, lookAt)
    else this.rig.enterShoulderView(shooterAt, yaw, lookAt)
  }
}
