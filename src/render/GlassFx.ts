import { BufferGeometry, DoubleSide, Float32BufferAttribute, Group, Mesh, MeshBasicMaterial, Vector3 } from 'three'
import { LEVEL_HEIGHT, TILE } from '../config'
import type { Grid } from '../core/Grid'
import { WALLS, WallKind } from '../core/Walls'
import type { EngineContext } from '../engine'
import { FACE_OFFSET } from './Blocks'

const SHARDS = 18
const GRAVITY = 9.8
const LIFETIME = 1.1
const FADE_FROM = 0.6

interface Shard {
  mesh: Mesh
  velocity: Vector3
  spin: Vector3
  age: number
  floor: number
}

/**
 * Glass coming apart.
 *
 * The rules turn a pane into an open edge in one step, and `Blocks` stops
 * drawing it on the next redraw. This throws a handful of triangular shards
 * from where the pane was, out to both sides, so the window is seen to break
 * rather than to vanish. Nothing but a triangle and a tint: no assets.
 *
 * Strictly a view. Skipped for a pane the viewer cannot see, so a window
 * breaking in the fog gives nothing away.
 */
export class GlassFx {
  private readonly group = new Group()
  private readonly shards: Shard[] = []
  private readonly geometry = new BufferGeometry()
  private readonly material = new MeshBasicMaterial({
    color: 0xbfe6f2,
    transparent: true,
    opacity: 0.75,
    side: DoubleSide,
    depthWrite: false,
  })

  constructor(
    private readonly engine: EngineContext,
    private readonly grid: Grid,
    /** Can the viewer see this edge? */
    private readonly seen: (edge: number) => boolean,
  ) {
    this.group.name = 'glass-shards'
    // A triangle about 12 cm across, shared by every shard.
    this.geometry.setAttribute('position', new Float32BufferAttribute([-0.06, -0.05, 0, 0.07, -0.03, 0, -0.01, 0.08, 0], 3))
    engine.scene.add(this.group)
  }

  /** A wall changed kind; panes that became open air shatter. */
  changed(edge: number, from: WallKind, to: WallKind): void {
    if (from !== WallKind.Glass || to !== WallKind.None || !this.seen(edge)) return

    const { x, y, side } = this.grid.edgeTile(edge)
    const [dx, dz] = FACE_OFFSET[side]!
    const floor = Math.max(this.grid.levelAt(x, y), this.grid.levelAt(x + dx, y + dz)) * LEVEL_HEIGHT
    const height = WALLS[WallKind.Glass].height
    // Along the pane: x for a north/south face, z for an east/west one.
    const [ax, az] = dx === 0 ? [1, 0] : [0, 1]
    const centreX = this.grid.worldX(x) + (dx * TILE) / 2
    const centreZ = this.grid.worldZ(y) + (dz * TILE) / 2

    for (let i = 0; i < SHARDS; i++) {
      const along = (Math.random() - 0.5) * TILE
      const mesh = new Mesh(this.geometry, this.material.clone())
      mesh.position.set(centreX + ax * along, floor + 0.2 + Math.random() * (height - 0.3), centreZ + az * along)
      mesh.rotation.set(Math.random() * 6, Math.random() * 6, Math.random() * 6)
      this.group.add(mesh)

      // Out through the opening either way, a little along it, mostly dropping.
      const outward = (Math.random() < 0.5 ? -1 : 1) * (0.6 + Math.random() * 1.6)
      const velocity = new Vector3(dx * outward + ax * (Math.random() - 0.5), 0.5 + Math.random() * 1.5, dz * outward + az * (Math.random() - 0.5))
      const spin = new Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(18)
      this.shards.push({ mesh, velocity, spin, age: 0, floor: floor + 0.02 })
    }
  }

  update(delta: number): void {
    for (let i = this.shards.length - 1; i >= 0; i--) {
      const shard = this.shards[i]!
      shard.age += delta
      if (shard.age >= LIFETIME) {
        this.group.remove(shard.mesh)
        ;(shard.mesh.material as MeshBasicMaterial).dispose()
        this.shards.splice(i, 1)
        continue
      }
      const { mesh, velocity, spin } = shard
      velocity.y -= GRAVITY * delta
      mesh.position.addScaledVector(velocity, delta)
      mesh.rotation.x += spin.x * delta
      mesh.rotation.y += spin.y * delta
      mesh.rotation.z += spin.z * delta
      if (mesh.position.y < shard.floor) {
        // Glass does not bounce: it lands and skids a little.
        mesh.position.y = shard.floor
        velocity.set(velocity.x * 0.3, 0, velocity.z * 0.3)
        spin.multiplyScalar(0.2)
      }
      const fade = Math.max(0, 1 - Math.max(0, shard.age - FADE_FROM) / (LIFETIME - FADE_FROM))
      ;(mesh.material as MeshBasicMaterial).opacity = 0.75 * fade
    }
  }

  dispose(): void {
    for (const shard of this.shards) (shard.mesh.material as MeshBasicMaterial).dispose()
    this.shards.length = 0
    this.engine.scene.remove(this.group)
    this.geometry.dispose()
    this.material.dispose()
  }
}
