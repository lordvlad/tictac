import { Faction, FACTION_INFO } from '../config'
import type { CombatFx } from '../core/Combatant'
import { doorAhead } from '../core/Doors'
import type { Grid } from '../core/Grid'
import { ITEMS, type ItemId, itemTargetsAlly } from '../core/Items'
import type { Rng } from '../core/rng'
import type { System } from '../ecs/System'
import { CombatSystem, GroundSystem, ItemSystem, MovementSystem, WallSystem } from '../ecs/systems'
import { type Carried, type CommandOrigin, CommandSystem } from '../ecs/systems/CommandSystem'
import type { World } from '../ecs/World'
import type { Soldier } from '../entities/Soldier'
import type { Squads } from '../entities/Squads'
import { ailmentCost } from '../rules/Combat'
import { type Command, isCommand } from '../rules/Command'
import type { HudIntent, PointerIntent } from '../ui/Intent'
import { carriedOut, debrief, escaped, winnerOf } from '../rules/MatchEnd'
import { compareDigests, reportDivergence, type StateDigest } from '../rules/StateDigest'
import { Recorder } from '../sim/Recorder'
import type { TurnManager } from '../sim/TurnManager'
import { digestWorld } from '../sim/WorldDigest'
import { RpcMethods } from '../wire/JsonRpc'
import type { NetworkMessage } from '../wire/NetworkMessage'
import type { CombatRecording, RecordingHeader } from '../wire/Recording'
import { headlessView, type MatchMode, type MatchView, type SessionState } from './MatchView'
import type { NetworkManager } from './NetworkManager'

/**
 * How far a soldier can reach to work on a squadmate, in tiles.
 *
 * One tile means orthogonally or diagonally adjacent, which is what handing
 * somebody a dressing actually takes. Anything longer and a medic treats
 * across a room; anything shorter and only the unit itself qualifies.
 */
const ITEM_REACH = 1

/**
 * The intents a spectator may still press.
 *
 * Everything here changes only what is on screen — which storey is drawn, where
 * the camera stands, which panel is open. Nothing here spends a point or moves
 * a unit, because in a replay the file is the only authority over that.
 */
const SPECTATOR_INTENTS: Partial<Record<HudIntent['type'], true>> = {
  // Inspection only: only a local match is built editable (`debugEditable`).
  openDebug: true,
  toggleDebugMap: true,
  selectLevel: true,
  toggleFreelook: true,
  toggleUnitView: true,
  selectUnit: true,
}

/** The end screen's buttons: answered on any side, whoever's turn the match ended on. */
const END_SCREEN_INTENTS: Partial<Record<HudIntent['type'], true>> = {
  endScreenNext: true,
  backToMenu: true,
}

/** What the debug panel is allowed to do to the recorder. */
export interface RecordingPort {
  /** True while a recorder is attached. */
  isRecording(): boolean
  /** True while starting one is still valid — no command has been issued yet. */
  canArm(): boolean
  eventCount(): number
  setRecording(on: boolean): void
  /** The file to save, or null while there is nothing in it. */
  take(): { filename: string; data: CombatRecording } | null
}

/** Everything a session is built from. The pieces that need a scene are the view's, not these. */
export interface MatchSessionParts {
  world: World
  grid: Grid
  squads: Squads
  turnManager: TurnManager
  /**
   * The match's dice.
   *
   * Passed in from the seed rather than reached for, so that both peers, a
   * replay and a sweep all resolve the same fight from the same stream. The
   * one rule about it: only the rules may draw from it — a tracer's scatter
   * or a puff of smoke takes its own randomness, because a draw here moves
   * every later roll in the match. Held as the stream rather than a roll
   * function because the state digest reads where it has got to.
   */
  dice: Rng
  /** What combat announces to; a scene's pictures, or nothing. */
  fx: CombatFx
  /** The match is over for this window and the player is going back to the menu. */
  onLeave: () => void
  network?: NetworkManager | null
  /**
   * Held as a watcher rather than a player: a recording played back (`replay`),
   * or a match on a server without a seat in it (`spectate`). Absent for a
   * window that plays, whose mode is its network's.
   */
  watching?: 'spectate' | 'replay'
  /** The match's opening position, for a recording armed from the debug panel. */
  recordingHeader?: RecordingHeader | null
}

