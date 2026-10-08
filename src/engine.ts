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

/**
 * Stop the engine drawing frames until the returned function is called: for a
 * screen that covers the canvas and draws its own (the world map), so two
 * render loops do not share the GPU. The engine's loop has no pause of its
 * own, so its one per-frame call is set aside and put back.
 */
export function pauseRendering(game: Game): () => void {
  const { renderer } = game
  const update = renderer.update
  renderer.update = () => {}
  return () => {
    renderer.update = update
  }
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
