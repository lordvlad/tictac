import type { Faction } from '../../config'
import { distance, facingYaw } from '../../core/math'
import { hears, type Noise, stepLoudness } from '../../core/Noise'
import { hear, lookAround } from '../../core/Awareness'
import { headingToward } from '../../core/Facing'
import type { Soldier } from '../../entities/Soldier'
import type { GrenadeResult, ShotResult } from '../../game/Combat'
import type { NetworkMessage } from '../../game/NetworkManager'
import type { Squads } from '../../game/Squads'
import type { TurnManager } from '../../game/TurnManager'
import { System } from '../System'
import type { World } from '../World'
import type { CombatSystem } from './CombatSystem'
import type { ItemSystem } from './ItemSystem'
import type { MovementSystem } from './MovementSystem'

/** The messages that change the world. Everything else on the wire is session or diagnosis. */
export type Command = Extract<
  NetworkMessage,
  {
    type:
      | 'moveUnit'
      | 'fireShot'
      | 'meleeAttack'
      | 'throwGrenade'
      | 'reload'
      | 'toggleCover'
      | 'overwatch'
      | 'useItem'
      | 'endUnitTurn'
      | 'endTurn'
      | 'rightClickFacing'
  }
>

const COMMAND_TYPES: ReadonlySet<string> = new Set<Command['type']>([
  'moveUnit',
  'fireShot',
  'meleeAttack',
  'throwGrenade',
  'reload',
  'toggleCover',
  'overwatch',
  'useItem',
  'endUnitTurn',
  'endTurn',
  'rightClickFacing',
])

export function isCommand(message: NetworkMessage): message is Command {
  return COMMAND_TYPES.has(message.type)
}

/**
 * Where a command came from.
 *
 * - `local`: this side's player. Checked for legality before it is applied,
 *   and the only origin that is sent to a peer.
 * - `peer`: the other player, over the wire.
 * - `record`: a file, a referee's log, or the sweep's policy.
 *
 * A command from anywhere but here is not second-guessed where the rules allow
 * the sender to have known better — item use is the one case — but every
 * refusal is reported, because from those origins a refusal means two sides
 * disagree about what was possible.
 */
export type CommandOrigin = 'local' | 'peer' | 'record'

/** Why a command could not be carried out. */
export interface Refusal {
  applied: false
  reason: string
}

/**
 * A command carried out. A shot and a throw say what they did, because
 * whoever issued them may want to know — a policy keeping score, a view
 * drawing the blast — and the rules are the only place that knows.
 */
export interface Carried {
  applied: true
  shot?: ShotResult
  grenade?: GrenadeResult
}

export type Applied = Carried | Refusal

const carried: Carried = { applied: true }
const refuse = (reason: string): Refusal => ({ applied: false, reason })

/**
 * The one place a command becomes a change to the world.
 *
 * Everything that issues commands goes through here: the player's clicks, the
 * other player's messages, a replay, the referee and the sweep. It used to be
 * three switches — the controller's for local input, the controller's for a
 * peer, and the headless host's — and only the last was ever tested. The
 * controller's peer switch shipped with a duplicated `case 'overwatch'` whose
 * first copy was the local handler, so a peer's watch was never applied in a
 * live match while every replay passed. With one switch, a replay *is* the live
 * path.
 *
 * Rules stay in their systems; this only looks the units up, asks the right
 * system, and reports what happened. What the view does about it — the HUD, the
 * fog, a blast, a damage number — is `onApplied`'s business and never this
 * class's.
 *
 * ### The queue
 *
 * A peer's commands arrive whenever the network delivers them, which is
 * usually long before this side has finished *animating* the last one. Applied
 * on arrival, a shot that follows a move would be resolved while the mover was
 * still between tiles on this screen, from a position the sender never shot
 * from. So a peer's commands wait in order in {@link enqueue} and are drained
 * by {@link update} only while nothing is walking — the same guarantee the
 * headless host gets by settling movement after every command.
 */
