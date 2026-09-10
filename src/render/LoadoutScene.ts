import {
  AmbientLight,
  AnimationMixer,
  BoxGeometry,
  Color,
  DirectionalLight,
  Fog,
  Group,
  HemisphereLight,
  Mesh,
  MeshStandardMaterial,
  type Object3D,
  PlaneGeometry,
} from 'three'
import { clone } from 'three/examples/jsm/utils/SkeletonUtils.js'
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js'
import type { EngineContext } from '../engine'
import { Faction, SQUAD_SIZE } from '../config'
import { Rng } from '../core/rng'
import { soldierColor } from '../entities/palette'

/** Radius of the arc the squad stands on. Wide enough that neighbours read as
 *  a line-up rather than a huddle: 50 degrees apart is 2.7 m of daylight. */
const RING_RADIUS = 3.2
/** Angle between neighbouring members. Four of them span 150 degrees. */
const SPOKE_STEP = (50 * Math.PI) / 180
/** Gap between the member on the arc and the camera in front of them. */
const CAMERA_GAP = 6.5
/** Camera height: a person's eye line. */
const EYE_HEIGHT = 1.65
/** Height of the point the camera looks at, so a whole body sits in frame. */
const LOOK_HEIGHT = 1.0
/** How fast the camera swings to a newly selected member. */
const SWING_RATE = 6

/**
 * The pre-combat staging ground: the squad on a semi-circle, backs to its
 * centre, on a lit floor with a few walls out in the fog.
 *
 * Deliberately self-contained. {@link Battlefield} does not exist yet at this
 * point in the boot flow, so this owns its own floor, lighting, sky and fog and
 * takes every one of them back out of the scene on {@link dispose}, leaving the
 * battlefield's own dressing authoritative when the match starts.
 *
 * The camera is driven directly rather than through {@link OrbitRig}: the rig
 * binds every pointer, wheel and pinch gesture on the canvas, and its tactical
 * tilt is a function of zoom distance, so eye level is not a pose it can hold.
 */
export class LoadoutScene {
  private readonly added: Object3D[] = []
  private readonly mixers: AnimationMixer[] = []
  private readonly geometries: { dispose: () => void }[] = []
  private readonly materials: { dispose: () => void }[] = []

  private angleTarget = -1.5 * SPOKE_STEP
  private angleCurrent = -1.5 * SPOKE_STEP

  private rafHandle = 0
  private lastFrameTime = 0
  private disposed = false

  constructor(
    private readonly engine: EngineContext,
    seed: number,
  ) {
    const scene = this.engine.scene
    const sky = new Color(0x05070a)
    scene.background = sky
    scene.fog = new Fog(sky.getHex(), 50, 110)

    this.buildFloor()
    this.buildWalls(new Rng(seed))
    this.buildLights()
    this.buildSquad()

    this.lastFrameTime = performance.now()
    this.loop()
  }

  /** Swing the camera round to the member on this spoke. */
  select(index: number): void {
    this.angleTarget = LoadoutScene.spokeAngle(index)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    cancelAnimationFrame(this.rafHandle)

    const scene = this.engine.scene
    for (const object of this.added) scene.remove(object)
    for (const mixer of this.mixers) mixer.stopAllAction()
    for (const geometry of this.geometries) geometry.dispose()
    for (const material of this.materials) material.dispose()
    this.added.length = 0
    this.mixers.length = 0

    scene.background = null
    scene.fog = null
  }

  // ---------------------------------------------------------------------------
  // Scene contents
  // ---------------------------------------------------------------------------

  /** Where squad member `index` stands, as an angle about the arc's centre. */
  private static spokeAngle(index: number): number {
    return (index - (SQUAD_SIZE - 1) / 2) * SPOKE_STEP
  }

  private add(object: Object3D): void {
    this.engine.scene.add(object)
    this.added.push(object)
  }

