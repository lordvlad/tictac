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
import { Faction, SQUAD_SIZE } from '../config'
import type { CharacterSheet } from '../core/Characters'
import { applyCharacterProportions } from './Proportions'
import { soldierColor } from '../entities/palette'
export class OffscreenPortraits {
  private readonly portraits = new Map<string, string>()

  constructor(
    private readonly engine: EngineContext,
    squads?: Partial<Record<Faction, readonly (CharacterSheet | undefined)[]>>,
  ) {
    this.generateAll(squads)
  }
  getPortrait(faction: Faction, squadIndex: number): string {
    const key = `${faction}_${squadIndex}`
    return this.portraits.get(key) ?? ''
  }
  update(faction: Faction, squadIndex: number, sheet?: CharacterSheet): void {
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

    this.renderSlot(renderer, canvas, scene, camera, gltf, faction, squadIndex, sheet)
    renderer.dispose()
  }

  private renderSlot(
    renderer: WebGLRenderer,
    canvas: HTMLCanvasElement,
    scene: Scene,
    camera: PerspectiveCamera,
    gltf: GLTF,
    faction: Faction,
    index: number,
    sheet?: CharacterSheet,
  ): void {
    const model = clone(gltf.scene) as Group
    model.position.set(0, 0, 0)
    model.rotation.y = 0
    applyCharacterProportions(model, sheet?.appearance)

    model.traverse((child) => {
      if (child instanceof Mesh) {
        child.frustumCulled = false
        if (child.material) {
          const mat = (child.material as MeshStandardMaterial).clone()
          mat.color.copy(soldierColor(faction, index))
          child.material = mat
        }
      }
    })

    scene.add(model)
    scene.updateMatrixWorld(true)

    const head = model.getObjectByName('Head')
    const headY = head ? new Vector3().setFromMatrixPosition(head.matrixWorld).y : 1.57 * (sheet?.appearance?.height ?? 1)
    camera.position.set(0, headY + 0.05, 0.75)
    camera.lookAt(new Vector3(0, headY + 0.01, 0))
    camera.updateMatrixWorld(true)

    renderer.render(scene, camera)
    const dataUrl = canvas.toDataURL('image/png')
    this.portraits.set(`${faction}_${index}`, dataUrl)

    scene.remove(model)
  }

  private generateAll(squads?: Partial<Record<Faction, readonly (CharacterSheet | undefined)[]>>): void {
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
      for (let index = 0; index < SQUAD_SIZE; index++) {
        const sheet = squads?.[faction]?.[index]
        this.renderSlot(renderer, canvas, scene, camera, gltf, faction, index, sheet)
      }
    }

    renderer.dispose()
  }
}