/**
 * A match as one window plays it: what the player's intents become, and the state
 * that comes out for the screen to show.
 *
 * Input arrives as {@link HudIntent} (a press on the HUD) or {@link PointerIntent}
 * (a press on the field); it is gated by whose turn it is and whether this window
 * is only watching; and what survives becomes a `Command` through the one door
 * ({@link CommandSystem}) — the same door the peer's messages and a replay's file
 * go through. State flows back out as view models ({@link SessionState}) and as
 * calls on a {@link MatchView}.
 *
 * Nothing here touches the DOM or a scene, so a session can be built, driven and
 * inspected headless. What needs a picture belongs to the view: the planners that
 * hold what is aimed at are reached through {@link MatchView.aiming}, and what is
 * drawn is the view's own business.
 */
export class MatchSession {
  readonly world: World
  readonly squads: Squads
  readonly turnManager: TurnManager
  readonly grid: Grid
  readonly movementSystem: MovementSystem
  readonly combatSystem: CombatSystem
  readonly itemSystem: ItemSystem
  readonly wallSystem: WallSystem
  readonly groundSystem: GroundSystem
  /**
   * The one door for anything that changes the world — this player's clicks,
   * the other player's messages and a replay's file alike. See
   * {@link CommandSystem} for why there is only one.
   */
  readonly commands: CommandSystem
  /** The recorder, as the debug panel is allowed to touch it; null where no opening is known. */
  readonly recording: RecordingPort | null
  readonly network: NetworkManager | null
  private readonly watchedAs: 'spectate' | 'replay' | null

  private view: MatchView = headlessView()
  private readonly dice: Rng
  private readonly onLeave: () => void
  private readonly recordingHeader: RecordingHeader | null
  /**
   * The item waiting for a patient, and the squadmate picked for it.
   *
   * Held here rather than in a planner because there is no rule to plan: the
   * item's own effects decide what it does, and who gets it is pure input.
   */
  private aimedItem: ItemId | null = null
  private itemTarget: Soldier | null = null
  /** Retreat has been pressed once; the next press goes. Any other press stands it down. */
  private retreatArmed = false
  /** What became of the last retreat that failed, until the next handover. */
  private retreatNote: string | null = null
  /** A recording was armed once this match, so it cannot be armed again. */
  private recordingStarted = false
  /**
   * Every command the world applied while armed, from either side. Fed by the
   * applier rather than by the network's send, which only ever saw this side.
   * Null unless the debug panel armed it.
   */
  private recorder: Recorder | null = null
  /** Whether the applier's queue held anything last tick; see `update`. */
  private rulesActing = false
  /** The match has been decided and the view told. */
  private over = false
  /** What this session put in the world's tick, in tick order, so `dispose` takes out exactly that. */
  private readonly systems: System[]

  constructor(parts: MatchSessionParts) {
    const { world, grid, squads, turnManager, dice, fx } = parts
    this.world = world
    this.grid = grid
    this.squads = squads
    this.turnManager = turnManager
    this.dice = dice
    this.onLeave = parts.onLeave
    this.network = parts.network ?? null
    this.watchedAs = parts.watching ?? null
    this.recordingHeader = parts.recordingHeader ?? null

    this.movementSystem = new MovementSystem(grid)
    this.itemSystem = new ItemSystem()
    this.combatSystem = new CombatSystem(grid, squads, fx, () => dice.next())
    this.wallSystem = new WallSystem(grid)
    this.groundSystem = new GroundSystem(grid)
    this.commands = new CommandSystem(
      world,
      squads,
      turnManager,
      this.movementSystem,
      this.combatSystem,
      this.itemSystem,
      this.wallSystem,
      this.groundSystem,
    )

    // First, so a queued command is applied before the tick that walks it.
    this.systems = [
      this.commands,
      this.movementSystem,
      this.combatSystem,
      this.itemSystem,
      turnManager.turns,
      this.wallSystem,
      this.groundSystem,
    ]
    for (const system of this.systems) world.addSystem(system)

    // One entity per wall, so the map's boundaries are state the systems and
    // the network can reach like any other. After the walls, in the same order
    // the headless host makes it, the ground is the same entity for both peers
    // and the referee.
    this.wallSystem.spawnFromGrid(world)
    this.groundSystem.spawn(world)

    this.commands.onBeforeApply = (command, origin) => {
      // The fingerprint is of the world as this side hands it over, so it is
      // taken at the last moment the handover has not happened yet.
      if ((command.type === 'endTurn' || command.type === 'retreat') && origin === 'local') this.sendStateDigest()
    }
    this.commands.onApplied = (command, result, origin) => {
      // Everything a player decided, from either side, is what a recording is
      // of. A replay's own commands are already on file, and what the rules
      // made a broken unit do is derived again by whoever plays it back.
      if (origin === 'local' || origin === 'peer') this.recorder?.record(command)
      // Only this side's own decisions travel, and only once the rules took
      // them: a refusal spent nothing here and would be refused there too.
      if (origin === 'local') this.network?.send(command)
      this.applied(command, result, origin)
    }
    this.commands.onRefused = (command, refusal, origin) => {
      // From the player, a refusal is a click the rules turned down. From a
      // peer or a file it means two sides disagree about what was possible.
      if (origin !== 'local') {
        console.error(`[commands] ${origin} ${command.type} refused: ${refusal.reason}`, command)
      }
    }

    this.recording = this.recordingHeader ? this.recordingPort(this.recordingHeader) : null
  }