  private buildFloor(): void {
    const geometry = new PlaneGeometry(80, 80)
    const material = new MeshStandardMaterial({ color: 0x6c6f63, roughness: 0.95, metalness: 0 })
    const floor = new Mesh(geometry, material)
    floor.rotation.x = -Math.PI / 2
    floor.receiveShadow = true
    this.geometries.push(geometry)
    this.materials.push(material)
    this.add(floor)
  }

  /**
   * Slabs scattered out in the fog. Seeded off the match seed, so reloading the
   * same `?seed=` stages the squad against the same skyline.
   */
  private buildWalls(rng: Rng): void {
    const material = new MeshStandardMaterial({ color: 0x55606e, roughness: 0.9, metalness: 0 })
    this.materials.push(material)

    for (let i = 0; i < 14; i++) {
      const width = rng.range(3, 9)
      const height = rng.range(3, 7)
      const geometry = new BoxGeometry(width, height, 0.6)
      this.geometries.push(geometry)

      const wall = new Mesh(geometry, material)
      const angle = rng.range(0, Math.PI * 2)
      const distance = rng.range(18, 34)
      wall.position.set(Math.sin(angle) * distance, height / 2, Math.cos(angle) * distance)
      wall.rotation.y = angle + rng.range(-0.4, 0.4)
      wall.castShadow = true
      this.add(wall)
    }
  }

  /** The battlefield's own lighting, so the handover to combat is not a jump. */
  private buildLights(): void {
    this.add(new AmbientLight(0xffffff, 0.5))
    this.add(new HemisphereLight(0x9fc4ff, 0x30281f, 0.55))

    const sun = new DirectionalLight(0xfff1d8, 1.6)
    sun.position.set(24, 38, 18)
    sun.castShadow = true
    sun.shadow.mapSize.set(2048, 2048)
    sun.shadow.camera.near = 1
    sun.shadow.camera.far = 120
    sun.shadow.normalBias = 0.04
    sun.shadow.bias = -0.0005
    this.add(sun)
    this.add(sun.target)
  }

  private buildSquad(): void {
    const gltf = this.engine.assets['character'] as GLTF | undefined
    if (!gltf) return

    const idle = gltf.animations.find((animation) => animation.name === 'idle')

    for (let index = 0; index < SQUAD_SIZE; index++) {
      const model = clone(gltf.scene) as Group
      const angle = LoadoutScene.spokeAngle(index)
      model.position.set(Math.sin(angle) * RING_RADIUS, 0, Math.cos(angle) * RING_RADIUS)
      // Yaw 0 faces +Z, so the spoke angle is exactly "facing outward".
      model.rotation.y = angle
      model.scale.set(1, 1, 1)

      const tint = soldierColor(Faction.Blue, index)
      model.traverse((child) => {
        if (child instanceof Mesh && child.material) {
          const material = (child.material as MeshStandardMaterial).clone()
          material.color.copy(tint)
          child.material = material
          child.castShadow = true
          this.materials.push(material)
        }
      })

      this.add(model)

      if (idle) {
        const mixer = new AnimationMixer(model)
        mixer.clipAction(idle).play()
        this.mixers.push(mixer)
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Frame loop
  // ---------------------------------------------------------------------------

  private readonly loop = (): void => {
    if (this.disposed) return
    const now = performance.now()
    const delta = Math.min(0.1, (now - this.lastFrameTime) / 1000)
    this.lastFrameTime = now

    for (const mixer of this.mixers) mixer.update(delta)

    // Shortest way round, so selecting across the arc never unwinds the long way.
    const difference = this.angleTarget - this.angleCurrent
    const step = Math.atan2(Math.sin(difference), Math.cos(difference))
    this.angleCurrent += step * (1 - Math.exp(-SWING_RATE * delta))

    const distance = RING_RADIUS + CAMERA_GAP
    const camera = this.engine.camera
    camera.position.set(
      Math.sin(this.angleCurrent) * distance,
      EYE_HEIGHT,
      Math.cos(this.angleCurrent) * distance,
    )
    camera.lookAt(0, LOOK_HEIGHT, 0)

    this.rafHandle = requestAnimationFrame(this.loop)
  }
}
