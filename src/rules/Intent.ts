import type { DoorVerb } from '../core/Doors'
import type { GrenadeId, ShotMode } from '../core/Arsenal'
import type { Tile } from '../core/Grid'
import type { ItemId } from '../core/Items'

/**
 * Everything the player can ask for by touching the HUD. The HUD emits these;
 * it never carries them out, so game state has exactly one mutator.
 *
 * An intent is a *wish*, not a command: it may be refused by the turn gate,
 * ignored because nothing is selected, or only change what is on screen.
 * What it becomes, if anything, is a `Command` (`rules/Command`) — the thing
 * both peers apply.
 */
export type HudIntent =
  | { type: 'selectUnit'; index: number }
  | { type: 'shoot' }
  | { type: 'cancelShoot' }
  | { type: 'selectTarget'; index: number }
  | { type: 'fireShot'; mode: ShotMode }
  /** The sidearm blow at the target being aimed at; offered only in reach. */
  | { type: 'meleeAttack' }
  /** Start aiming a blow at the best enemy in reach. */
  | { type: 'strike' }
  | { type: 'reload' }
  | { type: 'armGrenade'; kind: GrenadeId }
  | { type: 'useItem'; itemId: ItemId }
  | { type: 'confirmItem' }
  | { type: 'cancelItem' }
  | { type: 'confirmThrow' }
  | { type: 'cancelGrenade' }
  | { type: 'toggleCover' }
  | { type: 'overwatch' }
  | { type: 'toggleWaypoints' }
  | { type: 'endUnitTurn' }
  | { type: 'requestTurnSwitch' }
  | { type: 'confirmTurnSwitch' }
  /** Arm the side's retreat: the next press confirms it (`core/Retreat`). */
  | { type: 'requestRetreat' }
  /** Retreat now, with whoever is on the way out. */
  | { type: 'confirmRetreat' }
  | { type: 'toggleFreelook' }
  | { type: 'toggleUnitView' }
  | { type: 'openDebug' }
  | { type: 'selectLevel'; level: number }
  | { type: 'toggleDebugMap' }
  /** Work the door the selected unit is facing (`core/Doors`). */
  | { type: 'operateDoor'; verb: DoorVerb }
  /** The end screen's next page: from the loser's to the winner's, in a local match. */
  | { type: 'endScreenNext' }
  /** Leave a finished match for the start menu. */
  | { type: 'backToMenu' }

/**
 * What a press on the field itself asks for, once the canvas has worked out what
 * is under the pointer.
 *
 * Kept apart from {@link HudIntent} because a press on the field is not a press
 * on a button: it is not an answer to a retreat prompt, and which of its
 * readings applies (select, aim, walk) depends on the mode the match is in —
 * which only the session knows. Squads are named by index, as the HUD names
 * them, so the picking layer never hands the session an object from the scene.
 */
export type PointerIntent =
  /** A tap or click: the tile under it, and the soldiers of either side standing there. */
  | {
      type: 'tap'
      tile: Tile | null
      /** The living, visible soldier of the side whose turn it is, if one is under the pointer. */
      friendly: number | null
      /** The same, of the side waiting. */
      enemy: number | null
      /** Shift was held: a waypoint rather than a destination. */
      additive: boolean
    }
  /** A right-click that was not a drag: turn the selected unit towards this point. */
  | { type: 'face'; x: number; z: number }
