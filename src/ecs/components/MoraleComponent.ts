import { Component } from '../Component'
import { MORALE } from '../../config'
import { MoraleBreak } from '../../core/Morale'

const KINDS: ReadonlySet<unknown> = new Set(Object.values(MoraleBreak))

/**
 * How much more the unit can take, and whether it already could not
 * (`core/Morale`).
 *
 * Replicated and digested: a broken unit takes no orders and, panicking or in
 * a frenzy, is moved by the rules on both peers — two sides that disagreed
 * about it would be playing two matches, and the other side has to be able to
 * watch it happen.
 */
export class MoraleComponent extends Component {
  static readonly componentName = 'morale'
  get name(): string {
    return MoraleComponent.componentName
  }

  constructor(
    public morale: number = MORALE.max,
    /** The break the unit is in, or null while it holds. */
    public broken: MoraleBreak | null = null,
    /** Of its own turns begun broken, which is what its odds of steadying rise with. */
    public brokenTurns: number = 0,
  ) {
    super()
  }

  serialize(): Record<string, unknown> {
    return { morale: this.morale, broken: this.broken, brokenTurns: this.brokenTurns }
  }

  deserialize(data: Record<string, unknown>): void {
    if (typeof data.morale === 'number') this.morale = data.morale
    if (data.broken === null || KINDS.has(data.broken)) this.broken = data.broken as MoraleBreak | null
    if (typeof data.brokenTurns === 'number') this.brokenTurns = data.brokenTurns
  }
}
