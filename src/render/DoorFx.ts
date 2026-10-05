import { BoxGeometry, Color, Group, Mesh, MeshStandardMaterial } from 'three'
import { LEVEL_HEIGHT, TILE } from '../config'
import type { Grid } from '../core/Grid'
import { WALLS, WallKind } from '../core/Walls'
import type { EngineContext } from '../engine'
import { type Blocks, DOOR_LEAF, FACE_OFFSET, WALL_STYLE, WALL_THICKNESS } from './Blocks'

/** What is being drawn: the leaf swinging, or a locked one taking a shoulder. */
type Motion = 'open' | 'close' | 'break' | 'rattle'

const DURATION: Record<Motion, number> = { open: 0.3, close: 0.22, break: 0.55, rattle: 0.3 }

interface Swing {
  motion: Motion
  pivot: Group
  leaf: Mesh
  material: MeshStandardMaterial
  age: number
  /** Yaw of the leaf shut, and how far round it goes to stand open. */
  shutYaw: number
  turn: number
  floor: number
  height: number
  from: Color
  to: Color
}

/**
 * Doors that move.
 *
 * The rules change a door's kind in one step, and `Blocks` redraws it in the
 * next state: shut, standing open, or gone. That is the right truth and a
 * jarring picture, so for the few tenths of a second a door is changing this
 * hides the edge's static leaf and swings a loose one between the two. A
 * door forced off its hinges is flung open and falls away; a shoulder that did
 * not give is a shudder in a door that stays where it is.
 *
 * Strictly a view. Nothing here decides anything, and a door nobody can see
 * move does not move: the swing is skipped for an edge the viewer has no sight
 * of, so a shut door cannot be heard opening on the far side of the map.
 */
export class DoorFx {
  private readonly group = new Group()
  private readonly swings = new Map<number, Swing>()
  /** Unit-long along +X from the origin, so a leaf turns about its hinge. */
  private readonly geometry = new BoxGeometry(1, 1, WALL_THICKNESS).translate(0.5, 0, 0)

  constructor(
    private readonly engine: EngineContext,
    private readonly grid: Grid,
    private readonly blocks: Blocks,
    /** Can the viewer see this edge? */
    private readonly seen: (edge: number) => boolean,
  ) {
    this.group.name = 'door-swings'
    engine.scene.add(this.group)
  }

  /**
   * A wall changed kind. Called before the walls are redrawn, so the leaf is
   * already out of the static mesh when it is.
   */
  changed(edge: number, from: WallKind, to: WallKind): void {
    if (to === WallKind.DoorOpen && (from === WallKind.Door || from === WallKind.Locked)) {
      this.begin(edge, 'open', from, to, false)
    } else if (to === WallKind.Door && from === WallKind.DoorOpen) {
      this.begin(edge, 'close', from, to, false)
    } else if (to === WallKind.None && (from === WallKind.Door || from === WallKind.Locked)) {
      this.begin(edge, 'break', from, to, false)
    }
  }

  /** A shoulder was put to a locked door. Replaced by the swing if it gave. */
  rattle(edge: number): void {
    if (this.swings.has(edge)) return
    this.begin(edge, 'rattle', WallKind.Locked, WallKind.Locked, true)
  }

  update(delta: number): void {
    for (const [edge, swing] of this.swings) {
      swing.age += delta
      const t = Math.min(swing.age / DURATION[swing.motion], 1)
      if (t >= 1) {
        this.release(swing)
        this.swings.delete(edge)
        this.blocks.showWall(edge)
        continue
      }
      this.pose(swing, t)
    }
  }

  dispose(): void {
    for (const [edge, swing] of this.swings) {
      this.release(swing)
      this.blocks.showWall(edge)
    }
    this.swings.clear()
    this.engine.scene.remove(this.group)
    this.geometry.dispose()
  }

  private begin(edge: number, motion: Motion, from: WallKind, to: WallKind, rebuild: boolean): void {
    if (!this.seen(edge)) return

    const existing = this.swings.get(edge)
    if (existing) this.release(existing)
    else {
      this.blocks.hideWall(edge)
      if (rebuild) this.blocks.rebuildWalls()
    }

    const { x, y, side } = this.grid.edgeTile(edge)
    const [dx, dz] = FACE_OFFSET[side]!
    // A wall stands on the higher floor of the two it divides.
    const floor = Math.max(this.grid.levelAt(x, y), this.grid.levelAt(x + dx, y + dz)) * LEVEL_HEIGHT
    // Hung exactly as `Blocks` hangs the leaf it stands open: hinged at the
    // low end of the edge, shut along it and open across it into its own tile.
    const [ax, az] = dx === 0 ? [1, 0] : [0, 1]
    const hinge = (TILE - WALL_THICKNESS) / 2
    const pivot = new Group()
    pivot.position.set(
      this.grid.worldX(x) + (dx * TILE) / 2 - ax * hinge,
      floor,
      this.grid.worldZ(y) + (dz * TILE) / 2 - az * hinge,
    )

    const shutYaw = Math.atan2(-az, ax)
    const openYaw = Math.atan2(dz, -dx)
    let turn = openYaw - shutYaw
    while (turn > Math.PI) turn -= Math.PI * 2
    while (turn < -Math.PI) turn += Math.PI * 2

    const colorOf = (kind: WallKind) => new Color(WALL_STYLE[kind === WallKind.None ? WallKind.Door : kind].color)
    const material = new MeshStandardMaterial({ color: colorOf(from), transparent: true })
    const leaf = new Mesh(this.geometry, material)
    pivot.add(leaf)
    this.group.add(pivot)

    const swing: Swing = {
      motion,
      pivot,
      leaf,
      material,
      age: 0,
      shutYaw,
      turn,
      floor,
      height: WALLS[WallKind.Door].height,
      from: colorOf(from),
      to: colorOf(to),
    }
    this.swings.set(edge, swing)
    this.pose(swing, 0)
  }

  /** Put the leaf where `t` of the way through its motion has it. */
  private pose(swing: Swing, t: number): void {
    const { motion, pivot, leaf, material } = swing
    let open = 0
    let shudder = 0
    switch (motion) {
      case 'open':
        open = 1 - (1 - t) ** 3
        break
      case 'close':
        // Accelerating into the frame: a door that is shut, not set down.
        open = 1 - t * t
        break
      case 'break':
        open = 1 - (1 - Math.min(t / 0.3, 1)) ** 3
        break
      case 'rattle':
        shudder = Math.sin(t * Math.PI * 14) * 0.07 * (1 - t)
        break
    }

    pivot.rotation.y = swing.shutYaw + swing.turn * open + shudder
    leaf.scale.set(TILE * (1 - (1 - DOOR_LEAF) * open), swing.height, 1)
    leaf.position.y = swing.height / 2
    leaf.rotation.x = 0
    pivot.position.y = swing.floor
    material.opacity = 1
    material.color.copy(swing.from).lerp(swing.to, open)

    if (motion === 'break') {
      // Thrown open, it tips over its own length and drops away.
      const fall = Math.max((t - 0.3) / 0.7, 0)
      leaf.rotation.x = fall * 1.1
      pivot.position.y = swing.floor - 0.5 * fall * fall
      material.opacity = 1 - fall
    }
  }

  private release(swing: Swing): void {
    this.group.remove(swing.pivot)
    swing.material.dispose()
  }
}
