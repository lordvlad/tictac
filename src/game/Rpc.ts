import type { CharacterSheet } from '../core/Characters'
import type { Waypoint } from '../core/Travel'
import type { LobbyView, Seated, ServerIntent } from './Lobby'

/**
 * Everything a window asks a match server, over the one socket it holds
 * (`ITEM-060`).
 *
 * A window opens one WebSocket to its match server and keeps it: signing in,
 * the roster, the lobby, taking a seat and the squad's place on the map travel over it
 * as JSON-RPC 2.0. A *request* (`id` set) is answered by exactly one response;
 * a *notification* (no `id`) is the server telling the window something it did
 * not ask for — the lobby changed, the window was replaced. The match itself
 * keeps its own notifications (`RpcMethods` in `JsonRpc.ts`) on the same
 * socket, untouched. Only static assets — the built client and the map's
 * tiles (`/tiles/{z}/{x}/{y}.mvt`) — are plain HTTP.
 *
 * Why one socket rather than HTTP beside it: the window already is a socket
 * as far as the one-window-per-player rule is concerned, and a second channel
 * meant a ticket to bridge them, a CORS policy to keep, and a lobby that had
 * to be polled because HTTP cannot push.
 *
 * ## The order of things on a fresh socket
 *
 * 1. The window's first frame is the `hello` notification with its
 *    `PeerVersion`, exactly as before; the server version-gates it and, on a
 *    refusal, sends `abort` and closes. A request that arrives before a
 *    `hello` has passed is answered with `RPC_ERRORS.helloFirst`.
 * 2. Then any request, in any order. A signed-in window calls
 *    `account/signIn` with its stored token first, which is what binds the
 *    socket to a player — and what replaces a previous window of that player
 *    (`SESSION_REPLACED`).
 * 3. A window reconnecting after a drop does the same, then re-subscribes to
 *    the lobby if it was subscribed, and re-enters its room with
 *    `room/enter { kind: 'resume', roomId, seatKey }` if it held a seat (a
 *    spectator: `watch`).
 *
 * Kept free of anything that runs only on one side, so both import it.
 */

/** The player behind a session, as both sides name them. */
export interface Player {
  id: string
  name: string
}

/** A squad on the world map, as a window is shown it (GDD-WORLD §2). */
export interface Squad {
  id: string
  waypoints: Waypoint[]
}

/**
 * One character on a kept roster, as a window sees it: enough to show and to
 * pick from (`[ITEM-042]`), never the combat log or growth a player cannot
 * act on here.
 */
export interface RosterEntry {
  characterId: string
  slot: number
  sheet: CharacterSheet
  hp: number
  /** Consecutive deployments without rest, `0..FATIGUE.max` (`[ITEM-039]`). */
  fatigue: number
  /** Matches of medical bay left before this member can be picked again. */
  downtime: number
}

/** What the browser needs to run a passkey ceremony, and the id of the challenge it answers. */
export interface PasskeyOptions {
  challengeId: string
  publicKey: Record<string, unknown>
}

/** A created passkey, every binary field base64url. */
export interface PasskeyCreated {
  challengeId: string
  credentialId: string
  clientDataJSON: string
  authenticatorData: string
  /** SPKI, from `getPublicKey()`. */
  publicKey: string
  publicKeyAlgorithm: number
}

/** A passkey assertion, every binary field base64url. */
export interface PasskeyAsserted {
  challengeId: string
  credentialId: string
  clientDataJSON: string
  authenticatorData: string
  signature: string
}

/**
 * A session token and who it belongs to. The window stores the token (keyed
 * by server, as before) and presents it with `account/signIn` on every
 * socket it opens; it never travels in a url.
 */
export interface SignedIn {
  token: string
  player: Player
}

