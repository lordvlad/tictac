import { useEffect, useRef, useState } from 'react'
import { Account, type Player } from '../../game/Account'

export interface StartMenuProps {
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
  const [mainError, setMainError] = useState<string | null>(null)

  // Host mode state
  const [hostId, setHostId] = useState<string | null>(null)
  const [hostCopied, setHostCopied] = useState(false)

  // Join mode state
  const [joinId, setJoinId] = useState('')
  const [joinStatus, setJoinStatus] = useState<{ text: string; error: boolean } | null>(null)
  const joinInputRef = useRef<HTMLInputElement | null>(null)

  // Server mode state
  const [serverUrl, setServerUrl] = useState(() => localStorage.getItem('tictac.server') ?? '')
  const [accountStatus, setAccountStatus] = useState<string>('…')
  const [accountStatusColor, setAccountStatusColor] = useState<string>('#94a3b8')
  const [player, setPlayer] = useState<Player | null>(null)
  const [serverReachable, setServerReachable] = useState(true)
  const [accountName, setAccountName] = useState('')
  const [serverStatus, setServerStatus] = useState<{ text: string; color?: string }>({
    text: 'Run one with bun run serve:match.',
  })

  const fileInputRef = useRef<HTMLInputElement | null>(null)

  // Auto-focus join input when entering join mode
  useEffect(() => {
    if (mode === 'join') {
      const timer = setTimeout(() => joinInputRef.current?.focus(), 50)
      return () => clearTimeout(timer)
    }
  }, [mode])

  // Probe own origin if serverUrl is empty
  useEffect(() => {
    if (!localStorage.getItem('tictac.server')) {
      void probeOwnOriginServer().then((found) => {
        if (!found) return
        setServerUrl((current) => (current ? current : found))
      })
    }
  }, [probeOwnOriginServer])

  // Refresh account status when serverUrl changes or server mode entered
  useEffect(() => {
    if (mode !== 'server') return
    let active = true

    const run = async () => {
      const trimmed = serverUrl.trim()
      let me: Player | null = null
      try {
        me = await new Account(trimmed).me()
      } catch {
        if (!active) return
        setServerReachable(false)
        setPlayer(null)
        setAccountStatus('No match server answers at that address')
        setAccountStatusColor('#ef4444')
        return
      }

      if (!active) return
      setServerReachable(true)
      setPlayer(me)
      if (me) {
        setAccountStatus(`Signed in as ${me.name} — your squad is kept on this server`)
        setAccountStatusColor('#2dd4bf')
      } else {
        setAccountStatus('Not signed in — matches here are not kept')
        setAccountStatusColor('#94a3b8')
      }
    }

    void run()
    return () => {
      active = false
    }
  }, [mode, serverUrl])

  const refreshAccount = async (url: string) => {
    const trimmed = url.trim()
    try {
      const me = await new Account(trimmed).me()
      setServerReachable(true)
      setPlayer(me)
      if (me) {
        setAccountStatus(`Signed in as ${me.name} — your squad is kept on this server`)
        setAccountStatusColor('#2dd4bf')
      } else {
        setAccountStatus('Not signed in — matches here are not kept')
        setAccountStatusColor('#94a3b8')
      }
    } catch {
      setServerReachable(false)
      setPlayer(null)
      setAccountStatus('No match server answers at that address')
      setAccountStatusColor('#ef4444')
    }
  }

  const handleStartHost = async () => {
    setMode('host')
    setHostId(null)
    const id = await onInitHost()
    setHostId(id)
  }

  const handleCopyHostId = () => {
    if (!hostId) return
    navigator.clipboard.writeText(hostId)
    setHostCopied(true)
    setTimeout(() => setHostCopied(false), 2000)
  }

