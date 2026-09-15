import type { Vector3 } from 'three'
import type { Faction } from '../config'
import type { GrenadeId, GrenadeSpec } from './Arsenal'
import type { CombatantStats, StatusState } from './Ballistics'
import type { Tile } from './Grid'

/**
 * Which unit, by identity.
 *
 * A faction and a squad slot name a fighter without being the object that
 * draws it, which is what lets a resolved event be *announced* to a view that
 * looks the body up itself.
 */
export interface UnitRef {
  readonly faction: Faction
  readonly squadIndex: number
}

/**
 * The slice of a unit a resolved hit is applied to.
 *
 * Narrow on purpose: an incoming hit is four numbers and a status, so anything
 * wider would invite the applier to start deriving damage from the weapon it
 * can see — the one thing a replayed hit must never do.
 */
export interface Casualty extends UnitRef {
  hp: number
  armor: number
  statuses: StatusState[]
  readonly isDead: boolean
}

/**
 * A unit as the resolvers see it: state and identity, no presentation.
 *
 * Everything combat reads or writes about a fighter is here, and nothing else
 * is. `Soldier` satisfies it today by having these members among its graphics;
 * a headless runner satisfies it with an object literal. That is the whole
 * point — the rules should not be able to tell the difference, and until this
 * existed they could, because they were typed against a `three` scene node.
 */
export interface Combatant extends CombatantStats, Casualty {
  readonly isMoving: boolean
  tile: Tile
  ap: number
  /** Yaw the unit is turning towards. Facing is state; the turn is animation. */
  targetYaw: number
  /** The AP ceiling with live statuses folded in. */
  readonly effectiveMaxAp: number
  /** Points this unit's own actions have consumed since its last refill. */
  spentThisTurn: number
  /** Consecutive turns it has spent every point it had. */
  exhaustedTurns: number
  grenades: Record<GrenadeId, number>
  readonly grenadeSpecs: Record<GrenadeId, GrenadeSpec>
  /** Hunker down. Stance is state, so this belongs to the rules, not the view. */
  enterCover(): void
  exitCover(): void
}

/**
 * Where a resolved event goes to be *seen*.
 *
 * The resolvers used to call the renderer directly — spawn a tracer, play a
 * fire pose, play a death — which is what made a shot impossible to resolve
 * without a scene to draw it in. They announce through this instead, and what
 * is listening is somebody else's problem: a scene in a match, nothing at all
 * in a simulation.
 */
export interface CombatFx {
  /** A round in flight, and whether it landed. */
  tracer(from: Vector3, to: Vector3, hit: boolean): void
  shoot(unit: UnitRef): void
  hit(unit: UnitRef): void
}

/**
 * Dying is not here. A unit at zero hit points is a fact about its components,
 * so the view plays the collapse when it sees that - which means a peer's death
 * animates off replicated state rather than off a message, and nothing has to
 * announce it twice.
 */

/**
 * Where the view should be looking.
 *
 * Selecting a unit is a rules decision; pointing a camera at it is not.
 * {@link TurnManager} took an `OrbitRig` for one call, which meant a turn could
 * not be taken without a camera to swing.
 */
export interface FocusPort {
  focusOn(position: Vector3): void
}

/** Nobody is looking. */
export const NO_FOCUS: FocusPort = { focusOn: () => {} }

/** Resolve a match nobody is watching. */
export const NO_FX: CombatFx = {
  tracer: () => {},
  shoot: () => {},
  hit: () => {},
}
