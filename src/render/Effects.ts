import {
  AdditiveBlending,
  CanvasTexture,
  Group,
  Mesh,
  MeshBasicMaterial,
  NormalBlending,
  SphereGeometry,
  Sprite,
  SpriteMaterial,
  Vector3,
} from 'three'
import { FX } from '../config'
import { GrenadeId } from '../core/Arsenal'
import type { EngineContext } from '../engine'

interface FlashState {
  time: number
  duration: number
  /** Tint: frag is warm orange-red, flashbang is blinding pure white. */
  color: string
}

interface SmokePuff {
  sprite: Sprite
  velocity: Vector3
  spin: number
  age: number
  lifetime: number
}
interface ActiveGrenade {
  mesh: Mesh
  /** The flight as drawn, in world space. */
  points: readonly Vector3[]
  /** Distance along `points` to each of them, so the grenade keeps one speed through every bend. */
  along: number[]
  /** Index of the point the grenade is heading for. */
  next: number
  elapsed: number
  duration: number
  onLanded: () => void
}

/**
 * Visual effects for grenades: the fullscreen DOM flash and transient blast
 * puffs. Smoke that lasts is the ground's (`GroundFx`), because how long it
 * lasts is a rule.
 *
 * Persists across frames. The controller updates it in its frame loop.
 */
export class Effects {
  private readonly flashEl: HTMLDivElement
  private readonly smokeGroup = new Group()
  private readonly grenadeGroup = new Group()

  private flash: FlashState | null = null
  private readonly puffs: SmokePuff[] = []
  private readonly activeGrenades: ActiveGrenade[] = []

  private smokeTexture: CanvasTexture | null = null
  private grenadeGeometry: SphereGeometry | null = null
  private grenadeMaterial: MeshBasicMaterial | null = null

  constructor(private readonly engine: EngineContext) {
    this.flashEl = document.createElement('div')
    this.flashEl.className = 'fullscreen-flash'
    Object.assign(this.flashEl.style, {
      position: 'fixed',
      inset: '0',
      pointerEvents: 'none',
      zIndex: '150',
      opacity: '0',
      willChange: 'opacity, background-color',
    })
    document.body.appendChild(this.flashEl)

    this.smokeGroup.name = 'grenade-effects'
    this.grenadeGroup.name = 'grenade-projectiles'
    engine.scene.add(this.smokeGroup)
    engine.scene.add(this.grenadeGroup)
  }

  dispose(): void {
    this.flashEl.remove()
    this.engine.scene.remove(this.smokeGroup)
    this.engine.scene.remove(this.grenadeGroup)
    for (const p of this.puffs) {
      p.sprite.geometry.dispose()
      ;(p.sprite.material as SpriteMaterial).dispose()
    }
    for (const g of this.activeGrenades) {
      this.grenadeGroup.remove(g.mesh)
    }
    this.grenadeGeometry?.dispose()
    this.grenadeMaterial?.dispose()
    this.smokeTexture?.dispose()
  }
  /** Trigger the fullscreen overlay flash. */
  triggerFlash(kind: GrenadeId): void {
    if (kind === GrenadeId.Flash) {
      this.flash = { time: 0, duration: FX.flashDurationFlashbang, color: 'rgba(255, 255, 255, 0.96)' }
    } else if (kind === GrenadeId.Frag) {
      // Warm warm-orange/red explosion flash
      this.flash = { time: 0, duration: FX.flashDurationFrag, color: 'rgba(255, 120, 40, 0.72)' }
    }
  }

  /** Spawn quick blast puffs that expand, spin and fade over a fraction of a second. */
  spawnBlastPuffs(worldPos: Vector3, radius: number): void {
    const texture = this.getSmokeTexture()
    const count = Math.round(14 * radius)
    for (let i = 0; i < count; i++) {
      const mat = new SpriteMaterial({
        map: texture,
        transparent: true,
        blending: NormalBlending,
        depthWrite: false,
        opacity: 0.85,
      })
      const sprite = new Sprite(mat)

      // Randomised offset within the sphere
      const theta = Math.random() * Math.PI * 2
      const phi = Math.acos(Math.random() * 2 - 1)
      const r = Math.random() * radius * 0.8
      const offset = new Vector3(
        Math.sin(phi) * Math.cos(theta) * r,
        Math.abs(Math.sin(phi) * Math.sin(theta)) * r * 0.5 + 0.1, // keep above floor
        Math.cos(phi) * r,
      )
      sprite.position.copy(worldPos).add(offset)

      // Grow size randomly
      const sz = FX.smokeSpriteSize * (0.6 + Math.random() * 0.8)
      sprite.scale.set(sz, sz, 1)
      sprite.material.rotation = Math.random() * Math.PI * 2
      this.smokeGroup.add(sprite)

      // High speed outward blow, with rising heat buoyancy
      const vel = offset.clone().normalize().multiplyScalar(1.5 + Math.random() * 2.5)
      vel.y += 1.0 + Math.random() * 1.5

      this.puffs.push({
        sprite,
        velocity: vel,
        spin: (Math.random() * 2 - 1) * 2,
        age: 0,
        lifetime: 0.35 + Math.random() * 0.35, // short blast life
      })
    }
  }