  const handleConnectPeer = async () => {
    const trimmed = joinId.trim()
    if (!trimmed) return
    setJoinStatus({ text: 'Connecting to host...', error: false })
    try {
      await onJoinP2p(trimmed)
    } catch (err) {
      setJoinStatus({
        text:
          err instanceof Error && err.message.length > 0
            ? err.message
            : 'Failed to connect. Verify Peer ID.',
        error: true,
      })
    }
  }

  const runAccountAction = async (act: (account: Account) => Promise<unknown>) => {
    const trimmed = serverUrl.trim()
    try {
      await act(new Account(trimmed))
    } catch (err) {
      setServerStatus({
        text: err instanceof Error ? err.message : 'That did not work.',
        color: '#ef4444',
      })
    }
    await refreshAccount(trimmed)
  }

  const handleServerHost = async () => {
    const trimmed = serverUrl.trim()
    if (!trimmed) return
    localStorage.setItem('tictac.server', trimmed)
    setServerStatus({ text: 'Waiting for an opponent to join…', color: '#38bdf8' })
    try {
      await onServerHost(trimmed)
    } catch (err) {
      setServerStatus({
        text: err instanceof Error ? err.message : 'Could not open a match there.',
        color: '#ef4444',
      })
    }
  }

  const handleServerJoin = async () => {
    const trimmed = serverUrl.trim()
    if (!trimmed) return
    localStorage.setItem('tictac.server', trimmed)
    setServerStatus({ text: 'Connecting…', color: '#38bdf8' })
    try {
      await onServerJoin(trimmed)
    } catch (err) {
      setServerStatus({
        text:
          err instanceof Error && err.message.length > 0
            ? err.message
            : 'Could not join a match there.',
        color: '#ef4444',
      })
    }
  }

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
      <h1 style={{ margin: '0 0 8px 0', fontSize: 28, letterSpacing: 2, color: '#38bdf8' }}>
        TICTAC P2P
      </h1>
      <p style={{ margin: '0 0 24px 0', fontSize: 14, color: '#94a3b8' }}>Tactical Combat Engine</p>

      {mode === 'main' && (
        <div id="menu-actions" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <button
            id="btn-local"
            style={{
              padding: 12,
              background: '#3b82f6',
              color: 'white',
              border: 'none',
              borderRadius: 6,
              fontWeight: 600,
              cursor: 'pointer',
            }}
            onClick={onLocalVersus}
          >
            Local Versus (Same Screen)
          </button>
          <button
            id="btn-ai"
            style={{
              padding: 12,
              background: '#8b5cf6',
              color: 'white',
              border: 'none',
              borderRadius: 6,
              fontWeight: 600,
              cursor: 'pointer',
            }}
            onClick={onPlayAi}
          >
            Play Against the AI
          </button>
          <button
            id="btn-host-mode"
            style={{
              padding: 12,
              background: '#0ea5e9',
              color: 'white',
              border: 'none',
              borderRadius: 6,
              fontWeight: 600,
              cursor: 'pointer',
            }}
            onClick={handleStartHost}
          >
            Host P2P Match
          </button>
          <button
            id="btn-join-mode"
            style={{
              padding: 12,
              background: '#6366f1',
              color: 'white',
              border: 'none',
              borderRadius: 6,
              fontWeight: 600,
              cursor: 'pointer',
            }}
            onClick={() => {
              setMode('join')
              setJoinStatus(null)
            }}
          >
            Join P2P Match
          </button>
          <button
            id="btn-server-mode"
            style={{
              padding: 12,
              background: '#14b8a6',
              color: 'white',
              border: 'none',
              borderRadius: 6,
              fontWeight: 600,
              cursor: 'pointer',
            }}
            onClick={() => setMode('server')}
          >
            Play on a Match Server
          </button>
          <button
            id="btn-load-recording"
            style={{
              padding: 12,
              background: '#475569',
              color: 'white',
              border: 'none',
              borderRadius: 6,
              fontWeight: 600,
              cursor: 'pointer',
            }}
            onClick={() => fileInputRef.current?.click()}
          >
            Load Recording (Spectate)
          </button>
          <input
            id="recording-file"
            ref={fileInputRef}
            type="file"
            accept="application/json,.json"
            style={{ display: 'none' }}
            onChange={async (e) => {
              const file = e.target.files?.[0]
              if (!file) return
              try {
                await onLoadRecording(file)
              } catch (err) {
                if (fileInputRef.current) fileInputRef.current.value = ''
                setMainError(err instanceof Error ? err.message : 'could not read that file')
              }
            }}
          />

          {mainError && (
            <div id="menu-details" style={{ marginTop: 20 }}>
              <p style={{ fontSize: 12, color: '#ef4444', margin: 0 }}>{mainError}</p>
            </div>
          )}
        </div>
      )}

