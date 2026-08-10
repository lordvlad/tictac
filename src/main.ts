import Game from '@mavonengine/core/Game'
import type { Asset } from '@mavonengine/core/Types/Asset'
import { Vector3 } from 'three'
import { OrbitRig } from './camera/OrbitRig'
import { Battlefield } from './game/Battlefield'
import { resolveSeed } from './core/rng'
import './game.css'

const ASSETS: Asset[] = [
  { name: 'character', type: 'gltfModel', path: '/character.glb' },
]

const { seed, label: seedLabel } = resolveSeed()

// NOTE: no physics world is passed. This game is entirely grid-based, so Rapier
// is never stepped. `@dimforge/rapier3d-compat` still has to be installed
// because BaseGame.js imports its `version` export at module scope.
const game = new Game(ASSETS)

/**
 * The engine's LoadingScreen only wires itself up inside a `uiMounted`
 * listener, and it hard-requires an element with id="loadingBar". Until
 * `uiMounted` fires, LoadingScreen.update() early-returns and #ui stays at
 * opacity 0 — i.e. the entire HUD is invisible. So: mount, then trigger.
 */
game.on('documentReady', () => {
  const ui = game.uiRoot
  ui.innerHTML = `
    <div id="loadingBar"></div>
    <div id="bootLabel">Deploying — seed ${seedLabel}</div>
  `
  game.trigger('uiMounted')
})

game.resources.on('loaded', () => {
  document.getElementById('bootLabel')?.classList.add('ended')
  start()
})

function start(): void {
  const battlefield = new Battlefield(seed)

  const rig = new OrbitRig(Game.instance().camera.instance, Game.instance().canvas, {
    bounds: battlefield.grid.halfExtent,
  })
  rig.snapTo(new Vector3(0, 0, 0))

  // The engine ticks update() on a 30 Hz setInterval, and the very first tick
  // receives `performance.now() / 1000` because lastTickTime starts at 0.
  // Every consumer must guard against that spike.
  Game.instance().onUpdate((delta) => {
    if (delta > 0.5) return
    battlefield.flush()
  })

  Object.assign(window as unknown as Record<string, unknown>, {
    tictac: { game: Game.instance(), battlefield, rig, seed, seedLabel },
  })
  console.info(`[tictac] battlefield ready — seed ${seedLabel}`)
}
