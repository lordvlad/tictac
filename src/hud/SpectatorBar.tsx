import { createRoot, type Root } from 'react-dom/client'

/** Everything the watcher's bar shows, as one snapshot. */
export interface SpectatorView {
  roomId: string
  progress:
    | { kind: 'waiting' }
    /** `acting`: whose turn it is, by name. */
    | { kind: 'playing'; turn: number; acting: string }
    /** `winner`: the side left standing, by name. */
    | { kind: 'decided'; winner: string }
}

function readout({ roomId, progress }: SpectatorView): string {
  switch (progress.kind) {
    case 'waiting':
      return `watching ${roomId} · waiting for the match to start`
    case 'playing':
      return `watching ${roomId} · turn ${progress.turn} · ${progress.acting} to act`
    case 'decided':
      return `watching ${roomId} · ${progress.winner} won the match`
  }
}

function SpectatorStrip({ text, onLeave }: { text: string; onLeave: () => void }) {
  return (
    <>
      <div className="playback-readout">{text}</div>
      <div className="playback-row">
        <button className="hud-btn interactive playback-btn-primary" title="Stop watching" onClick={onLeave}>
          Leave
        </button>
      </div>
    </>
  )
}

/**
 * A live match's watcher bar, in place of the HUD.
 *
 * The replay transport's berth and look (`PlaybackControls`), with nothing to
 * press but the way out: a live match runs at the players' pace, so there is
 * no clock here to pause and nothing behind the present to step back to. It
 * says whose turn it is, because a watcher has no HUD to tell them, and that
 * the match has been decided, because a watcher gets no end screen either.
 */
export class SpectatorBar {
  private readonly container: HTMLElement
  private readonly root: Root
  private shown: string | null = null

  constructor(private readonly onLeave: () => void) {
    this.container = document.createElement('div')
    this.container.className = 'playback-bar'
    ;(document.getElementById('ui') ?? document.body).appendChild(this.container)
    this.root = createRoot(this.container)
  }

  dispose(): void {
    this.root.unmount()
    this.container.remove()
  }

  /** Cheap to call every tick: the bar is only redrawn when what it says changes. */
  render(view: SpectatorView): void {
    const text = readout(view)
    if (text === this.shown) return
    this.shown = text
    this.root.render(<SpectatorStrip text={text} onLeave={this.onLeave} />)
  }
}
