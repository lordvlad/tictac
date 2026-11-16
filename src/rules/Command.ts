import type { DoorVerb } from '../core/Doors'
import type { GrenadeId, ShotMode } from '../core/Arsenal'
import type { ItemId } from '../core/Items'
import type { Faction } from '../config'

/**
 * Commands: things one peer asks the other to *do*, and what the rules issue
 * for a broken unit (`Breakdown`).
 *
 * Under ADR-0004 full-knowledge lockstep, only intent travels on the wire.
 * Both sides simulate deterministically from the same seeded stream. The wire
 * wraps these in the session messages around them (`wire/NetworkMessage`); they
 * live here because the rules produce them and the ECS executes them, and
 * neither may depend on the wire above.
 */
export type Command =
  | { type: 'moveUnit'; faction: Faction; squadIndex: number; path: { x: number; y: number }[] }
  | {
      type: 'fireShot'
      shooterFaction: Faction
      shooterIndex: number
      targetFaction: Faction
      targetIndex: number
      mode: ShotMode
    }
  /** `targetLevel`: the storey of the tile aimed at, so a roofed tile is a room or its roof (`throwsLow`). */
  | {
      type: 'throwGrenade'
      shooterFaction: Faction
      shooterIndex: number
      kind: GrenadeId
      targetTile: { x: number; y: number }
      targetLevel: number
    }
  | { type: 'reload'; faction: Faction; squadIndex: number }
  /** Strike an adjacent enemy with the sidearm. Intent only, like a shot. */
  | {
      type: 'meleeAttack'
      attackerFaction: Faction
      attackerIndex: number
      targetFaction: Faction
      targetIndex: number
    }
  | { type: 'toggleCover'; faction: Faction; squadIndex: number }
  /**
   * Hold fire for the other side's turn.
   *
   * An intent like any other, and notably *only* an intent: the reactions it
   * provokes are resolved by both peers from the path the mover declares, so
   * nothing about a reaction ever travels.
   */
  | { type: 'overwatch'; faction: Faction; squadIndex: number }
  | { type: 'endUnitTurn'; faction: Faction; squadIndex: number }
  // The target is optional because most uses are on the carrier: a frame with
  // no target named, or naming a unit this side cannot find, is a self-use.
  | { type: 'useItem'; faction: Faction; squadIndex: number; itemId: ItemId; targetFaction?: Faction; targetIndex?: number }
  | { type: 'endTurn'; faction: Faction }
  /**
   * The whole side tries to get out (`core/Retreat`): everyone on its way out
   * goes, everyone else is left behind. Intent only — the roll is the rules',
   * from the match's dice, on every side.
   */
  | { type: 'retreat'; faction: Faction }
  /** Work the door on `edge`, beside the unit: open, close, unlock or force it (`core/Doors`). */
  | { type: 'operateDoor'; faction: Faction; squadIndex: number; edge: number; verb: DoorVerb }
  | { type: 'rightClickFacing'; faction: Faction; squadIndex: number; x: number; z: number }

const COMMAND_TYPES: ReadonlySet<string> = new Set<Command['type']>([
  'moveUnit',
  'fireShot',
  'meleeAttack',
  'throwGrenade',
  'reload',
  'toggleCover',
  'overwatch',
  'useItem',
  'operateDoor',
  'endUnitTurn',
  'endTurn',
  'retreat',
  'rightClickFacing',
])

/** Whether a wire message is a command rather than session or diagnosis. */
export function isCommand(message: { type: string }): message is Command {
  return COMMAND_TYPES.has(message.type)
}
