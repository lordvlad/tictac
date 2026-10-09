import type { Faction } from '../config'

/**
 * The lobby contract, shared by the match server and the browser.
 *
 * A match server holds many rooms. A room is one match: two seats (Blue opens
 * it, Red joins it) and any number of spectators. Which room a window is in,
 * and in what role, is decided when it asks (`room/enter`, `src/game/Rpc.ts`)
 * and stated back in the answer (`Seated`). Everything after that is the same
 * JSON-RPC conversation a match always had, scoped to the room, on the same
 * socket — which outlives the room: leaving one is not hanging up.
 *
 * Three rules hold the whole thing together:
 *
 * - **One match per player.** A signed-in player who holds a seat in a room
 *   that is not over cannot open, join or watch anything else: whatever they
 *   asked for, they are put back in their own seat (`redirected`).
 * - **One live window per player.** A signed-in player's newest socket wins:
 *   signing in on it replaces the previous one, which is told why and closed,
 *   and whose seat is held for the grace. A match already `playing` carries
 *   on in the new window, rebuilt from the log; a match still being set up
 *   (`waiting` or `deploying`) is abandoned once the new window enters
 *   anywhere other than by that seat's key. Moving a half-equipped loadout
 *   between windows is not worth what it would cost.
 * - **A seat is a socket.** Nothing a seat sends is accepted from anywhere
 *   else; a spectator sends nothing that is acted on.
 *
 * Kept free of anything that runs only on one side, so both import it.
 */

/** What a window asks for when it enters a room (`room/enter`). */
export type ServerIntent =
  /** Open a new room and take its Blue seat. */
  | { kind: 'open' }
  /** Take the Red seat of a room that is waiting for an opponent. */
  | { kind: 'join'; roomId: string }
  /** Watch a room without a seat. */
  | { kind: 'watch'; roomId: string }
  /**
   * Take a seat back.
   *
   * With `roomId` and `seatKey` (from this window's own earlier seat): the
   * same window reconnecting after a dropped connection or a server restart,
   * signed in or not — the key is the seat's proof of ownership. Without
   * them: a signed-in player taking their match over in a new window, which
   * is only meaningful for a match `playing`. Anything else is refused with
   * a reason.
   */
  | { kind: 'resume'; roomId?: string; seatKey?: string }

/**
 * Where a room is in its life.
 *
 * `waiting`: Blue is seated, nobody has joined. `deploying`: both seats are
 * taken and the loadout screens are up. `playing`: the host has stated the
 * opening position (`matchHeader`) and intents are being refereed. A room
 * that is over (settled or aborted) is no longer listed.
 */
export type RoomPhase = 'waiting' | 'deploying' | 'playing'

/**
 * Where the server put a window (`room/enter`): which room it is in and as
 * whom.
 *
 * `faction` is null for a spectator. A seat in a room that is `playing`, and
 * every spectator of one, is sent the match's `log` (header and every intent
 * so far) straight after the answer; a spectator of a room that starts later
 * is sent it when the room starts. A seat in a room that is still being set
 * up proceeds exactly as before: Blue announces the match (`init`), Red
 * waits for it.
 */
export interface Seated {
  roomId: string
  faction: Faction | null
  phase: RoomPhase
  /**
   * True when the server put this socket somewhere other than it asked,
   * because the player already holds a seat elsewhere — so the client can
   * say why it is in a match it did not just choose.
   */
  redirected: boolean
  /**
   * The secret that takes this seat back (`resume` with `roomId`), or null
   * for a spectator, who has no seat to take back and simply watches again.
   * Kept by the window in memory only; a new window proves itself by
   * signing in instead.
   */
  seatKey: string | null
}

/** A seat as the lobby shows it. */
export interface LobbySeat {
  /** The player's name, or null for an anonymous player. */
  name: string | null
  /** False while a signed-in player's seat is held open for them to come back. */
  connected: boolean
}

import type { SeatControl } from './Encounter'

export interface LobbyRoom {
  id: string
  phase: RoomPhase
  blue: LobbySeat
  /** Null while the room is waiting for somebody to join. */
  red: LobbySeat | null
  spectators: number
  /** The turn in force, once the match is playing. */
  turn: number | null
  createdAt: string
}

/** The rooms as a window is shown them (`lobby/subscribe`, then every `lobby/changed`); `you` is null for an anonymous socket. */
export interface LobbyView {
  rooms: LobbyRoom[]
  /**
   * The seat the asking player holds, if any. A client seeing one takes it
   * over (`resume`) — unless `control` says it is not theirs to take: the AI
   * has it (`ai`), or the server is still keeping it for them to decide
   * (`reserved`, until `joinBy`; `encounter/started` is what asks them).
   */
  you: {
    roomId: string
    faction: Faction
    phase: RoomPhase
    control: SeatControl
    /** The server's clock, in ms, when a `reserved` seat passes to the AI; null otherwise. */
    joinBy: number | null
  } | null
}
