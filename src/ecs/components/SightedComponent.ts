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

  constructor(
    public seen: boolean = true,
    /**
     * Whether this unit's *sheet* has been worked out by the other side.
     *
     * Seeing a body tells you nothing about how hard it is to hit; having it
     * shoot at you, or hitting it, does. Local for the same reason `seen` is:
     * it is one side's knowledge about the other, not a fact about the unit.
     */
    public known: boolean = false,
  ) {
    super()
  }

  serialize(): Record<string, unknown> {
    return { seen: this.seen, known: this.known }
  }

  deserialize(data: Record<string, unknown>): void {
    if (typeof data.seen === 'boolean') this.seen = data.seen
    if (typeof data.known === 'boolean') this.known = data.known
  }
}
