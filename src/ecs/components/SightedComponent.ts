import { Component } from '../Component'

/**
 * Whether this unit can currently be seen, and whether its sheet is known.
 *
 * Fog of war decides `seen`, the HUD and the input planners read it, and a
 * view mirrors it onto a mesh. It lived on the mesh's `visible` flag until
 * now, which made "can I shoot that" a question about the renderer — and
 * unanswerable with no renderer attached.
 *
 * `seen` is a *view* of shared state, not state: each window computes it for
 * what it is showing (a spectator reveals everything), and no rule reads it —
 * only the HUD, the planners and the meshes. So it is left out of
 * `serialize`, which is what replication, rewind snapshots and the state
 * digest all read. While it was in, every window published its own fog as if
 * it were a fact about the unit, and a referee — which draws no fog at all —
 * disagreed with the first digest of every refereed match on whether the
 * other side's units were visible, and aborted it. Fog is recomputed after
 * every rewind and every tick, so nothing is lost by not storing it.
 *
 * `known` is the opposite: the rules set it (a shot, a hit, a blast), on
 * every peer alike, so it is shared state and travels like any other.
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
     * shoot at you, or hitting it, does.
     */
    public known: boolean = false,
  ) {
    super()
  }

  serialize(): Record<string, unknown> {
    return { known: this.known }
  }

  deserialize(data: Record<string, unknown>): void {
    if (typeof data.known === 'boolean') this.known = data.known
  }
}
