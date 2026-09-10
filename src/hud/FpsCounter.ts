import { bottomLeftStack } from './CornerStack'

/**
 * How long each reading covers. Short enough that a stall is visible while it
 * is happening, long enough that the number is readable rather than flickering.
 */
const WINDOW_MS = 500

/** Above this the frame rate reads as smooth; below the lower one, as a problem. */
const SMOOTH_FPS = 50
const ROUGH_FPS = 30

/**
 * Frames actually drawn, per second.
 *
 * Measured on its own animation frame rather than through `Game.onUpdate`: those
 * callbacks come off a fixed `setInterval` tick, so they would report the
 * simulation rate — a number that stays at its nominal value precisely when
 * rendering is struggling, which is when the counter is worth looking at.
 */
export class FpsCounter {
  private readonly root: HTMLDivElement
  private frames = 0
  private windowStart = performance.now()
  private handle = 0
  private disposed = false

  constructor() {
    this.root = document.createElement('div')
    this.root.className = 'fps-counter'
    this.root.textContent = '— fps'
    bottomLeftStack().appendChild(this.root)

    this.handle = requestAnimationFrame(this.frame)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    cancelAnimationFrame(this.handle)
    this.root.remove()
  }

  private readonly frame = (now: number): void => {
    if (this.disposed) return
    this.frames++

    const elapsed = now - this.windowStart
    if (elapsed >= WINDOW_MS) {
      const fps = Math.round((this.frames * 1000) / elapsed)
      this.root.textContent = `${fps} fps`
      this.root.dataset.rate = fps >= SMOOTH_FPS ? 'smooth' : fps >= ROUGH_FPS ? 'fair' : 'rough'
      this.frames = 0
      this.windowStart = now
    }

    this.handle = requestAnimationFrame(this.frame)
  }
}
