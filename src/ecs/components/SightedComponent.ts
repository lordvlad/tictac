import { Component } from '../Component'

/**
 * Whether this unit can currently be seen by the side whose turn it is.
 *
 * Fog of war decides it, the HUD and the planners read it, and a view mirrors
 * it onto a mesh. It lived on the mesh's `visible` flag until now, which made
 * "can I shoot that" a question about the renderer — and unanswerable with no
 * renderer attached.
 *
 * Not replicated: each peer computes fog for the side it is looking at, so this
 * is a local view of shared state rather than state in its own right.
 */
export class SightedComponent extends Component {
  static readonly componentName = 'sighted'
  get name(): string {
    return SightedComponent.componentName
  }

  constructor(public seen: boolean = true) {
    super()
  }

  serialize(): Record<string, unknown> {
    return { seen: this.seen }
  }

  deserialize(data: Record<string, unknown>): void {
    if (typeof data.seen === 'boolean') this.seen = data.seen
  }
}
