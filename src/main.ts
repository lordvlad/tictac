import Game from '@mavonengine/core/Game'
import type { Asset } from '@mavonengine/core/Types/Asset'
import { Vector3 } from 'three'
import { OrbitRig } from './camera/OrbitRig'
import { createEngineContext } from './engine'
import { SIM } from './config'
import { resolveSeed } from './core/rng'
import { Battlefield } from './game/Battlefield'
import { InteractionController } from './game/InteractionController'
import { Squads } from './game/Squads'
import { TurnManager } from './game/TurnManager'
import { Hud } from './hud/Hud'
import { OffscreenPortraits } from './render/Portraits'
import { Tracers } from './render/Tracers'
import './game.css'

// Vite exposed the deploy base via `import.meta.env.BASE_URL`; under Bun we
// resolve runtime-loaded assets against the document's own base URL instead,
// which works both at the dev-server root and under a GitHub Pages subpath.
const baseUrl = new URL('./', document.baseURI).href

const ASSETS: Asset[] = [
  { name: 'character', type: 'gltfModel', path: `${baseUrl}character.glb` },
]

const { seed, label: seedLabel } = resolveSeed()

// Initialize MavonEngine without physics world (grid-based game)
const game = new Game(ASSETS)
game.resources.loaders.gltfLoader.dracoLoader?.setDecoderPath(`${baseUrl}draco/`)

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
  const engine = createEngineContext(Game.instance())

  const battlefield = new Battlefield(seed, engine)
  const squads = new Squads(battlefield.grid, battlefield.spawns, engine)

  const rig = new OrbitRig(engine.camera, engine.canvas, {
    bounds: battlefield.grid.halfExtent,
  })

  const portraits = new OffscreenPortraits(engine)
  const tracers = new Tracers(engine)
  const turnManager = new TurnManager(squads, rig)

  // The HUD is a pure view: it emits intents, the controller carries them out.
  // `controller` is assigned just below, so the handler defers the lookup.
  const hud = new Hud((intent) => controller.handleIntent(intent))

  const controller = new InteractionController(
    battlefield,
    squads,
    turnManager,
    rig,
    hud,
    portraits,
    seedLabel,
    tracers,
    engine,
  )

  // Initial camera focus on map center (no character selected on start)
  rig.snapTo(new Vector3(0, 0, 0))

  // The engine ticks on a setInterval, which browsers clamp hard in a hidden or
  // busy tab — a delivery can carry seconds of wall time. Draining it in fixed
  // steps keeps movement, animation and fog advancing at the rate they would at
  // full frame rate, and the catch-up ceiling bounds the work instead of
  // discarding the frame: the previous `delta > 0.5` bail froze the entire
  // simulation for as long as the tab stayed throttled.
  let accumulator = 0
  Game.instance().onUpdate((delta) => {
    accumulator = Math.min(accumulator + delta, SIM.maxCatchUp)
    while (accumulator >= SIM.step) {
      accumulator -= SIM.step
      squads.renderUpdate(SIM.step)
      tracers.update(SIM.step)
      controller.update(SIM.step)
    }
    battlefield.flush()
  })

  Object.assign(window as unknown as Record<string, unknown>, {
    tictac: {
      game: Game.instance(),
      battlefield,
      squads,
      rig,
      turnManager,
      hud,
      controller,
      tracers,
      seed,
      seedLabel,
    },
  })

  console.info(`[tictac] tactical combat ready — seed ${seedLabel}`)
}
