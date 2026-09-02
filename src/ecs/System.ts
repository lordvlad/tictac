import type { World } from './World'

export abstract class System {
  abstract update(delta: number, world: World): void
}
