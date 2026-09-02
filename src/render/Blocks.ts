import {
  BoxGeometry,
  BufferGeometry,
  Color,
  DynamicDrawUsage,
  Float32BufferAttribute,
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

function createSteppedStairGeometry(): BufferGeometry {
  const w = (TILE * 0.98) / 2
  const h = 2.0 / 2
  const l = (TILE * 0.98) / 2
  const steps = 4
  const stepH = (2 * h) / steps
  const stepL = (2 * l) / steps

  const pos: number[] = []

  // Generate 4 steps (treads and risers)
  for (let i = 0; i < steps; i++) {
    const zStart = +-l + i * stepL
    const zEnd = zStart + stepL
    const yBottom = +-h + i * stepH
    const yTop = yBottom + stepH

    // Riser (vertical face at zStart)
    pos.push(
      +-w, yBottom, zStart,   w, yBottom, zStart,   w, yTop, zStart,
      +-w, yBottom, zStart,   w, yTop, zStart,    +-w, yTop, zStart
    )

    // Tread (horizontal face at yTop)
    pos.push(
      +-w, yTop, zStart,   w, yTop, zStart,   w, yTop, zEnd,
      +-w, yTop, zStart,   w, yTop, zEnd,    +-w, yTop, zEnd
    )
  }

  // Back wall (at z = +l, from y = -h to +h)
  pos.push(
    w, +-h, l,   +-w, +-h, l,   +-w, h, l,
    w, +-h, l,   +-w, h, l,     w, h, l
  )

  // Bottom base (at y = -h, from z = -l to +l)
  pos.push(
    +-w, +-h, +-l,   w, +-h, +-l,   w, +-h, l,
    +-w, +-h, +-l,   w, +-h, l,   +-w, +-h, l
  )

  // West side wall (-w)
  for (let i = 0; i < steps; i++) {
    const zStart = +-l + i * stepL
    const zEnd = zStart + stepL
    const yTop = +-h + (i + 1) * stepH
    pos.push(
      +-w, +-h, zStart,  +-w, +-h, zEnd,  +-w, yTop, zEnd,
      +-w, +-h, zStart,  +-w, yTop, zEnd, +-w, yTop, zStart
    )
  }

  // East side wall (+w)
  for (let i = 0; i < steps; i++) {
    const zStart = +-l + i * stepL
    const zEnd = zStart + stepL
    const yTop = +-h + (i + 1) * stepH
    pos.push(
      w, +-h, zEnd,  w, +-h, zStart,  w, yTop, zStart,
      w, +-h, zEnd,  w, yTop, zStart,  w, yTop, zEnd
    )
  }

  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new Float32BufferAttribute(pos, 3))
  geometry.computeVertexNormals()
  return geometry
}
function createLadderWallGeometry(): BufferGeometry {
  const railW = 0.05
  const railH = 2.0
  const railD = 0.08
  const rungW = 0.51
  const rungH = 0.04
  const rungD = 0.05
  const rungs = 5

  const pos: number[] = []

  // Helper to push a box into pos array
  const addBox = (cx: number, cy: number, cz: number, bw: number, bh: number, bd: number) => {
    const x0 = cx - bw / 2, x1 = cx + bw / 2
    const y0 = cy - bh / 2, y1 = cy + bh / 2
    const z0 = cz - bd / 2, z1 = cz + bd / 2

    // Front (z1)
    pos.push(x0, y0, z1,  x1, y0, z1,  x1, y1, z1,   x0, y0, z1,  x1, y1, z1,  x0, y1, z1)
    // Back (z0)
    pos.push(x1, y0, z0,  x0, y0, z0,  x0, y1, z0,   x1, y0, z0,  x0, y1, z0,  x1, y1, z0)
    // Left (x0)
    pos.push(x0, y0, z0,  x0, y0, z1,  x0, y1, z1,   x0, y0, z0,  x0, y1, z1,  x0, y1, z0)
    // Right (x1)
    pos.push(x1, y0, z1,  x1, y0, z0,  x1, y1, z0,   x1, y0, z1,  x1, y1, z0,  x1, y1, z1)
    // Top (y1)
    pos.push(x0, y1, z1,  x1, y1, z1,  x1, y1, z0,   x0, y1, z1,  x1, y1, z0,  x0, y1, z0)
    // Bottom (y0)
    pos.push(x0, y0, z0,  x1, y0, z0,  x1, y0, z1,   x0, y0, z0,  x1, y0, z1,  x0, y0, z1)
  }

  // Left rail
  addBox(-0.28, 0, 0, railW, railH, railD)
  // Right rail
  addBox(0.28, 0, 0, railW, railH, railD)

  // 5 horizontal rungs
  for (let i = 0; i < rungs; i++) {
    const ry = -0.8 + i * 0.4
    addBox(0, ry, 0, rungW, rungH, rungD)
  }

  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new Float32BufferAttribute(pos, 3))
  geometry.computeVertexNormals()
  return geometry
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
  private activeLevelFilter: number | null = null
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

    const upperFloorLayer = this.buildUpperFloors()
    if (upperFloorLayer) {
      this.layers.push(upperFloorLayer)
      this.group.add(upperFloorLayer.mesh)
    }
  }

  private buildLayer(kind: Exclude<Block, typeof Block.None>, instances: BlockInstance[]): BlockLayer {
    const height = blockHeight(kind) || 2.0
    const capacity = Math.max(1, instances.length)
    const geometry =
      kind === Block.Stair
        ? createSteppedStairGeometry()
        : kind === Block.Ladder
          ? createLadderWallGeometry()
          : new BoxGeometry(TILE * 0.98, height, TILE * 0.98)
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

  private buildUpperFloors(): BlockLayer | null {
    const instances: BlockInstance[] = []
    this.grid.forEach((x, y, block) => {
      const level = this.grid.levelAt(x, y)
      if (level > 0 && block !== Block.Full) {
        instances.push({ x, y, index: instances.length })
      }
    })
    if (instances.length === 0) return null

    const height = 0.15
    const capacity = instances.length
    const geometry = new BoxGeometry(TILE * 0.98, height, TILE * 0.98)
    const fade = new InstancedBufferAttribute(new Float32Array(capacity).fill(1), 1)
    geometry.setAttribute(FADE_ATTRIBUTE, fade)

    const material = new MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.8,
      metalness: 0.1,
      transparent: true,
    })

    material.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nattribute float aFade;\nvarying float vFade;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvFade = aFade;')
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying float vFade;')
        .replace(
          '#include <dithering_fragment>',
          `#include <dithering_fragment>\n#ifdef USE_INSTANCING_COLOR\n  gl_FragColor.rgb *= vColor.rgb;\n#endif\ngl_FragColor.a *= vFade;`
        )
    }

    const mesh = new InstancedMesh(geometry, material, capacity)
    mesh.instanceMatrix.setUsage(DynamicDrawUsage)
    mesh.count = instances.length
    mesh.castShadow = true
    mesh.receiveShadow = true
    mesh.userData.type = 'floor'
    mesh.frustumCulled = false

    const baseColor = new Color(0x64748b)
    const layer: BlockLayer = { mesh, instances, baseColor, fade }

    for (const tile of layer.instances) {
      const level = this.grid.levelAt(tile.x, tile.y)
      this.dummy.position.set(
        this.grid.worldX(tile.x),
        level * 2.0 - height / 2,
        this.grid.worldZ(tile.y)
      )
      this.dummy.rotation.y = 0
      this.dummy.updateMatrix()
      layer.mesh.setMatrixAt(tile.index, this.dummy.matrix)
      layer.mesh.setColorAt(tile.index, baseColor)
    }
    layer.mesh.instanceMatrix.needsUpdate = true
    if (layer.mesh.instanceColor !== null) layer.mesh.instanceColor.needsUpdate = true

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

  /**
   * Set active level filter.
   * Blocks above `level` are rendered transparently (0.15 opacity), while
   * blocks at or below `level` remain fully opaque. `null` means all levels opaque.
   */
  setLevelFilter(level: number | null): void {
    this.activeLevelFilter = level
    for (const layer of this.layers) {
      this.applyFade(layer, 1)
    }
  }

  private applyFade(layer: BlockLayer, xrayOpacity: number): void {
    const values = layer.fade.array as Float32Array
    let dirty = false
    for (const tile of layer.instances) {
      const tileLevel = this.grid.levelAt(tile.x, tile.y)
      let levelOpacity = 1.0
      if (this.activeLevelFilter !== null && tileLevel > this.activeLevelFilter) {
        levelOpacity = 0.15 // Transparent for upper levels when viewing lower level
      }

      const isXrayFaded = this.occlusionMask[this.grid.index(tile.x, tile.y)]
      const targetOpacity = isXrayFaded ? Math.min(levelOpacity, xrayOpacity) : levelOpacity

      if (values[tile.index] !== targetOpacity) {
        values[tile.index] = targetOpacity
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
