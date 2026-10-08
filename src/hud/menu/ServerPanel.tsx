import { useEffect, useReducer, useRef, useState } from 'react'
import { Account } from '../../game/Account'
import type { LobbyView, ServerIntent } from '../../game/Lobby'
import type { ServerConnection } from '../../game/ServerConnection'
import {
  MENU_COLOURS,
  MenuButton,
  MenuInput,
  PanelTitle,
  StatusLine,
} from './controls'
import { LobbyList } from './LobbyList'

/**
 * Playing on a match server, and the account that makes it worth doing.
 *
 * Signing in is not a separate feature from playing here: a match on a server
 * nobody is signed in to is watched and written down exactly the same, it is
 * simply not kept on anybody's roster. So the passkey ceremony and the lobby
 * share one panel, and the status line above them says which of the two the
 * next match will be.
 *
 * Everything on it travels over the window's one connection to the server
 * (`ServerConnection`): who this window is, the room list — pushed by the
 * server as it changes, never polled — and every way in, which is one
 * `onServerConnect(url, intent)`; the server decides where the window
 * actually lands, and says so.
 */

/**
 * How long a typed address has to stand still before a connection is opened
 * to it: every keystroke is an address, and only the last one is meant.
 */
const ADDRESS_SETTLE_MS = 400

/** What the status line says while each kind of connection is in flight. */
const WAITING: Record<ServerIntent['kind'], string> = {
  open: 'Waiting for an opponent to join…',
  join: 'Joining…',
  watch: 'Connecting to watch…',
  resume: 'Your match is open in another window — continuing it here…',
}

/** And what it says when one fails without a reason of its own. */
const FAILURE: Record<ServerIntent['kind'], string> = {
  open: 'Could not open a match there.',
  join: 'Could not join that match.',
  watch: 'Could not watch that match.',
  resume: 'Could not continue your match here.',
}

/** What the connection says about whoever is holding this page, as the panel shows it. */
interface ServerIdentity {
  /** Signed in: the passkey row offers signing out. */
  signedIn: boolean
  /** False when there is no server to talk to: there is no account to offer either way. */
  reachable: boolean
  text: string
  colour: string
}

function identify(connection: ServerConnection | null): ServerIdentity {
  const state = connection?.state ?? { kind: 'connecting' as const }
  switch (state.kind) {
    case 'connecting':
      return { signedIn: false, reachable: true, text: '…', colour: MENU_COLOURS.muted }
    case 'closed':
      return { signedIn: false, reachable: false, text: state.reason, colour: MENU_COLOURS.danger }
    case 'reconnecting':
      return {
        signedIn: false,
        reachable: true,
        text: 'The match server stopped answering — still trying…',
        colour: MENU_COLOURS.warning,
      }
  }
  const player = connection!.player
  if (player) {
    return {
      signedIn: true,
      reachable: true,
      text: `Signed in as ${player.name} — your squad is kept on this server`,
      colour: MENU_COLOURS.signedIn,
    }
  }
  const refused = connection!.signInRefused
  if (refused) return { signedIn: false, reachable: true, text: refused, colour: MENU_COLOURS.warning }
  return {
    signedIn: false,
    reachable: true,
    text: 'Not signed in — matches here are not kept',
    colour: MENU_COLOURS.muted,
  }
}

