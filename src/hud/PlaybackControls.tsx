import { createRoot, type Root } from 'react-dom/client'
import type { PlaybackSpeed } from '../game/Playback'

/** Everything the transport bar shows, as one snapshot. */
export interface PlaybackView {
  playing: boolean
  speed: PlaybackSpeed
  index: number
  total: number
  turn: number
  turns: number
  seedLabel: string
}

export type PlaybackCommand =
  | { type: 'play'; speed: PlaybackSpeed }
  | { type: 'pause' }
  | { type: 'stepForward' }
  | { type: 'stepBackward' }

const SPEEDS: readonly PlaybackSpeed[] = [0.5, 1, 2]

function PlaybackBar({ view, onCommand }: { view: PlaybackView; onCommand: (command: PlaybackCommand) => void }) {
  const atEnd = view.index >= view.total
  return (
    <>
      <div className="playback-readout">
        seed {view.seedLabel} · turn {view.turn}/{view.turns} · event {view.index}/{view.total}
      </div>
      <div className="playback-row">
        <button
          className="hud-btn hud-btn-glyph interactive"
          title="Step back one action"
          disabled={view.index === 0}
          onClick={() => onCommand({ type: 'stepBackward' })}
        >
          {'\u23EE'}
        </button>
        {SPEEDS.map((speed) => (
          <button
            key={speed}
            className={view.playing && view.speed === speed ? 'hud-btn interactive active' : 'hud-btn interactive'}
            title={`Play at ${speed}x`}
            disabled={atEnd}
            onClick={() => onCommand({ type: 'play', speed })}
          >
            {speed}×
          </button>
        ))}
        <button
          className="hud-btn hud-btn-glyph interactive playback-btn-primary"
          title={view.playing ? 'Pause' : 'Play'}
          disabled={atEnd}
          // Pause while running, resume at whatever speed was last chosen.
          onClick={() => onCommand(view.playing ? { type: 'pause' } : { type: 'play', speed: view.speed })}
        >
          {view.playing ? '\u2759\u2759' : '\u25B6'}
        </button>
        <button
          className="hud-btn hud-btn-glyph interactive"
          title="Step forward one action"
          disabled={atEnd}
          onClick={() => onCommand({ type: 'stepForward' })}
        >
          {'\u23ED'}
        </button>
      </div>
    </>
  )
}

/**
 * The replay transport, in place of the HUD.
 *
 * A pure view in the same mould as {@link Hud}: it renders the snapshot it is
 * handed and reports presses, so what a button *does* is answered once, in the
 * thing that owns the clock.
 *
 * Glyphs rather than `<Icon>` on purpose — the icon table has no transport
 * symbols, and adding three would mean a vendor build step to draw a triangle.
 */
export class PlaybackControls {
  private readonly container: HTMLElement
  private readonly root: Root

  constructor(private readonly onCommand: (command: PlaybackCommand) => void) {
    this.container = document.createElement('div')
    this.container.className = 'playback-bar'
    ;(document.getElementById('ui') ?? document.body).appendChild(this.container)
    this.root = createRoot(this.container)
  }

  dispose(): void {
    this.root.unmount()
    this.container.remove()
  }

  render(view: PlaybackView): void {
    this.root.render(<PlaybackBar view={view} onCommand={this.onCommand} />)
  }
}
