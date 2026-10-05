import {
  AdditiveBlending,
  CanvasTexture,
  DoubleSide,
  Group,
  Mesh,
  MeshBasicMaterial,
  RingGeometry,
  Sprite,
  SpriteMaterial,
  Vector3,
} from 'three'
import { GrenadeId } from '../core/Arsenal'
import type { EngineContext } from '../engine'

const GRAVITY = 9.8

/** One thing in a blast: it is given its progress through its life, and tidies up after itself. */
interface Piece {
  age: number
  duration: number
  tick(t: number, delta: number): void
  dispose(): void
}

/**
 * The picture of a grenade going off: a fireball, a shockwave on the floor and
 * a spray of sparks. Drawn from nothing but a gradient and a ring, so it needs
 * no assets. The fullscreen flash, the shake and the smoke that lingers are
 * somebody else's; this is the few tenths of a second in the middle.
 *
 * Presentation only: it draws its own randomness, because nothing here is
 * state and nothing here reaches the rules.
 */
export class Blast {
  private readonly group = new Group()
  private readonly pieces: Piece[] = []
  private fireTexture: CanvasTexture | null = null
  private whiteTexture: CanvasTexture | null = null
  private sparkTexture: CanvasTexture | null = null
  private ringGeometry: RingGeometry | null = null

  constructor(private readonly engine: EngineContext) {
    this.group.name = 'grenade-blast'
    engine.scene.add(this.group)
  }

  /**
   * Set off the picture for `kind` at `at`, `radius` metres across. Smoke has
   * no bang to draw, and a thrown flashbang has a burst of light but no fire.
   */
  spawn(at: Vector3, radius: number, kind: GrenadeId): void {
    const centre = at.clone()
    centre.y += 0.35
    if (kind === GrenadeId.Frag) {
      this.fireball(centre, radius, this.fire(), 1)
      this.shockwave(at, radius, 0xffc890)
      this.sparks(centre, radius, 14)
    } else if (kind === GrenadeId.Incendiary) {
      this.fireball(centre, radius, this.fire(), 0.8)
      this.sparks(centre, radius, 6)
    } else if (kind === GrenadeId.Flash) {
      this.fireball(centre, radius, this.white(), 0.7)
      this.shockwave(at, radius, 0xffffff)
    }
  }

  update(delta: number): void {
    for (let i = this.pieces.length - 1; i >= 0; i--) {
      const piece = this.pieces[i]!
      piece.age += delta
      const t = Math.min(piece.age / piece.duration, 1)
      piece.tick(t, delta)
      if (t >= 1) {
        piece.dispose()
        this.pieces.splice(i, 1)
      }
    }
  }

  dispose(): void {
    for (const piece of this.pieces) piece.dispose()
    this.pieces.length = 0
    this.engine.scene.remove(this.group)
    this.fireTexture?.dispose()
    this.whiteTexture?.dispose()
    this.sparkTexture?.dispose()
    this.ringGeometry?.dispose()
  }

  /** A ball of light that swells fast, then thins out. */
  private fireball(at: Vector3, radius: number, map: CanvasTexture, strength: number): void {
    const material = new SpriteMaterial({
      map,
      transparent: true,
      blending: AdditiveBlending,
      depthWrite: false,
    })
    const sprite = new Sprite(material)
    sprite.position.copy(at)
    sprite.material.rotation = Math.random() * Math.PI * 2
    this.group.add(sprite)
    const full = Math.max(1.6, radius * 2.4) * strength
    this.pieces.push({
      age: 0,
      duration: 0.4,
      tick: (t) => {
        // Out fast and slowing, which is what a pressure front does.
        const grown = 1 - (1 - t) ** 3
        const size = full * (0.25 + 0.75 * grown)
        sprite.scale.set(size, size, 1)
        material.opacity = (1 - t) ** 1.5
      },
      dispose: () => {
        this.group.remove(sprite)
        material.dispose()
      },
    })
  }

  /** A ring racing out across the floor. */
  private shockwave(at: Vector3, radius: number, color: number): void {
    this.ringGeometry ??= new RingGeometry(0.88, 1, 40)
    const material = new MeshBasicMaterial({
      color,
      transparent: true,
      blending: AdditiveBlending,
      depthWrite: false,
      side: DoubleSide,
    })
    const ring = new Mesh(this.ringGeometry, material)
    ring.rotation.x = -Math.PI / 2
    ring.position.set(at.x, at.y + 0.06, at.z)
    this.group.add(ring)
    const reach = Math.max(1, radius) * 1.15
    this.pieces.push({
      age: 0,
      duration: 0.38,
      tick: (t) => {
        const size = reach * (1 - (1 - t) ** 2)
        ring.scale.set(size, size, 1)
        material.opacity = (1 - t) * 0.8
      },
      dispose: () => {
        this.group.remove(ring)
        material.dispose()
      },
    })
  }

  /** Hot fragments thrown out and pulled down. */
  private sparks(at: Vector3, radius: number, count: number): void {
    const map = this.spark()
    for (let i = 0; i < count; i++) {
      const material = new SpriteMaterial({
        map,
        transparent: true,
        blending: AdditiveBlending,
        depthWrite: false,
      })
      const sprite = new Sprite(material)
      sprite.position.copy(at)
      const size = 0.12 + Math.random() * 0.1
      sprite.scale.set(size, size, 1)
      this.group.add(sprite)

      const heading = Math.random() * Math.PI * 2
      const speed = (2 + Math.random() * 3) * Math.max(1, radius * 0.6)
      const velocity = new Vector3(Math.cos(heading) * speed, 2 + Math.random() * 3, Math.sin(heading) * speed)
      this.pieces.push({
        age: 0,
        duration: 0.45 + Math.random() * 0.25,
        tick: (t, delta) => {
          velocity.y -= GRAVITY * delta
          sprite.position.addScaledVector(velocity, delta)
          // Never through the floor it was thrown across.
          if (sprite.position.y < at.y - 0.3) {
            sprite.position.y = at.y - 0.3
            velocity.y = Math.abs(velocity.y) * 0.3
          }
          material.opacity = 1 - t
        },
        dispose: () => {
          this.group.remove(sprite)
          material.dispose()
        },
      })
    }
  }

  private fire(): CanvasTexture {
    return (this.fireTexture ??= gradient([
      [0, 'rgba(255, 250, 220, 1)'],
      [0.25, 'rgba(255, 190, 80, 0.9)'],
      [0.55, 'rgba(255, 90, 20, 0.45)'],
      [1, 'rgba(120, 20, 0, 0)'],
    ]))
  }

  private white(): CanvasTexture {
    return (this.whiteTexture ??= gradient([
      [0, 'rgba(255, 255, 255, 1)'],
      [0.35, 'rgba(235, 240, 255, 0.7)'],
      [1, 'rgba(220, 230, 255, 0)'],
    ]))
  }

  private spark(): CanvasTexture {
    return (this.sparkTexture ??= gradient([
      [0, 'rgba(255, 255, 230, 1)'],
      [0.4, 'rgba(255, 170, 60, 0.9)'],
      [1, 'rgba(255, 90, 20, 0)'],
    ]))
  }
}

/** A round soft sprite: colour stops from the centre out. */
function gradient(stops: readonly [number, string][]): CanvasTexture {
  const size = 64
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')!
  const grad = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2)
  for (const [at, color] of stops) grad.addColorStop(at, color)
  ctx.fillStyle = grad
  ctx.fillRect(0, 0, size, size)
  return new CanvasTexture(canvas)
}