  /**
   * Fly a grenade along `points` — the whole flight, arc and bounces already
   * in them — at one steady speed, and call `onLanded` when it gets there.
   */
  spawnGrenade(points: readonly Vector3[], onLanded: () => void): void {
    const along = [0]
    for (let i = 1; i < points.length; i++) along.push(along[i - 1]! + points[i]!.distanceTo(points[i - 1]!))
    const total = along[along.length - 1]!
    if (total === 0) {
      onLanded()
      return
    }

    this.grenadeGeometry ??= new SphereGeometry(0.12, 8, 8)
    this.grenadeMaterial ??= new MeshBasicMaterial({ color: 0x1a1a1a })
    const mesh = new Mesh(this.grenadeGeometry, this.grenadeMaterial)
    mesh.position.copy(points[0]!)
    this.grenadeGroup.add(mesh)
    this.activeGrenades.push({
      mesh,
      points,
      along,
      next: 1,
      elapsed: 0,
      duration: clamp(total * 0.05, 0.25, 0.6),
      onLanded,
    })
  }

  /** Per-frame update: animates flash, ticks transient puffs and flying grenades. */
  update(delta: number): void {
    // 1. Fullscreen flash
    if (this.flash) {
      this.flash.time += delta
      const progress = clamp(this.flash.time / this.flash.duration, 0, 1)
      if (progress >= 1) {
        this.flashEl.style.opacity = '0'
        this.flash = null
      } else {
        // Fast peak, slow decay
        const opacity = Math.sin(Math.pow(1 - progress, 2) * Math.PI / 2)
        this.flashEl.style.backgroundColor = this.flash.color
        this.flashEl.style.opacity = String(opacity)
      }
    }

    // 2. Grenades in the air
    for (let i = this.activeGrenades.length - 1; i >= 0; i--) {
      const g = this.activeGrenades[i]!
      g.elapsed += delta
      const last = g.points.length - 1
      const flown = clamp(g.elapsed / g.duration, 0, 1) * g.along[last]!
      while (g.next < last && g.along[g.next]! < flown) g.next++
      const from = g.along[g.next - 1]!
      const span = g.along[g.next]! - from
      g.mesh.position.lerpVectors(g.points[g.next - 1]!, g.points[g.next]!, span > 0 ? (flown - from) / span : 1)

      if (g.elapsed >= g.duration) {
        this.grenadeGroup.remove(g.mesh)
        this.activeGrenades.splice(i, 1)
        g.onLanded()
      }
    }

    // 3. Transient puffs (blast + fading smoke)
    for (let i = this.puffs.length - 1; i >= 0; i--) {
      const p = this.puffs[i]!
      p.age += delta
      if (p.age >= p.lifetime) {
        this.smokeGroup.remove(p.sprite)
        p.sprite.geometry.dispose()
        ;(p.sprite.material as SpriteMaterial).dispose()
        this.puffs.splice(i, 1)
        continue
      }

      // Drag slows them down, buoyancy lifts them
      p.velocity.multiplyScalar(1 - 4 * delta)
      p.sprite.position.addScaledVector(p.velocity, delta)
      p.sprite.material.rotation += p.spin * delta

      const progress = p.age / p.lifetime
      // Expand over life
      const sz = p.sprite.scale.x * (1 + 0.6 * delta)
      p.sprite.scale.set(sz, sz, 1)
      // Fade out
      p.sprite.material.opacity = (1 - progress) * 0.85
    }
  }

  private getSmokeTexture(): CanvasTexture {
    if (this.smokeTexture) return this.smokeTexture

    const size = 64
    const canvas = document.createElement('canvas')
    canvas.width = size
    canvas.height = size
    const ctx = canvas.getContext('2d')!

    const grad = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2)
    grad.addColorStop(0, 'rgba(80, 85, 90, 0.46)')
    grad.addColorStop(0.3, 'rgba(75, 80, 85, 0.28)')
    grad.addColorStop(0.7, 'rgba(65, 70, 75, 0.06)')
    grad.addColorStop(1, 'rgba(65, 70, 75, 0)')

    ctx.fillStyle = grad
    ctx.fillRect(0, 0, size, size)

    this.smokeTexture = new CanvasTexture(canvas)
    return this.smokeTexture
  }
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value
}
