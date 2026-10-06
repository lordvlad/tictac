import type { Faction } from '../config'

/**
 * The lobby contract, shared by the match server and the browser.
 *
 * A match server holds many rooms. A room is one match: two seats (Blue opens
 * it, Red joins it) and any number of spectators. Which room a socket belongs
 * to, and in what role, is decided once, when it connects — by the intent in
 * its url — and stated back to it in one `seated` frame. Everything after that
 * is the same JSON-RPC conversation a match always had, scoped to the room.
 *
 * Three rules hold the whole thing together:
 *
 * - **One match per player.** A signed-in player who holds a seat in a room
 *   that is not over cannot open, join or watch anything else: whatever they
 *   asked for, they are put back in their own seat (`redirected`).
 * - **One live window per player.** A signed-in player's newest socket wins.
 *   Their previous socket, wherever it was, is told why and closed. A match
 *   already `playing` carries on in the new window, rebuilt from the log; a
 *   match still being set up (`waiting` or `deploying`) is abandoned instead,
 *   and the new window starts from the lobby. Moving a half-equipped loadout
 *   between windows is not worth what it would cost.
 * - **A seat is a socket.** Nothing a seat sends is accepted from anywhere
 *   else; a spectator sends nothing that is acted on.
 *
 * Kept free of anything that runs only on one side, so both import it.
 */

/** What a socket asks for when it connects. Encoded into its url (`intentQuery`). */
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
   * With `roomId` and `seatKey` (from this socket's own earlier `seated`):
   * the same window reconnecting after a dropped connection or a server
   * restart, signed in or not — the key is the seat's proof of ownership, so
   * no ticket is needed. Without them: a signed-in player taking their match
   * over in a new window, which is only meaningful for a match `playing`.
   * Anything else is refused with a reason.
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
 * The first frame a server sends a socket, once its `hello` has passed the
 * version gate: which room it is in and as whom.
 *
 * `faction` is null for a spectator. A seat in a room that is `playing`, and
 * every spectator of one, is sent the match's `log` (header and every intent
 * so far) straight after; a spectator of a room that starts later is sent it
 * when the room starts. A seat in a room that is still being set up proceeds
 * exactly as before: Blue announces the match (`init`), Red waits for it.
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
   * Kept by the window in memory only; a new window proves itself with a
   * ticket instead.
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

/** `GET /api/lobby`. The bearer token is optional; without one `you` is null. */
export interface LobbyView {
  rooms: LobbyRoom[]
  /** The seat the asking player holds, if any. A client seeing one takes it over (`resume`). */
  you: { roomId: string; faction: Faction; phase: RoomPhase } | null
}

/** The query string a socket url carries for `intent`, without the leading `?`/`&`. */
export function intentQuery(intent: ServerIntent): string {
  const params = new URLSearchParams({ intent: intent.kind })
  if (intent.kind === 'join' || intent.kind === 'watch') params.set('room', intent.roomId)
  if (intent.kind === 'resume' && intent.roomId && intent.seatKey) {
    params.set('room', intent.roomId)
    params.set('seat', intent.seatKey)
  }
  return params.toString()
}

/**
 * The intent a socket url states, or null for one that states none or states
 * one badly. Peer input: checked, not trusted.
 */
export function parseIntent(params: URLSearchParams): ServerIntent | null {
  const kind = params.get('intent')
  const roomId = params.get('room')
  const usable = (value: string | null): value is string => !!value && value.length > 0 && value.length <= 64
  switch (kind) {
    case 'open':
      return { kind }
    case 'resume': {
      // Both or neither: a room without its key proves nothing, and a key
      // without its room names nothing.
      const seatKey = params.get('seat')
      if (roomId === null && seatKey === null) return { kind }
      return usable(roomId) && usable(seatKey) ? { kind, roomId, seatKey } : null
    }
    case 'join':
    case 'watch':
      return usable(roomId) ? { kind, roomId } : null
    default:
      return null
  }
}
