import type { Faction } from '../config'
import type { GroundSystem } from '../ecs/systems/GroundSystem'
import type { Rng } from '../core/rng'
import type { World, WorldSnapshot } from '../ecs/World'
import type { CommandSystem } from '../ecs/systems/CommandSystem'
import type { MovementSystem } from '../ecs/systems/MovementSystem'
import type { TurnSystem } from '../ecs/systems/TurnSystem'
import type { WallSystem } from '../ecs/systems/WallSystem'

/**
 * Everything a match is at one moment between two commands — what a replay
 * stepped backwards has to put back.
 *
 * Commands are not invertible (damage is applied, points spent, glass broken),
 * so going back means having kept the moment. Four things make one up, and
 * forgetting any of them means playing on from the restored moment reaches a
 * different match than the file records:
 *
 * - the units' components;
 * - the walls, since a round through a window breaks it — kept as one kind per
 *   wall rather than as components, because there are hundreds of them and a
 *   frame is taken at every event;
 * - the ground: what is burning, what smoke there is, what burned away;
 * - the dice: every roll is a function of all the rolls before it.
 */
export interface Moment {
  units: WorldSnapshot
  walls: Uint8Array
  /** Fire, smoke, ash and burned crates: one small component, kept whole. */
  ground: WorldSnapshot
  dice: number
  activeFaction: Faction
  turnNumber: number
}

/** The parts of a match a moment is taken from and put back into. */
export interface Rewindable {
  world: World
  unitIds: readonly number[]
  walls: WallSystem
  ground: GroundSystem
  turns: TurnSystem
  dice: Rng
  movement: MovementSystem
  commands: CommandSystem
}

/** The match as it is now. Only between commands: nothing walking, nothing queued. */
export function captureMoment(match: Rewindable): Moment {
  return {
    units: match.world.snapshot(match.unitIds),
    walls: match.walls.kinds(match.world),
    ground: match.world.snapshot([match.ground.entity]),
    dice: match.dice.snapshot(),
    activeFaction: match.turns.activeFaction,
    turnNumber: match.turns.turnNumber,
  }
}

/**
 * Put the match back to `moment`.
 *
 * Routes first: a unit's path is the one piece of movement state that is not
 * a component, so a restored unit would otherwise walk on along a path it is
 * no longer on. The same for whatever the rules had queued for a broken unit:
 * it was decided about the moment being left.
 */
export function restoreMoment(match: Rewindable, moment: Moment): void {
  match.movement.clearRoutes(match.world, match.unitIds)
  match.commands.clear()
  match.world.restore(moment.units)
  match.walls.restoreKinds(match.world, moment.walls)
  match.world.restore(moment.ground)
  // The grid is an index over the ground component; catch it up now rather
  // than on the next tick, so the restored moment is whole at once.
  match.ground.update(0, match.world)
  match.dice.restore(moment.dice)
  match.turns.activeFaction = moment.activeFaction
  match.turns.turnNumber = moment.turnNumber
}
