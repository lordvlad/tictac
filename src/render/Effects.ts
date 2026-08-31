import {
  AdditiveBlending,
  CanvasTexture,
  Group,
  NormalBlending,
  Sprite,
  SpriteMaterial,
  Vector3,
} from 'three'
import { FX } from '../config'
import { GrenadeId } from '../core/Arsenal'
import type { Tile } from '../core/Grid'
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

/**
 * Visual effects for grenades: fullscreen DOM flash, 3D transient blast puffs
 * and persistent turn-based smoke fields.
 *
 * Persists across frames. The controller updates it in its frame loop and ticks
 * turns on turn switches.
 */
export class Effects {
  private readonly flashEl: HTMLDivElement
  private readonly smokeGroup = new Group()

  private flash: FlashState | null = null
  private readonly puffs: SmokePuff[] = []

  /** Persistent smoke clouds, keyed by tile index. */
  private readonly persistentClouds = new Map<number, { sprites: Sprite[]; age: number; turnsLeft: number }>()

  private smokeTexture: CanvasTexture | null = null

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
    engine.scene.add(this.smokeGroup)
  }

  dispose(): void {
    this.flashEl.remove()
    this.engine.scene.remove(this.smokeGroup)
    for (const p of this.puffs) {
      p.sprite.geometry.dispose()
      ;(p.sprite.material as SpriteMaterial).dispose()
    }
    for (const cloud of this.persistentClouds.values()) {
      for (const s of cloud.sprites) {
        s.geometry.dispose()
        ;(s.material as SpriteMaterial).dispose()
      }
    }
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

  /** Spawn a persistent smoke cloud over a tile that stays for `turns`. */
  spawnPersistentSmoke(tileIdx: number, worldPos: Vector3, radius: number, turns = 2): void {
    if (this.persistentClouds.has(tileIdx)) return

    const texture = this.getSmokeTexture()
    const sprites: Sprite[] = []
    const count = 9
    for (let i = 0; i < count; i++) {
      const mat = new SpriteMaterial({
        map: texture,
        transparent: true,
        blending: NormalBlending,
        depthWrite: false,
        opacity: 0.65,
      })
      const sprite = new Sprite(mat)

      const a = Math.random() * Math.PI * 2
      const r = Math.random() * radius * 0.5
      sprite.position.set(
        worldPos.x + Math.cos(a) * r,
        FX.smokeHeight + (Math.random() * 0.5 - 0.25),
        worldPos.z + Math.sin(a) * r,
      )
      const sz = FX.smokeSpriteSize * (0.8 + Math.random() * 0.6)
      sprite.scale.set(sz, sz, 1)
      sprite.material.rotation = Math.random() * Math.PI * 2
      this.smokeGroup.add(sprite)
      sprites.push(sprite)
    }

    this.persistentClouds.set(tileIdx, { sprites, age: 0, turnsLeft: turns })
  }

  /** Clear the persistent smoke cloud over a tile, fading it out. */
  clearPersistentSmoke(tileIdx: number): void {
    const cloud = this.persistentClouds.get(tileIdx)
    if (!cloud) return

    // Simple transition: spawn them as transient puffs with no speed, just
    // letting them fade out naturally.
    for (const sprite of cloud.sprites) {
      this.puffs.push({
        sprite,
        velocity: new Vector3(0, 0.15, 0), // slow drift
        spin: (Math.random() * 2 - 1) * 0.2,
        age: 0,
        lifetime: 0.5, // quick fade
      })
    }
    this.persistentClouds.delete(tileIdx)
  }
  /** Count down persistent smoke turns, fading out expired ones. */
  tickTurn(): void {
    for (const [tileIdx, cloud] of this.persistentClouds.entries()) {
      cloud.turnsLeft -= 1
      if (cloud.turnsLeft <= 0) this.clearPersistentSmoke(tileIdx)
    }
  }

  /** Per-frame update: animates flash, ticks transient puffs. */
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

    // 2. Transient puffs (blast + fading smoke)
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

    // 3. Idle drift on persistent clouds (gentle bobbing/spin)
    for (const cloud of this.persistentClouds.values()) {
      cloud.age += delta
      for (const s of cloud.sprites) {
        s.position.y += Math.sin(cloud.age * 2 + s.position.x) * 0.05 * delta
        s.material.rotation += 0.05 * delta
      }
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
    grad.addColorStop(0, 'rgba(255, 255, 255, 0.46)')
    grad.addColorStop(0.3, 'rgba(240, 240, 240, 0.28)')
    grad.addColorStop(0.7, 'rgba(200, 200, 200, 0.06)')
    grad.addColorStop(1, 'rgba(200, 200, 200, 0)')

    ctx.fillStyle = grad
    ctx.fillRect(0, 0, size, size)

    this.smokeTexture = new CanvasTexture(canvas)
    return this.smokeTexture
  }
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value
}