export class CommandSystem extends System {
  /** Called after a command has been carried out. */
  onApplied?: (command: Command, result: Carried, origin: CommandOrigin) => void
  /** Called before a command is applied: the last moment the world is as the issuer saw it. */
  onBeforeApply?: (command: Command, origin: CommandOrigin) => void
  /** Called when the rules refused a command. */
  onRefused?: (command: Command, refusal: Refusal, origin: CommandOrigin) => void
  /** A unit arrived on a tile — after any reactions it provoked have been resolved. */
  onStep?: (mover: Soldier) => void
  /**
   * Something was made audible, and these units of the other side heard it.
   * Called only when somebody did: a noise nobody hears is not an event.
   */
  onNoise?: (noise: Noise, heard: Soldier[]) => void

  /** Reactions fired so far: a fact about the match, not about any one command. */
  reactions = 0

  private readonly queue: Array<{ command: Command; origin: CommandOrigin } | (() => void)> = []

  constructor(
    private readonly world: World,
    private readonly squads: Squads,
    private readonly turns: TurnManager,
    private readonly movement: MovementSystem,
    private readonly combat: CombatSystem,
    private readonly items: ItemSystem,
  ) {
    super()
    // The reaction trigger lives with the applier, not with whoever happens to
    // be showing the match: arriving on a tile is what a watcher was waiting
    // for, and every carrier of a match has to agree about that.
    movement.onStep = (entityId) => {
      const mover = this.squads.byEntityId(entityId)
      if (!mover) return
      // The step is made before anybody reacts to it: a watcher's shot is an
      // answer to the arrival, and its report follows the footfall. Hearing
      // it may turn a watcher round; seeing it may engage one — both before
      // the reaction, which is what they are for.
      this.sound({ at: { ...mover.tile }, loudness: stepLoudness(mover.isCrouching), faction: mover.faction })
      this.look()
      this.reactions += this.combat.reactTo(mover)
      this.onStep?.(mover)
    }
    combat.onNoise = (noise) => this.sound(noise)
  }

  /**
   * Who heard `noise`, by the one rule (`hears`): the same list on both peers,
   * in squad order, because it is worked out from state both hold. Each of
   * them is alerted by it and turns toward it (`core/Awareness`).
   */
  private sound(noise: Noise): void {
    const heard = this.squads.soldiers.filter((unit) => hears(unit, noise))
    if (heard.length === 0) return
    for (const unit of heard) hear(unit, noise)
    this.onNoise?.(noise, heard)
  }

  /** Whoever can now see an enemy is in the fight (`lookAround`). */
  private look(): void {
    lookAround(this.combat.grid, this.squads.soldiers, this.turns.activeFaction)
  }

  /** True while any unit is still walking a route. */
  get busy(): boolean {
    return this.squads.soldiers.some((unit) => unit.isMoving)
  }

  /** True while anything is waiting its turn in the queue. */
  get pending(): boolean {
    return this.queue.length > 0
  }

  /** Queue a peer's command behind anything still waiting or walking. */
  enqueue(command: Command, origin: CommandOrigin): void {
    this.queue.push({ command, origin })
    this.drain()
  }

  /**
   * Run `fn` once everything queued before it has been applied and has
   * stopped moving. For checks about state — a peer's digest is a claim about
   * the world *after* its commands, not after whatever this side has animated.
   */
  whenSettled(fn: () => void): void {
    this.queue.push(fn)
    this.drain()
  }

  update(): void {
    this.drain()
  }

  private drain(): void {
    while (this.queue.length > 0 && !this.busy) {
      const next = this.queue.shift()!
      if (typeof next === 'function') next()
      else this.apply(next.command, next.origin)
    }
  }

  /**
   * Carry out one command, now.
   *
   * A move only *starts* here: the walk is `MovementSystem`'s, over however
   * many ticks it takes. A caller that needs the arrival — the headless host,
   * the queue — waits for {@link busy} to clear.
   */
  apply(command: Command, origin: CommandOrigin): Applied {
    this.onBeforeApply?.(command, origin)
    const result = this.resolve(command, origin)
    // Whatever changed — a shot, a turn, a handover — may have put an enemy
    // in somebody's view.
    if (result.applied) this.look()
    if (result.applied) this.onApplied?.(command, result, origin)
    else this.onRefused?.(command, result, origin)
    return result
  }

