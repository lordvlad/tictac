import {
  BoxGeometry,
  Color,
  DynamicDrawUsage,
  Group,
  InstancedBufferAttribute,
  InstancedMesh,
  MeshStandardMaterial,
  Object3D,
  type Vector3,
} from 'three'
import { TILE } from '../config'
import { Block, blockHeight, type Grid } from '../core/Grid'
import { markOccludedTiles } from '../core/Occlusion'
import { VIS_BRIGHTNESS, VisState } from '../core/Visibility'

/** Per-instance opacity attribute name (the wall x-ray fade). */
const FADE_ATTRIBUTE = 'aFade'

/** Base colour per block kind, before fog dimming. */
const BLOCK_COLORS: Record<Exclude<Block, typeof Block.None>, number> = {
  [Block.Half]: 0x9a7c4f,
  [Block.Full]: 0x8b8f96,
  [Block.Stair]: 0x00d2ff, // Distinct cyan stair highlight
  [Block.Ladder]: 0xff8800, // Distinct orange ladder highlight
}

interface BlockInstance {
  x: number
  y: number
  index: number
}

/**
 * One InstancedMesh per block kind, since each kind is a different box height.
 * Kinds are driven by {@link BLOCK_COLORS}, so a new height class is one entry
 * plus its enum member rather than another pair of hand-maintained fields.
 */
interface BlockLayer {
  mesh: InstancedMesh
  instances: BlockInstance[]
  baseColor: Color
  fade: InstancedBufferAttribute
}

/**
 * The obstacles standing on the floor.
 *
 * Fog is applied per instance via instance colour, using the same
 * {@link VIS_BRIGHTNESS} ramp as the ground shader so walls and floor dim
 * together. Walls hiding a character can additionally be faded per instance
 * (`beginOcclusionFade` / `addOcclusionRay` / `commitOcclusionFade`); that
 * opacity rides a dedicated instanced attribute because instance colour is
 * already spoken for by fog.
 */
export class Blocks {
  readonly group = new Group()

  private readonly layers: BlockLayer[] = []
  private readonly dummy = new Object3D()
  private readonly scratch = new Color()

  /** Per-tile occlusion scratch for the x-ray pass. */
  private readonly occlusionMask: Uint8Array
  private occlusionActive = false

  constructor(private readonly grid: Grid) {
    const kinds = Object.keys(BLOCK_COLORS).map(Number) as Exclude<Block, typeof Block.None>[]

    const tilesByKind = new Map<Block, BlockInstance[]>(kinds.map((kind) => [kind, []]))
    grid.forEach((x, y, block) => {
      const tiles = tilesByKind.get(block)
      if (tiles) tiles.push({ x, y, index: tiles.length })
    })

    for (const kind of kinds) {
      const instances = tilesByKind.get(kind) ?? []
      const layer = this.buildLayer(kind, instances)
      this.layers.push(layer)
      this.group.add(layer.mesh)
    }

    this.group.name = 'blocks'
    this.occlusionMask = new Uint8Array(grid.size * grid.size)
  }

