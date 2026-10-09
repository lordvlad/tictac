import { createRoot } from 'react-dom/client'
import type { EncounterStarted } from '../game/Encounter'
import type { LobbyView } from '../game/Lobby'
import type { ServerConnection } from '../game/ServerConnection'
import { formatCountdown, type Prompt, promptFor } from './EncounterView'

/**
 * The question a fight on the road asks (`ITEM-048`, decision 5): aliens
 * found the squad and the match is already a room, held for this player
 * until `joinBy`; after that the AI plays it.
 *
 * Mounted on `<body>` above every screen, the map included, because it can
 * come at any moment and must work from wherever the player is: taking the
 * fight is the `resume` path the server panel uses, which `take` runs after
 * putting the map and the menu away. It knows of a fight two ways — the
 * `encounter/started` push, and `LobbyView.you.control === 'reserved'`, which
 * is how a window that connected after the push learns the same — and the
 * countdown runs on the server's clock (`connection.now()`), so a machine
 * whose own is off still shows the time the server will act on.
 */

/** How often the countdown is redrawn: under a second, so `0:01` never lingers. */
const TICK_MS = 250

export interface EncounterPromptActions {
  /** Whether the player is somewhere a fight can be taken over from: the menu or the map, not a match or a replay. */
  available: () => boolean
  /** Take the seat in `roomId`; rejects with a player-readable reason. */
  take: (roomId: string) => Promise<void>
  /** Show the return feed. */
  showFeed: () => void
}

/** Point the prompt at a connection (or at none); the one it follows before is let go of. */
export interface EncounterPromptHandle {
  follow: (connection: ServerConnection | null) => void
}

export function mountEncounterPrompt(actions: EncounterPromptActions): EncounterPromptHandle {
  const container = document.createElement('div')
  container.className = 'enc-root'
  document.body.appendChild(container)
  const root = createRoot(container)

  let following: ServerConnection | null = null
  let release: () => void = () => {}
  let pushed: EncounterStarted | null = null
  let you: LobbyView['you'] | undefined
  /** The room this window took: nothing more to ask about it. */
  let taken: string | null = null
  /** The room whose "the AI has it" note the player put away. */
  let dismissed: string | null = null
  let busy = false
  let problem: string | null = null

  const draw = () => {
    const prompt = following && actions.available() ? promptFor({ pushed, you, now: following.now() }) : null
    const hidden = prompt !== null && (prompt.roomId === taken || (prompt.kind === 'ai' && prompt.roomId === dismissed))
    if (!following || !prompt || hidden) {
      root.render(null)
      return
    }
    root.render(
      <PromptView
        prompt={prompt}
        remaining={prompt.kind === 'offer' ? prompt.joinBy - following.now() : 0}
        busy={busy}
        problem={problem}
        onTake={() => void take(prompt.roomId)}
        onFeed={actions.showFeed}
        onDismiss={() => {
          dismissed = prompt.roomId
          draw()
        }}
      />,
    )
  }

  const take = async (roomId: string) => {
    busy = true
    problem = null
    draw()
    try {
      await actions.take(roomId)
      taken = roomId
    } catch (error) {
      problem = error instanceof Error && error.message.length > 0 ? error.message : 'The fight could not be taken.'
    } finally {
      busy = false
    }
    draw()
  }

  return {
    follow: (connection) => {
      if (connection === following) return
      release()
      following = connection
      pushed = null
      you = undefined
      taken = null
      dismissed = null
      busy = false
      problem = null
      if (!connection) {
        release = () => {}
        draw()
        return
      }
      const stopLobby = connection.watchLobby((view) => {
        you = view.you
        draw()
      })
      const stopPushes = connection.watchEncounters((started) => {
        pushed = started
        problem = null
        draw()
      })
      const timer = window.setInterval(draw, TICK_MS)
      release = () => {
        stopLobby()
        stopPushes()
        window.clearInterval(timer)
      }
      draw()
    },
  }
}

function PromptView({
  prompt,
  remaining,
  busy,
  problem,
  onTake,
  onFeed,
  onDismiss,
}: {
  prompt: Prompt
  remaining: number
  busy: boolean
  problem: string | null
  onTake: () => void
  onFeed: () => void
  onDismiss: () => void
}) {
  if (prompt.kind === 'ai') {
    return (
      <div className="enc-prompt" role="status">
        <div className="enc-title">The AI is fighting for your squad</div>
        <div className="enc-note">You can watch it back from the feed once it is under way.</div>
        {problem && <div className="enc-problem">{problem}</div>}
        <div className="enc-actions">
          <button type="button" onClick={onFeed}>
            See the feed
          </button>
          <button type="button" onClick={onDismiss}>
            Dismiss
          </button>
        </div>
      </div>
    )
  }
  return (
    <div className="enc-prompt" role="alertdialog" aria-label="Aliens found your squad">
      <div className="enc-title">Aliens found your squad — take the fight?</div>
      <div className="enc-count">{formatCountdown(remaining)}</div>
      <div className="enc-actions">
        <button type="button" className="enc-take" disabled={busy} onClick={onTake}>
          Take the fight
        </button>
      </div>
      <div className="enc-note">If the time runs out, the AI plays it for you.</div>
      {problem && <div className="enc-problem">{problem}</div>}
    </div>
  )
}
