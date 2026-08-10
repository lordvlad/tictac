import {
  BoxGeometry,
  Color,
  DynamicDrawUsage,
  Group,
  InstancedMesh,
  MeshStandardMaterial,
  Object3D,
} from 'three'
import { FULL_BLOCK_HEIGHT, HALF_BLOCK_HEIGHT, TILE } from '../config'
import { Block, type Grid } from '../core/Grid'

/** Base colours before fog dimming. */
const HALF_COLOR = new Color(0x9a7c4f)
const FULL_COLOR = new Color(0x8b8f96)

/** Fog brightness multipliers matching the ground shader. */
const LIT_UNKNOWN = 0.0
const LIT_EXPLORED = 0.22
const LIT_VISIBLE = 1.0

interface BlockInstance {
  x: number
  y: number
  index: number
}

/**
 * Obstacles rendered as two InstancedMeshes (one per height class).
 * Fog is applied per instance via instance colour, matching the ground shader's
 * brightness ramp so walls and floor dim together.
 */
export class Blocks {
  readonly group = new Group()

  private readonly halfMesh: InstancedMesh
  private readonly fullMesh: InstancedMesh
  private readonly halfInstances: BlockInstance[] = []
  private readonly fullInstances: BlockInstance[] = []
  private readonly dummy = new Object3D()
  private readonly scratch = new Color()

  constructor(private readonly grid: Grid) {
    const halfTiles: BlockInstance[] = []
    const fullTiles: BlockInstance[] = []

    grid.forEach((x, y, block) => {
      if (block === Block.Half) halfTiles.push({ x, y, index: halfTiles.length })
      else if (block === Block.Full) fullTiles.push({ x, y, index: fullTiles.length })
    })

    this.halfMesh = this.buildMesh(HALF_BLOCK_HEIGHT, HALF_COLOR, Math.max(1, halfTiles.length))
    this.fullMesh = this.buildMesh(FULL_BLOCK_HEIGHT, FULL_COLOR, Math.max(1, fullTiles.length))
    this.halfMesh.count = halfTiles.length
    this.fullMesh.count = fullTiles.length

    this.halfInstances = halfTiles
    this.fullInstances = fullTiles

    this.placeAll(this.halfMesh, halfTiles, HALF_BLOCK_HEIGHT)
    this.placeAll(this.fullMesh, fullTiles, FULL_BLOCK_HEIGHT)

    this.group.name = 'blocks'
    this.group.add(this.halfMesh, this.fullMesh)
  }

  private buildMesh(height: number, color: Color, capacity: number): InstancedMesh {
    // Slight inset so adjacent blocks read as separate volumes.
    const geometry = new BoxGeometry(TILE * 0.98, height, TILE * 0.98)
    const material = new MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.85,
      metalness: 0.02,
    })

    // Multiply final lit output by instance color so unexplored blocks (black)
    // fade completely to pure pitch black without leaving specular or ambient 3D silhouettes.
    material.onBeforeCompile = (shader) => {
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <dithering_fragment>',
        /* glsl */ `
        #include <dithering_fragment>
        #ifdef USE_INSTANCING_COLOR
          gl_FragColor.rgb *= vColor.rgb;
        #endif
        `,
      )
    }
    material.customProgramCacheKey = () => 'tictac-block'

    const mesh = new InstancedMesh(geometry, material, capacity)
    mesh.instanceMatrix.setUsage(DynamicDrawUsage)
    mesh.castShadow = true
    mesh.receiveShadow = true
    mesh.userData.type = 'block'
    mesh.userData.baseColor = color
    mesh.frustumCulled = false
    return mesh
  }

  private placeAll(mesh: InstancedMesh, tiles: BlockInstance[], height: number): void {
    const base = mesh.userData.baseColor as Color
    for (const tile of tiles) {
      this.dummy.position.set(
        this.grid.worldX(tile.x),
        height / 2,
        this.grid.worldZ(tile.y),
      )
      this.dummy.rotation.set(0, 0, 0)
      this.dummy.scale.set(1, 1, 1)
      this.dummy.updateMatrix()
      mesh.setMatrixAt(tile.index, this.dummy.matrix)
      mesh.setColorAt(tile.index, base)
    }
    mesh.instanceMatrix.needsUpdate = true
    if (mesh.instanceColor !== null) mesh.instanceColor.needsUpdate = true
  }

  /**
   * Dim blocks according to the active faction's visibility.
   * `values`: 0 unknown, 1 explored, 2 visible (one byte per tile).
   *
   * A block on an unknown tile is hidden entirely. A block is treated as
   * visible if any orthogonally adjacent tile is visible, so that the *faces*
   * of walls you are standing next to are lit even though the wall tile itself
   * is never walkable and therefore never directly "seen".
   */
  applyVisibility(values: Uint8Array): void {
    this.applyTo(this.halfMesh, this.halfInstances, values)
    this.applyTo(this.fullMesh, this.fullInstances, values)
  }

  private applyTo(mesh: InstancedMesh, tiles: BlockInstance[], values: Uint8Array): void {
    const base = mesh.userData.baseColor as Color
    for (const tile of tiles) {
      // Use exact tile visibility state (do not bleed visibility to neighboring unexplored wall tiles)
      const state = values[this.grid.index(tile.x, tile.y)] ?? 0
      const lit = state === 2 ? LIT_VISIBLE : state === 1 ? LIT_EXPLORED : LIT_UNKNOWN
      this.scratch.copy(base).multiplyScalar(lit)
      mesh.setColorAt(tile.index, this.scratch)
    }
    if (mesh.instanceColor !== null) mesh.instanceColor.needsUpdate = true
  }

  /** Fully lit — used before the first visibility pass. */
  revealAll(): void {
    this.resetColors(this.halfMesh, this.halfInstances)
    this.resetColors(this.fullMesh, this.fullInstances)
  }

  private resetColors(mesh: InstancedMesh, tiles: BlockInstance[]): void {
    const base = mesh.userData.baseColor as Color
    for (const tile of tiles) mesh.setColorAt(tile.index, base)
    if (mesh.instanceColor !== null) mesh.instanceColor.needsUpdate = true
  }

  dispose(): void {
    for (const mesh of [this.halfMesh, this.fullMesh]) {
      mesh.geometry.dispose()
      ;(mesh.material as MeshStandardMaterial).dispose()
      mesh.dispose()
    }
  }
}
