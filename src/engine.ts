import type Game from '@mavonengine/core/Game'

/**
 * The slice of the engine this game actually uses.
 *
 * Modules take this instead of reaching for `Game.instance()`, so what a class
 * touches is visible in its constructor and a test can hand it a scene and a
 * canvas without booting the engine.
 *
 * Members are the engine's own long-lived objects, so holding them is safe:
 * `resources.items` is filled in place as assets load, and `camera.instance`
 * survives resizes.
 *
 * Not everything can be routed this way: the engine's own `Entity3D` base class
 * adds itself to `Game.instance().scene`, so entities remain bound to the
 * singleton regardless of what we pass them.
 */
export interface EngineContext {
  readonly scene: Game['scene']
  readonly camera: Game['camera']['instance']
  readonly canvas: Game['canvas']
  readonly assets: Game['resources']['items']
  readonly world: Game['world']
}

export function createEngineContext(game: Game): EngineContext {
  return {
    scene: game.scene,
    camera: game.camera.instance,
    canvas: game.canvas,
    assets: game.resources.items,
    world: game.world,
  }
}
