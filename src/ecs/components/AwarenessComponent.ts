import { Component } from '../Component'
import { Awareness } from '../../core/Awareness'

/**
 * What the unit knows is going on around it (`core/Awareness`).
 *
 * Replicated and digested: it decides what a watcher can react to and which
 * way a unit turns on hearing something, so two peers that disagreed about it
 * would be playing two matches.
 */
export class AwarenessComponent extends Component {
  static readonly componentName = 'awareness'
  get name(): string {
    return AwarenessComponent.componentName
  }

  constructor(
    public state: Awareness = Awareness.Unaware,
    /** Of its own turns spent alerted without hearing anything new. */
    public quietTurns: number = 0,
  ) {
    super()
  }

  serialize(): Record<string, unknown> {
    return { state: this.state, quietTurns: this.quietTurns }
  }

  deserialize(data: Record<string, unknown>): void {
    if (data.state === Awareness.Unaware || data.state === Awareness.Alerted || data.state === Awareness.Engaged) {
      this.state = data.state
    }
    if (typeof data.quietTurns === 'number') this.quietTurns = data.quietTurns
  }
}