      {mode === 'host' && (
        <div id="menu-details" style={{ marginTop: 20 }}>
          {!hostId ? (
            <p style={{ fontSize: 14, color: '#94a3b8' }}>Initializing PeerJS Host...</p>
          ) : (
            <>
              <p style={{ fontSize: 14, color: '#38bdf8', marginBottom: 8 }}>Host Created!</p>
              <p style={{ fontSize: 12, color: '#94a3b8', marginBottom: 8 }}>
                Share this Peer ID with your opponent:
              </p>
              <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
                <input
                  id="peer-id-input"
                  value={hostId}
                  readOnly
                  style={{
                    flex: 1,
                    padding: 8,
                    background: '#0f172a',
                    border: '1px solid #475569',
                    color: '#f8fafc',
                    borderRadius: 4,
                    fontFamily: 'monospace',
                    fontSize: 12,
                  }}
                />
                <button
                  id="btn-copy-id"
                  style={{
                    padding: '8px 12px',
                    background: '#334155',
                    color: 'white',
                    border: 'none',
                    borderRadius: 4,
                    cursor: 'pointer',
                  }}
                  onClick={handleCopyHostId}
                >
                  {hostCopied ? 'Copied!' : 'Copy'}
                </button>
              </div>
              <p style={{ fontSize: 12, color: '#e2e8f0', animation: 'pulse 2s infinite' }}>
                Waiting for peer to join...
              </p>
            </>
          )}
        </div>
      )}

      {mode === 'join' && (
        <div id="menu-details" style={{ marginTop: 20 }}>
          <p style={{ fontSize: 14, color: '#818cf8', marginBottom: 8 }}>Join P2P Game</p>
          <input
            id="join-peer-id"
            ref={joinInputRef}
            placeholder="Enter Host Peer ID..."
            value={joinId}
            onChange={(e) => setJoinId(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void handleConnectPeer()
            }}
            style={{
              width: '100%',
              boxSizing: 'border-box',
              padding: 8,
              background: '#0f172a',
              border: '1px solid #475569',
              color: '#f8fafc',
              borderRadius: 4,
              fontFamily: 'monospace',
              fontSize: 12,
              marginBottom: 12,
            }}
          />
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              id="btn-connect-peer"
              style={{
                flex: 1,
                padding: 10,
                background: '#6366f1',
                color: 'white',
                border: 'none',
                borderRadius: 4,
                fontWeight: 600,
                cursor: 'pointer',
              }}
              onClick={handleConnectPeer}
            >
              Connect
            </button>
            <button
              id="btn-back"
              style={{
                padding: 10,
                background: '#475569',
                color: 'white',
                border: 'none',
                borderRadius: 4,
                cursor: 'pointer',
              }}
              onClick={() => setMode('main')}
            >
              Back
            </button>
          </div>
          {joinStatus && (
            <p
              id="join-status"
              style={{
                fontSize: 12,
                color: joinStatus.error ? '#ef4444' : '#38bdf8',
                marginTop: 8,
              }}
            >
              {joinStatus.text}
            </p>
          )}
        </div>
      )}

