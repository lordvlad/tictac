import { Component } from '../Component'
import { WeaponId } from '../../core/Arsenal'
import { type Deeds, noDeeds } from '../../core/Progression'

const COUNTS = ['kills', 'wounds', 'unseen', 'pushed', 'blows', 'forced', 'heavy', 'kit'] as const

/**
 * A unit's service record for the match (`core/Progression`): what it did
 * that it can learn from once the match is over.
 *
 * Replicated and digested, like morale: it is written by the rules on both
 * peers from the same commands, so two sides that disagreed about it would
 * show two different end screens — and a rewind puts it back with the unit.
 */
export class DeedsComponent extends Component implements Deeds {
  static readonly componentName = 'deeds'
  get name(): string {
    return DeedsComponent.componentName
  }

  hits: Record<WeaponId, number>
  crits: Record<WeaponId, number>
  kills: number
  wounds: number
  unseen: number
  pushed: number
  blows: number
  forced: number
  heavy: number
  kit: number

  constructor() {
    super()
    const empty = noDeeds()
    this.hits = empty.hits
    this.crits = empty.crits
    this.kills = empty.kills
    this.wounds = empty.wounds
    this.unseen = empty.unseen
    this.pushed = empty.pushed
    this.blows = empty.blows
    this.forced = empty.forced
    this.heavy = empty.heavy
    this.kit = empty.kit
  }

  serialize(): Record<string, unknown> {
    return {
      hits: { ...this.hits },
      crits: { ...this.crits },
      kills: this.kills,
      wounds: this.wounds,
      unseen: this.unseen,
      pushed: this.pushed,
      blows: this.blows,
      forced: this.forced,
      heavy: this.heavy,
      kit: this.kit,
    }
  }

  deserialize(data: Record<string, unknown>): void {
    for (const key of COUNTS) {
      const value = data[key]
      if (typeof value === 'number') this[key] = value
    }
    for (const table of ['hits', 'crits'] as const) {
      const incoming = data[table]
      if (typeof incoming !== 'object' || incoming === null) continue
      for (const weapon of Object.values(WeaponId)) {
        const value = (incoming as Record<string, unknown>)[weapon]
        if (typeof value === 'number') this[table][weapon] = value
      }
    }
  }
}
