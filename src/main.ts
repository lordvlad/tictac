import Game from '@mavonengine/core/Game'
import type { Asset } from '@mavonengine/core/Types/Asset'
import { Vector3 } from 'three'
import { OrbitRig } from './camera/OrbitRig'
import { Faction } from './config'
import { resolveSeed } from './core/rng'
import { createVisibilityMap } from './core/Visibility'
import { Battlefield } from './game/Battlefield'
import { InteractionController } from './game/InteractionController'
import { Squads } from './game/Squads'
import { TurnManager } from './game/TurnManager'
import { Hud } from './hud/Hud'
import { OffscreenPortraits } from './render/Portraits'
import { Tracers } from './render/Tracers'
import './game.css'

const baseUrl = import.meta.env.BASE_URL.endsWith('/')
  ? import.meta.env.BASE_URL
  : `${import.meta.env.BASE_URL}/`

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
  const battlefield = new Battlefield(seed)
  const squads = new Squads(battlefield.grid, battlefield.spawns)

  const rig = new OrbitRig(Game.instance().camera.instance, Game.instance().canvas, {
    bounds: battlefield.grid.halfExtent,
  })

  const portraits = new OffscreenPortraits()
  const tracers = new Tracers()
  const turnManager = new TurnManager(squads, rig)

  const hud = new Hud(turnManager, squads, rig, portraits, seedLabel)

  const visibilityMaps: Record<Faction, Uint8Array> = {
    [Faction.Blue]: createVisibilityMap(battlefield.grid.size),
    [Faction.Red]: createVisibilityMap(battlefield.grid.size),
  }

  const controller = new InteractionController(
    battlefield,
    squads,
    turnManager,
    rig,
    hud,
    tracers,
    visibilityMaps,
  )

  // Initial camera focus on map center (no character selected on start)
  rig.snapTo(new Vector3(0, 0, 0))

  // Handle 30 Hz simulation & per-frame rAF updates
  Game.instance().onUpdate((delta) => {
    if (delta > 0.5) return
    squads.renderUpdate(delta)
    tracers.update(delta)
    controller.update(delta)
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
