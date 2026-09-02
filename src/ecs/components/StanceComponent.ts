import { Component } from '../Component'
import type { Tile } from '../../core/Grid'

export class StanceComponent extends Component {
  static readonly componentName = 'stance'
  get name(): string {
    return StanceComponent.componentName
  }

  constructor(
    public isCrouching: boolean = false,
    public isMoving: boolean = false,
    public movingPath: Tile[] = [],
    /** Corner peeking: also see from the free tiles beside the wall hugged. */
    public peek: boolean = false
  ) {
    super()
  }

  serialize(): Record<string, unknown> {
    return {
      isCrouching: this.isCrouching,
      isMoving: this.isMoving,
      peek: this.peek,
      movingPath: this.movingPath.map((t) => ({ x: t.x, y: t.y })),
    }
  }

  deserialize(data: Record<string, unknown>): void {
    if (typeof data.isCrouching === 'boolean') this.isCrouching = data.isCrouching
    if (typeof data.isMoving === 'boolean') this.isMoving = data.isMoving
    if (typeof data.peek === 'boolean') this.peek = data.peek
    if (Array.isArray(data.movingPath)) {
      const path: Tile[] = []
      for (const entry of data.movingPath) {
        if (entry && typeof entry === 'object') {
          const t = entry as Record<string, unknown>
          if (typeof t.x === 'number' && typeof t.y === 'number') path.push({ x: t.x, y: t.y })
        }
      }
      this.movingPath = path
    }
  }
}
