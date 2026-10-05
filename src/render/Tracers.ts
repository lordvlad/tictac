import {
  AdditiveBlending,
  BufferGeometry,
  BoxGeometry,
  CanvasTexture,
  Group,
  Line,
  LineBasicMaterial,
  Mesh,
  MeshBasicMaterial,
  NormalBlending,
  PointLight,
  Sprite,
  SpriteMaterial,
  Vector3,
} from 'three'
import type { EngineContext } from '../engine'
import { EYE_HEIGHT } from '../config'

/** How far in front of the shooter, and how far below the eye, a muzzle is. */
const MUZZLE_FORWARD = 0.55
const MUZZLE_DROP = 0.25

/** A sprite that swells, drifts and fades once, then is gone: a flash, a spark, a puff of dust. */
interface Pop {
  sprite: Sprite
  age: number
  duration: number
  from: number
  to: number
  /** Metres per second upward. */
  rise: number
}

/** A spent case on its way to the floor, and then lying on it for a moment. */
interface Casing {
  mesh: Mesh
  velocity: Vector3
  spin: Vector3
  age: number
  floor: number
}

const GRAVITY = 9.8
const CASING_LIFETIME = 1.6
const CASING_SHRINK = 0.3

export class Tracers {
  constructor(private readonly engine: EngineContext) {}

  private activeTracers: { line: Line; light: PointLight; age: number; duration: number }[] = []
  private readonly pops: Pop[] = []
  private readonly popGroup = new Group()
  private readonly casings: Casing[] = []
  private casingGeometry: BoxGeometry | null = null
  private casingMaterial: MeshBasicMaterial | null = null
  private flashTexture: CanvasTexture | null = null
  private dustTexture: CanvasTexture | null = null

  spawnTracer(fromWorld: Vector3, toWorld: Vector3, hit: boolean): void {
    const scene = this.engine.scene
    if (!this.popGroup.parent) {
      this.popGroup.name = 'tracer-pops'
      scene.add(this.popGroup)
    }

    const eye = fromWorld.clone().add(new Vector3(0, EYE_HEIGHT, 0))
    const target = toWorld.clone().add(new Vector3(0, EYE_HEIGHT, 0))

    if (!hit) {
      // Offset missed shots slightly past or to the side of target
      target.x += (Math.random() - 0.5) * 1.5
      target.z += (Math.random() - 0.5) * 1.5
    }

    // The round leaves the muzzle, not the eye.
    const heading = new Vector3(target.x - eye.x, 0, target.z - eye.z)
    if (heading.lengthSq() > 0) heading.normalize()
    const origin = eye.clone().addScaledVector(heading, MUZZLE_FORWARD)
    origin.y -= MUZZLE_DROP

    const geometry = new BufferGeometry().setFromPoints([origin, target])
    const material = new LineBasicMaterial({
      color: 0xffe066,
      linewidth: 2,
    })

    const line = new Line(geometry, material)
    scene.add(line)

    const light = new PointLight(0xffaa22, 5, 4)
    light.position.copy(origin)
    scene.add(light)

    this.activeTracers.push({ line, light, age: 0, duration: 0.15 })

    this.muzzleFlash(origin)
    this.ejectCase(origin, heading, fromWorld.y)
    if (hit) this.sparks(target)
    else this.dust(new Vector3(target.x, toWorld.y + 0.1, target.z))
  }

  update(delta: number): void {
    const scene = this.engine.scene

    for (let i = this.activeTracers.length - 1; i >= 0; i--) {
      const tracer = this.activeTracers[i]!
      tracer.age += delta

      if (tracer.age >= tracer.duration) {
        scene.remove(tracer.line)
        scene.remove(tracer.light)
        tracer.line.geometry.dispose()
        ;(tracer.line.material as LineBasicMaterial).dispose()
        tracer.light.dispose()
        this.activeTracers.splice(i, 1)
      } else {
        // Fade light
        tracer.light.intensity = 5 * (1 - tracer.age / tracer.duration)
      }
    }

    for (let i = this.casings.length - 1; i >= 0; i--) {
      const casing = this.casings[i]!
      casing.age += delta
      if (casing.age >= CASING_LIFETIME) {
        this.popGroup.remove(casing.mesh)
        this.casings.splice(i, 1)
        continue
      }
      const { mesh, velocity } = casing
      velocity.y -= GRAVITY * delta
      mesh.position.addScaledVector(velocity, delta)
      mesh.rotation.x += casing.spin.x * delta
      mesh.rotation.y += casing.spin.y * delta
      mesh.rotation.z += casing.spin.z * delta
      if (mesh.position.y < casing.floor) {
        // One skip and it settles: damped, then lying where it landed.
        mesh.position.y = casing.floor
        velocity.y = Math.abs(velocity.y) * 0.35
        velocity.x *= 0.5
        velocity.z *= 0.5
        casing.spin.multiplyScalar(0.4)
      }
      const left = CASING_LIFETIME - casing.age
      const scale = left < CASING_SHRINK ? left / CASING_SHRINK : 1
      mesh.scale.setScalar(scale)
    }

    for (let i = this.pops.length - 1; i >= 0; i--) {
      const pop = this.pops[i]!
      pop.age += delta
      const t = Math.min(pop.age / pop.duration, 1)
      if (t >= 1) {
        this.popGroup.remove(pop.sprite)
        pop.sprite.material.dispose()
        this.pops.splice(i, 1)
        continue
      }
      const size = pop.from + (pop.to - pop.from) * (1 - (1 - t) ** 2)
      pop.sprite.scale.set(size, size, 1)
      pop.sprite.position.y += pop.rise * delta
      pop.sprite.material.opacity = 1 - t
    }
  }

