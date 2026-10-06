import { useEffect, useRef, useState } from 'react'
import { MENU_COLOURS, MenuButton, MenuInput, PanelTitle, StatusLine } from './controls'

/**
 * The two halves of a peer-to-peer match: handing out an id, and using one.
 *
 * No server is involved past the signalling broker that introduces the two
 * browsers, which is why these live apart from `ServerPanel` — there is no
 * account, nothing is kept, and the only thing to exchange is the id.
 */

/**
 * Waiting to be joined.
 *
 * The id arrives from the broker asynchronously, so the panel exists before
 * there is anything to show: `id` is null until it does.
 */
export function HostPanel({ id }: { id: string | null }) {
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 2000)
    return () => clearTimeout(timer)
  }, [copied])

  if (!id) {
    return (
      <div id="menu-details" style={{ marginTop: 20 }}>
        <p style={{ fontSize: 14, color: MENU_COLOURS.muted }}>Initializing PeerJS Host...</p>
      </div>
    )
  }

  return (
    <div id="menu-details" style={{ marginTop: 20 }}>
      <PanelTitle text="Host Created!" tone="peerHost" />
      <p style={{ fontSize: 12, color: MENU_COLOURS.muted, marginBottom: 8 }}>
        Share this Peer ID with your opponent:
      </p>
      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        <MenuInput id="peer-id-input" grow value={id} readOnly />
        <MenuButton
          id="btn-copy-id"
          tone="neutralDark"
          size="sm"
          onClick={() => {
            void navigator.clipboard.writeText(id)
            setCopied(true)
          }}
        >
          {copied ? 'Copied!' : 'Copy'}
        </MenuButton>
      </div>
      <p style={{ fontSize: 12, color: '#e2e8f0', animation: 'pulse 2s infinite' }}>
        Waiting for peer to join...
      </p>
    </div>
  )
}

/** Using somebody else's id. */
export function JoinPanel({
  onConnect,
  onBack,
}: {
  onConnect: (hostId: string) => Promise<void>
  onBack: () => void
}) {
  const [peerId, setPeerId] = useState('')
  const [status, setStatus] = useState<{ text: string; colour: string } | null>(null)
  const field = useRef<HTMLInputElement | null>(null)

  // The panel exists to take one value, so the cursor starts in it. Deferred a
  // frame because the element is not in the document when this first runs.
  useEffect(() => {
    const timer = setTimeout(() => field.current?.focus(), 50)
    return () => clearTimeout(timer)
  }, [])

  const connect = async () => {
    const trimmed = peerId.trim()
    if (!trimmed) return
    setStatus({ text: 'Connecting to host...', colour: MENU_COLOURS.accent })
    try {
      await onConnect(trimmed)
    } catch (err) {
      setStatus({
        text:
          err instanceof Error && err.message.length > 0
            ? err.message
            : 'Failed to connect. Verify Peer ID.',
        colour: MENU_COLOURS.danger,
      })
    }
  }

  return (
    <div id="menu-details" style={{ marginTop: 20 }}>
      <PanelTitle text="Join P2P Game" tone="peerJoin" />
      <MenuInput
        id="join-peer-id"
        inputRef={field}
        value={peerId}
        placeholder="Enter Host Peer ID..."
        onChange={setPeerId}
        onEnter={() => void connect()}
      />
      <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
        <MenuButton id="btn-connect-peer" tone="peerJoin" grow onClick={() => void connect()}>
          Connect
        </MenuButton>
        <MenuButton id="btn-back" tone="neutral" onClick={onBack}>
          Back
        </MenuButton>
      </div>
      {status && <StatusLine id="join-status" text={status.text} colour={status.colour} />}
    </div>
  )
}
