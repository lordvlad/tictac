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
 * stepped backwards has to put back. Taken and restored by `Playback`, which
 * is the only code that does either: a rewind presents a recording and is
 * never a move in live play.
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
