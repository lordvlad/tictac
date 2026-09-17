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

/**
 * The replay transport, in place of the HUD.
 *
 * A pure view in the same mould as {@link Hud}: it renders the snapshot it is
 * handed and reports presses, so what a button *does* is answered once, in the
 * thing that owns the clock.
 *
 * Glyphs rather than `icon()` on purpose — the icon table has no transport
 * symbols, and adding three would mean a vendor build step to draw a triangle.
 */
export class PlaybackControls {
  private readonly root: HTMLElement
  private view: PlaybackView | null = null

  constructor(private readonly onCommand: (command: PlaybackCommand) => void) {
    this.root = document.createElement('div')
    this.root.className = 'playback-bar'
    ;(document.getElementById('ui') ?? document.body).appendChild(this.root)
    // Delegated: the row is re-rendered wholesale on every change, so
    // per-element handlers would have to be re-bound each time.
    this.root.addEventListener('click', this.onClick)
  }

  dispose(): void {
    this.root.removeEventListener('click', this.onClick)
    this.root.remove()
  }

  render(view: PlaybackView): void {
    this.view = view
    const atEnd = view.index >= view.total
    const speedButtons = SPEEDS.map((speed) => {
      const label = speed === 0.5 ? '0.5&times;' : `${speed}&times;`
      const active = view.playing && view.speed === speed ? 'active' : ''
      return `<button class="hud-btn interactive ${active}" data-playback="speed" data-speed="${speed}"
                      title="Play at ${speed}x" ${atEnd ? 'disabled' : ''}>${label}</button>`
    }).join('')

    this.root.innerHTML = `
      <div class="playback-readout">
        seed ${view.seedLabel} &middot; turn ${view.turn}/${view.turns} &middot; event ${view.index}/${view.total}
      </div>
      <div class="playback-row">
        <button class="hud-btn hud-btn-glyph interactive" data-playback="stepBackward"
                title="Step back one action" ${view.index === 0 ? 'disabled' : ''}>&#9198;</button>
        ${speedButtons}
        <button class="hud-btn hud-btn-glyph interactive playback-btn-primary" data-playback="toggle"
                title="${view.playing ? 'Pause' : 'Play'}" ${atEnd ? 'disabled' : ''}>${
                  view.playing ? '&#10073;&#10073;' : '&#9654;'
                }</button>
        <button class="hud-btn hud-btn-glyph interactive" data-playback="stepForward"
                title="Step forward one action" ${atEnd ? 'disabled' : ''}>&#9197;</button>
      </div>
    `
  }

  private readonly onClick = (event: MouseEvent): void => {
    const button = (event.target as HTMLElement | null)?.closest('[data-playback]')
    if (!(button instanceof HTMLElement)) return
    if (button instanceof HTMLButtonElement && button.disabled) return

    switch (button.dataset.playback) {
      case 'stepBackward':
        this.onCommand({ type: 'stepBackward' })
        return
      case 'stepForward':
        this.onCommand({ type: 'stepForward' })
        return
      case 'toggle':
        // Pause while running, resume at whatever speed was last chosen.
        if (this.view?.playing) this.onCommand({ type: 'pause' })
        else this.onCommand({ type: 'play', speed: this.view?.speed ?? 1 })
        return
      case 'speed': {
        const speed = Number(button.dataset.speed) as PlaybackSpeed
        this.onCommand({ type: 'play', speed })
        return
      }
    }
  }
}
