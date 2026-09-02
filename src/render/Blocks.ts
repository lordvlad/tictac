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
import { LEVEL_HEIGHT, TILE } from '../config'
import { Block, blockHeight, type Grid, LadderFace } from '../core/Grid'
import { markOccludedTiles } from '../core/Occlusion'
import { VIS_BRIGHTNESS, VisState } from '../core/Visibility'

/** Per-instance opacity attribute name (the wall x-ray fade). */
const FADE_ATTRIBUTE = 'aFade'

/** Base colour per block kind, before fog dimming. */
const BLOCK_COLORS: Record<Exclude<Block, typeof Block.None>, number> = {
  [Block.Half]: 0x9a7c4f,
  [Block.Full]: 0x8b8f96,
  [Block.Stair]: 0x00d2ff,
}

/** Ladders are edges, not tiles, so they get their own colour and layer. */
const LADDER_COLOR = 0xff8800

/** Face bits in a stable order, so instances and their offsets stay paired. */
const LADDER_FACE_ORDER: readonly number[] = [
  LadderFace.North,
  LadderFace.East,
  LadderFace.South,
  LadderFace.West,
]

/** Grid-space step from a tile centre toward each face, as [dx, dy]. */
const LADDER_FACE_OFFSET: Record<number, readonly [number, number]> = {
  [LadderFace.North]: [0, -1],
  [LadderFace.East]: [1, 0],
  [LadderFace.South]: [0, 1],
  [LadderFace.West]: [-1, 0],
}

/**
 * A lit material carrying the two per-instance channels every layer needs:
 * instance colour for fog dimming, and `aFade` for the wall x-ray and the
 * level filter.
 *
 * `transparent` so per-instance alpha blends; depth write stays on so opaque
 * walls still occlude normally.
 */
function createFadedMaterial(roughness: number, metalness: number): MeshStandardMaterial {
  const material = new MeshStandardMaterial({
    color: 0xffffff,
    roughness,
    metalness,
    transparent: true,
  })

  // Multiply lit output by instance colour so unexplored tiles (black) go to
  // pure black instead of leaving a lit silhouette.
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
  return material
}

/**
 * A flight of steps rising from the low edge (`-Z`) to the high edge (`+Z`).
 *
 * Every face is wound counter-clockwise *seen from outside the solid*, so its
 * normal points away from the volume. Getting a face backwards is invisible
 * from below and collapses the whole flight into one flat slab from above —
 * which is the angle the tactical camera actually looks from.
 */
export function createSteppedStairGeometry(steps = 4): BufferGeometry {
  const east = (TILE * 0.98) / 2
  const west = east * -1
  const high = LEVEL_HEIGHT / 2
  const floor = high * -1
  const back = (TILE * 0.98) / 2
  const front = back * -1
  const stepH = LEVEL_HEIGHT / steps
  const stepL = (back * 2) / steps

  const pos: number[] = []

  /** Two triangles for a planar quad, wound a to d as seen from outside. */
  const quad = (
    ax: number, ay: number, az: number,
    bx: number, by: number, bz: number,
    cx: number, cy: number, cz: number,
    dx: number, dy: number, dz: number,
  ): void => {
    pos.push(ax, ay, az, bx, by, bz, cx, cy, cz)
    pos.push(ax, ay, az, cx, cy, cz, dx, dy, dz)
  }

  for (let i = 0; i < steps; i++) {
    const zFront = front + i * stepL
    const zBack = zFront + stepL
    const yFoot = floor + i * stepH
    const yTread = yFoot + stepH

    // Riser, facing the approach (-Z).
    quad(
      east, yFoot, zFront,
      west, yFoot, zFront,
      west, yTread, zFront,
      east, yTread, zFront,
    )

    // Tread, the walkable surface (+Y).
    quad(
      west, yTread, zBack,
      east, yTread, zBack,
      east, yTread, zFront,
      west, yTread, zFront,
    )

    // Side skirts down to the floor (-X and +X).
    quad(
      west, floor, zFront,
      west, floor, zBack,
      west, yTread, zBack,
      west, yTread, zFront,
    )
    quad(
      east, floor, zBack,
      east, floor, zFront,
      east, yTread, zFront,
      east, yTread, zBack,
    )
  }

  // Back wall under the top landing (+Z).
  quad(
    west, floor, back,
    east, floor, back,
    east, high, back,
    west, high, back,
  )

  // Underside (-Y).
  quad(
    west, floor, front,
    east, floor, front,
    east, floor, back,
    west, floor, back,
  )

  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new Float32BufferAttribute(pos, 3))
  geometry.computeVertexNormals()
  return geometry
}
/**
 * A ladder: two rails and their rungs, lying flat in the plane of the wall it
 * is bolted to and spanning exactly one storey.
 *
 * Built around the origin in the XY plane and thin in Z, so the caller can
 * park it on a tile edge and turn local +Z to face the drop.
 */
