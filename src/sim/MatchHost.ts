import { Faction, SIM } from '../config'
import { NO_FOCUS, NO_FX } from '../core/Combatant'
import { generateMap } from '../core/MapGenerator'
import { matchDice } from '../core/rng'
import type { Grid } from '../core/Grid'
import type { NetworkMessage } from '../game/NetworkManager'
import type { RecordingHeader } from '../game/Recording'
import { Squads } from '../game/Squads'
import { digestWorld, type StateDigest } from '../game/StateDigest'
import { TurnManager } from '../game/TurnManager'
import { createGlobalRules } from '../ecs/globals'
import { CombatSystem, ItemSystem, MovementSystem, TurnSystem, WallSystem } from '../ecs/systems'
import { type Applied, CommandSystem, isCommand } from '../ecs/systems/CommandSystem'
import { World } from '../ecs/World'

/**
 * A whole match, with nobody watching, driven by intents.
 *
 * The world a played match builds, minus the scene: the same systems, the same
 * {@link CommandSystem} applying the same commands. Its users are the replay
 * runner (`Replay.ts`), the referee (`src/server/Referee.ts`), the sweep
 * (`SimMatch`) and any test that wants a match without an engine. Because the
 * applier is shared with the played game, everything they exercise is the
 * path real players take — which was not true while the controller kept
 * switches of its own.
 *
 * What it adds is time: movement is animated, so a host steps the world at a
 * fixed rate until every walker has arrived. What it deliberately does *not*
 * do is decide anything. Deciding is the AI's job in `SimMatch`, and a
 * player's in the controller.
 */

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

  readonly commands: CommandSystem
  readonly walls: WallSystem
  private readonly step: number
  private readonly maxSteps: number

  /**
   * Build the opening position from a match's header.
   *
   * Terrain comes from the seed rather than from the header, because terrain is
   * a function of the seed and storing it would be storing something that can
   * be derived — and something that could then disagree with what the seed says.
   */
  constructor(header: RecordingHeader, options: MatchHostOptions = {}) {
    const map = generateMap(header.seed, header.map)
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

    const movement = new MovementSystem(map.grid)
    const combat = new CombatSystem(map.grid, this.squads, NO_FX, matchDice(header.seed))
    const items = new ItemSystem()
    const turns = new TurnSystem()
    // An entity per wall, as in a played match, so a broken window is state
    // like any other. Not added as a system: its tick only catches the grid up
    // with a peer's replicated walls, and a host has no peer.
    this.walls = new WallSystem(map.grid)
    this.walls.spawnFromGrid(this.world)
    this.turnManager = new TurnManager(this.world, turns, this.squads, NO_FOCUS)
    this.commands = new CommandSystem(this.world, this.squads, this.turnManager, movement, combat, items, this.walls)
    this.world.addSystem(this.commands)
    this.world.addSystem(movement)
    this.world.addSystem(combat)
    this.world.addSystem(items)
    this.world.addSystem(turns)
    this.turnManager.autoSelectFirst()
  }

  /** Advance time until nothing is walking, so the next intent sees the arrival. */
  private settleMovement(): void {
    for (let i = 0; i < this.maxSteps; i++) {
      if (!this.commands.busy) return
      this.world.update(this.step)
    }
  }

  /**
   * Carry out one intent, and wait for it to finish.
   *
   * The same applier the played game uses, so this is not a second reading of
   * the rules: the only thing a host adds is time. A move is advanced at a
   * fixed step until the walker arrives, so the next intent sees the arrival —
   * exactly what the played game's queue waits for.
   *
   * A refusal is a *finding*, never a silent no-op: it means this build and
   * whoever sent the intent disagree about what was possible, which is a
   * bigger disagreement than any number.
   */
  apply(command: NetworkMessage): Applied {
    // Handshake and diagnostic frames are not intents and are never recorded;
    // anything else here is a command this build does not know, which is a
    // finding about the sender's version.
    if (!isCommand(command)) return { applied: false, reason: 'unknown command' }
    const result = this.commands.apply(command, 'record')
    this.settleMovement()
    return result
  }

  /** Reactions fired so far. */
  get reactions(): number {
    return this.commands.reactions
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
