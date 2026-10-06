import { useEffect, useRef, useState } from 'react'
import { BUILD_ID } from '../../version'
import { MENU_COLOURS, MenuButton, MenuGroup } from './controls'
import { HostPanel, JoinPanel } from './PeerPanel'
import { ServerPanel } from './ServerPanel'

/**
 * The first screen, arranged by the one question that decides everything
 * behind it: **who is on the other end?**
 *
 * A match server is a third machine that keeps an account, watches the match
 * and remembers what it did. A peer is another browser and nothing else — no
 * account, nothing kept. Offline is nobody: the same rules against the AI,
 * against somebody sharing the keyboard, or replayed out of a file. Those
 * three answers decide whether signing in means anything, whether an id has
 * to be exchanged, and whether a result is kept, so they are the grouping
 * rather than a flat list of six buttons that each hid which kind they were.
 *
 * Each group leads to a panel that owns its own state (`ServerPanel`,
 * `HostPanel`/`JoinPanel`); what stays here is the choice between them, and
 * the match-server address, which is a remembered preference rather than one
 * panel's business.
 */

export interface StartMenuProps {
  /**
   * Why the player is looking at this menu, when something sent them back to
   * it — a referee's refusal, a peer that dropped during the loadout screen.
   */
  notice?: string
  onLocalVersus: () => void
  onPlayAi: () => void
  onLoadRecording: (file: File) => Promise<void>
  onInitHost: () => Promise<string>
  onJoinP2p: (hostId: string) => Promise<void>
  onServerHost: (url: string) => Promise<void>
  onServerJoin: (url: string) => Promise<void>
  probeOwnOriginServer: () => Promise<string | null>
}

type MenuMode = 'main' | 'host' | 'join' | 'server'

export function StartMenu({
  notice,
  onLocalVersus,
  onPlayAi,
  onLoadRecording,
  onInitHost,
  onJoinP2p,
  onServerHost,
  onServerJoin,
  probeOwnOriginServer,
}: StartMenuProps) {
  const [mode, setMode] = useState<MenuMode>('main')
  const [mainError, setMainError] = useState<string | null>(notice ?? null)
  const [hostId, setHostId] = useState<string | null>(null)
  const [serverUrl, setServerUrl] = useState(() => localStorage.getItem('tictac.server') ?? '')
  const fileInput = useRef<HTMLInputElement | null>(null)

  /**
   * Offer this page's own origin when nothing has been chosen before.
   *
   * The Cloudflare deployment serves the client and its referee from one
   * origin, so the right answer is usually "here"; GitHub Pages serves no
   * backend, so there is usually no answer at all. Probed rather than named,
   * so neither host is hardcoded.
   */
  useEffect(() => {
    if (localStorage.getItem('tictac.server')) return
    void probeOwnOriginServer().then((found) => {
      if (found) setServerUrl((current) => current || found)
    })
  }, [probeOwnOriginServer])

  return (
    <div
      style={{
        background: '#1e293b',
        padding: '32px 40px',
        borderRadius: 12,
        border: '1px solid #334155',
        boxShadow: '0 20px 25px -5px rgba(0,0,0,0.5)',
        width: 380,
        textAlign: 'center',
      }}
    >
      <h1 style={{ margin: '0 0 8px 0', fontSize: 28, letterSpacing: 2, color: MENU_COLOURS.accent }}>
        TICTAC
      </h1>
      <p style={{ margin: '0 0 24px 0', fontSize: 14, color: MENU_COLOURS.muted }}>
        Tactical Combat Engine
      </p>

      {mode === 'main' && (
        <div id="menu-actions" style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          <MenuGroup
            id="group-server"
            title="Match Server"
            caption="Sign in with a passkey; your squad is kept between matches."
            tone="server"
          >
            <MenuButton id="btn-server-mode" tone="server" size="lg" onClick={() => setMode('server')}>
              Play on a Match Server
            </MenuButton>
          </MenuGroup>

          <MenuGroup
            id="group-p2p"
            title="Peer to Peer"
            caption="Straight to another browser. Nothing is kept."
            tone="peerHost"
          >
            <MenuButton
              id="btn-host-mode"
              tone="peerHost"
              size="lg"
              onClick={async () => {
                setMode('host')
                setHostId(null)
                setHostId(await onInitHost())
              }}
            >
              Host P2P Match
            </MenuButton>
            <MenuButton id="btn-join-mode" tone="peerJoin" size="lg" onClick={() => setMode('join')}>
              Join P2P Match
            </MenuButton>
          </MenuGroup>

          <MenuGroup
            id="group-offline"
            title="Offline"
            caption="Nobody on the other end — one machine, start to finish."
            tone="offline"
          >
            <MenuButton id="btn-local" tone="offline" size="lg" onClick={onLocalVersus}>
              Local Versus (Same Screen)
            </MenuButton>
            <MenuButton id="btn-ai" tone="offlineAi" size="lg" onClick={onPlayAi}>
              Play Against the AI
            </MenuButton>
            <MenuButton
              id="btn-load-recording"
              tone="neutral"
              size="lg"
              onClick={() => fileInput.current?.click()}
            >
              Load Recording (Spectate)
            </MenuButton>
          </MenuGroup>

          <input
            id="recording-file"
            ref={fileInput}
            type="file"
            accept="application/json,.json"
            style={{ display: 'none' }}
            onChange={async (event) => {
              const file = event.target.files?.[0]
              if (!file) return
              try {
                await onLoadRecording(file)
              } catch (err) {
                if (fileInput.current) fileInput.current.value = ''
                setMainError(err instanceof Error ? err.message : 'could not read that file')
              }
            }}
          />

          {mainError && (
            <div id="menu-details">
              <p style={{ fontSize: 12, color: MENU_COLOURS.danger, margin: 0 }}>{mainError}</p>
            </div>
          )}
        </div>
      )}

      {mode === 'host' && <HostPanel id={hostId} />}

      {mode === 'join' && (
        <JoinPanel onConnect={onJoinP2p} onBack={() => setMode('main')} />
      )}

      {mode === 'server' && (
        <ServerPanel
          url={serverUrl}
          onUrlChange={setServerUrl}
          onHost={onServerHost}
          onJoin={onServerJoin}
          onBack={() => setMode('main')}
        />
      )}

      <p
        id="build-id"
        title="The commit this build was made from; peers on different builds are refused a match"
        style={{ margin: '24px 0 0 0', fontSize: 11, color: '#64748b', fontFamily: 'monospace' }}
      >
        build {BUILD_ID}
      </p>
    </div>
  )
}