      {mode === 'server' && (
        <div id="menu-details" style={{ marginTop: 20 }}>
          <p style={{ fontSize: 14, color: '#2dd4bf', marginBottom: 8 }}>Play on a Match Server</p>
          <input
            id="server-url"
            value={serverUrl}
            onChange={(e) => setServerUrl(e.target.value)}
            placeholder="wss://your-match-server/ — leave blank to look for one at this address"
            style={{
              width: '100%',
              boxSizing: 'border-box',
              padding: 8,
              background: '#0f172a',
              border: '1px solid #475569',
              color: '#f8fafc',
              borderRadius: 4,
              fontFamily: 'monospace',
              fontSize: 12,
              marginBottom: 8,
            }}
          />
          <p id="account-status" style={{ fontSize: 12, color: accountStatusColor, marginBottom: 8 }}>
            {accountStatus}
          </p>

          {serverReachable && (
            <div id="account-actions" style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
              {!player ? (
                <>
                  <input
                    id="account-name"
                    maxLength={24}
                    placeholder="Name for a new passkey"
                    value={accountName}
                    onChange={(e) => setAccountName(e.target.value)}
                    style={{
                      flex: 1,
                      boxSizing: 'border-box',
                      padding: 8,
                      background: '#0f172a',
                      border: '1px solid #475569',
                      color: '#f8fafc',
                      borderRadius: 4,
                      fontSize: 12,
                    }}
                  />
                  <button
                    id="btn-passkey-create"
                    style={{
                      padding: '8px 10px',
                      background: '#0d9488',
                      color: 'white',
                      border: 'none',
                      borderRadius: 4,
                      fontSize: 12,
                      cursor: 'pointer',
                    }}
                    onClick={() => {
                      const trimmed = accountName.trim()
                      void runAccountAction((it) => it.register(trimmed))
                    }}
                  >
                    Create passkey
                  </button>
                  <button
                    id="btn-passkey-signin"
                    style={{
                      padding: '8px 10px',
                      background: '#334155',
                      color: 'white',
                      border: 'none',
                      borderRadius: 4,
                      fontSize: 12,
                      cursor: 'pointer',
                    }}
                    onClick={() => void runAccountAction((it) => it.signIn())}
                  >
                    Sign in with passkey
                  </button>
                </>
              ) : (
                <button
                  id="btn-passkey-signout"
                  style={{
                    padding: '8px 10px',
                    background: '#334155',
                    color: 'white',
                    border: 'none',
                    borderRadius: 4,
                    fontSize: 12,
                    cursor: 'pointer',
                  }}
                  onClick={() => void runAccountAction((it) => it.signOut())}
                >
                  Sign out
                </button>
              )}
            </div>
          )}

          <div style={{ display: 'flex', gap: 8 }}>
            <button
              id="btn-server-host"
              style={{
                flex: 1,
                padding: 10,
                background: '#0d9488',
                color: 'white',
                border: 'none',
                borderRadius: 4,
                fontWeight: 600,
                cursor: 'pointer',
              }}
              onClick={handleServerHost}
            >
              Open a Match
            </button>
            <button
              id="btn-server-join"
              style={{
                flex: 1,
                padding: 10,
                background: '#14b8a6',
                color: 'white',
                border: 'none',
                borderRadius: 4,
                fontWeight: 600,
                cursor: 'pointer',
              }}
              onClick={handleServerJoin}
            >
              Join the Match
            </button>
            <button
              id="btn-server-back"
              style={{
                padding: 10,
                background: '#475569',
                color: 'white',
                border: 'none',
                borderRadius: 4,
                cursor: 'pointer',
              }}
              onClick={() => setMode('main')}
            >
              Back
            </button>
          </div>
          <p
            id="server-status"
            style={{
              fontSize: 12,
              color: serverStatus.color ?? '#94a3b8',
              marginTop: 8,
            }}
          >
            {serverStatus.text}
          </p>
        </div>
      )}
    </div>
  )
}