export function createLadderWallGeometry(rungs = 5): BufferGeometry {
  const railW = 0.06
  const railH = LEVEL_HEIGHT
  const railD = 0.05
  const railOffsetX = 0.26
  const rungW = railOffsetX * 2 - railW
  const rungH = 0.04
  const rungD = 0.07

  const pos: number[] = []

  /** An axis-aligned box, every face wound outward. */
  const addBox = (cx: number, cy: number, cz: number, bw: number, bh: number, bd: number) => {
    const x0 = cx - bw / 2, x1 = cx + bw / 2
    const y0 = cy - bh / 2, y1 = cy + bh / 2
    const z0 = cz - bd / 2, z1 = cz + bd / 2

    pos.push(x0, y0, z1,  x1, y0, z1,  x1, y1, z1,   x0, y0, z1,  x1, y1, z1,  x0, y1, z1)
    pos.push(x1, y0, z0,  x0, y0, z0,  x0, y1, z0,   x1, y0, z0,  x0, y1, z0,  x1, y1, z0)
    pos.push(x0, y0, z0,  x0, y0, z1,  x0, y1, z1,   x0, y0, z0,  x0, y1, z1,  x0, y1, z0)
    pos.push(x1, y0, z1,  x1, y0, z0,  x1, y1, z0,   x1, y0, z1,  x1, y1, z0,  x1, y1, z1)
    pos.push(x0, y1, z1,  x1, y1, z1,  x1, y1, z0,   x0, y1, z1,  x1, y1, z0,  x0, y1, z0)
    pos.push(x0, y0, z0,  x1, y0, z0,  x1, y0, z1,   x0, y0, z0,  x1, y0, z1,  x0, y0, z1)
  }

  addBox(railOffsetX * -1, 0, 0, railW, railH, railD)
  addBox(railOffsetX, 0, 0, railW, railH, railD)

  const spacing = railH / (rungs + 1)
  for (let i = 0; i < rungs; i++) {
    addBox(0, railH / -2 + spacing * (i + 1), 0, rungW, rungH, rungD)
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

    for (const extra of [this.buildUpperFloors(), this.buildLadders()]) {
      if (extra === null) continue
      this.layers.push(extra)
      this.group.add(extra.mesh)
    }
  }

  private buildLayer(kind: Exclude<Block, typeof Block.None>, instances: BlockInstance[]): BlockLayer {
    const height = blockHeight(kind) || LEVEL_HEIGHT
    const capacity = Math.max(1, instances.length)
    const geometry =
      kind === Block.Stair
        ? createSteppedStairGeometry()
        : new BoxGeometry(TILE * 0.98, height, TILE * 0.98)
    // Per-instance x-ray opacity. Starts fully opaque; Float32Array zero-inits,
    // so the fill(1) is required.
    const fade = new InstancedBufferAttribute(new Float32Array(capacity).fill(1), 1)
    geometry.setAttribute(FADE_ATTRIBUTE, fade)

    const material = createFadedMaterial(0.85, 0.02)

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

    const material = createFadedMaterial(0.8, 0.1)

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
        level * LEVEL_HEIGHT - height / 2,
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

  /**
   * One ladder per mounted face.
   *
   * Placed on the shared edge between the raised tile and the tile below, so a
   * ladder takes up no floor: both tiles stay walkable.
   */
  private buildLadders(): BlockLayer | null {
    const instances: BlockInstance[] = []
    const faces: number[] = []

    this.grid.forEach((x, y) => {
      const mounted = this.grid.ladderFacesAt(x, y)
      for (const face of LADDER_FACE_ORDER) {
        if ((mounted & face) === 0) continue
        instances.push({ x, y, index: instances.length })
        faces.push(face)
      }
    })
    if (instances.length === 0) return null

    const capacity = instances.length
    const geometry = createLadderWallGeometry()
    const fade = new InstancedBufferAttribute(new Float32Array(capacity).fill(1), 1)
    geometry.setAttribute(FADE_ATTRIBUTE, fade)

    const mesh = new InstancedMesh(geometry, createFadedMaterial(0.7, 0.25), capacity)
    mesh.instanceMatrix.setUsage(DynamicDrawUsage)
    mesh.count = capacity
    mesh.castShadow = true
    mesh.receiveShadow = true
    mesh.userData.type = 'ladder'
    mesh.frustumCulled = false

    const baseColor = new Color(LADDER_COLOR)
    const layer: BlockLayer = { mesh, instances, baseColor, fade }

    instances.forEach((tile, i) => {
      const [dx, dz] = LADDER_FACE_OFFSET[faces[i]!]!
      const level = this.grid.levelAt(tile.x, tile.y)

      this.dummy.position.set(
        this.grid.worldX(tile.x) + (dx * TILE) / 2,
        (level - 0.5) * LEVEL_HEIGHT,
        this.grid.worldZ(tile.y) + (dz * TILE) / 2,
      )
      // Turn local +Z to look out over the drop.
      this.dummy.rotation.y = Math.atan2(dx, dz)
      this.dummy.updateMatrix()
      layer.mesh.setMatrixAt(tile.index, this.dummy.matrix)
      layer.mesh.setColorAt(tile.index, baseColor)
    })

    layer.mesh.instanceMatrix.needsUpdate = true
    if (layer.mesh.instanceColor !== null) layer.mesh.instanceColor.needsUpdate = true

    return layer
  }
  private placeAll(layer: BlockLayer, height: number): void {
    for (const tile of layer.instances) {
      const level = this.grid.levelAt(tile.x, tile.y)
      const baseY = level * LEVEL_HEIGHT
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
