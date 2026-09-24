import { System } from '../System'
import type { World } from '../World'
import { Block, type Grid } from '../../core/Grid'
import { burnedSurface, type Ground } from '../../core/Fire'
import type { Surface } from '../../core/Surfaces'
import { GroundComponent } from '../components/GroundComponent'

/**
 * Owns what is on the ground — fire, smoke, ash, crates burned away — and
 * keeps the grid's index in step with it.
 *
 * The same arrangement as walls: the component is the truth that replicates,
 * digests and rewinds; the grid is the index the rules read on every step and
 * sight line. Every change the rules make goes through here, the one writer,
 * so the two cannot disagree. A change that arrives from outside — a peer's
 * replication, a replay put back — is caught up in {@link update}.
 */
export class GroundSystem extends System implements Ground {
  /** Fired when the ground changed: something caught, burned out, or cleared. */
  onGroundChanged?: () => void

  private entityId = -1
  /** The map as generated, to put back what a rewind un-burns. */
  private readonly baseSurfaces: Uint8Array
  private readonly baseBlocks: Uint8Array
  /** The component revision the grid was last rebuilt from. */
  private seen = 0
  private world: World | null = null

  constructor(readonly grid: Grid) {
    super()
    this.baseSurfaces = grid.surfaces.slice()
    this.baseBlocks = grid.blocks.slice()
  }

  /** Create the one ground entity. Both peers do it at the same point, so it has the same id. */
  spawn(world: World): number {
    this.world = world
    this.entityId = world.createEntity()
    world.addComponent(this.entityId, new GroundComponent())
    return this.entityId
  }

  /** The ground entity, for whoever decides who replicates it. */
  get entity(): number {
    return this.entityId
  }

  private get state(): GroundComponent {
    const state = this.world?.getComponent(this.entityId, GroundComponent)
    if (!state) throw new Error('GroundSystem used before spawn')
    return state
  }

  setFire(index: number, turns: number): void {
    const state = this.state
    if (turns > 0) state.fire.set(index, turns)
    else state.fire.delete(index)
    this.grid.fire[index] = turns
    this.onGroundChanged?.()
  }

  burnOut(index: number): void {
    const state = this.state
    const surface = this.grid.surfaces[index] as Surface
    const ash = burnedSurface(surface)
    if (ash !== surface) {
      state.ash.add(index)
      this.grid.surfaces[index] = ash
    }
    if (this.grid.blocks[index] === Block.Half) {
      state.razed.add(index)
      this.grid.blocks[index] = Block.None
    }
    this.onGroundChanged?.()
  }

  /** Rebuild the grid's index from the component, when it changed from outside. */
  update(_delta: number, world: World): void {
    const state = world.getComponent(this.entityId, GroundComponent)
    if (!state || state.revision === this.seen) return
    this.seen = state.revision
    const { grid } = this
    grid.fire.fill(0)
    grid.smoke.fill(0)
    for (const [index, turns] of state.fire) grid.fire[index] = turns
    for (const [index, turns] of state.smoke) grid.smoke[index] = turns
    grid.surfaces.set(this.baseSurfaces)
    grid.blocks.set(this.baseBlocks)
    for (const index of state.ash) grid.surfaces[index] = burnedSurface(grid.surfaces[index] as Surface)
    for (const index of state.razed) grid.blocks[index] = Block.None
    this.onGroundChanged?.()
  }
}
