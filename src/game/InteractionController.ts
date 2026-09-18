import { NetworkManager, type NetworkMessage, type WireHit } from './NetworkManager'
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
import { applyHitEffects, calculateHitChance, type ResolvedHit } from './Combat'
import { reportDivergence, shadowShot, shadowThrow } from './Divergence'
import { compareDigests, digestWorld, type StateDigest } from './StateDigest'
import { RpcMethods } from './JsonRpc'
import type { Roll } from '../core/rng'
import { toWireHits, Recorder, type RecordingHeader } from './Recording'
import { settleTurn } from './Turn'
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
import { MovementSystem, CombatSystem, ItemSystem, RenderSystem, WallSystem } from '../ecs/systems'
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


    this.movementSystem.onStep = () => {
      this.recomputeVisibility()
      this.refreshHud()
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
    this.shoot = new ShootPlanner(battlefield.grid, squads, this.combatSystem, engine, dice)
    this.combatSystem.onShotResolved = (shooter, target, result) => {
      this.shoot.reportShot(shooter, target, result)
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
      isRecording: () => this.network?.recorder != null,
      canArm: () => !this.recordingStarted && this.turnManager.turnNumber === 1,
      eventCount: () => this.network?.recorder?.eventCount ?? 0,
      setRecording: (on) => {
        const network = this.network
        const header = this.recordingHeader
        if (!network || !header) return
        if (!on) {
          network.recorder = null
          return
        }
        if (this.recordingStarted) return
        network.recorder = new Recorder(header, () => ({
          turn: this.turnManager.turnNumber,
          faction: this.turnManager.activeFaction,
        }))
        this.recordingStarted = true
      },
      export: () => {
        const recorder = this.network?.recorder
        if (!recorder || recorder.eventCount === 0) return
        downloadJson(recorder.filename(), recorder.toJSON())
      },
    }
  }

  /**
   * Apply a recorded command as a spectator.
   *
   * Mostly the peer's own door, because a peer's command *is* a recorded one.
   * Two of them are no-ops over the wire and cannot be here: a peer learns a
   * reload's clip and an item's effect from replicated components, and a replay
   * has no peer to replicate from — so the same rules are run locally instead.
   */
  applyRecordedCommand(command: NetworkMessage): void {
    switch (command.type) {
      case 'reload': {
        const soldier = this.squads.byFaction[command.faction][command.squadIndex]
        if (soldier) this.combatSystem.reload(soldier)
        this.refreshHud()
        return
      }
      case 'useItem': {
        const soldier = this.squads.byFaction[command.faction][command.squadIndex]
        // A recording re-runs the use, so it is the one path that has to know
        // who it was used on. A frame from before targeted use, or one naming
        // a unit this build cannot find, replays as a use on the carrier.
        const target =
          command.targetFaction !== undefined && command.targetIndex !== undefined
            ? this.squads.byFaction[command.targetFaction][command.targetIndex]
            : undefined
        if (soldier) this.itemSystem.use(soldier, command.itemId, target ?? soldier)
        this.afterCombat()
        return
      }
      default:
        this.handleRemoteNetworkMessage(command)
        // The played game picks the incoming side's first unit for the player;
        // a replay does it so the camera follows whoever acts next.
        if (command.type === 'endTurn') this.turnManager.autoSelectFirst()
    }
  }

  /** True while a unit is still walking, which is what paces a replay. */
  get anyUnitMoving(): boolean {
    return this.squads.soldiers.some((soldier) => soldier.isMoving)
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
        if (shooter) {
          const shotData = this.shoot.fire(shooter, intent.mode)
          // `send` is a no-op in local play on its own; gating again here would
          // leave a local recording missing every shot fired in it.
          if (shotData && this.network) {
            this.network.send({
              type: 'fireShot',
              shooterFaction: shooter.faction,
              shooterIndex: shooter.squadIndex,
              targetFaction: shotData.target.faction,
              targetIndex: shotData.target.squadIndex,
              mode: intent.mode,
              rolls: shotData.result.rolls,
              hits: toWireHits(shotData.result.hits),
              chance: shotData.result.hitChance,
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
          this.network?.send({
            type: 'endUnitTurn',
            faction: selected.faction,
            squadIndex: selected.squadIndex,
          })
        }
        break
      }
      case 'requestTurnSwitch':
        if (this.network && this.network.mode !== 'local') {
          this.sendStateDigest()
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
        this.sendStateDigest()
        this.network?.send({ type: 'endTurn', faction: this.turnManager.activeFaction })
        this.turnManager.startNextTurn()
        this.onTurnSwitched()
        this.refreshHud()
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
        // Checked before applying, because the shadow needs the state the shot
        // was fired at. The peer's numbers are still what lands.
        reportDivergence(
          `${shooter.name}'s shot at ${target.name}`,
          shadowShot(
            this.battlefield.grid,
            shooter,
            target,
            this.squads.soldiers,
            msg.mode,
            msg.rolls,
            msg.hits,
            msg.chance,
          ),
        )
        this.combatSystem.replayShot(shooter, target, msg.rolls, this.fromWireHits(msg.hits))
        this.afterCombat()
        break
      }
      case 'throwGrenade': {
        const thrower = this.squads.byFaction[msg.shooterFaction][msg.shooterIndex]
        if (!thrower) break
        // Worth more than the shot check: a thrower resolves damage for
        // everybody in the blast, including this side's own squad.
        reportDivergence(
          `${thrower.name}'s ${msg.kind}`,
          shadowThrow(
            this.battlefield.grid,
            thrower,
            msg.targetTile,
            msg.kind,
            this.squads.soldiers,
            msg.hits,
          ),
        )
        const hits = this.fromWireHits(msg.hits)
        // Applied before the FX so a death animation is not overwritten by a
        // flinch; the indicators read their numbers from the message either way.
        for (const hit of hits) {
          applyHitEffects(hit.soldier, hit.damage, hit.armorShred, hit.status)
        }
        this.grenade.replayThrow(msg.kind, msg.targetTile, msg.areaRadius, hits)
        this.afterCombat()
        break
      }
      case 'reload': {
        // Nothing to recompute: `maxClip` is the peer's weapon, not this side's
        // stock copy of it, and the clip it filled arrives by replication.
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
        if (distance(dx, dz) > 0.01) soldier.targetYaw = facingYaw(dx, dz)
        break
      }
      case 'digest': {
        // Compared before `endTurn` is applied, because that is the state the
        // sender fingerprinted: it took its digest immediately before handing
        // over, and this side has not advanced past that point yet.
        reportDivergence(
          `state at the end of turn ${msg.digest.turn}`,
          compareDigests(this.localDigest(), msg.digest, (entityId) => this.unitName(entityId)),
        )
        break
      }
      case 'useItem': {
        // The peer already spent the item and applied its effect; HP, AP,
        // armour, statuses and the item counts all replicate from its side.
        this.refreshHud()
        break
      }
      case 'init':
        break
    }
  }

  /**
   * Wire hits back to local soldiers. Anything missing or already dead on this
   * side is dropped: a unit this side has buried must not replay a death.
   */
  private fromWireHits(hits: readonly WireHit[]): ResolvedHit[] {
    const resolved: ResolvedHit[] = []
    for (const hit of hits) {
      const soldier = this.squads.byFaction[hit.faction][hit.index]
      if (!soldier || soldier.isDead) continue
      resolved.push({
        soldier,
        damage: hit.damage,
        armorShred: hit.armorShred,
        killed: false,
        status: hit.status,
        // Older peers do not send it; an unmarked hit is an ordinary one.
        crit: hit.crit ?? false,
      })
    }
    return resolved
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
      areaRadius: thrower.grenadeSpecs[thrown.kind].areaRadius,
      hits: toWireHits(thrown.result.hits),
    })
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
   * Spend the item and tell the peer.
   *
   * Only the target travels: both sides hold both squads' real sheets, so how
   * much a trained medic heals is derived identically on each.
   */
  private applyItem(user: Soldier, itemId: ItemId, target: Soldier): void {
    if (!this.itemSystem.use(user, itemId, target)) return
    // Self-use names nobody, exactly as it did before there was anyone to name.
    const aimed = target === user ? null : target
    this.network?.send({
      type: 'useItem',
      faction: user.faction,
      squadIndex: user.squadIndex,
      itemId,
      targetFaction: aimed?.faction,
      targetIndex: aimed?.squadIndex,
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
    // Statuses expire, and anyone who ran themselves into the ground pays for
    // it. The incoming side has already been handed its points by `TurnSystem`.
    settleTurn(this.squads.soldiers, this.turnManager.activeFaction)
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

    this.executeRightClickFacing(selected.squadIndex, selected.faction, pt.x, pt.z)
    this.network?.send({
      type: 'rightClickFacing',
      faction: selected.faction,
      squadIndex: selected.squadIndex,
      x: pt.x,
      z: pt.z,
    })
  }

  executeRightClickFacing(squadIndex: number, faction: Faction, x: number, z: number): void {
    const soldier = this.squads.byFaction[faction][squadIndex]
    if (!soldier || soldier.isMoving || soldier.isDead) return
    const dx = x - soldier.position.x
    const dz = z - soldier.position.z
    if (distance(dx, dz) > 0.01) soldier.targetYaw = facingYaw(dx, dz)
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