  private buildLayer(kind: Exclude<Block, typeof Block.None>, instances: BlockInstance[]): BlockLayer {
    const height = blockHeight(kind) || 2.0
    const capacity = Math.max(1, instances.length)

    // Slight inset so adjacent blocks read as separate volumes.
    const geometry = new BoxGeometry(TILE * 0.98, height, TILE * 0.98)
    // Per-instance x-ray opacity. Starts fully opaque; Float32Array zero-inits,
    // so the fill(1) is required.
    const fade = new InstancedBufferAttribute(new Float32Array(capacity).fill(1), 1)
    geometry.setAttribute(FADE_ATTRIBUTE, fade)

    // `transparent` so per-instance alpha actually blends; depth write stays on
    // so opaque walls still occlude normally.
    const material = new MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.85,
      metalness: 0.02,
      transparent: true,
    })

    // Multiply final lit output by instance colour so unexplored blocks (black)
    // go to pure black instead of leaving a lit silhouette. `aFade` carries the
    // per-instance x-ray opacity.
    material.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          '#include <common>\nattribute float aFade;\nvarying float vFade;',
        )
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvFade = aFade;')
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying float vFade;')
        .replace(
          '#include <dithering_fragment>',
          /* glsl */ `
          #include <dithering_fragment>
          #ifdef USE_INSTANCING_COLOR
            gl_FragColor.rgb *= vColor.rgb;
          #endif
          gl_FragColor.a *= vFade;
          `,
        )
    }
    material.customProgramCacheKey = () => 'tictac-block'

    const mesh = new InstancedMesh(geometry, material, capacity)
    mesh.instanceMatrix.setUsage(DynamicDrawUsage)
    mesh.count = instances.length
    mesh.castShadow = true
    mesh.receiveShadow = true
    mesh.userData.type = 'block'
    mesh.frustumCulled = false

    const baseColor = new Color(BLOCK_COLORS[kind])
    const layer: BlockLayer = { mesh, instances, baseColor, fade }
    this.placeAll(layer, height)
    return layer
  }

  private placeAll(layer: BlockLayer, height: number): void {
    for (const tile of layer.instances) {
      const level = this.grid.levelAt(tile.x, tile.y)
      const baseY = level * 2.0
      this.dummy.position.set(
        this.grid.worldX(tile.x),
        baseY + height / 2,
        this.grid.worldZ(tile.y)
      )

      // Apply stair rotation if this is a stair block
      const block = this.grid.blockAt(tile.x, tile.y)
      if (block === Block.Stair) {
        const dir = this.grid.stairDirectionAt(tile.x, tile.y)
        // Rotate around Y axis based on StairDirection (0: North, 1: East, 2: South, 3: West)
        this.dummy.rotation.y = -(dir * Math.PI) / 2
      } else {
        this.dummy.rotation.y = 0
      }

      this.dummy.updateMatrix()
      layer.mesh.setMatrixAt(tile.index, this.dummy.matrix)
      layer.mesh.setColorAt(tile.index, layer.baseColor)
    }
    layer.mesh.instanceMatrix.needsUpdate = true
    if (layer.mesh.instanceColor !== null) layer.mesh.instanceColor.needsUpdate = true
  }

  /**
   * Dim blocks according to the active faction's visibility.
   * `values` is one {@link VisState} byte per tile.
   *
   * Exact tile state is used: visibility must not bleed into neighbouring
   * unexplored wall tiles.
   */
  applyVisibility(values: Uint8Array): void {
    for (const layer of this.layers) {
      for (const tile of layer.instances) {
        const state = (values[this.grid.index(tile.x, tile.y)] ?? VisState.Unknown) as VisState
        this.scratch.copy(layer.baseColor).multiplyScalar(VIS_BRIGHTNESS[state])
        layer.mesh.setColorAt(tile.index, this.scratch)
      }
      if (layer.mesh.instanceColor !== null) layer.mesh.instanceColor.needsUpdate = true
    }
  }

  /** Fully lit — used before the first visibility pass. */
  revealAll(): void {
    for (const layer of this.layers) {
      for (const tile of layer.instances) layer.mesh.setColorAt(tile.index, layer.baseColor)
      if (layer.mesh.instanceColor !== null) layer.mesh.instanceColor.needsUpdate = true
    }
  }

  // -------------------------------------------------------------------------
  // Wall x-ray fade
  // -------------------------------------------------------------------------

  /**
   * Start a fade pass. Follow with one `addOcclusionRay` per character being
   * kept visible, then `commitOcclusionFade`. Split into three calls so any
   * number of characters can contribute without allocating a target list.
   */
  beginOcclusionFade(): void {
    this.occlusionMask.fill(0)
  }

  /** Mark the blocks the camera→character segment passes through. */
  addOcclusionRay(from: Vector3, to: Vector3): void {
    markOccludedTiles(this.grid, from, to, this.occlusionMask)
  }

  /** Fade every marked block to `opacity`; all others return to fully opaque. */
  commitOcclusionFade(opacity: number): void {
    this.occlusionActive = true
    for (const layer of this.layers) this.applyFade(layer, opacity)
  }

  /** Restore all blocks to full opacity. Cheap no-op when nothing is faded. */
  clearOcclusionFade(): void {
    if (!this.occlusionActive) return
    this.occlusionActive = false
    for (const layer of this.layers) this.applyFade(layer, 1)
  }

  private applyFade(layer: BlockLayer, opacity: number): void {
    const values = layer.fade.array as Float32Array
    let dirty = false
    for (const tile of layer.instances) {
      const value = this.occlusionMask[this.grid.index(tile.x, tile.y)] ? opacity : 1
      if (values[tile.index] !== value) {
        values[tile.index] = value
        dirty = true
      }
    }
    if (dirty) layer.fade.needsUpdate = true
  }

  dispose(): void {
    for (const layer of this.layers) {
      layer.mesh.geometry.dispose()
      ;(layer.mesh.material as MeshStandardMaterial).dispose()
      layer.mesh.dispose()
    }
  }
}
