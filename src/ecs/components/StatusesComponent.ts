import { Component } from '../Component'
import { type StatusState, statusStacks } from '../../core/Ballistics'
import type { StatusKind } from '../../core/Arsenal'

export class StatusesComponent extends Component {
  static readonly componentName = 'statuses'
  get name(): string {
    return StatusesComponent.componentName
  }

  constructor(public list: StatusState[] = []) {
    super()
  }

  serialize(): Record<string, unknown> {
    return {
      // Normalised on the way out, so a round trip is idempotent and a peer
      // never receives an absent count to guess at.
      list: this.list.map((s) => ({
        kind: s.kind,
        turnsLeft: s.turnsLeft,
        stacks: statusStacks(s),
      })),
    }
  }

  deserialize(data: Record<string, unknown>): void {
    if (Array.isArray(data.list)) {
      this.list = data.list
        .filter(
          (s): s is Record<string, unknown> =>
            typeof s === 'object' && s !== null && typeof s.kind === 'string' && typeof s.turnsLeft === 'number'
        )
        .map((s) => ({
          kind: s.kind as StatusKind,
          turnsLeft: s.turnsLeft as number,
          // An unstacked status is one stack; a peer that omits it means one.
          stacks: typeof s.stacks === 'number' && s.stacks > 0 ? s.stacks : 1,
        }))
    }
  }
}
