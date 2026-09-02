import { Component } from '../Component'
import { WallKind } from '../../core/Walls'

/**
 * One wall, as the boundary it actually is: the edge it stands on plus what it
 * is made of.
 *
 * The edge is identity and never changes; `kind` is the mutable part. Giving a
 * wall an entity is what lets the environment change during a match — glazing
 * shattering into an open doorway is a `kind` write, and it replicates and
 * re-renders through the same path as a unit losing hit points.
 */
export class WallComponent extends Component {
  static readonly componentName = 'wall'
  get name(): string {
    return WallComponent.componentName
  }

  constructor(
    /** {@link Grid.edgeId} of the edge this wall occupies. */
    public edge: number = 0,
    public kind: WallKind = WallKind.Solid,
  ) {
    super()
  }

  serialize(): Record<string, unknown> {
    return { edge: this.edge, kind: this.kind }
  }

  deserialize(data: Record<string, unknown>): void {
    if (typeof data.edge === 'number') this.edge = data.edge
    if (typeof data.kind === 'number') this.kind = data.kind as WallKind
  }
}
