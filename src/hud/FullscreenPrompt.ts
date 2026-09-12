import { bottomLeftStack } from './CornerStack'
import { icon } from './icons'

/**
 * The same condition the compact HUD uses: whichever viewport axis is smaller
 * decides, so a phone counts whichever way it is held.
 */
const COMPACT_VIEWPORT = '(max-width: 820px), (max-height: 560px)'

/** Safari still ships the prefixed API, and TypeScript's DOM lib omits it. */
interface LegacyFullscreenElement {
  webkitRequestFullscreen?: () => Promise<void> | void
}

interface LegacyFullscreenDocument {
  webkitFullscreenElement?: Element | null
  webkitFullscreenEnabled?: boolean
}

/**
 * Suggests fullscreen on the screens that gain from it, and asks for it on tap.
 *
 * A request only succeeds inside a user gesture, so this cannot enter fullscreen
 * on its own — the button is the gesture. It shows itself only where the compact
 * HUD applies, and takes itself away once the request lands; leaving fullscreen
 * brings it back, unless the player dismissed it.
 */
export class FullscreenPrompt {
  private readonly root: HTMLDivElement
  private readonly media = window.matchMedia(COMPACT_VIEWPORT)
  private dismissed = false

  constructor() {
    this.root = document.createElement('div')
    this.root.className = 'fs-prompt'
    this.root.innerHTML = `
      <button class="fs-prompt-cta interactive" type="button" data-fs="enter">
        ${icon('ui-expand')} <span class="fs-prompt-label">Play fullscreen</span>
      </button>
      <button class="fs-prompt-close interactive" type="button" data-fs="dismiss" aria-label="Dismiss">${icon('ui-cancel')}</button>
    `
    this.root.addEventListener('click', this.onClick)
    bottomLeftStack().appendChild(this.root)

    this.media.addEventListener('change', this.sync)
    document.addEventListener('fullscreenchange', this.sync)
    document.addEventListener('webkitfullscreenchange', this.sync)
    this.sync()
  }

  dispose(): void {
    this.root.removeEventListener('click', this.onClick)
    this.media.removeEventListener('change', this.sync)
    document.removeEventListener('fullscreenchange', this.sync)
    document.removeEventListener('webkitfullscreenchange', this.sync)
    this.root.remove()
  }

  private readonly onClick = (event: MouseEvent): void => {
    const target = (event.target as HTMLElement | null)?.closest('[data-fs]')
    if (!(target instanceof HTMLElement)) return

    if (target.dataset.fs === 'dismiss') {
      this.dismissed = true
      this.sync()
      return
    }

    const element = document.documentElement as HTMLElement & LegacyFullscreenElement
    const request = element.requestFullscreen?.bind(element) ?? element.webkitRequestFullscreen?.bind(element)
    if (!request) return
    // A refused request (an iframe without the permission, a user setting) must
    // not surface as an unhandled rejection; the prompt simply stays put.
    void Promise.resolve(request()).catch(() => {})
  }

  /** Visible only where it is both useful and possible. */
  private readonly sync = (): void => {
    const legacy = document as Document & LegacyFullscreenDocument
    const supported = document.fullscreenEnabled || legacy.webkitFullscreenEnabled === true
    const active = document.fullscreenElement !== null || (legacy.webkitFullscreenElement ?? null) !== null

    this.root.hidden = this.dismissed || !supported || active || !this.media.matches
  }
}
