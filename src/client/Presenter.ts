import { Vector3 } from 'three'
import { CAM, Faction, FACTION_INFO } from '../config'
import { GroundPicker } from '../camera/GroundPicker'
import type { OrbitRig } from '../camera/OrbitRig'
import { distance, facingYaw } from '../core/math'
import { MELEE } from '../core/Melee'
import type { MoraleBreak } from '../core/Morale'
import { roughly } from '../core/Noise'
import { VisState } from '../core/Visibility'
import type { Command } from '../rules/Command'
import type { Tile } from '../core/Grid'
import { tileEquals } from '../core/Grid'
import type { Carried, CommandOrigin } from '../ecs/systems/CommandSystem'
import type { EngineContext } from '../engine'
import type { Soldier } from '../entities/Soldier'
import { DebugMap } from '../hud/DebugMap'
import type { Hud } from '../hud/Hud'
import { type EndScreen, tileReadout } from '../hud/HudModel'
import { downloadJson } from '../hud/download'
import { debugEditable } from '../game/DebugAccess'
import type { MatchSession } from '../game/MatchSession'
import type { Aiming, MatchView, Outcome, ViewIntent } from '../game/MatchView'
import { FACE_OFFSET } from '../render/Blocks'
import { DamageIndicators } from '../render/DamageIndicators'
import { DoorFx } from '../render/DoorFx'
import { Effects } from '../render/Effects'
import { GlassFx } from '../render/GlassFx'
import { GroundFx } from '../render/GroundFx'
import { NoiseMarks } from '../render/NoiseMarks'
import type { OffscreenPortraits } from '../render/Portraits'
import type { RenderSystem } from '../render/RenderSystem'
import type { SquadViews } from '../render/SquadViews'
import type { NetworkMessage } from '../wire/NetworkMessage'
import { calculateHitChance } from '../rules/Combat'
import type { Battlefield } from './Battlefield'
import { DebugPanel, type RecordingControls } from './DebugPanel'
import { FogOfWar } from './FogOfWar'
import { GrenadePlanner } from './GrenadePlanner'
import { buildHudModel, endScreens } from './HudModelBuilder'
import { MovementPlanner } from './MovementPlanner'
import { ShootPlanner } from './ShootPlanner'
import { WallXray } from './WallXray'

/** What floats over a unit that breaks, by the break. */
const BREAK_CALLOUT: Record<MoraleBreak, { text: string; color: string }> = {
  panic: { text: 'PANIC', color: '#ffb347' },
  frenzy: { text: 'FRENZY', color: '#ff4d6d' },
  freeze: { text: 'FROZEN', color: '#9bd7ff' },
}
const STEADIED = { text: 'STEADIED', color: '#9be89b' }

/** Everything a presenter draws with, and the session it draws. */
export interface PresenterParts {
  session: MatchSession
  battlefield: Battlefield
  /** The squad's bodies, built before the combat system that announces to them. */
  views: SquadViews
  /** The system that eases the bodies toward their units; added to the world here and taken out on dispose. */
  renderSystem: RenderSystem
  rig: OrbitRig
  hud: Hud
  portraits: OffscreenPortraits
  seedLabel: string
  engine: EngineContext
}

/**
 * Draws a {@link MatchSession}: the HUD from its view models, and the scene —
 * fog, overlays, effects, camera — from what its systems announce.
 *
 * The session decides and this shows. It never issues a command; the only thing
 * it holds that the player can change is what is *aimed at* (the planners,
 * reached by the session through {@link Aiming}) and what is *looked at*
 * (storey, camera mode, open panels), which no rule reads.
 */
export class Presenter implements MatchView {
  readonly aiming: Aiming
  private readonly planner: MovementPlanner
  private readonly shoot: ShootPlanner
  private readonly grenade: GrenadePlanner
  private readonly debug: DebugPanel
  private readonly debugMap = new DebugMap()
  private readonly fog: FogOfWar
  private readonly xray: WallXray
  private readonly noiseMarks: NoiseMarks
  /** A line over a unit that breaks or steadies. */
  private readonly callouts: DamageIndicators
  private readonly effects: Effects
  /** Fire on the ground, as the grid has it. */
  private readonly groundFx: GroundFx
  private readonly doorFx: DoorFx
  private readonly glassFx: GlassFx
  private readonly picker: GroundPicker
  private readonly session: MatchSession
  private readonly battlefield: Battlefield
  private readonly views: SquadViews
  private readonly renderSystem: RenderSystem
  private readonly rig: OrbitRig
  private readonly hud: Hud
  private readonly portraits: OffscreenPortraits
  private readonly seedLabel: string
  private readonly engine: EngineContext