/** Requests a window may make: method → its params and its result. */
export interface RpcApi {
  'tictac/api/account/registerOptions': { params: { name: string }; result: PasskeyOptions }
  /**
   * Make a player, a squad and a session, and bind this socket to them — as
   * `account/signIn` would. The server reads where the connection came from
   * (`request.cf` on Cloudflare) off the socket it arrived on, never off the
   * params.
   */
  'tictac/api/account/registerVerify': { params: PasskeyCreated; result: SignedIn }
  'tictac/api/account/loginOptions': { params: Record<string, never>; result: PasskeyOptions }
  /** Start a session and bind this socket to it, as `account/signIn` would. */
  'tictac/api/account/loginVerify': { params: PasskeyAsserted; result: SignedIn }
  /**
   * Bind this socket to the player a stored token names. Refused with
   * `RPC_ERRORS.signInFirst` for a token the server no longer honours — the
   * window then forgets it — and with `RPC_ERRORS.conflict` when the player's
   * seat in a match being played is in a room this page's build cannot carry
   * on, so a newer tab cannot cut off the window that can finish it. Any
   * other socket already bound to that player is sent `SESSION_REPLACED` and
   * closed, and a seat it held is *held* for its grace, in every phase: the
   * same window reconnecting signs in before it re-enters by its seat key, so
   * signing in cannot be what abandons a room. A room still being set up is
   * abandoned only when this window enters a room other than by that seat's
   * key, or when the hold runs out (`ITEM-058`/`ITEM-059`).
   */
  'tictac/api/account/signIn': { params: { token: string }; result: { player: Player } }
  /** End the session: the token is revoked and this socket is anonymous again. */
  'tictac/api/account/signOut': { params: Record<string, never>; result: null }
  /** Who this socket is bound to, if anybody. */
  'tictac/api/account/me': { params: Record<string, never>; result: { player: Player | null } }
  'tictac/api/roster/list': { params: Record<string, never>; result: { roster: RosterEntry[] } }
  'tictac/api/roster/recruit': { params: Record<string, never>; result: { member: RosterEntry } }
  /**
   * This player's squad on the world map: its waypoint list, from which
   * `positionAt` (`src/core/Travel.ts`) gives where it is at any moment. A
   * player registered before squads existed is placed on first asking, near
   * where this socket's connection was placed.
   */
  'tictac/api/squad/get': { params: Record<string, never>; result: { squad: Squad } }
  /**
   * The lobby now, and `tictac/api/lobby/changed` with the whole view
   * whenever it changes until `lobby/unsubscribe` (or the socket closes).
   * `you` is this socket's player's own seat. Open to anonymous sockets.
   */
  'tictac/api/lobby/subscribe': { params: Record<string, never>; result: LobbyView }
  'tictac/api/lobby/unsubscribe': { params: Record<string, never>; result: null }
  /**
   * Take a seat or a spectator's place (`src/game/Lobby.ts` for what each
   * intent means and the rules that redirect or refuse it). The answer is
   * where the server put this socket; a seat in a match being played, and a
   * spectator of one, are then sent the match's `log` notification, and the
   * match runs over this socket as it always has. Refusals are errors with
   * the player-readable reasons the lobby already gives.
   */
  'tictac/api/room/enter': { params: { intent: ServerIntent }; result: Seated }
  /**
   * Stand up from the room this socket is in: a spectator leaving, or a
   * window done with a match that is over. Leaving a seat in a match still
   * being played or set up is the same as the socket dropping — the seat is
   * held for its grace.
   */
  'tictac/api/room/leave': { params: Record<string, never>; result: null }
}

export type RpcMethod = keyof RpcApi
export type RpcParams<M extends RpcMethod> = RpcApi[M]['params']
export type RpcResult<M extends RpcMethod> = RpcApi[M]['result']

/** Notifications the server sends without being asked. */
export interface RpcPushes {
  /** The whole lobby view, to a socket subscribed to it, whenever it changes. */
  'tictac/api/lobby/changed': LobbyView
  /**
   * This window has been replaced by a newer one of the same player, and its
   * socket is about to close. The window must not reconnect: its player is
   * playing somewhere else now.
   */
  'tictac/api/session/replaced': { reason: string }
}

export type RpcPush = keyof RpcPushes

/** Sent with `session/replaced`. */
export const SESSION_REPLACED = 'You opened TicTac in another window; this one was disconnected.'

/**
 * Error codes a response can carry.
 *
 * The JSON-RPC ones for a malformed exchange, and HTTP-shaped ones for what
 * the old routes answered — so a reason that used to be a 401 is still a 401.
 * The `message` is always one a player can read; anything internal is
 * `serverFailed` with no detail.
 */
export const RPC_ERRORS = {
  parse: -32700,
  invalidRequest: -32600,
  noSuchMethod: -32601,
  invalidParams: -32602,
  /** A request before the version gate. */
  helloFirst: 425,
  badInput: 400,
  signInFirst: 401,
  notYours: 403,
  gone: 410,
  conflict: 409,
  serverFailed: 500,
} as const

export type RpcErrorCode = (typeof RPC_ERRORS)[keyof typeof RPC_ERRORS]
