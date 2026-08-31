import {
  AmbientLight,
  Box3,
  Color,
  DirectionalLight,
  Group,
  Mesh,
  MeshStandardMaterial,
  PerspectiveCamera,
  Scene,
  Vector3,
  WebGLRenderer,
} from 'three'
import { clone } from 'three/examples/jsm/utils/SkeletonUtils.js'
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js'
import type { EngineContext } from '../engine'
import { Faction, FACTION_INFO, SOLDIER_HEIGHT, SQUAD_SIZE } from '../config'

export class OffscreenPortraits {
  private readonly portraits = new Map<string, string>()

  constructor(private readonly engine: EngineContext) {
    this.generateAll()
  }

  getPortrait(faction: Faction, squadIndex: number): string {
    const key = `${faction}_${squadIndex}`
    return this.portraits.get(key) ?? ''
  }

  private generateAll(): void {
    const gltf = this.engine.assets['character'] as GLTF | undefined
    if (!gltf) return

    const canvas = document.createElement('canvas')
    canvas.width = 128
    canvas.height = 128

    const renderer = new WebGLRenderer({
      canvas,
      alpha: false,
      antialias: true,
      preserveDrawingBuffer: true,
    })
    renderer.setPixelRatio(1)
    renderer.setSize(128, 128)
    renderer.setClearColor(0x1a222d, 1)

    const scene = new Scene()
    const camera = new PerspectiveCamera(30, 1, 0.1, 10)

    scene.add(new AmbientLight(0xffffff, 1.2))
    const dir = new DirectionalLight(0xffffff, 1.5)
    dir.position.set(1, 2, 2)
    scene.add(dir)

    for (const faction of [Faction.Blue, Faction.Red]) {
      const color = FACTION_INFO[faction].color

      for (let index = 0; index < SQUAD_SIZE; index++) {
        const model = clone(gltf.scene) as Group
        model.position.set(0, 0, 0)
        // The rig faces +Z at yaw 0 (same convention as in-game movement) and
        // the portrait camera sits on +Z, so no rotation is needed. Turning it
        // by PI here is what produced portraits of the back of everyone's head.
        model.rotation.y = 0
        model.scale.set(1, 1, 1)
        model.updateMatrixWorld(true)

        // Tint material
        model.traverse((child) => {
          if (child instanceof Mesh && child.material) {
            const mat = (child.material as MeshStandardMaterial).clone()
            mat.color.setHex(color)
            child.material = mat
          }
        })

        scene.add(model)

        // Head is roughly at y = 1.62
        camera.position.set(0, 1.62, 0.75)
        camera.lookAt(new Vector3(0, 1.58, 0))
        renderer.render(scene, camera)
        const dataUrl = canvas.toDataURL('image/png')
        this.portraits.set(`${faction}_${index}`, dataUrl)

        scene.remove(model)
      }
    }

    renderer.dispose()
  }
}