  // Hover state (mouse only — touch has no hover phase).
  private hoveredTile: Tile | null = null
  private hoveredEnemy: Soldier | null = null
  /** The player asked for unit view. Aiming borrows the same camera on its own. */
  private unitViewRequested = false
  private selectedLevelFilter = 0
  /** Highest storey this map has; the level selector offers one button each. */
  private readonly topLevel: number
  /** Scratch aim point for the shoulder camera, to avoid a per-frame allocation. */
  private readonly aimPoint = new Vector3()
  /** The ground changed since the view last caught up with it; see `update`. */
  private groundDirty = false
  /** The end screen's pages still to show, once the match is over; null while it is being played. */
  private endPages: EndScreen[] | null = null

  constructor(parts: PresenterParts) {
    const { session, battlefield, views, renderSystem, rig, hud, portraits, seedLabel, engine } = parts
    this.session = session
    this.battlefield = battlefield
    this.views = views
    this.renderSystem = renderSystem
    this.rig = rig
    this.hud = hud
    this.portraits = portraits
    this.seedLabel = seedLabel
    this.engine = engine
    this.topLevel = battlefield.grid.maxLevel

    this.effects = new Effects(engine)
    // After the session's systems: it only reads what they wrote.
    session.world.addSystem(renderSystem)

    const { grid, squads, turnManager } = session
    this.planner = new MovementPlanner(grid, squads, engine)
    this.shoot = new ShootPlanner(grid, squads, engine)
    this.grenade = new GrenadePlanner(grid, squads, this.effects, rig, engine)
    this.aiming = { shoot: this.shoot, grenade: this.grenade, movement: this.planner }
    this.fog = new FogOfWar(grid, battlefield.ground, battlefield.blocks)
    this.xray = new WallXray(rig, squads, battlefield.blocks)
    this.picker = new GroundPicker(engine.camera)
    this.noiseMarks = new NoiseMarks(engine, grid)
    this.callouts = new DamageIndicators(engine)
    this.groundFx = new GroundFx(engine, grid)
    this.doorFx = new DoorFx(engine, grid, battlefield.blocks, (edge) => this.edgeInSight(edge))
    this.glassFx = new GlassFx(engine, grid, (edge) => this.edgeInSight(edge))
    this.debug = new DebugPanel(
      () => {
        // Live edits can change reach, cost and visibility, so everything the
        // player is looking at has to be recomputed, not just the panels.
        this.recomputeVisibility()
        this.renderOverlay()
        this.battlefield.flush()
        this.refreshHud()
      },
      () => turnManager.selectedSoldier,
      this.recordingControls(),
      debugEditable(session.mode),
    )
    this.battlefield.blocks.setLevelFilter(0)

    session.wallSystem.onKindChanged = (edge, from, to) => {
      this.doorFx.changed(edge, from, to)
      this.glassFx.changed(edge, from, to)
    }
    session.wallSystem.onWallsChanged = () => {
      this.battlefield.blocks.rebuildWalls()
      this.recomputeVisibility()
      this.renderOverlay()
      this.battlefield.flush()
    }
    // A fire changes the ground many tiles at a time; the view catches up once
    // per frame (`update`) rather than once per tile.
    session.groundSystem.onGroundChanged = () => {
      this.groundDirty = true
    }
    session.itemSystem.onItemUsed = (soldier) => {
      // The user, not the patient: the kit comes out of one pouch however many
      // people the effects land on.
      this.views.viewOf(soldier)?.playUse()
      this.recomputeVisibility()
      this.renderOverlay()
      this.refreshHud()
      this.debug.refresh()
    }
    // Reactions are the applier's, resolved before this is called: the fog
    // and the HUD show the result of a watcher's shot, not the moment before.
    session.commands.onStep = () => {
      this.recomputeVisibility()
      this.refreshHud()
    }
    session.commands.onDoorWorked = (unit, edge, verb) => {
      this.views.viewOf(unit)?.playUse()
      // A shoulder that gives is swung open by the wall change that follows; one
      // that does not is a shudder, and this is the only place that is known.
      if (verb === 'force') this.doorFx.rattle(edge)
    }
    session.commands.onNoise = (noise, heard) => {
      this.noiseMarks.add(roughly(noise.at), heard[0]!.faction, this.handovers)
    }
    session.commands.onBurned = (unit, damage) => {
      this.callouts.say(unit.position, `\u2212${damage} FIRE`, '#ff8a4a')
    }
    // Said over the unit on both screens: the rules already took it over, and
    // the other player has to be able to watch it happen.
    session.commands.onMorale = (unit, broke) => {
      const { text, color } = broke ? BREAK_CALLOUT[broke] : STEADIED
      this.callouts.say(unit.position, text, color)
      this.refreshHud()
    }
    session.movementSystem.onArrived = () => {
      this.recomputeVisibility()
      this.refreshHud()
    }
    session.combatSystem.onShotResolved = (shooter, target, result) => {
      this.shoot.reportShot(shooter, target, result)
    }
    this.shoot.onShotResolved = () => {
      this.recomputeVisibility()
      this.renderOverlay()
      this.refreshHud()
    }
    turnManager.onSelectionChanged = () => {
      this.debug.refresh()
      this.planner.clear()
      this.renderOverlay()
      this.battlefield.flush()
      this.refreshHud()
    }

    session.attach(this)
    this.recomputeVisibility()
    this.refreshHud()
  }

