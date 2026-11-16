import type { Component, ComponentClass } from './Component'
import type { System } from './System'

/** Singleton entity holding match-wide rule components. */
export const GLOBAL_ENTITY_ID = 0

/** One entity's components, serialised. */
export interface EntitySnapshot {
  entityId: number
  components: Record<string, Record<string, unknown>>
}

/**
 * A moment, as component data.
 *
 * Recorded commands are not invertible — damage is applied, points are spent,
 * statuses stack — so a replay that wants to step *backwards* has to have kept
 * the moment it is going back to. Built from the same `serialize`/`deserialize`
 * pair the state digest reads, because a second way to read a component out is
 * a second thing to keep in step.
 */
export type WorldSnapshot = EntitySnapshot[]

export class World {
  private nextEntityId = 1
  private readonly activeEntities = new Set<number>()

  /** entityId -> componentName -> component */
  private readonly entityComponents = new Map<number, Map<string, Component>>()
  /**
   * componentName -> entities carrying it.
   *
   * A query used to scan every entity, which was fine while the entities were
   * a squad each; with one per wall it made systems that tick every frame —
   * movement, above all — cost in proportion to the map's walls.
   */
  private readonly byComponent = new Map<string, Set<number>>()

  private readonly systems: System[] = []

  createEntity(): number {
    const id = this.nextEntityId++
    this.registerEntity(id)
    return id
  }

  private registerEntity(id: number): Map<string, Component> {
    let map = this.entityComponents.get(id)
    if (!map) {
      map = new Map()
      this.entityComponents.set(id, map)
    }
    this.activeEntities.add(id)
    return map
  }

  destroyEntity(id: number): void {
    for (const name of this.entityComponents.get(id)?.keys() ?? []) this.byComponent.get(name)?.delete(id)
    this.activeEntities.delete(id)
    this.entityComponents.delete(id)
  }

  /**
   * Every live entity.
   *
   * Exposed for the state digest, which has to account for *all* of a world
   * rather than the entities a caller happens to know about — a divergence in
   * a wall or in the rule tables is exactly as fatal as one in a soldier.
   */
  entityIds(): Iterable<number> {
    return this.activeEntities
  }

  /** The components on one entity, serialised, or null if it has none. */
  componentData(entityId: number): Record<string, Record<string, unknown>> | null {
    const components = this.entityComponents.get(entityId)
    if (!components) return null
    const data: Record<string, Record<string, unknown>> = {}
    for (const [name, component] of components) data[name] = component.serialize()
    return data
  }

  hasEntity(id: number): boolean {
    return this.activeEntities.has(id)
  }

  addComponent<T extends Component>(entityId: number, component: T): T {
    this.registerEntity(entityId).set(component.name, component)
    let holders = this.byComponent.get(component.name)
    if (!holders) {
      holders = new Set()
      this.byComponent.set(component.name, holders)
    }
    holders.add(entityId)
    return component
  }

  getComponent<T extends Component>(
    entityId: number,
    componentClass: ComponentClass<T>
  ): T | undefined {
    return this.entityComponents.get(entityId)?.get(componentClass.componentName) as T | undefined
  }

  hasComponent(entityId: number, componentClass: ComponentClass): boolean {
    return this.entityComponents.get(entityId)?.has(componentClass.componentName) ?? false
  }

  removeComponent(entityId: number, componentClass: ComponentClass): void {
    const map = this.entityComponents.get(entityId)
    if (!map?.delete(componentClass.componentName)) return
    this.byComponent.get(componentClass.componentName)?.delete(entityId)
  }

  /**
   * Entities carrying every one of `componentClasses`, in ascending id — the
   * order they were created in, which is the order systems have always walked
   * them, and an order both peers share.
   */
  query(componentClasses: ComponentClass[]): number[] {
    let smallest: Set<number> | undefined
    for (const cls of componentClasses) {
      const holders = this.byComponent.get(cls.componentName)
      if (!holders || holders.size === 0) return []
      if (!smallest || holders.size < smallest.size) smallest = holders
    }
    if (!smallest) return [...this.activeEntities]
    const result: number[] = []
    for (const entityId of smallest) {
      const map = this.entityComponents.get(entityId)
      if (!map) continue
      let match = true
      for (const cls of componentClasses) {
        if (!map.has(cls.componentName)) {
          match = false
          break
        }
      }
      if (match) result.push(entityId)
    }
    return result.sort((a, b) => a - b)
  }

  addSystem(system: System): void {
    this.systems.push(system)
  }

  /** Stop ticking `system`. Disposing it is the caller's, since only the caller knows who else holds it. */
  removeSystem(system: System): void {
    const index = this.systems.indexOf(system)
    if (index !== -1) this.systems.splice(index, 1)
  }

  get systemCount(): number {
    return this.systems.length
  }

  update(delta: number): void {
    for (const system of this.systems) system.update(delta, this)
  }

  /**
   * Serialise the named entities' components.
   *
   * Named rather than "all": walls are entities too, and there are hundreds of
   * them on a map, so a replay keeps them as one byte each instead
   * (`WallSystem.kinds`) and snapshots only the units here.
   */
  snapshot(entityIds: Iterable<number>): WorldSnapshot {
    const frame: WorldSnapshot = []
    for (const entityId of entityIds) {
      const components = this.entityComponents.get(entityId)
      if (!components) continue
      const data: Record<string, Record<string, unknown>> = {}
      for (const [name, component] of components) data[name] = component.serialize()
      frame.push({ entityId, components: data })
    }
    return frame
  }

  /**
   * Put a snapshot back. A component named in the frame but no longer on the
   * entity is skipped.
   */
  restore(snapshot: WorldSnapshot): void {
    for (const { entityId, components } of snapshot) {
      const live = this.entityComponents.get(entityId)
      if (!live) continue
      for (const [name, data] of Object.entries(components)) live.get(name)?.deserialize(data)
    }
  }

  clear(): void {
    this.activeEntities.clear()
    this.entityComponents.clear()
    this.byComponent.clear()
    this.systems.length = 0
    this.nextEntityId = 1
  }
}
