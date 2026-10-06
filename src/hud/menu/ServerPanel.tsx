import { useEffect, useRef, useState } from 'react'
import { Account, type Player } from '../../game/Account'
import type { LobbyView, ServerIntent } from '../../game/Lobby'
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
 * The lobby is the server's list of rooms (`src/game/Lobby.ts`), polled while
 * the panel is up. Every way in — open, join, watch, take back a match from
 * another window — is one `onServerConnect(url, intent)`; the server decides
 * where the socket actually lands, and says so.
 */

/** How often the room list is re-asked. Rooms fill in seconds, not minutes. */
const LOBBY_POLL_MS = 2_000

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

/** What a server says about whoever is holding this page, as the panel shows it. */
interface ServerIdentity {
  /** The signed-in account, or null for an anonymous (still welcome) visitor. */
  player: Player | null
  /** False when nothing answered: there is no account to offer either way. */
  reachable: boolean
  text: string
  colour: string
}

async function identify(url: string): Promise<ServerIdentity> {
  let me: Player | null = null
  try {
    me = await new Account(url.trim()).me()
  } catch {
    return {
      player: null,
      reachable: false,
      text: 'No match server answers at that address',
      colour: MENU_COLOURS.danger,
    }
  }
  if (!me) {
    return {
      player: null,
      reachable: true,
      text: 'Not signed in — matches here are not kept',
      colour: MENU_COLOURS.muted,
    }
  }
  return {
    player: me,
    reachable: true,
    text: `Signed in as ${me.name} — your squad is kept on this server`,
    colour: MENU_COLOURS.signedIn,
  }
}

/**
 * Why the room list could not be fetched, in words a player can act on. A
 * `TypeError` is `fetch` itself failing — nothing answered — rather than a
 * server that answered with a reason.
 */
function lobbyFailure(err: unknown): string {
  if (err instanceof TypeError || !(err instanceof Error)) {
    return 'The match server stopped answering — still trying…'
  }
  return `The match server would not list its matches: ${err.message}`
}

export function ServerPanel({
  url,
  onUrlChange,
  onServerConnect,
  onBack,
}: {
  url: string
  onUrlChange: (url: string) => void
  /**
   * Connect to the server at `url` with `intent`. Resolves once the match,
   * loadout or spectator view has taken over; rejects with a player-readable
   * reason.
   */
  onServerConnect: (url: string, intent: ServerIntent) => Promise<void>
  onBack: () => void
}) {
  const [identity, setIdentity] = useState<ServerIdentity>({
    player: null,
    reachable: true,
    text: '…',
    colour: MENU_COLOURS.muted,
  })
  const [accountName, setAccountName] = useState('')
  const [status, setStatus] = useState<{ text: string; colour?: string } | null>(null)
  /**
   * The last room list and the last failure to get one, each tagged with the
   * address it was for, so a change of address hides the old server's rooms
   * at once instead of after the new server's first answer.
   */
  const [lobby, setLobby] = useState<{ url: string; view: LobbyView; at: number } | null>(null)
  const [lobbyError, setLobbyError] = useState<{ url: string; text: string } | null>(null)
  /** A connection is in flight: the ways in are disabled until it settles. */
  const [busy, setBusy] = useState(false)
  /** The takeover has been tried in this panel; a failed one is not retried every poll. */
  const resumed = useRef(false)

  const trimmed = url.trim()

  /**
   * Who this server thinks we are, re-asked whenever the address changes.
   *
   * `active` because the address is typed: every keystroke starts a request,
   * and the one that finishes last is not necessarily the one for the address
   * now in the box.
   */
  useEffect(() => {
    let active = true
    void identify(url).then((found) => {
      if (active) setIdentity(found)
    })
    return () => {
      active = false
    }
  }, [url])

  /**
   * The room list, polled while the server answers.
   *
   * Each poll is scheduled when the previous one settles rather than on a
   * fixed interval, so a slow server is never asked twice at once. Restarted
   * on a change of account as well as of address: `you` is the asking
   * player's seat, and signing in is what makes there be one. Stale answers
   * are dropped by `active`, as in the identity lookup above. A failure keeps
   * the last list up — a blip should not empty the screen — and keeps polling.
   */
  const playerId = identity.player?.id ?? null
  useEffect(() => {
    if (!identity.reachable || !trimmed) return
    let active = true
    let timer: number | undefined
    const poll = async () => {
      try {
        const view = await new Account(trimmed).lobby()
        if (!active) return
        setLobby({ url: trimmed, view, at: Date.now() })
        setLobbyError(null)
      } catch (err) {
        if (!active) return
        setLobbyError({ url: trimmed, text: lobbyFailure(err) })
      }
      if (active) timer = window.setTimeout(() => void poll(), LOBBY_POLL_MS)
    }
    void poll()
    return () => {
      active = false
      window.clearTimeout(timer)
    }
  }, [trimmed, identity.reachable, playerId])

  const view = lobby?.url === trimmed ? lobby.view : null
  const listError = lobbyError?.url === trimmed ? lobbyError.text : null
  const you = view?.you ?? null

  /**
   * Run a passkey ceremony, then ask again who we are.
   *
   * Asking rather than believing the ceremony's own answer: the session token
   * is what every later request carries, and whether it works is a question
   * only the server can settle. Asked directly rather than by re-running the
   * effect above, which the unchanged address would not do.
   */
  const ceremony = async (act: (it: Account) => Promise<unknown>) => {
    try {
      await act(new Account(trimmed))
    } catch (err) {
      setStatus({
        text: err instanceof Error ? err.message : 'That did not work.',
        colour: MENU_COLOURS.danger,
      })
    }
    setIdentity(await identify(url))
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
   * The takeover: this player's match is being played in another window, so
   * it moves here — the server closes the other window and replays the log
   * into this one. Once per panel, and never while this panel is itself
   * mid-connection (that seat is the one it is connecting).
   */
  const youPlaying = you?.phase === 'playing'
  useEffect(() => {
    if (!youPlaying || busy || resumed.current) return
    resumed.current = true
    void connect({ kind: 'resume' })
  }, [youPlaying, busy])

  /**
   * What the status line says. A connection in flight speaks first; then a
   * room list that cannot be had, because that is the more current news; then
   * whatever last went wrong; and otherwise what to do next.
   */
  let line: { text: string; colour?: string } = { text: 'Looking for matches…' }
  if (busy && status) line = status
  else if (listError) line = { text: listError, colour: MENU_COLOURS.danger }
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
          {identity.player ? (
            <MenuButton
              id="btn-passkey-signout"
              tone="neutralDark"
              size="sm"
              onClick={() => void ceremony((it) => it.signOut())}
            >
              Sign out
            </MenuButton>
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