  /** The storey being drawn: what a tap is resolved against. */
  get level(): number {
    return this.selectedLevelFilter
  }

  /** Re-project game state into the HUD. The HUD reads nothing on its own. */
  refreshHud(): void {
    const { turnManager, squads, grid } = this.session
    const shooter = turnManager.selectedSoldier
    const state = this.session.state
    this.hud.render(
      buildHudModel({
        turnManager,
        squads,
        rig: this.rig,
        portraits: this.portraits,
        seedLabel: this.seedLabel,
        shootActive: this.shoot.active,
        shootReady: this.shoot.canEnter(shooter),
        strikeReady:
          shooter && !this.shoot.active && this.shoot.inReach(shooter).length > 0
            ? { sidearm: shooter.sidearm, name: MELEE[shooter.sidearm].name, apCost: MELEE[shooter.sidearm].apCost }
            : null,
        waypointActive: this.planner.waypointMode,
        rulesActing: state.rulesActing,
        retreatArmed: state.retreatArmed,
        retreatNote: state.retreatNote,
        grid,
        selectedLevelFilter: this.selectedLevelFilter,
        topLevel: this.topLevel,
        debugMapOpen: this.debugMap.isOpen,
        shoot:
          this.shoot.active && shooter
            ? {
                targets: this.shoot.availableTargets(shooter).map((soldier) => ({
                  soldier,
                  hitChance: calculateHitChance(grid, shooter, soldier),
                })),
                pending: this.shoot.pending(shooter),
              }
            : null,
        grenade: { armed: this.grenade.armed, pending: this.grenade.pending(shooter) },
        item: state.item,
        unitViewRequested: this.unitViewRequested,
        canAct: state.canAct,
        seat: state.seat,
      }),
    )
  }

  /** The minimap, handed who is standing where as plain data rather than the squads themselves. */
  private refreshDebugMap(): void {
    const units = this.session.squads.soldiers.filter((soldier) => !soldier.isDead)
    this.debugMap.refresh(
      this.session.grid,
      units.map(({ tile, faction }) => ({ tile, faction })),
      this.selectedLevelFilter,
      this.seedLabel,
    )
  }

  /**
   * The recorder, as the debug panel is allowed to touch it: the session's own
   * rules about when it may be armed, and the download that only a page can do.
   */
  private recordingControls(): RecordingControls | null {
    const recording = this.session.recording
    if (!recording) return null
    return {
      ...recording,
      export: () => {
        const file = recording.take()
        if (file) downloadJson(file.filename, file.data)
      },
    }
  }