  private unit(faction: Faction, index: number): Soldier | undefined {
    return this.squads.byFaction[faction]?.[index]
  }

  private resolve(command: Command, origin: CommandOrigin): Applied {
    switch (command.type) {
      case 'moveUnit': {
        const soldier = this.unit(command.faction, command.squadIndex)
        if (!soldier || soldier.isDead) return refuse('no such live unit')
        if (command.path.length < 2) return refuse('a route needs somewhere to go')
        this.movement.startMovement(this.world, soldier.entityId, command.path)
        return carried
      }
      case 'fireShot': {
        const shooter = this.unit(command.shooterFaction, command.shooterIndex)
        const target = this.unit(command.targetFaction, command.targetIndex)
        if (!shooter || !target) return refuse('shooter or target missing')
        const shot = this.combat.fireShot(shooter, target, command.mode)
        return shot ? { applied: true, shot } : refuse('shot refused by the rules')
      }
      case 'meleeAttack': {
        const attacker = this.unit(command.attackerFaction, command.attackerIndex)
        const target = this.unit(command.targetFaction, command.targetIndex)
        if (!attacker || !target) return refuse('attacker or target missing')
        const shot = this.combat.melee(attacker, target)
        return shot ? { applied: true, shot } : refuse('blow refused by the rules')
      }
      case 'throwGrenade': {
        const thrower = this.unit(command.shooterFaction, command.shooterIndex)
        if (!thrower) return refuse('no such thrower')
        const grenade = this.combat.throwGrenade(thrower, command.targetTile, command.kind)
        return grenade.thrown ? { applied: true, grenade } : refuse('throw refused by the rules')
      }
      case 'reload': {
        const soldier = this.unit(command.faction, command.squadIndex)
        if (!soldier) return refuse('no such unit')
        return this.combat.reload(soldier) ? carried : refuse('nothing to reload')
      }
      case 'toggleCover': {
        const soldier = this.unit(command.faction, command.squadIndex)
        if (!soldier) return refuse('no such unit')
        return this.combat.toggleCover(this.world, soldier.entityId)
          ? carried
          : refuse('cannot change stance')
      }
      case 'overwatch': {
        const soldier = this.unit(command.faction, command.squadIndex)
        if (!soldier) return refuse('no such unit')
        return this.combat.overwatch(soldier) ? carried : refuse('cannot afford a watch')
      }
      case 'useItem': {
        const user = this.unit(command.faction, command.squadIndex)
        if (!user) return refuse('no such unit')
        // A frame naming nobody, or a unit this side cannot find, is a self-use.
        const target =
          command.targetFaction !== undefined && command.targetIndex !== undefined
            ? this.unit(command.targetFaction, command.targetIndex)
            : undefined
        // Forced from anywhere but here: the acting side established reach and
        // need, which this side would otherwise second-guess into a refusal.
        // `use` still refuses what no legitimate sender could have done.
        return this.items.use(user, command.itemId, target ?? user, origin !== 'local')
          ? carried
          : refuse('item refused by the rules')
      }
      case 'endUnitTurn': {
        const soldier = this.unit(command.faction, command.squadIndex)
        if (!soldier || soldier.isDead) return refuse('no such live unit')
        this.turns.finishSoldierTurn(soldier)
        return carried
      }
      case 'endTurn': {
        this.turns.startNextTurn()
        return carried
      }
      case 'rightClickFacing': {
        const soldier = this.unit(command.faction, command.squadIndex)
        if (!soldier || soldier.isDead) return refuse('no such live unit')
        const dx = command.x - soldier.position.x
        const dz = command.z - soldier.position.z
        if (distance(dx, dz) > 0.01) soldier.targetYaw = facingYaw(dx, dz)
        // World x runs with tile x and world z with tile y, so the same offset
        // names the heading; comparisons only, so both peers agree.
        soldier.heading = headingToward(dx, dz, soldier.heading)
        return carried
      }
    }
  }
}
