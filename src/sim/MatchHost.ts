import { Faction, SIM } from '../config'
import { NO_FOCUS, NO_FX } from '../core/Combatant'
import { generateMap } from '../core/MapGenerator'
import { distance, facingYaw } from '../core/math'
import { matchDice } from '../core/rng'
import type { Grid } from '../core/Grid'
import { type ShotResult, throwGrenade } from '../game/Combat'
import type { NetworkMessage } from '../game/NetworkManager'
import type { RecordingHeader } from '../game/Recording'
import { Squads } from '../game/Squads'
import { digestWorld, type StateDigest } from '../game/StateDigest'
import { TurnManager } from '../game/TurnManager'
import { createGlobalRules } from '../ecs/globals'
import { CombatSystem, ItemSystem, MovementSystem, TurnSystem } from '../ecs/systems'
import { World } from '../ecs/World'

/**
 * A whole match, with nobody watching, driven by intents.
 *
 * One applier, three users: the replay runner (`Replay.ts`), the referee
 * (`src/server/Referee.ts`) and any test that wants to play a match without an
 * engine. Under [ADR-0004](../../docs/design/adr/0004-full-knowledge-lockstep.md)
 * a command carries what a player decided and both sides *resolve* it, so
 * "apply this intent to a world" is the same operation wherever it happens —
 * and having three copies of it would be three chances to resolve a match
 * differently from the peers playing it.
 *
 * It is not a second implementation of the rules: every branch below calls the
 * same door a live match calls — `CombatSystem.fireShot`, `throwGrenade`,
 * `MovementSystem.startMovement`, `TurnManager`.
 *
 * What it deliberately does *not* do is decide anything. There is no policy
 * here and no input: a host is told what happened and works out what that
 * means. Deciding is the AI's job in `SimMatch`, and a player's in the
 * controller.
 */

/** Why an intent could not be carried out. */
export interface Refusal {
  applied: false
  reason: string
}

/**
 * An intent carried out. A shot says what it did, because whoever sent it may
 * want to know — a policy deciding its next move, a sweep keeping score — and
 * the rules are the only place that knows.
 */
export interface Carried {
  applied: true
  shot?: ShotResult
}

export type Applied = Carried | Refusal

const carried: Applied = { applied: true }
const refuse = (reason: string): Refusal => ({ applied: false, reason })

/** Where a unit ended up, for a report that has no scene to look at. */
export interface UnitState {
  name: string
  faction: Faction
  squadIndex: number
  hp: number
  maxHp: number
  ap: number
  armor: number
  tile: { x: number; y: number }
  dead: boolean
}

export interface MatchHostOptions {
  /**
   * Movement is animated, so a host has to advance time for a unit to arrive.
   * Fixed step, because a variable one would make the outcome depend on how
   * fast the machine running it is.
   */
  step?: number
  /** Give up on a unit that never arrives, rather than looping forever. */
  maxStepsPerMove?: number
}

export class MatchHost {
  readonly world = new World()
  readonly grid: Grid
  readonly squads: Squads
  readonly turnManager: TurnManager

  private readonly movement: MovementSystem
  private readonly combat: CombatSystem
  private readonly items: ItemSystem
  private readonly step: number
  private readonly maxSteps: number

  /** Reactions fired so far: a fact about the match, not about any one intent. */
  reactions = 0

  /**
   * Build the opening position from a match's header.
   *
   * Terrain comes from the seed rather than from the header, because terrain is
   * a function of the seed and storing it would be storing something that can
   * be derived — and something that could then disagree with what the seed says.
   */
  constructor(header: RecordingHeader, options: MatchHostOptions = {}) {
    const map = generateMap(header.seed)
    this.grid = map.grid
    this.step = options.step ?? SIM.step
    this.maxSteps = options.maxStepsPerMove ?? 2000

    createGlobalRules(this.world)
    this.squads = new Squads(
      this.world,
      map.grid,
      map.spawns,
      undefined,
      Faction.Blue,
      header.sheets,
    )
    // Both sides' kit: a host resolves attacks for everybody, so it needs the
    // weapons both squads actually fought with rather than the stock spread.
    this.squads.equipFaction(Faction.Blue, header.loadouts[Faction.Blue])
    this.squads.equipFaction(Faction.Red, header.loadouts[Faction.Red])

    this.movement = new MovementSystem(map.grid)
    // The reaction trigger, wired identically to a live match's: a unit that
    // walked into somebody's watch is shot at by the rules rather than by a
    // message. Both peers, a replay and a referee therefore provoke the same
    // reactions from the same intent.
    this.movement.onStep = (entityId) => {
      const mover = this.squads.byEntityId(entityId)
      if (mover) this.reactions += this.combat.reactTo(mover)
    }
    this.combat = new CombatSystem(map.grid, this.squads, NO_FX, matchDice(header.seed))
    this.items = new ItemSystem()
    const turns = new TurnSystem()
    this.turnManager = new TurnManager(this.world, turns, this.squads, NO_FOCUS)
    this.world.addSystem(this.movement)
    this.world.addSystem(this.combat)
    this.world.addSystem(this.items)
    this.world.addSystem(turns)
    this.turnManager.autoSelectFirst()
  }

