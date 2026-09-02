import type { Component, ComponentClass } from './Component'
import type { System } from './System'

/** Singleton entity holding match-wide rule components. */
export const GLOBAL_ENTITY_ID = 0

export type ComponentChangeListener = (
  entityId: number,
  componentName: string,
  data: Record<string, unknown>
) => void

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
    this.activeEntities.delete(id)
    this.entityComponents.delete(id)
    this.snapshots.delete(id)
  }

  hasEntity(id: number): boolean {
    return this.activeEntities.has(id)
  }

  addComponent<T extends Component>(entityId: number, component: T): T {
    this.registerEntity(entityId).set(component.name, component)
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
    this.snapshots.get(entityId)?.delete(componentClass.componentName)
  }

  query(componentClasses: ComponentClass[]): number[] {
    const result: number[] = []
    for (const entityId of this.activeEntities) {
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
    return result
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

  private emit(entityId: number, componentName: string, data: Record<string, unknown>): void {
    for (const listener of this.listeners) listener(entityId, componentName, data)
  }

  clear(): void {
    this.activeEntities.clear()
    this.entityComponents.clear()
    this.snapshots.clear()
    this.systems.length = 0
    this.listeners.length = 0
    this.nextEntityId = 1
  }
}