  /**
   * Hand the session the screen that shows it.
   *
   * After construction, not during it: the screen is built from this session's
   * systems (it hooks their events) while the session asks the screen what is
   * being aimed at, and each needs the other to exist first.
   */
  attach(view: MatchView): void {
    this.view = view
    view.aiming.movement.onMovementStarted = (soldier, path) => {
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
  }

  /** The state input has built up, for the HUD's model. */
  get state(): SessionState {
    const shooter = this.turnManager.selectedSoldier
    return {
      retreatArmed: this.retreatArmed,
      retreatNote: this.retreatNote,
      rulesActing: this.commands.pending,
      item:
        this.aimedItem !== null && shooter
          ? { itemId: this.aimedItem, candidates: this.itemCandidates(shooter), target: this.itemTarget }
          : null,
      canAct: this.canAct,
      seat: this.seat,
    }
  }

  /** How this window holds the match: a watcher's mode wins, otherwise the network's, otherwise one screen. */
  get mode(): MatchMode {
    return this.watchedAs ?? this.network?.mode ?? 'local'
  }

  /** The network this window shares the match over: only a player with a seat has one. */
  private get peer(): NetworkManager | null {
    const { mode } = this
    return mode === 'host' || mode === 'join' ? this.network : null
  }

  /** The side this window plays when it shares the match with someone; null on one screen and for a watcher. */
  get seat(): Faction | null {
    return this.peer?.myFaction ?? null
  }

  /** Whose eyes the screen is: one's own over the network, whoever is up when sharing a screen. */
  get viewerFaction(): Faction {
    return this.seat ?? this.turnManager.activeFaction
  }

  /** Watching rather than playing: a replay, or a match on a server without a seat in it. */
  get watching(): boolean {
    const { mode } = this
    return mode === 'spectate' || mode === 'replay'
  }

  private get enemyFaction(): Faction {
    return this.turnManager.activeFaction === Faction.Blue ? Faction.Red : Faction.Blue
  }

  /**
   * The recorder, as the debug panel is allowed to touch it.
   *
   * Arming is refused once the match has issued a command, because a stream
   * that does not begin at the opening position cannot be replayed at all:
   * playback rebuilds state by re-running the rules over the commands, from
   * the start. Better to say so than to write a file that desynchronises.
   */
  private recordingPort(header: RecordingHeader): RecordingPort {
    return {
      isRecording: () => this.recorder !== null,
      canArm: () => !this.recordingStarted && this.turnManager.turnNumber === 1,
      eventCount: () => this.recorder?.eventCount ?? 0,
      setRecording: (on) => {
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
      take: () => {
        const recorder = this.recorder
        if (!recorder || recorder.eventCount === 0) return null
        return { filename: recorder.filename(), data: recorder.toJSON() }
      },
    }
  }

  /**
   * Apply a recorded command as a spectator.
   *
   * Through the same door as the player's own clicks and the peer's messages.
   * Playback paces itself on {@link busy}, so the command is applied at once
   * rather than queued.
   */
  applyRecordedCommand(command: NetworkMessage): void {
    if (isCommand(command)) this.commands.apply(command, 'record')
  }

  /**
   * True while a unit is still walking or the rules are still moving a broken
   * unit, which is what paces a replay: the next recorded command was decided
   * after both.
   */
  get busy(): boolean {
    return this.commands.busy || this.commands.pending
  }

  /**
   * Whether this window may command the match now. The one answer: the HUD
   * reads it from {@link SessionState}, and every intent and press on the field
   * is checked against it here. A mode that is added is decided in this switch
   * or fails to compile, rather than being missed by whichever caller tested
   * for the modes it knew.
   */
  get canAct(): boolean {
    switch (this.mode) {
      case 'local':
        return true
      case 'host':
      case 'join':
        // Not while getting the seat back: see `NetworkManager.reconnecting`.
        return this.peer !== null && !this.peer.reconnecting && this.turnManager.activeFaction === this.peer.myFaction
      case 'spectate':
      case 'replay':
        return false
    }
  }

  /**
   * Whether this window may press an intent: whoever can act may, the end
   * screen's buttons answer on any side, and a watcher may use the view
   * controls — which change only what is on screen, never the match.
   */
  private permits(intent: HudIntent): boolean {
    // The match is over, so whose turn it ended on decides nothing, and without
    // this the side that was waiting — or a spectator — could never leave it.
    if (END_SCREEN_INTENTS[intent.type] === true) return true
    if (this.canAct) return true
    // A replay is not commanded: the panels that would spend a unit's points
    // are hidden, and this is what makes that a rule rather than a consequence
    // of the layout.
    return this.watching && SPECTATOR_INTENTS[intent.type] === true
  }

  /** Single place where a HUD press becomes a change to the game. */
  handleIntent(intent: HudIntent): void {
    if (!this.permits(intent)) return

    // Retreat asks twice; anything else pressed in between means not now.
    if (this.retreatArmed && intent.type !== 'requestRetreat' && intent.type !== 'confirmRetreat') {
      this.retreatArmed = false
    }

    switch (intent.type) {
      case 'requestRetreat':
        this.retreatArmed = true
        this.view.refreshHud()
        break
      case 'confirmRetreat':
        this.retreatArmed = false
        this.commands.apply({ type: 'retreat', faction: this.turnManager.activeFaction }, 'local')
        this.view.refreshHud()
        break
      case 'selectUnit': {
        const soldier = this.squads.byFaction[this.turnManager.activeFaction][intent.index]
        if (soldier && !soldier.isDead) {
          this.turnManager.selectSoldier(soldier)
          this.standDown()
        }
        break
      }
      case 'shoot':
        this.enterShootMode('shoot')
        break
      case 'strike':
        this.enterShootMode('strike')
        break
      case 'cancelShoot':
        this.standDown()
        break
      case 'selectTarget': {
        // The strip shows patients while a kit is in hand, and enemies otherwise.
        if (this.aimedItem !== null) {
          const mate = this.squads.byFaction[this.turnManager.activeFaction][intent.index]
          if (mate) this.selectItemTarget(mate)
          break
        }
        const enemy = this.squads.byFaction[this.enemyFaction][intent.index]
        if (enemy && !enemy.isDead) this.view.aiming.shoot.selectTarget(enemy)
        this.view.renderOverlay()
        this.view.refreshHud()
        break
      }
      case 'fireShot': {
        const shooter = this.turnManager.selectedSoldier
        const target = shooter ? this.view.aiming.shoot.choose(shooter, intent.mode) : null
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
        const target = this.view.aiming.shoot.selectedTarget
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
        const { shoot, grenade, movement } = this.view.aiming
        const thrower = this.turnManager.selectedSoldier
        shoot.exit()
        if (grenade.armed === intent.kind) grenade.exit()
        else grenade.arm(intent.kind, thrower)
        movement.clear()
        this.view.renderOverlay()
        this.view.refreshHud()
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
        this.view.aiming.grenade.exit()
        this.view.renderOverlay()
        this.view.refreshHud()
        break
      case 'openDebug':
      case 'toggleDebugMap':
      case 'selectLevel':
      case 'toggleFreelook':
      case 'toggleUnitView':
      case 'endScreenNext':
        this.view.show(intent)
        break
      case 'backToMenu':
        // What leaving means (and what has to be put away first) is the
        // screen's to say: this session is one of the things it puts away.
        this.onLeave()
        break
      case 'operateDoor': {
        const soldier = this.turnManager.selectedSoldier
        const edge = soldier ? doorAhead(this.grid, soldier.tile, soldier.heading) : null
        if (soldier && edge !== null) {
          this.commands.apply(
            { type: 'operateDoor', faction: soldier.faction, squadIndex: soldier.squadIndex, edge, verb: intent.verb },
            'local',
          )
        }
        break
      }
      case 'overwatch': {
        const soldier = this.turnManager.selectedSoldier
        if (soldier) this.commands.apply({ type: 'overwatch', faction: soldier.faction, squadIndex: soldier.squadIndex }, 'local')
        break
      }
      case 'toggleCover': {
        // Hunker into / out of a crouch cover stance. Entering costs AP; standing is free.
        const soldier = this.turnManager.selectedSoldier
        if (soldier) this.commands.apply({ type: 'toggleCover', faction: soldier.faction, squadIndex: soldier.squadIndex }, 'local')
        break
      }
      case 'toggleWaypoints':
        this.view.aiming.movement.toggleWaypointMode()
        this.view.renderOverlay()
        this.view.refreshHud()
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
        if (this.peer) {
          this.commands.apply({ type: 'endTurn', faction: this.turnManager.activeFaction }, 'local')
        } else {
          this.view.show(intent)
        }
        break
      case 'confirmTurnSwitch':
        this.view.show(intent)
        this.commands.apply({ type: 'endTurn', faction: this.turnManager.activeFaction }, 'local')
        break
    }
  }

  /**
   * A press on the field, once the canvas has said what is under it.
   *
   * Gated like a button press by whose turn it is; unlike one, it does not stand
   * down an armed retreat, because it is not an answer to the prompt.
   */
  handlePointer(intent: PointerIntent): void {
    // A watcher may look (below); a player out of turn may not even do that.
    if (!this.canAct && !this.watching) return
    switch (intent.type) {
      case 'face': {
        if (!this.canAct) return
        const selected = this.turnManager.selectedSoldier
        if (!selected || selected.isMoving || selected.isDead) return
        this.commands.apply(
          { type: 'rightClickFacing', faction: selected.faction, squadIndex: selected.squadIndex, x: intent.x, z: intent.z },
          'local',
        )
        return
      }
      case 'tap':
        this.tap(intent)
        return
    }
  }

  private tap(tap: Extract<PointerIntent, { type: 'tap' }>): void {
    const active = this.turnManager.activeFaction
    const { shoot, grenade } = this.view.aiming

    // Watching: picking a unit to inspect is welcome, ordering it anywhere is
    // not. Selection is view state — `selectSoldier` refuses a unit whose side
    // is not up, so this cannot desynchronise the replay either.
    if (!this.canAct) {
      if (tap.friendly !== null) this.clickSoldier(tap.friendly, active)
      else if (tap.enemy !== null) this.clickSoldier(tap.enemy, this.enemyFaction)
      return
    }

    const selected = this.turnManager.selectedSoldier

    // An item is aimed: a tap is for choosing who gets it and nothing else,
    // the selected unit included — treating yourself is a use like any other.
    if (this.aimedItem !== null) {
      if (tap.friendly !== null) this.clickSoldier(tap.friendly, active)
      return
    }

    // Tapping a friendly selects it.
    if (tap.friendly !== null) {
      const friendly = this.squads.byFaction[active][tap.friendly]
      if (friendly && friendly !== selected) {
        this.clickSoldier(tap.friendly, active)
        return
      }
    }

    if (!selected || selected.isDead) return
    const tile = tap.tile
    if (!tile) return

    // A grenade is armed: the first tap aims the blast, a second tap on the
    // same tile throws it. Tapping elsewhere re-aims instead of committing, so
    // a mis-tap costs nothing.
    if (grenade.active) {
      if (grenade.isAimedAt(tile)) this.confirmThrow()
      else grenade.aimAt(tile)
      this.view.renderOverlay()
      this.view.refreshHud()
      return
    }

    // In shoot mode a click on an enemy picks it as the target.
    if (shoot.active) {
      if (tap.enemy !== null) this.clickSoldier(tap.enemy, this.enemyFaction)
      return
    }

    if (selected.isMoving || selected.ap <= 0) return
    if (this.view.aiming.movement.handleClick(selected, tile, tap.additive)) this.view.refreshHud()
  }

  private clickSoldier(squadIndex: number, faction: Faction): void {
    const soldier = this.squads.byFaction[faction][squadIndex]
    if (!soldier || soldier.isDead) return
    if (this.aimedItem !== null && faction === this.turnManager.activeFaction) {
      this.selectItemTarget(soldier)
    } else if (faction === this.turnManager.activeFaction) {
      this.turnManager.selectSoldier(soldier)
      this.standDown()
    } else if (this.view.aiming.shoot.active) {
      this.view.aiming.shoot.selectTarget(soldier)
    }
    this.view.renderOverlay()
    this.view.refreshHud()
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
   * What the session itself does once a command has been carried out; what the
   * player sees change is the view's.
   *
   * Every rule has already run. Only the turn's bookkeeping is decided here —
   * who is selected, what a failed retreat leaves to be said — and the screen
   * is told afterwards, so that it reads the world as it now stands.
   */
  private applied(command: Command, result: Carried, origin: CommandOrigin): void {
    switch (command.type) {
      case 'endTurn':
        this.retreatNote = null
        this.turnSwitched()
        // The played game picks the incoming side's first unit for the player;
        // a replay does it so the camera follows whoever acts next.
        if (origin === 'record') this.turnManager.autoSelectFirst()
        break
      case 'retreat':
        // The left-behind fall when the side escaped; the match is over, which `update` notices.
        if (result.retreat?.escaped) break
        // Caught: the attempt was the side's turn.
        this.retreatNote = `${FACTION_INFO[command.faction].name} tried to retreat (${result.retreat?.chance ?? 0}%) and was caught.`
        this.turnSwitched()
        if (origin === 'record') this.turnManager.autoSelectFirst()
        break
      default:
        break
    }
    this.view.commandApplied(command, result, origin)
  }

  /** The turn changed hands: nothing aimed carries over, and over a network the screen follows its own side. */
  private turnSwitched(): void {
    this.view.turnSwitched()
    this.standDown()

    const myFaction = this.seat
    if (myFaction !== null) {
      if (this.turnManager.activeFaction === myFaction) {
        const living = this.squads.getLiving(myFaction)
        if (living.length > 0) this.turnManager.selectSoldier(living[0]!)
      } else {
        this.turnManager.selectSoldier(null)
      }
    }

    this.view.recomputeVisibility()
  }

  /** This side's fingerprint of the world, as of now. */
  private localDigest(): StateDigest {
    return digestWorld(
      this.world,
      this.squads.soldiers.map((unit) => unit.entityId),
      this.turnManager.turnNumber,
      this.dice,
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
    const { peer } = this
    if (!peer) return
    peer.sendRpc({
      jsonrpc: '2.0',
      method: RpcMethods.digest,
      params: { digest: this.localDigest() },
    })
  }

  /** Every aiming mode off: the selection or the turn changed under them. */
  standDown(): void {
    const { shoot, grenade, movement } = this.view.aiming
    shoot.exit()
    grenade.exit()
    movement.clear()
    this.view.renderOverlay()
    this.view.refreshHud()
  }

  private enterShootMode(intent: 'shoot' | 'strike'): void {
    if (!this.view.aiming.shoot.enter(this.turnManager.selectedSoldier, intent)) return
    this.view.aiming.movement.clear()
    this.view.renderOverlay()
    this.view.refreshHud()
  }

  /** Throw the armed grenade at the aimed tile. */
  private confirmThrow(): void {
    const thrower = this.turnManager.selectedSoldier
    const aimed = thrower ? this.view.aiming.grenade.aimed(thrower) : null
    if (!thrower || !aimed) return
    this.commands.apply(
      {
        type: 'throwGrenade',
        shooterFaction: thrower.faction,
        shooterIndex: thrower.squadIndex,
        kind: aimed.kind,
        targetTile: aimed.targetTile,
        targetLevel: aimed.targetLevel,
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
  private useItem(itemId: ItemId): void {
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
    const { shoot, grenade, movement } = this.view.aiming
    shoot.exit()
    grenade.exit()
    movement.clear()
    this.aimedItem = itemId
    this.itemTarget = this.neediestNearby(soldier, itemId)
    this.view.renderOverlay()
    this.view.refreshHud()
  }

  /** Aim the item being held at a squadmate, if they are one it can reach. */
  private selectItemTarget(soldier: Soldier): void {
    const user = this.turnManager.selectedSoldier
    if (!user || this.aimedItem === null) return
    if (!this.itemCandidates(user).includes(soldier)) return
    this.itemTarget = soldier
    this.view.renderOverlay()
    this.view.refreshHud()
  }

  /** Use the item being held on the squadmate picked for it. */
  private confirmItem(): void {
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
    this.view.renderOverlay()
    this.view.refreshHud()
  }

  /**
   * Squadmates `user` can put their hands on: alive, on their side and within
   * arm's reach — themselves included, since treating yourself is still a use.
   */
  private itemCandidates(user: Soldier): Soldier[] {
    return this.squads.byFaction[user.faction].filter(
      (mate) => !mate.isDead && this.grid.distance(user.tile, mate.tile) <= ITEM_REACH,
    )
  }

  /**
   * Who in reach is worst off in whatever the item restores, so the common
   * case is one tap — the same favour shoot mode does by pre-picking the best
   * odds. An ailment the kit ends counts as the hit points it will still cost
   * (a bleed on a unit at full health is a need). Nobody is pre-picked when
   * nobody needs it: spending a kit on a unit that does not should take a
   * deliberate tap.
   */
  private neediestNearby(user: Soldier, itemId: ItemId): Soldier | null {
    const effects = ITEMS[itemId].effects
    const treats = effects.some((e) => e.kind === 'restoreHp')
    const repairs = effects.some((e) => e.kind === 'restoreArmor')
    const stanches = effects.some((e) => e.kind === 'treatAilments')
    let best: Soldier | null = null
    let worst = 0
    for (const mate of this.itemCandidates(user)) {
      const need =
        (treats ? mate.maxHp - mate.hp : 0) +
        (repairs ? mate.maxArmor - mate.armor : 0) +
        (stanches ? ailmentCost(mate) : 0)
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

  /** One tick of the rules, then the things that notice what it changed. */
  update(delta: number): void {
    // Systems advance the simulation; every mutation lands in a component.
    this.world.update(delta)
    // The HUD offers nothing while the rules are running a broken unit, so it
    // has to hear when they stop — which is a tick, not an event.
    if (this.commands.pending !== this.rulesActing) {
      this.rulesActing = this.commands.pending
      this.view.refreshHud()
    }
    // The match is over once a side has nobody standing — checked once
    // everything has settled, so the last shot's walk and reactions are done.
    // Not in a replay: there is nobody to show it to.
    if (!this.over && !this.watching && !this.busy) {
      const winner = winnerOf(this.squads)
      if (winner !== null) this.conclude(winner)
    }
  }

  /**
   * The match is decided: work out what the end screens need, put every aiming
   * mode away and tell the view. Online, this side's own page; in a local match
   * both sides share the screen.
   */
  private conclude(winner: Faction): void {
    this.over = true
    const viewer = this.seat
    const loser = winner === Faction.Blue ? Faction.Red : Faction.Blue
    // Picked from the match seed, so both sides carry out the same one.
    const carried = this.recordingHeader
      ? carriedOut(this.squads, loser, this.grid, this.recordingHeader.seed)
      : null
    const outcome = {
      winner,
      viewer,
      debriefs: debrief(this.squads, winner),
      escapees: escaped(this.squads, loser),
      carried,
    }
    this.network?.leaveDecidedMatch()
    const { shoot, grenade, movement } = this.view.aiming
    shoot.exit()
    grenade.exit()
    movement.clear()
    this.view.matchEnded(outcome)
  }

  /**
   * Take this session back out of the world it was added to, leaving that world
   * as it was before: a system left in it would keep ticking and answering for a
   * match that is gone.
   */
  dispose(): void {
    for (const system of this.systems) this.world.removeSystem(system)
    this.recorder = null
  }
}
