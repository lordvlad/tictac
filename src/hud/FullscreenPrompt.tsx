import { createRoot, type Root } from 'react-dom/client'
import { bottomLeftRow } from './CornerStack'
import { Icon } from './Icon'

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

function requestFullscreen(): void {
  const element = document.documentElement as HTMLElement & LegacyFullscreenElement
  const request = element.requestFullscreen?.bind(element) ?? element.webkitRequestFullscreen?.bind(element)
  if (!request) return
  // A refused request (an iframe without the permission, a user setting) must
  // not surface as an unhandled rejection; the prompt simply stays put.
  void Promise.resolve(request()).catch(() => {})
}

function PromptButtons({ onDismiss }: { onDismiss: () => void }) {
  return (
    <>
      <button className="fs-prompt-cta interactive" type="button" onClick={requestFullscreen}>
        <Icon file="ui-expand" /> <span className="fs-prompt-label">Play fullscreen</span>
      </button>
      <button className="fs-prompt-close interactive" type="button" aria-label="Dismiss" onClick={onDismiss}>
        <Icon file="ui-cancel" />
      </button>
    </>
  )
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
  private readonly container: HTMLDivElement
  private readonly root: Root
  private readonly media = window.matchMedia(COMPACT_VIEWPORT)
  private dismissed = false

  constructor() {
    this.container = document.createElement('div')
    this.container.className = 'fs-prompt'
    bottomLeftRow().appendChild(this.container)
    this.root = createRoot(this.container)
    this.root.render(
      <PromptButtons
        onDismiss={() => {
          this.dismissed = true
          this.sync()
        }}
      />,
    )

    this.media.addEventListener('change', this.sync)
    document.addEventListener('fullscreenchange', this.sync)
    document.addEventListener('webkitfullscreenchange', this.sync)
    this.sync()
  }

  dispose(): void {
    this.media.removeEventListener('change', this.sync)
    document.removeEventListener('fullscreenchange', this.sync)
    document.removeEventListener('webkitfullscreenchange', this.sync)
    this.root.unmount()
    this.container.remove()
  }

  /** Visible only where it is both useful and possible. */
  private readonly sync = (): void => {
    const legacy = document as Document & LegacyFullscreenDocument
    const supported = document.fullscreenEnabled || legacy.webkitFullscreenEnabled === true
    const active = document.fullscreenElement !== null || (legacy.webkitFullscreenElement ?? null) !== null

    this.container.hidden = this.dismissed || !supported || active || !this.media.matches
  }
}
