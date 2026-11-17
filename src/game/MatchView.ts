import type { Faction } from '../config'
import type { ShotMode, GrenadeId } from '../core/Arsenal'
import type { Tile } from '../core/Grid'
import type { ItemId } from '../core/Items'
import type { Soldier } from '../entities/Soldier'
import type { CommandOrigin, Carried } from '../ecs/systems/CommandSystem'
import type { Command } from '../rules/Command'
import type { HudIntent } from '../rules/Intent'
import type { Debrief } from '../rules/MatchEnd'
import type { NetworkMode } from './NetworkManager'

/**
 * What a `MatchSession` needs from whatever shows it.
 *
 * The session decides and the view draws, and this is the whole of the seam: the
 * view is told *that* something changed and reads what it needs from the session's
 * view models, and the session asks the view only what is kept with the picture
 * (what is aimed at, because the planners that hold it also draw it).
 * A session with no view at all is a match that can be driven and inspected with
 * no DOM and no WebGL — which is what makes the rules of *input* testable.
 */

/** The shot being lined up, which lives with the planner that draws it. */
export interface ShootAim {
  readonly active: boolean
  readonly selectedTarget: Soldier | null
  /** Start aiming; false when there is nothing to aim at. */
  enter(shooter: Soldier | null, intent: 'shoot' | 'strike'): boolean
  exit(): void
  selectTarget(soldier: Soldier | null): void
  /** The target of a shot in `mode`, if the panel offers one. */
  choose(shooter: Soldier, mode: ShotMode): Soldier | null
}

/** A throw as aimed: what becomes a `throwGrenade` command. */
export interface AimedThrow {
  kind: GrenadeId
  targetTile: Tile
  targetLevel: number
}

/** The grenade being lined up. */
export interface GrenadeAim {
  readonly active: boolean
  readonly armed: GrenadeId | null
  arm(kind: GrenadeId, thrower: Soldier | null): boolean
  exit(): void
  aimAt(tile: Tile): void
  isAimedAt(tile: Tile): boolean
  /** The throw currently lined up, if the panel offers it. */
  aimed(thrower: Soldier): AimedThrow | null
}

/** The route being planned for the selected unit. */
export interface MoveAim {
  readonly waypointMode: boolean
  toggleWaypointMode(): boolean
  clear(): void
  /** A tap on `tile`; true when it started a walk. */
  handleClick(soldier: Soldier, tile: Tile, asWaypoint: boolean): boolean
  /** Called when the player confirmed a route; the session turns it into a command. */
  onMovementStarted?: (soldier: Soldier, path: Tile[]) => void
}

/** Everything the player can be lining up before committing to it. */
export interface Aiming {
  readonly shoot: ShootAim
  readonly grenade: GrenadeAim
  readonly movement: MoveAim
}

/**
 * The intents only a screen can answer: which storey is drawn, which panel is
 * open, where the camera stands, the hot-seat cover, the end screen's pages.
 * Nothing here spends a point or moves a unit.
 */
export type ViewIntent = Extract<
  HudIntent,
  {
    type:
      | 'openDebug'
      | 'toggleDebugMap'
      | 'selectLevel'
      | 'toggleFreelook'
      | 'toggleUnitView'
      | 'endScreenNext'
      | 'requestTurnSwitch'
      | 'confirmTurnSwitch'
  }
>

/** How a match ended, as the end screens need it. */
export interface Outcome {
  winner: Faction
  /** The side this window belongs to online; null where both sides share a screen. */
  viewer: Faction | null
  debriefs: Debrief<Soldier>[]
  escapees: Debrief<Soldier>[]
  /** The one of the loser's carried out alive, when someone was. */
  carried: Soldier | null
}

export interface MatchView {
  readonly aiming: Aiming
  /** The HUD's inputs changed. */
  refreshHud(): void
  /** What is painted over the ground (routes, aim, blasts) is out of date. */
  renderOverlay(): void
  /** Units moved, died or were revealed: fog and who is drawn are out of date. */
  recomputeVisibility(): void
  /** Whatever the screen held for the turn that ended (unit view, shoulder camera) goes. */
  turnSwitched(): void
  /**
   * A command the rules carried out, from any side: draw whatever is not state
   * (a throw's flight, the camera following a broken unit) and refresh.
   */
  commandApplied(command: Command, result: Carried, origin: CommandOrigin): void
  /** An intent that is the screen's alone. */
  show(intent: ViewIntent): void
  /** The match is decided. */
  matchEnded(outcome: Outcome): void
}

/** An item waiting for a patient: what the HUD shows while one is being chosen. */
export interface AimedItem {
  itemId: ItemId
  /** Squadmates the user can reach, the user included. */
  candidates: readonly Soldier[]
  /** The one picked, or null while the player is still choosing. */
  target: Soldier | null
}

/** What the HUD needs from a session besides the world itself: the state input has built up. */
export interface SessionState {
  /** Retreat has been pressed once; the next press goes. */
  retreatArmed: boolean
  /** What became of the last retreat that failed, until the next handover. */
  retreatNote: string | null
  /** The rules are still running a broken unit; nothing is offered meanwhile. */
  rulesActing: boolean
  /** The item waiting for a patient, when one is being aimed. */
  item: AimedItem | null
  networkMode: NetworkMode
  myFaction: Faction
}

/**
 * A view for a session nobody is watching: nothing is aimed, nothing is drawn.
 *
 * Built per session rather than shared, because a session wires the planner's
 * callback onto whatever aim it is given (`MatchSession.attach`).
 */
export function headlessView(): MatchView {
  return {
    aiming: {
      shoot: {
        active: false,
        selectedTarget: null,
        enter: () => false,
        exit() {},
        selectTarget() {},
        choose: () => null,
      },
      grenade: {
        active: false,
        armed: null,
        arm: () => false,
        exit() {},
        aimAt() {},
        isAimedAt: () => false,
        aimed: () => null,
      },
      movement: {
        waypointMode: false,
        toggleWaypointMode: () => false,
        clear() {},
        handleClick: () => false,
      },
    },
    refreshHud() {},
    renderOverlay() {},
    recomputeVisibility() {},
    turnSwitched() {},
    commandApplied() {},
    show() {},
    matchEnded() {},
  }
}
