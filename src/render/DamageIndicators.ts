import { Vector3 } from 'three'
import Game from '@mavonengine/core/Game'
import { smoothstep } from '../core/math'

/**
 * Floating hit / miss combat text. Each indicator is a DOM label anchored to a
 * fixed ground position (the target's x/z at fire time) whose height, scale and
 * opacity are animated, then projected to screen space every frame against the
 * live camera:
 *
 *   0 .. IN      fade in, grow to full size, rise from chest to above the head
 *   IN .. HOLD   hold above the head (readable)
 *   HOLD .. OUT  drift further up while fading out
 *
 * Mounted on <body> (not the HUD root) so HUD innerHTML rewrites never wipe it.
 */

/** Chest height where the indicator is born, in metres. */
const CHEST_Y = 1.1
/** Resting height above the target's head. */
const HEAD_Y = 2.15
/** Extra rise during the fade-out. */
const RISE_Y = 0.9

const T_IN = 0.25
const T_HOLD = 1.0
const T_OUT = 0.6
const LIFETIME = T_IN + T_HOLD + T_OUT

interface Floaty {
  el: HTMLElement
  x: number
  z: number
  age: number
}

export class DamageIndicators {
  private readonly container: HTMLDivElement
  private readonly floaties: Floaty[] = []
  private readonly projected = new Vector3()
  private rafHandle = 0
  private lastTime = 0
  private disposed = false

  constructor() {
    this.container = document.createElement('div')
    Object.assign(this.container.style, {
      position: 'fixed',
      inset: '0',
      overflow: 'hidden',
      pointerEvents: 'none',
      zIndex: '60',
    })
    document.body.appendChild(this.container)
    this.lastTime = performance.now()
    this.loop()
  }

  /** Spawn an indicator over `position` (a target's feet-level world position). */
  spawn(position: Vector3, hit: boolean, damage: number): void {
    const el = document.createElement('div')
    el.textContent = hit ? `\u2212${damage}` : 'MISS'
    Object.assign(el.style, {
      position: 'absolute',
      left: '0',
      top: '0',
      willChange: 'transform, opacity',
      opacity: '0',
      whiteSpace: 'nowrap',
      fontFamily: "'Segoe UI', 'Inter', system-ui, sans-serif",
      fontWeight: '800',
      fontSize: hit ? '30px' : '24px',
      letterSpacing: '0.5px',
      color: hit ? '#ff5a4a' : '#c9d4e3',
      textShadow: '0 0 6px rgba(0,0,0,0.9), 0 2px 3px rgba(0,0,0,0.9)',
    })
    this.container.appendChild(el)
    this.floaties.push({ el, x: position.x, z: position.z, age: 0 })
  }

  private readonly loop = (): void => {
    if (this.disposed) return
    const now = performance.now()
    const delta = Math.min(0.1, (now - this.lastTime) / 1000)
    this.lastTime = now
    this.update(delta)
    this.rafHandle = requestAnimationFrame(this.loop)
  }

  private update(delta: number): void {
    if (this.floaties.length === 0) return

    const camera = Game.instance().camera.instance
    camera.updateMatrixWorld()
    const canvas = Game.instance().canvas
    const width = canvas.clientWidth
    const height = canvas.clientHeight

    for (let i = this.floaties.length - 1; i >= 0; i--) {
      const f = this.floaties[i]!
      f.age += delta
      if (f.age >= LIFETIME) {
        f.el.remove()
        this.floaties.splice(i, 1)
        continue
      }

      let y: number
      let opacity: number
      let scale: number
      if (f.age < T_IN) {
        const t = f.age / T_IN
        const eased = smoothstep(t)
        y = CHEST_Y + (HEAD_Y - CHEST_Y) * eased
        opacity = t
        scale = 0.5 + 0.5 * eased
      } else if (f.age < T_IN + T_HOLD) {
        y = HEAD_Y
        opacity = 1
        scale = 1
      } else {
        const t = (f.age - T_IN - T_HOLD) / T_OUT
        y = HEAD_Y + RISE_Y * t
        opacity = 1 - t
        scale = 1
      }

      this.projected.set(f.x, y, f.z).project(camera)
      // Behind the camera / off the depth range: keep invisible this frame.
      if (this.projected.z > 1 || this.projected.z < -1) {
        f.el.style.opacity = '0'
        continue
      }

      const sx = (this.projected.x * 0.5 + 0.5) * width
      const sy = (-this.projected.y * 0.5 + 0.5) * height
      f.el.style.transform = `translate(${sx}px, ${sy}px) translate(-50%, -50%) scale(${scale})`
      f.el.style.opacity = String(opacity)
    }
  }

  dispose(): void {
    this.disposed = true
    cancelAnimationFrame(this.rafHandle)
    for (const f of this.floaties) f.el.remove()
    this.floaties.length = 0
    this.container.remove()
  }
}
