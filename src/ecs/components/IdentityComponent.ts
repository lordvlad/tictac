import { Component } from '../Component'
import type { Faction } from '../../config'

export class IdentityComponent extends Component {
  static readonly componentName = 'identity'
  get name(): string {
    return IdentityComponent.componentName
  }

  constructor(
    public faction: Faction,
    public squadIndex: number,
    public nameString: string
  ) {
    super()
  }

  serialize(): Record<string, unknown> {
    return {
      faction: this.faction,
      squadIndex: this.squadIndex,
      name: this.nameString,
    }
  }

  deserialize(data: Record<string, unknown>): void {
    if (typeof data.faction === 'number' || typeof data.faction === 'string') {
      this.faction = data.faction as Faction
    }
    if (typeof data.squadIndex === 'number') this.squadIndex = data.squadIndex
    if (typeof data.name === 'string') this.nameString = data.name
  }
}
