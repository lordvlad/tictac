import type { LatLng } from '../core/Travel'

/**
 * What an encounter on the road is, on the wire (`ITEM-048`, GDD-WORLD §5).
 *
 * Only what a window is told or shown lives here; the server's own
 * machinery (the roll, the room, the AI seat) is in `src/core/Encounters.ts`
 * and `src/server/`.
 */

/**
 * Whose a side is. `human`: a player's squad, kept on the roster. `ai`: the
 * game's own, rolled for the fight and written nowhere. This is whose squad
 * it *is* — it is stated in the match's header (`RecordingHeader.controllers`)
 * and never changes; who is moving it at a given moment is `SeatControl`.
 */
export type Controller = 'human' | 'ai'

/**
 * Who moves a seat now, as its own player is told (`LobbyView.you`).
 *
 * - `player`: this player's window holds it, or may take it back with its key.
 * - `reserved`: the server kept it for a player who has not arrived; they
 *   can take it until `joinBy`, and the AI plays it after.
 * - `ai`: the AI is playing it. It is not the player's to take any more.
 */
export type SeatControl = 'player' | 'reserved' | 'ai'

/**
 * Pushed (`tictac/api/encounter/started`) to a signed-in player's window when
 * something finds their squad and they are online: take the fight with
 * `room/enter { kind: 'resume', roomId }` before `joinBy`.
 */
export interface EncounterStarted {
  roomId: string
  /** The server's clock (`clock/now`), in ms: after this the AI plays the seat. */
  joinBy: number
  /** When the contact happened. */
  at: number
  place: LatLng
}

/** How an encounter ended for the player, as the return feed tells it. */
export type EncounterResult = 'inProgress' | 'won' | 'lost' | 'passedBy'

/** Why an encounter did not become a fight. */
export type PassedFor = 'nobodyFit' | 'busy'

/** One line of the return feed (`tictac/api/encounter/feed`), newest first. */
export interface EncounterEntry {
  id: string
  /** The server's clock, in ms: when the squad was found. */
  at: number
  place: LatLng
  result: EncounterResult
  /** Why there was no fight, when `result` is `passedBy`. */
  passedFor: PassedFor | null
  /** Who played the player's side; null when there was no fight. */
  playedBy: 'you' | 'ai' | null
  /** The match, to watch back (`tictac/api/match/recording`); null when there was no fight. */
  matchId: string | null
  /** How many aliens it was. */
  aliens: number
}
