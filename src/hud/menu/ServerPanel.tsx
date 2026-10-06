import { useEffect, useState } from 'react'
import { Account, type Player } from '../../game/Account'
import {
  MENU_COLOURS,
  MenuButton,
  MenuInput,
  PanelTitle,
  StatusLine,
} from './controls'

/**
 * Playing on a match server, and the account that makes it worth doing.
 *
 * Signing in is not a separate feature from playing here: a match on a server
 * nobody is signed in to is watched and written down exactly the same, it is
 * simply not kept on anybody's roster. So the passkey ceremony and the two
 * ways into a match share one panel, and the status line above them says
 * which of the two the next match will be.
 */

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

export function ServerPanel({
  url,
  onUrlChange,
  onHost,
  onJoin,
  onBack,
}: {
  url: string
  onUrlChange: (url: string) => void
  onHost: (url: string) => Promise<void>
  onJoin: (url: string) => Promise<void>
  onBack: () => void
}) {
  const [identity, setIdentity] = useState<ServerIdentity>({
    player: null,
    reachable: true,
    text: '…',
    colour: MENU_COLOURS.muted,
  })
  const [accountName, setAccountName] = useState('')
  const [status, setStatus] = useState<{ text: string; colour?: string }>({
    text: 'Run one with bun run serve:match.',
  })

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
   * Run a passkey ceremony, then ask again who we are.
   *
   * Asking rather than believing the ceremony's own answer: the session token
   * is what every later request carries, and whether it works is a question
   * only the server can settle. Asked directly rather than by re-running the
   * effect above, which the unchanged address would not do.
   */
  const ceremony = async (act: (it: Account) => Promise<unknown>) => {
    try {
      await act(new Account(url.trim()))
    } catch (err) {
      setStatus({
        text: err instanceof Error ? err.message : 'That did not work.',
        colour: MENU_COLOURS.danger,
      })
    }
    setIdentity(await identify(url))
  }

  /**
   * Both ways into a match, which differ only in what they say while waiting
   * and what they say when they fail. The address is remembered on the way in
   * rather than as it is typed, so a half-typed one is never what comes back.
   */
  const enter = async (
    act: (url: string) => Promise<void>,
    waiting: string,
    failure: string,
  ) => {
    const trimmed = url.trim()
    if (!trimmed) return
    localStorage.setItem('tictac.server', trimmed)
    setStatus({ text: waiting, colour: MENU_COLOURS.accent })
    try {
      await act(trimmed)
    } catch (err) {
      setStatus({
        text: err instanceof Error && err.message.length > 0 ? err.message : failure,
        colour: MENU_COLOURS.danger,
      })
    }
  }

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

      <div style={{ display: 'flex', gap: 8 }}>
        <MenuButton
          id="btn-server-host"
          tone="serverDeep"
          grow
          onClick={() =>
            void enter(onHost, 'Waiting for an opponent to join…', 'Could not open a match there.')
          }
        >
          Open a Match
        </MenuButton>
        <MenuButton
          id="btn-server-join"
          tone="server"
          grow
          onClick={() => void enter(onJoin, 'Connecting…', 'Could not join a match there.')}
        >
          Join the Match
        </MenuButton>
        <MenuButton id="btn-server-back" tone="neutral" onClick={onBack}>
          Back
        </MenuButton>
      </div>
      <StatusLine id="server-status" text={status.text} colour={status.colour} />
    </div>
  )
}
