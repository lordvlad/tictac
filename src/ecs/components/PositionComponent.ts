import { Vector3 } from 'three'
import { Component } from '../Component'
import type { Tile } from '../../core/Grid'

/**
 * Where the unit is, logically.
 *
 * `targetPos` is a {@link Vector3} because the renderer lerps the mesh toward
 * it every frame; holding the same object the renderer reads keeps one store,
 * and the wire format stays plain `{x, y, z}`.
 */
export class PositionComponent extends Component {
  static readonly componentName = 'position'
  get name(): string {
    return PositionComponent.componentName
  }

  readonly targetPos: Vector3

  constructor(
    public tile: Tile = { x: 0, y: 0 },
    targetPos: Vector3 = new Vector3(),
    public targetYaw: number = 0,
    public level: number = 0
  ) {
    super()
    this.targetPos = targetPos
  }

  serialize(): Record<string, unknown> {
    return {
      tile: { x: this.tile.x, y: this.tile.y },
      targetPos: { x: this.targetPos.x, y: this.targetPos.y, z: this.targetPos.z },
      targetYaw: this.targetYaw,
      level: this.level,
    }
  }

  deserialize(data: Record<string, unknown>): void {
    if (data.tile && typeof data.tile === 'object') {
      const t = data.tile as Record<string, unknown>
      if (typeof t.x === 'number' && typeof t.y === 'number') this.tile = { x: t.x, y: t.y }
    }
    if (data.targetPos && typeof data.targetPos === 'object') {
      const p = data.targetPos as Record<string, unknown>
      if (typeof p.x === 'number' && typeof p.y === 'number' && typeof p.z === 'number') {
        this.targetPos.set(p.x, p.y, p.z)
      }
    }
    if (typeof data.targetYaw === 'number') this.targetYaw = data.targetYaw
    if (typeof data.level === 'number') this.level = data.level
  }
}
