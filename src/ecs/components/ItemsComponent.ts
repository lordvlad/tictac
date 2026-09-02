import { Component } from '../Component'
import { ItemId, STARTING_ITEMS } from '../../core/Items'

/** Consumables still in the pouch, by item. */
export class ItemsComponent extends Component {
  static readonly componentName = 'items'
  get name(): string {
    return ItemsComponent.componentName
  }

  constructor(public items: Record<ItemId, number> = { ...STARTING_ITEMS }) {
    super()
  }

  serialize(): Record<string, unknown> {
    return { items: { ...this.items } }
  }

  deserialize(data: Record<string, unknown>): void {
    if (!data.items || typeof data.items !== 'object') return
    for (const id of Object.values(ItemId)) {
      const value = (data.items as Record<string, unknown>)[id]
      if (typeof value === 'number') this.items[id] = value
    }
  }
}
