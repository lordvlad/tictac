import type { Component, ComponentClass } from './Component'
import type { System } from './System'

/** Singleton entity holding match-wide rule components. */
export const GLOBAL_ENTITY_ID = 0

export type ComponentChangeListener = (
  entityId: number,
  componentName: string,
  data: Record<string, unknown>
) => void

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
 * pair replication uses, because a second way to read a component out is a
 * second thing to keep in step.
 */
export type WorldSnapshot = EntitySnapshot[]

/** Structural equality over the JSON-shaped data a component serialises to. */
function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== typeof b) return false
  if (a === null || b === null) return false
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) if (!jsonEqual(a[i], b[i])) return false
    return true
  }
  if (typeof a === 'object') {
    const ao = a as Record<string, unknown>
    const bo = b as Record<string, unknown>
    const keys = Object.keys(ao)
    if (keys.length !== Object.keys(bo).length) return false
    for (const k of keys) if (!jsonEqual(ao[k], bo[k])) return false
    return true
  }
  return false
}

export class World {
  private nextEntityId = 1
  private readonly activeEntities = new Set<number>()

  /** entityId -> componentName -> component */
  private readonly entityComponents = new Map<number, Map<string, Component>>()
  /** entityId -> componentName -> last broadcast snapshot, for dirty diffing. */
  private readonly snapshots = new Map<number, Map<string, Record<string, unknown>>>()
  /**
   * componentName -> entities carrying it.
   *
   * A query used to scan every entity, which was fine while the entities were
   * a squad each; with one per wall it made systems that tick every frame —
   * movement, above all — cost in proportion to the map's walls.
   */
  private readonly byComponent = new Map<string, Set<number>>()

  private readonly systems: System[] = []
  private readonly listeners: ComponentChangeListener[] = []

  /** True while remote state is being applied, so echoes are not re-broadcast. */
  private applyingRemote = false

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
      this.snapshots.set(id, new Map())
    }
    this.activeEntities.add(id)
    return map
  }

  destroyEntity(id: number): void {
    for (const name of this.entityComponents.get(id)?.keys() ?? []) this.byComponent.get(name)?.delete(id)
    this.activeEntities.delete(id)
    this.entityComponents.delete(id)
    this.snapshots.delete(id)
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
    const data = component.serialize()
    this.snapshots.get(entityId)?.set(component.name, data)
    this.emit(entityId, component.name, data)
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
    this.snapshots.get(entityId)?.delete(componentClass.componentName)
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

  update(delta: number): void {
    for (const system of this.systems) system.update(delta, this)
  }

  onComponentChanged(listener: ComponentChangeListener): () => void {
    this.listeners.push(listener)
    return () => {
      const idx = this.listeners.indexOf(listener)
      if (idx !== -1) this.listeners.splice(idx, 1)
    }
  }

  /**
   * Broadcast every component whose serialised form changed since the last pass.
   *
   * State is mutated all over the codebase — combat resolution, the turn
   * manager, the debug panel — and requiring each of those call sites to
   * announce itself is how updates go missing. Diffing instead means a
   * mutation cannot be forgotten, only observed late.
   */
  syncDirty(): void {
    // Local play has no listener, so there is nothing to diff for.
    if (this.applyingRemote || this.listeners.length === 0) return
    for (const [entityId, components] of this.entityComponents) {
      const entitySnapshots = this.snapshots.get(entityId)
      if (!entitySnapshots) continue
      for (const [name, component] of components) {
        const data = component.serialize()
        if (jsonEqual(entitySnapshots.get(name), data)) continue
        entitySnapshots.set(name, data)
        this.emit(entityId, name, data)
      }
    }
  }

  /**
   * Write peer state into a component without echoing it back to that peer.
   * Records the result as the current snapshot so the diff stays quiet.
   */
  applyRemote(entityId: number, componentName: string, data: Record<string, unknown>): boolean {
    const component = this.entityComponents.get(entityId)?.get(componentName)
    if (!component) return false
    this.applyingRemote = true
    try {
      component.deserialize(data)
      this.snapshots.get(entityId)?.set(componentName, component.serialize())
    } finally {
      this.applyingRemote = false
    }
    return true
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
   * Put a snapshot back, without announcing it and without leaving the diff
   * armed.
   *
   * Same discipline as {@link applyRemote}: writes are made under
   * `applyingRemote` so nothing echoes, and each result is re-baselined so the
   * next `syncDirty` does not report the rewind as a mutation. A component
   * named in the frame but no longer on the entity is skipped.
   */
  restore(snapshot: WorldSnapshot): void {
    this.applyingRemote = true
    try {
      for (const { entityId, components } of snapshot) {
        const live = this.entityComponents.get(entityId)
        if (!live) continue
        const baseline = this.snapshots.get(entityId)
        for (const [name, data] of Object.entries(components)) {
          const component = live.get(name)
          if (!component) continue
          component.deserialize(data)
          baseline?.set(name, component.serialize())
        }
      }
    } finally {
      this.applyingRemote = false
    }
  }

  private emit(entityId: number, componentName: string, data: Record<string, unknown>): void {
    for (const listener of this.listeners) listener(entityId, componentName, data)
  }

  clear(): void {
    this.activeEntities.clear()
    this.entityComponents.clear()
    this.snapshots.clear()
    this.byComponent.clear()
    this.systems.length = 0
    this.listeners.length = 0
    this.nextEntityId = 1
  }
}
