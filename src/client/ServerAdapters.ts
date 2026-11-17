import { Account } from '../game/Account'
import type { ServerConnection } from '../game/ServerConnection'
import type { EncounterFeedPort, EncounterPromptPort, MapPort, ServerPanelPort, ServerState } from '../hud/ServerPorts'
import { parseRecording } from '../wire/Recording'

/**
 * The window's connection to the match server, cut into the views each screen
 * is given (`hud/ServerPorts`).
 *
 * The one place the HUD's idea of "the squad", "the feed" and "who I am" meets
 * the RPC methods and the connection's state; `main.tsx` builds it with the
 * connection and hands the parts to the screens, which import neither.
 */
export interface ServerPorts {
  panel: ServerPanelPort
  map: MapPort
  prompt: EncounterPromptPort
}

/** Run `listener` each time the connection goes from not open to open: a socket that came back from a drop. */
function whenReopened(connection: ServerConnection, listener: () => void): () => void {
  let wasOpen = connection.state.kind === 'open'
  return connection.onChange(() => {
    const open = connection.state.kind === 'open'
    if (open && !wasOpen) listener()
    wasOpen = open
  })
}

export function serverPortsOver(connection: ServerConnection): ServerPorts {
  const account = new Account(connection)

  const feed: EncounterFeedPort = {
    get url() {
      return connection.url
    },
    now: () => connection.now(),
    feed: async () => (await connection.request('tictac/api/encounter/feed', {})).entries,
    // Read as a file is, so a build that cannot play this version says so rather than failing silently.
    recording: async (matchId) => parseRecording((await connection.request('tictac/api/match/recording', { matchId })).recording),
    onStale(listener) {
      const stops = [
        connection.watchSquad(listener),
        connection.watchEncounters(listener),
        whenReopened(connection, listener),
      ]
      return () => stops.forEach((stop) => stop())
    },
  }

  const map: MapPort = {
    get url() {
      return connection.url
    },
    now: () => connection.now(),
    squad: async () => (await connection.request('tictac/api/squad/get', {})).squad,
    onSquadChanged: (listener) => connection.watchSquad(({ squad }) => listener(squad)),
    onReopened: (listener) => whenReopened(connection, listener),
    reconnecting: () => connection.state.kind === 'reconnecting',
    stand: async (order) => (await connection.request('tictac/api/squad/standing', { order })).squad,
    order: async (order) => (await connection.request('tictac/api/squad/order', { order })).squad,
    feed,
  }

  const prompt: EncounterPromptPort = {
    get url() {
      return connection.url
    },
    now: () => connection.now(),
    onLobby: (listener) => connection.watchLobby(listener),
    onEncounter: (listener) => connection.watchEncounters(listener),
  }

  const panel: ServerPanelPort = {
    state(): ServerState {
      const { state } = connection
      if (state.kind !== 'open') return state
      return { kind: 'open', player: connection.player, signInRefused: connection.signInRefused }
    },
    onChange: (listener) => connection.onChange(listener),
    onLobby: (listener) => connection.watchLobby(listener),
    register: (name) => account.register(name),
    signIn: () => account.signIn(),
    signOut: () => account.signOut(),
  }

  return { panel, map, prompt }
}