  private unitAt(faction: Faction, index: number) {
    return this.squads.byFaction[faction][index]
  }

  /** Advance time until nothing is walking, so the next intent sees the arrival. */
  private settleMovement(): void {
    for (let i = 0; i < this.maxSteps; i++) {
      if (!this.squads.soldiers.some((unit) => unit.isMoving)) return
      this.world.update(this.step)
    }
  }

  /**
   * Carry out one intent.
   *
   * A refusal is a *finding*, never a silent no-op: it means this build and
   * whoever sent the intent disagree about what was possible, which is a
   * bigger disagreement than any number.
   */
  apply(command: NetworkMessage): Applied {
    switch (command.type) {
      case 'moveUnit': {
        const soldier = this.unitAt(command.faction, command.squadIndex)
        if (!soldier || soldier.isDead) return refuse('no such live unit')
        this.movement.startMovement(this.world, soldier.entityId, command.path)
        this.settleMovement()
        return carried
      }
      case 'fireShot': {
        const shooter = this.unitAt(command.shooterFaction, command.shooterIndex)
        const target = this.unitAt(command.targetFaction, command.targetIndex)
        if (!shooter || !target) return refuse('shooter or target missing')
        // Resolved from the match's dice, exactly as the peer that sent the
        // intent did and exactly as the peer receiving it does.
        const shot = this.combat.fireShot(shooter, target, command.mode)
        if (!shot) return refuse('shot refused by the rules')
        return { applied: true, shot }
      }
      case 'throwGrenade': {
        const thrower = this.unitAt(command.shooterFaction, command.shooterIndex)
        if (!thrower) return refuse('no such thrower')
        const result = throwGrenade(
          this.grid,
          thrower,
          command.targetTile,
          command.kind,
          this.squads.soldiers,
        )
        if (!result.thrown) return refuse('throw refused by the rules')
        return carried
      }
      case 'reload': {
        const soldier = this.unitAt(command.faction, command.squadIndex)
        if (!soldier) return refuse('no such unit')
        this.combat.reload(soldier)
        return carried
      }
      case 'toggleCover': {
        const soldier = this.unitAt(command.faction, command.squadIndex)
        if (!soldier) return refuse('no such unit')
        this.combat.toggleCover(this.world, soldier.entityId)
        return carried
      }
      case 'overwatch': {
        const soldier = this.unitAt(command.faction, command.squadIndex)
        if (!soldier) return refuse('no such unit')
        if (!this.combat.overwatch(soldier)) return refuse('cannot afford a watch')
        return carried
      }
      case 'useItem': {
        const user = this.unitAt(command.faction, command.squadIndex)
        if (!user) return refuse('no such unit')
        const target =
          command.targetFaction !== undefined && command.targetIndex !== undefined
            ? this.unitAt(command.targetFaction, command.targetIndex)
            : undefined
        // Forced: the acting side established that it was legal, and a host
        // that second-guessed it would report a disagreement about legality as
        // a failure to apply.
        this.items.use(user, command.itemId, target ?? user, true)
        return carried
      }
      case 'endUnitTurn': {
        const soldier = this.unitAt(command.faction, command.squadIndex)
        if (!soldier || soldier.isDead) return refuse('no such live unit')
        this.turnManager.finishSoldierTurn(soldier)
        return carried
      }
      case 'endTurn': {
        this.turnManager.startNextTurn()
        return carried
      }
      case 'rightClickFacing': {
        const soldier = this.unitAt(command.faction, command.squadIndex)
        if (!soldier || soldier.isDead) return refuse('no such live unit')
        const dx = command.x - soldier.position.x
        const dz = command.z - soldier.position.z
        if (distance(dx, dz) > 0.01) soldier.targetYaw = facingYaw(dx, dz)
        return carried
      }
      default:
        // Handshake and diagnostic frames are not intents and are never
        // recorded; anything else here is a command this build does not know,
        // which is a finding about the sender's version.
        return refuse('unknown command')
    }
  }

  /** The fingerprint two sides compare to find out whether they agree. */
  digest(): StateDigest {
    return digestWorld(
      this.world,
      this.squads.soldiers.map((unit) => unit.entityId),
      this.turnManager.turnNumber,
    )
  }

  get turnNumber(): number {
    return this.turnManager.turnNumber
  }

  get activeFaction(): Faction {
    return this.turnManager.activeFaction
  }

  /** Whether the match is over, and who is left standing. */
  get living(): Record<Faction, number> {
    return {
      [Faction.Blue]: this.squads.byFaction[Faction.Blue].filter((u) => !u.isDead).length,
      [Faction.Red]: this.squads.byFaction[Faction.Red].filter((u) => !u.isDead).length,
    }
  }

  units(): UnitState[] {
    return this.squads.soldiers.map((unit) => ({
      name: unit.name,
      faction: unit.faction,
      squadIndex: unit.squadIndex,
      hp: unit.hp,
      maxHp: unit.maxHp,
      ap: unit.ap,
      armor: unit.armor,
      tile: { ...unit.tile },
      dead: unit.isDead,
    }))
  }
}