  commandApplied(command: Command, result: Carried, origin: CommandOrigin): void {
    switch (command.type) {
      case 'moveUnit': {
        // A peer's route replaces whatever this side was previewing.
        if (origin !== 'local') this.planner.clear()
        // Nobody here chose this walk, so show the player who is making it.
        const walker = origin === 'rules' ? this.session.squads.byFaction[command.faction][command.squadIndex] : undefined
        if (walker) this.rig.focusOn(walker.position)
        this.refreshHud()
        return
      }
      case 'throwGrenade': {
        const thrower = this.session.squads.byFaction[command.shooterFaction][command.shooterIndex]
        if (thrower && result.grenade?.thrown) {
          const { flight, hits } = result.grenade
          this.grenade.replayThrow(command.kind, flight, thrower.grenadeSpecs[command.kind].areaRadius, hits)
        }
        this.afterCombat()
        return
      }
      case 'fireShot':
      case 'meleeAttack':
      case 'useItem':
        this.afterCombat()
        return
      case 'retreat':
        // The left-behind fall; the match is over, which `update` notices.
        if (result.retreat?.escaped) this.afterCombat()
        else this.refreshHud()
        return
      case 'endTurn':
      case 'reload':
      case 'toggleCover':
      case 'overwatch':
      case 'endUnitTurn':
      case 'rightClickFacing':
      case 'operateDoor':
        this.refreshHud()
        return
    }
  }

  /** Shared post-combat refresh: damage can reveal, kill, and re-cover. */
  private afterCombat(): void {
    this.recomputeVisibility()
    this.renderOverlay()
    this.refreshHud()
  }

  turnSwitched(): void {
    this.unitViewRequested = false
    if (this.rig.isShoulderViewActive) this.rig.exitShoulderView()
  }

  show(intent: ViewIntent): void {
    switch (intent.type) {
      case 'openDebug':
        this.debug.toggle()
        break
      case 'toggleDebugMap':
        this.debugMap.toggle()
        this.refreshDebugMap()
        this.refreshHud()
        break
      case 'endScreenNext': {
        this.endPages?.shift()
        const page = this.endPages?.[0]
        if (page) this.hud.showEndScreen(page)
        break
      }
      case 'selectLevel':
        this.selectedLevelFilter = intent.level
        this.battlefield.blocks.setLevelFilter(intent.level)
        this.rig.setFocusLevel(intent.level)
        this.grenade.viewStorey(intent.level)
        this.renderOverlay()
        if (this.debugMap.isOpen) {
          this.refreshDebugMap()
        }
        this.refreshHud()
        break
      case 'toggleFreelook':
        this.unitViewRequested = false
        if (this.rig.isShoulderViewActive) this.rig.exitShoulderView()
        this.rig.toggleFreeLookMode()
        this.refreshHud()
        break
      case 'toggleUnitView':
        if (!this.session.turnManager.selectedSoldier) break
        this.unitViewRequested = !this.unitViewRequested
        this.refreshHud()
        break
      case 'requestTurnSwitch':
        this.hud.showTurnOverlay()
        break
      case 'confirmTurnSwitch':
        this.hud.hideTurnOverlay()
        break
    }
  }

  /**
   * Show the end of the match: in a local match the loser's page first, then
   * the winner's survivors and what they learned; online, this side's own.
   */
  matchEnded(outcome: Outcome): void {
    this.endPages = endScreens(outcome.winner, outcome.viewer, outcome.debriefs, outcome.escapees, outcome.carried, this.portraits)
    const first = this.endPages[0]
    if (first) this.hud.showEndScreen(first)
  }

  /** The pointer moved over the field (mouse only). */
  hover(tile: Tile | null, enemy: Soldier | null): void {
    if (!tileEquals(tile, this.hoveredTile)) {
      this.hud.showTile(tile ? tileReadout(this.session.grid, tile) : null)
    }
    this.hoveredTile = tile
    this.hoveredEnemy = enemy
    this.renderOverlay()
  }

  /** Handovers so far: the clock noise marks fade by. */
  private get handovers(): number {
    const { turnManager } = this.session
    return turnManager.turnNumber * 2 + (turnManager.activeFaction === Faction.Blue ? 0 : 1)
  }

  /** Is either side of this wall in the viewer's sight right now? A replay watches everything. */
  private edgeInSight(edge: number): boolean {
    if (this.session.watching) return true
    const grid = this.session.grid
    const { x, y, side } = grid.edgeTile(edge)
    const [dx, dz] = FACE_OFFSET[side]!
    const map = this.fog.mapFor(this.session.viewerFaction)
    return (
      map[grid.index(x, y)] === VisState.Visible ||
      (grid.inBounds(x + dx, y + dz) && map[grid.index(x + dx, y + dz)] === VisState.Visible)
    )
  }

