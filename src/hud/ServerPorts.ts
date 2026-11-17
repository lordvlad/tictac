import type { EncounterEntry, EncounterStarted } from '../wire/Encounter'
import type { LobbyView } from '../wire/Lobby'
import type { CombatRecording } from '../wire/Recording'
import type { Squad, SquadOrder, StandingOrder } from '../wire/Rpc'

/**
 * What the screens that talk to a match server need of it, and no more.
 *
 * The HUD never imports the connection (`game/ServerConnection`): `main.tsx`
 * builds these over the window's one connection and hands them in, so a screen
 * names what it wants to know ("the squad", "the feed") rather than an RPC
 * method, and a test gives it a stub of a handful of functions instead of a
 * socket. Every `on…` returns what stops it listening.
 */

/** The server's own clock and address, which every server-backed screen counts time and remembers things by. */
export interface ServerClock {
  readonly url: string
  /** The server's time now, as well as this window can tell. */
  now(): number
}

/** "While you were away": the return feed under the map. */
export interface EncounterFeedPort extends ServerClock {
  /** The feed as the server holds it, newest first; rejects with a reason a player can read. */
  feed(): Promise<EncounterEntry[]>
  /** A fight to play back, read as a recording file is; rejects with why it cannot be played. */
  recording(matchId: string): Promise<CombatRecording>
  /**
   * The feed may have a new line: the squad or an encounter was pushed, or the
   * socket came back from a drop (what happened meanwhile was pushed to nobody).
   */
  onStale(listener: () => void): () => void
}

/** The world map: the squad on the planet, and the orders that send it. */
export interface MapPort extends ServerClock {
  /** The squad's route as the server has it. */
  squad(): Promise<Squad>
  /** A new route was pushed: an order from any of the player's windows, or an arrival. */
  onSquadChanged(listener: (squad: Squad) => void): () => void
  /** The socket came back after a drop, so a route pushed meanwhile was missed and wants asking for. */
  onReopened(listener: () => void): () => void
  /** The socket has dropped and the window is trying to get back. */
  reconnecting(): boolean
  /** Set what the squad does when it is found; answers with the route that results. */
  stand(order: StandingOrder): Promise<Squad>
  /** Send the squad; answers with the route that results. */
  order(order: SquadOrder): Promise<Squad>
  readonly feed: EncounterFeedPort
}

/** The question a fight on the road asks: what it needs to hear, and the clock it counts down on. */
export interface EncounterPromptPort extends ServerClock {
  /** The room list changed; `you` is how a window that connected after the push learns of a fight. */
  onLobby(listener: (view: LobbyView) => void): () => void
  /** Something found the squad and a fight is the player's to take. */
  onEncounter(listener: (started: EncounterStarted) => void): () => void
}

/** Where the window stands with the server, as the panel words it. */
export type ServerState =
  /** The window's first socket, on its way to being open. */
  | { kind: 'connecting' }
  /** Open; `player` is who the window is signed in as, or why the stored sign-in was refused. */
  | { kind: 'open'; player: { name: string } | null; signInRefused: string | null }
  /** The socket dropped; this is try `attempt` at getting back. */
  | { kind: 'reconnecting'; attempt: number }
  /** For good, and why. */
  | { kind: 'closed'; reason: string }

/** The panel for playing on a match server: who the window is, the rooms, and the passkey ceremonies. */
export interface ServerPanelPort {
  state(): ServerState
  /** The state changed, or who the window is signed in as did. */
  onChange(listener: () => void): () => void
  /** The room list, as the server pushes it. */
  onLobby(listener: (view: LobbyView) => void): () => void
  /** Make a passkey, and with it a player and a squad on this server. */
  register(name: string): Promise<unknown>
  signIn(): Promise<unknown>
  signOut(): Promise<unknown>
}