export function ServerPanel({
  url,
  onUrlChange,
  connectionFor,
  onServerConnect,
  onOpenMap,
  onBack,
}: {
  url: string
  onUrlChange: (url: string) => void
  /** The window's connection to the server at an address (`main.tsx`). */
  connectionFor: (url: string) => ServerConnection
  /**
   * Connect to the server at `url` with `intent`. Resolves once the match,
   * loadout or spectator view has taken over; rejects with a player-readable
   * reason.
   */
  onServerConnect: (url: string, intent: ServerIntent) => Promise<void>
  /** Open the world map on the server at `url`; resolves once the player closes it. */
  onOpenMap: (url: string) => Promise<void>
  onBack: () => void
}) {
  const [connection, setConnection] = useState<ServerConnection | null>(null)
  /** Redraw on every change of the connection's state or of who it is signed in as. */
  const [, redraw] = useReducer((n: number) => n + 1, 0)
  const [accountName, setAccountName] = useState('')
  const [status, setStatus] = useState<{ text: string; colour?: string } | null>(null)
  /** The room list as last pushed, and when — the rooms' ages are counted from it. */
  const [lobby, setLobby] = useState<{ view: LobbyView; at: number } | null>(null)
  /** A connection is in flight: the ways in are disabled until it settles. */
  const [busy, setBusy] = useState(false)
  /** The takeover has been tried in this panel; a failed one is not retried on every push. */
  const resumed = useRef(false)

  const trimmed = url.trim()

  /**
   * The connection to the address in the box, once it has stood still. The
   * window keeps one connection (`connectionFor`): coming back to this panel
   * without a page load — a room refused, a match aborted — finds it still
   * open, and only a different address replaces it.
   */
  useEffect(() => {
    if (!trimmed) {
      setConnection(null)
      return
    }
    const timer = window.setTimeout(() => setConnection(connectionFor(trimmed)), ADDRESS_SETTLE_MS)
    return () => window.clearTimeout(timer)
  }, [trimmed, connectionFor])

  useEffect(() => connection?.onChange(redraw), [connection])

  /**
   * The room list, as the server pushes it. A new connection shows nothing
   * of the old one's rooms: they were another server's.
   */
  useEffect(() => {
    setLobby(null)
    if (!connection) return
    return connection.watchLobby((view) => setLobby({ view, at: Date.now() }))
  }, [connection])

  const identity = identify(connection)
  const view = lobby?.view ?? null
  const you = view?.you ?? null

  /**
   * Run a passkey ceremony. Who the window then is comes from the
   * connection, which the ceremony's answer has already told.
   */
  const ceremony = async (act: (it: Account) => Promise<unknown>) => {
    if (!connection) return
    try {
      await act(new Account(connection))
      setStatus(null)
    } catch (err) {
      setStatus({
        text: err instanceof Error ? err.message : 'That did not work.',
        colour: MENU_COLOURS.danger,
      })
    }
  }

  /**
   * Every way into a room. The address is remembered on the way in rather
   * than as it is typed, so a half-typed one is never what comes back.
   */
  const connect = async (intent: ServerIntent) => {
    if (!trimmed) {
      setStatus({ text: 'Type a match server address first.', colour: MENU_COLOURS.danger })
      return
    }
    localStorage.setItem('tictac.server', trimmed)
    setBusy(true)
    setStatus({ text: WAITING[intent.kind], colour: MENU_COLOURS.accent })
    try {
      await onServerConnect(trimmed, intent)
    } catch (err) {
      setStatus({
        text: err instanceof Error && err.message.length > 0 ? err.message : FAILURE[intent.kind],
        colour: MENU_COLOURS.danger,
      })
    } finally {
      setBusy(false)
    }
  }

  /**
   * The takeover: this player's match is being played and no window holds
   * it — signing in here replaced the one that did — so it continues here,
   * rebuilt from the log. Once per panel, and never while this panel is
   * itself mid-connection (that seat is the one it is connecting).
   */
  const youPlaying = you?.phase === 'playing'
  useEffect(() => {
    if (!youPlaying || busy || resumed.current) return
    resumed.current = true
    void connect({ kind: 'resume' })
  }, [youPlaying, busy])

  /**
   * What the status line says. A connection in flight speaks first; then
   * whatever last went wrong; and otherwise what to do next.
   */
  let line: { text: string; colour?: string } = { text: 'Looking for matches…' }
  if (busy && status) line = status
  else if (status) line = status
  else if (!identity.reachable) line = { text: 'Run one with bun run serve:match.' }
  else if (view) line = { text: 'Open a match, or join or watch one below.' }

  return (
    <div id="menu-details" style={{ marginTop: 20 }}>
      <PanelTitle text="Play on a Match Server" tone="server" />
      <MenuInput
        id="server-url"
        value={url}
        onChange={onUrlChange}
        placeholder="wss://your-match-server/ — leave blank to look for one at this address"
      />
      <p id="account-status" style={{ fontSize: 12, color: identity.colour, margin: '8px 0' }}>
        {identity.text}
      </p>

      {identity.reachable && (
        <div
          id="account-actions"
          // A column, because three things abreast squeezed both button
          // labels onto three lines each: the name belongs to the passkey
          // being created, so it sits above both ways of presenting one.
          style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 12 }}
        >
          {identity.signedIn ? (
            <div style={{ display: 'flex', gap: 8 }}>
              <MenuButton
                id="btn-open-map"
                tone="serverDeep"
                size="sm"
                grow
                disabled={busy}
                onClick={() => void onOpenMap(trimmed)}
              >
                Open the Map
              </MenuButton>
              <MenuButton
                id="btn-passkey-signout"
                tone="neutralDark"
                size="sm"
                onClick={() => void ceremony((it) => it.signOut())}
              >
                Sign out
              </MenuButton>
            </div>
          ) : (
            <>
              <MenuInput
                id="account-name"
                maxLength={24}
                value={accountName}
                placeholder="Name for a new passkey"
                onChange={setAccountName}
              />
              <div style={{ display: 'flex', gap: 8 }}>
                <MenuButton
                  id="btn-passkey-create"
                  tone="serverDeep"
                  size="sm"
                  grow
                  onClick={() => void ceremony((it) => it.register(accountName.trim()))}
                >
                  Create passkey
                </MenuButton>
                <MenuButton
                  id="btn-passkey-signin"
                  tone="neutralDark"
                  size="sm"
                  grow
                  onClick={() => void ceremony((it) => it.signIn())}
                >
                  Sign in with passkey
                </MenuButton>
              </div>
            </>
          )}
        </div>
      )}

      {/*
        The server abandons a match still being set up the moment this
        player's newest window asks for anything; this only says so first.
        Not while this panel is connecting, because then that match is this
        window's own.
      */}
      {!busy && (you?.phase === 'waiting' || you?.phase === 'deploying') && (
        <p id="lobby-warning" style={{ fontSize: 12, color: MENU_COLOURS.warning, margin: '0 0 8px 0' }}>
          You have a match being set up in another window. Opening, joining or watching here
          abandons it.
        </p>
      )}

      <div style={{ display: 'flex', gap: 8 }}>
        <MenuButton
          id="btn-server-open"
          tone="serverDeep"
          grow
          disabled={busy}
          onClick={() => void connect({ kind: 'open' })}
        >
          Open a Match
        </MenuButton>
        <MenuButton id="btn-server-back" tone="neutral" onClick={onBack}>
          Back
        </MenuButton>
      </div>
      <StatusLine id="server-status" text={line.text} colour={line.colour} />

      {view && (
        <LobbyList
          view={view}
          now={lobby?.at ?? 0}
          busy={busy}
          onJoin={(roomId) => void connect({ kind: 'join', roomId })}
          onWatch={(roomId) => void connect({ kind: 'watch', roomId })}
        />
      )}
    </div>
  )
}
