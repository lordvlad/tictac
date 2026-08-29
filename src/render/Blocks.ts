import {
  BoxGeometry,
  Color,
  DynamicDrawUsage,
  Group,
  InstancedBufferAttribute,
  InstancedMesh,
  MeshStandardMaterial,
  Object3D,
  Vector3,
} from 'three'
import { FULL_BLOCK_HEIGHT, HALF_BLOCK_HEIGHT, TILE } from '../config'
import { Block, blockHeight, type Grid } from '../core/Grid'

/** Base colours before fog dimming. */
const HALF_COLOR = new Color(0x9a7c4f)
const FULL_COLOR = new Color(0x8b8f96)

/** Fog brightness multipliers matching the ground shader. */
const LIT_UNKNOWN = 0.0
const LIT_EXPLORED = 0.22
const LIT_VISIBLE = 1.0

/** Per-instance opacity attribute name (the wall x-ray fade). */
const FADE_ATTRIBUTE = 'aFade'

interface BlockInstance {
  x: number
  y: number
  index: number
}

/**
 * Obstacles rendered as two InstancedMeshes (one per height class).
 * Fog is applied per instance via instance colour, matching the ground shader's
 * brightness ramp so walls and floor dim together.
 *
 * Walls that block the camera's view of the selected character can be faded
 * per instance (`setOcclusionFade`): opacity rides a dedicated instanced
 * attribute, since instance colours are already taken by fog.
 */
export class Blocks {
  readonly group = new Group()

  private readonly halfMesh: InstancedMesh
  private readonly fullMesh: InstancedMesh
  private readonly halfInstances: BlockInstance[] = []
  private readonly fullInstances: BlockInstance[] = []
  private readonly dummy = new Object3D()
  private readonly scratch = new Color()

  /** Per-tile occlusion scratch for the x-ray pass. */
  private readonly occlusionMask: Uint8Array
  private occlusionActive = false

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
    this.occlusionMask = new Uint8Array(grid.size * grid.size)
  }

  private buildMesh(height: number, color: Color, capacity: number): InstancedMesh {
    // Slight inset so adjacent blocks read as separate volumes.
    const geometry = new BoxGeometry(TILE * 0.98, height, TILE * 0.98)
    // Per-instance x-ray opacity. Starts fully opaque; written by
    // `setOcclusionFade`. Float32Array zero-inits, so fill(1) is required.
    geometry.setAttribute(
      FADE_ATTRIBUTE,
      new InstancedBufferAttribute(new Float32Array(capacity).fill(1), 1),
    )

    // `transparent` so per-instance alpha actually blends; depth write stays on
    // so opaque walls still occlude normally.
    const material = new MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.85,
      metalness: 0.02,
      transparent: true,
    })

    // Multiply final lit output by instance color so unexplored blocks (black)
    // fade completely to pure pitch black without leaving specular or ambient 3D silhouettes.
    // `aFade` carries per-instance opacity for the wall x-ray.
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

  // -------------------------------------------------------------------------
  // Wall x-ray fade
  // -------------------------------------------------------------------------

  /**
   * Fade every wall whose volume the camera→character segment passes through
   * down to `opacity`; all other walls stay opaque. Call every frame while the
   * effect is active, and `clearOcclusionFade` once it should stop.
   */
  setOcclusionFade(from: Vector3, to: Vector3, opacity: number): void {
    this.occlusionActive = true
    this.occlusionMask.fill(0)
    this.markOccludedTiles(from, to, this.occlusionMask)
    this.applyFade(this.halfMesh, this.halfInstances, opacity)
    this.applyFade(this.fullMesh, this.fullInstances, opacity)
  }

  /** Restore all walls to full opacity. Cheap no-op when nothing is faded. */
  clearOcclusionFade(): void {
    if (!this.occlusionActive) return
    this.occlusionActive = false
    this.applyFade(this.halfMesh, this.halfInstances, 1)
    this.applyFade(this.fullMesh, this.fullInstances, 1)
  }

  private applyFade(mesh: InstancedMesh, tiles: BlockInstance[], opacity: number): void {
    const attribute = mesh.geometry.getAttribute(FADE_ATTRIBUTE) as InstancedBufferAttribute
    const values = attribute.array as Float32Array
    let dirty = false
    for (const tile of tiles) {
      const value = this.occlusionMask[this.grid.index(tile.x, tile.y)] ? opacity : 1
      if (values[tile.index] !== value) {
        values[tile.index] = value
        dirty = true
      }
    }
    if (dirty) attribute.needsUpdate = true
  }

  /**
   * Mark every wall tile the segment `from`→`to` passes through: a 2D DDA walk
   * over the grid columns crossed by the segment, checking that the segment's
   * height inside each column overlaps the block's vertical extent. Columns the
   * segment merely flies over (e.g. a 1 m crate far from the character, with
   * the ray still several metres up) do not count.
   */
  private markOccludedTiles(from: Vector3, to: Vector3, mask: Uint8Array): void {
    const grid = this.grid
    const half = grid.halfExtent
    const toTile = (v: number): number => Math.floor((v + half) / TILE)

    let cx = toTile(from.x)
    let cy = toTile(from.z)
    const endX = toTile(to.x)
    const endY = toTile(to.z)

    const dx = to.x - from.x
    const dz = to.z - from.z
    const dy = to.y - from.y

    const stepX = dx > 0 ? 1 : -1
    const stepZ = dz > 0 ? 1 : -1

    // Segment parameter (0..1) at which the next grid line is crossed.
    let tMaxX = dx !== 0 ? ((cx + (dx > 0 ? 1 : 0)) * TILE - half - from.x) / dx : Infinity
    let tMaxZ = dz !== 0 ? ((cy + (dz > 0 ? 1 : 0)) * TILE - half - from.z) / dz : Infinity
    const tDeltaX = dx !== 0 ? Math.abs(TILE / dx) : Infinity
    const tDeltaZ = dz !== 0 ? Math.abs(TILE / dz) : Infinity

    // Every column the straight line crosses: at most one step per grid line.
    const steps = Math.abs(endX - cx) + Math.abs(endY - cy) + 2
    let tEnter = 0

    for (let i = 0; i < steps; i++) {
      const tExit = Math.min(tMaxX, tMaxZ, 1)

      if (grid.inBounds(cx, cy)) {
        const block = grid.blockAt(cx, cy)
        if (block !== Block.None) {
          const yEnter = from.y + dy * tEnter
          const yExit = from.y + dy * tExit
          // Blocks span y in [0, height]; both segment endpoints sit above the
          // floor, so overlap reduces to comparing the low end vs. the height.
          if (Math.min(yEnter, yExit) < blockHeight(block)) {
            mask[grid.index(cx, cy)] = 1
          }
        }
      }

      if (tExit >= 1 || (cx === endX && cy === endY)) break
      if (tMaxX < tMaxZ) {
        cx += stepX
        tMaxX += tDeltaX
      } else {
        cy += stepZ
        tMaxZ += tDeltaZ
      }
      tEnter = tExit
    }
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