  dispose(): void {
    const scene = this.engine.scene
    for (const tracer of this.activeTracers) {
      scene.remove(tracer.line)
      scene.remove(tracer.light)
      tracer.line.geometry.dispose()
      ;(tracer.line.material as LineBasicMaterial).dispose()
      tracer.light.dispose()
    }
    this.activeTracers = []
    for (const pop of this.pops) pop.sprite.material.dispose()
    this.pops.length = 0
    this.casings.length = 0
    this.casingGeometry?.dispose()
    this.casingMaterial?.dispose()
    scene.remove(this.popGroup)
    this.flashTexture?.dispose()
    this.dustTexture?.dispose()
  }

  /**
   * A brass case thrown out to the shooter's right, up and a little back,
   * landing on the floor at `floor` (the shooter's feet).
   */
  private ejectCase(from: Vector3, heading: Vector3, floor: number): void {
    this.casingGeometry ??= new BoxGeometry(0.05, 0.02, 0.02)
    this.casingMaterial ??= new MeshBasicMaterial({ color: 0xd9a441 })
    const mesh = new Mesh(this.casingGeometry, this.casingMaterial)
    mesh.position.copy(from).addScaledVector(heading, -0.2)
    this.popGroup.add(mesh)

    // Right-hand side of the heading, which is where a rifle's port is.
    const right = new Vector3(-heading.z, 0, heading.x)
    const velocity = right.multiplyScalar(1.3 + Math.random() * 0.8)
    velocity.addScaledVector(heading, -0.3 + Math.random() * 0.4)
    velocity.y = 1.6 + Math.random() * 0.8
    const spin = new Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(40)
    this.casings.push({ mesh, velocity, spin, age: 0, floor: floor + 0.02 })
  }

  /** A four-point star that is there for a handful of frames. */
  private muzzleFlash(at: Vector3): void {
    this.pop(this.flash(), at, 0.35 + Math.random() * 0.15, 0.8, 0.07, AdditiveBlending, 0)
  }

  /** A flicker where a round landed on somebody. */
  private sparks(at: Vector3): void {
    this.pop(this.flash(), at, 0.15, 0.45, 0.12, AdditiveBlending, 0)
  }

  /** A puff kicked up where a round landed on nobody. */
  private dust(at: Vector3): void {
    this.pop(this.dustSprite(), at, 0.2, 0.9, 0.45, NormalBlending, 0.5)
  }

  private pop(
    map: CanvasTexture,
    at: Vector3,
    from: number,
    to: number,
    duration: number,
    blending: typeof AdditiveBlending | typeof NormalBlending,
    rise: number,
  ): void {
    const material = new SpriteMaterial({ map, transparent: true, blending, depthWrite: false })
    material.rotation = Math.random() * Math.PI * 2
    const sprite = new Sprite(material)
    sprite.position.copy(at)
    sprite.scale.set(from, from, 1)
    this.popGroup.add(sprite)
    this.pops.push({ sprite, age: 0, duration, from, to, rise })
  }

  private flash(): CanvasTexture {
    if (this.flashTexture) return this.flashTexture
    const size = 64
    const canvas = document.createElement('canvas')
    canvas.width = size
    canvas.height = size
    const ctx = canvas.getContext('2d')!
    const c = size / 2

    const glow = ctx.createRadialGradient(c, c, 0, c, c, c)
    glow.addColorStop(0, 'rgba(255, 255, 235, 1)')
    glow.addColorStop(0.25, 'rgba(255, 210, 110, 0.85)')
    glow.addColorStop(1, 'rgba(255, 140, 40, 0)')
    ctx.fillStyle = glow
    ctx.fillRect(0, 0, size, size)

    // The spikes: long and thin along both axes and a shorter pair between.
    ctx.strokeStyle = 'rgba(255, 240, 190, 0.95)'
    ctx.lineCap = 'round'
    for (let i = 0; i < 4; i++) {
      const angle = (i * Math.PI) / 4
      const reach = i % 2 === 0 ? c * 0.95 : c * 0.55
      ctx.lineWidth = i % 2 === 0 ? 3 : 2
      ctx.beginPath()
      ctx.moveTo(c - Math.cos(angle) * reach, c - Math.sin(angle) * reach)
      ctx.lineTo(c + Math.cos(angle) * reach, c + Math.sin(angle) * reach)
      ctx.stroke()
    }

    this.flashTexture = new CanvasTexture(canvas)
    return this.flashTexture
  }

  private dustSprite(): CanvasTexture {
    if (this.dustTexture) return this.dustTexture
    const size = 64
    const canvas = document.createElement('canvas')
    canvas.width = size
    canvas.height = size
    const ctx = canvas.getContext('2d')!
    const grad = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2)
    grad.addColorStop(0, 'rgba(150, 140, 125, 0.55)')
    grad.addColorStop(0.5, 'rgba(140, 130, 115, 0.3)')
    grad.addColorStop(1, 'rgba(130, 120, 105, 0)')
    ctx.fillStyle = grad
    ctx.fillRect(0, 0, size, size)
    this.dustTexture = new CanvasTexture(canvas)
    return this.dustTexture
  }
}
