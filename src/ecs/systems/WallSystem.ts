import { System } from '../System'
import type { World, WorldSnapshot } from '../World'
import type { Grid } from '../../core/Grid'
import { WallKind } from '../../core/Walls'
import { WallComponent } from '../components/WallComponent'

/**
 * Owns the map's walls, and keeps the grid's edge storage in step with them.
 *
 * The components are the truth; the grid is a spatial index over them, because
 * pathfinding and line of sight cannot afford an entity query per edge. Every
 * write goes through {@link setKind} so there is exactly one writer, and a
 * change arriving from the debug panel, a rule, or a peer over the network all
 * land the same way.
 */
export class WallSystem extends System {
  /** Fired when the grid changed shape, so the renderer can rebuild. */
  onWallsChanged?: () => void

  /** edgeId -> entity, so an edge can be found without scanning the world. */
  private readonly byEdge = new Map<number, number>()

  constructor(private readonly grid: Grid) {
    super()
  }

  /** Register a wall entity per wall the map actually placed. */
  spawnFromGrid(world: World): void {
    this.byEdge.clear()
    this.grid.forEachWall((x, y, side, kind) => {
      const edge = this.grid.edgeId(x, y, side)
      const entityId = world.createEntity()
      world.addComponent(entityId, new WallComponent(edge, kind))
      this.byEdge.set(edge, entityId)
    })
  }

  entityAt(edge: number): number | undefined {
    return this.byEdge.get(edge)
  }

  /** Every wall entity, so callers can test ownership without a world query. */
  get entityIds(): Iterable<number> {
    return this.byEdge.values()
  }

  /**
   * Change what a wall is made of — shattering glazing, for instance.
   *
   * Writes the component and the grid together; the alternative is a grid that
   * disagrees with the entity about whether a unit can walk through.
   */
  setKind(world: World, edge: number, kind: WallKind): void {
    const entityId = this.byEdge.get(edge)
    if (entityId === undefined) return
    const wall = world.getComponent(entityId, WallComponent)
    if (!wall || wall.kind === kind) return
    wall.kind = kind
    this.writeToGrid(wall.edge, kind)
    this.onWallsChanged?.()
  }

  /**
   * Every wall's kind, one byte each in entity order: a whole map's walls as
   * a few hundred bytes, which a replay can afford to keep at every event.
   */
  kinds(world: World): Uint8Array {
    const kinds = new Uint8Array(this.byEdge.size)
    let i = 0
    for (const entityId of this.byEdge.values()) {
      kinds[i++] = world.getComponent(entityId, WallComponent)?.kind ?? WallKind.None
    }
    return kinds
  }

  /**
   * Put the walls back to `kinds`, as {@link kinds} took them.
   *
   * Through `World.restore`, so a rewound window is not announced as a change
   * nobody made, and then the same catch-up a peer's walls get: the grid is an
   * index over the components.
   */
  restoreKinds(world: World, kinds: Uint8Array): void {
    const changed: WorldSnapshot = []
    let i = 0
    for (const entityId of this.byEdge.values()) {
      const wall = world.getComponent(entityId, WallComponent)
      const kind = kinds[i++] as WallKind | undefined
      if (!wall || kind === undefined || wall.kind === kind) continue
      changed.push({ entityId, components: { [WallComponent.componentName]: { edge: wall.edge, kind } } })
    }
    if (changed.length === 0) return
    world.restore(changed)
    this.update(0, world)
  }

  /**
   * Re-read every component into the grid.
   *
   * Peer state is applied straight onto components, which leaves the index
   * stale; this is how it catches up.
   */
  update(_delta: number, world: World): void {
    let changed = false
    for (const entityId of world.query([WallComponent])) {
      const wall = world.getComponent(entityId, WallComponent)!
      const { x, y, side } = this.grid.edgeTile(wall.edge)
      if (this.grid.wallAt(x, y, side) === wall.kind) continue
      this.writeToGrid(wall.edge, wall.kind)
      changed = true
    }
    if (changed) this.onWallsChanged?.()
  }

  private writeToGrid(edge: number, kind: WallKind): void {
    const { x, y, side } = this.grid.edgeTile(edge)
    this.grid.setWall(x, y, side, kind)
  }
}