  recomputeVisibility(): void {
    // A replay is watched, not played: hiding half the fight from the only
    // person in the room would be hiding it from nobody's advantage.
    if (this.session.watching) {
      this.battlefield.ground.revealAll()
      this.battlefield.blocks.revealAll()
      for (const soldier of this.session.squads.soldiers) soldier.seen = true
      this.noiseMarks.show(null, this.handovers)
      return
    }

    const fogFaction = this.session.viewerFaction
    this.fog.recompute(fogFaction, this.session.squads)
    this.noiseMarks.show(fogFaction, this.handovers)
  }

  renderOverlay(): void {
    this.battlefield.ground.clearOverlay()

    const selected = this.session.turnManager.selectedSoldier
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

  /** One tick of everything: the rules, then the screens that read what they changed. */
  update(delta: number): void {
    this.session.update(delta)
    if (this.groundDirty) {
      this.groundDirty = false
      this.battlefield.ground.refreshSurfaces()
      this.battlefield.blocks.rebuildGround()
      this.groundFx.sync()
      this.recomputeVisibility()
      this.renderOverlay()
      this.battlefield.flush()
      if (this.hoveredTile) this.hud.showTile(tileReadout(this.session.grid, this.hoveredTile))
    }
    this.groundFx.update(delta)
    this.doorFx.update(delta)
    this.glassFx.update(delta)
    this.effects.update(delta)
    this.planner.update(delta)

    this.updateShoulderCamera()

    const selected = this.session.turnManager.selectedSoldier
    if (selected && !selected.isDead) {
      selected.seen = true
      if (selected.isMoving && !this.rig.isShoulderViewActive) this.rig.focusOn(selected.position)
    }

    this.xray.update(this.engine.camera.position)
  }

  /**
   * Bring a freshly built match up to date with `commands`, all at once.
   *
   * For a window that arrives in the middle of a match — taking a seat back,
   * or watching — the match so far is a log, and the player wants the
   * position, not a re-enactment. Each command is applied exactly as a replay
   * applies it, once the one before it has finished walking, and time is
   * advanced in fixed steps until it has: the same thing a headless host does
   * (`MatchHost`), so the world reached is the one every other window holds.
   * Steps rather than a jump to the end because movement *is* stepped state —
   * a watcher's reaction fires on an arrival — and how far a walk has got is
   * not something the rules can skip over.
   *
   * Presentation advances along with it — `alongside` is for whatever the
   * caller ticks beside the presenter, the tracers — so the blasts and
   * callouts it set off are long finished by the time anyone sees the field.
   * Nothing is published for the steps on the way: peers hold the same
   * commands, so the state reached is theirs without being sent.
   */
  catchUp(commands: readonly NetworkMessage[], step: number, alongside?: (step: number) => void): void {
    for (const command of commands) {
      this.settle(step, alongside)
      this.session.applyRecordedCommand(command)
    }
    this.settle(step, alongside)
  }

  /** Advance time until nothing is walking and the rules have nothing queued. */
  private settle(step: number, alongside?: (step: number) => void): void {
    // Bounded, like `MatchHost`, so a walker that never arrives costs a stall
    // rather than a frozen tab.
    for (let i = 0; i < 2000 && this.session.busy; i++) {
      this.update(step)
      alongside?.(step)
    }
  }

  /**
   * Decide whether the shoulder camera is up this frame, and where it looks.
   *
   * Two things ask for it — the unit-view toggle, and lining up a shot — so
   * the question is answered in one place rather than by enter/exit calls
   * scattered across the input handlers.
   */
  private updateShoulderCamera(): void {
    const selected = this.session.turnManager.selectedSoldier
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

  dispose(): void {
    this.planner.dispose()
    this.shoot.dispose()
    this.noiseMarks.dispose()
    this.callouts.dispose()
    this.groundFx.dispose()
    this.doorFx.dispose()
    this.glassFx.dispose()
    this.grenade.dispose()
    this.debug.dispose()
    this.debugMap.dispose()
    this.effects.dispose()
    // The bodies too: a match rebuilt in place (`main.tsx`, a resync) would
    // otherwise stand the new squads among the old ones.
    this.views.dispose()
    this.session.world.removeSystem(this.renderSystem)
  }
}
