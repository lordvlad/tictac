import Game from '@mavonengine/core/Game'
import type { Asset } from '@mavonengine/core/Types/Asset'
import { Vector3 } from 'three'
import { OrbitRig } from './camera/OrbitRig'
import { createEngineContext } from './engine'
import { Faction, SIM } from './config'
import { resolveSeed } from './core/rng'
import { Battlefield } from './game/Battlefield'
import { InteractionController } from './game/InteractionController'
import { Squads } from './game/Squads'
import { TurnManager } from './game/TurnManager'
import { Hud } from './hud/Hud'
import { OffscreenPortraits } from './render/Portraits'
import { Tracers } from './render/Tracers'
import './game.css'
import { NetworkManager } from './game/NetworkManager'

const baseUrl = new URL('./', document.baseURI).href

const ASSETS: Asset[] = [
  { name: 'character', type: 'gltfModel', path: `${baseUrl}character.glb` },
]

const game = new Game(ASSETS)
game.resources.loaders.gltfLoader.dracoLoader?.setDecoderPath(`${baseUrl}draco/`)

game.on('documentReady', () => {
  const ui = game.uiRoot
  ui.innerHTML = `
    <div id="loadingBar"></div>
    <div id="bootLabel">Deploying...</div>
  `
  game.trigger('uiMounted')
})

game.resources.on('loaded', () => {
  document.getElementById('bootLabel')?.classList.add('ended')
  showMenu()
})

function showMenu(): void {
  const ui = Game.instance().uiRoot
  const container = document.createElement('div')
  container.id = 'start-menu-overlay'
  container.style.cssText = `
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    background: rgba(10, 14, 20, 0.92);
    backdrop-filter: blur(8px);
    z-index: 10000;
    font-family: inherit;
    color: #e2e8f0;
  `

  container.innerHTML = `
    <div style="background: #1e293b; padding: 32px 40px; border-radius: 12px; border: 1px solid #334155; box-shadow: 0 20px 25px -5px rgba(0,0,0,0.5); width: 380px; text-align: center;">
      <h1 style="margin: 0 0 8px 0; font-size: 28px; letter-spacing: 2px; color: #38bdf8;">TICTAC P2P</h1>
      <p style="margin: 0 0 24px 0; font-size: 14px; color: #94a3b8;">Tactical Combat Engine</p>
      
      <div id="menu-actions" style="display: flex; flex-direction: column; gap: 12px;">
        <button id="btn-local" style="padding: 12px; background: #3b82f6; color: white; border: none; border-radius: 6px; font-weight: 600; cursor: pointer;">Local Versus (Same Screen)</button>
        <button id="btn-host-mode" style="padding: 12px; background: #0ea5e9; color: white; border: none; border-radius: 6px; font-weight: 600; cursor: pointer;">Host P2P Match</button>
        <button id="btn-join-mode" style="padding: 12px; background: #6366f1; color: white; border: none; border-radius: 6px; font-weight: 600; cursor: pointer;">Join P2P Match</button>
      </div>

      <div id="menu-details" style="margin-top: 20px; display: none;"></div>
    </div>
  `

  ui.appendChild(container)

  const actionsEl = container.querySelector('#menu-actions') as HTMLElement
  const detailsEl = container.querySelector('#menu-details') as HTMLElement

  // Local Mode
  container.querySelector('#btn-local')?.addEventListener('click', () => {
    container.remove()
    const { seed, label } = resolveSeed()
    const network = new NetworkManager()
    start(seed, label, network)
  })

  // Host Mode
  container.querySelector('#btn-host-mode')?.addEventListener('click', async () => {
    actionsEl.style.display = 'none'
    detailsEl.style.display = 'block'
    detailsEl.innerHTML = `<p style="font-size: 14px; color: #94a3b8;">Initializing PeerJS Host...</p>`

    const { seed, label } = resolveSeed()
    const network = new NetworkManager()
    const hostId = await network.initHost(seed, label)

    detailsEl.innerHTML = `
      <p style="font-size: 14px; color: #38bdf8; margin-bottom: 8px;">Host Created!</p>
      <p style="font-size: 12px; color: #94a3b8; margin-bottom: 8px;">Share this Peer ID with your opponent:</p>
      <div style="display: flex; gap: 8px; margin-bottom: 16px;">
        <input id="peer-id-input" value="${hostId}" readonly style="flex: 1; padding: 8px; background: #0f172a; border: 1px solid #475569; color: #f8fafc; border-radius: 4px; font-family: monospace; font-size: 12px;" />
        <button id="btn-copy-id" style="padding: 8px 12px; background: #334155; color: white; border: none; border-radius: 4px; cursor: pointer;">Copy</button>
      </div>
      <p style="font-size: 12px; color: #e2e8f0; animation: pulse 2s infinite;">Waiting for peer to join...</p>
    `

    container.querySelector('#btn-copy-id')?.addEventListener('click', () => {
      const input = container.querySelector('#peer-id-input') as HTMLInputElement
      input.select()
      navigator.clipboard.writeText(input.value)
      const btn = container.querySelector('#btn-copy-id') as HTMLButtonElement
      btn.textContent = 'Copied!'
      setTimeout(() => (btn.textContent = 'Copy'), 2000)
    })

    network.onConnected = () => {
      container.remove()
      start(seed, label, network)
    }
  })

  // Join Mode
  container.querySelector('#btn-join-mode')?.addEventListener('click', () => {
    actionsEl.style.display = 'none'
    detailsEl.style.display = 'block'
    detailsEl.innerHTML = `
      <p style="font-size: 14px; color: #818cf8; margin-bottom: 8px;">Join P2P Game</p>
      <input id="join-peer-id" placeholder="Enter Host Peer ID..." style="width: 100%; box-sizing: border-box; padding: 8px; background: #0f172a; border: 1px solid #475569; color: #f8fafc; border-radius: 4px; font-family: monospace; font-size: 12px; margin-bottom: 12px;" />
      <div style="display: flex; gap: 8px;">
        <button id="btn-connect-peer" style="flex: 1; padding: 10px; background: #6366f1; color: white; border: none; border-radius: 4px; font-weight: 600; cursor: pointer;">Connect</button>
        <button id="btn-back" style="padding: 10px; background: #475569; color: white; border: none; border-radius: 4px; cursor: pointer;">Back</button>
      </div>
      <p id="join-status" style="font-size: 12px; color: #ef4444; margin-top: 8px; display: none;"></p>
    `

    container.querySelector('#btn-back')?.addEventListener('click', () => {
      detailsEl.style.display = 'none'
      actionsEl.style.display = 'flex'
    })

    container.querySelector('#btn-connect-peer')?.addEventListener('click', async () => {
      const input = container.querySelector('#join-peer-id') as HTMLInputElement
      const hostId = input.value.trim()
      if (!hostId) return

      const statusEl = container.querySelector('#join-status') as HTMLElement
      statusEl.style.color = '#38bdf8'
      statusEl.style.display = 'block'
      statusEl.textContent = 'Connecting to host...'

      try {
        const network = new NetworkManager()
        const initData = await network.initJoin(hostId)
        container.remove()
        start(initData.seed, initData.seedLabel, network)
      } catch (err) {
        statusEl.style.color = '#ef4444'
        statusEl.textContent = 'Failed to connect. Verify Peer ID.'
      }
    })
  })
}

function start(seed: number, seedLabel: string, network: NetworkManager): void {
  const engine = createEngineContext(Game.instance())

  const battlefield = new Battlefield(seed, engine)
  const squads = new Squads(battlefield.grid, battlefield.spawns, engine)

  const rig = new OrbitRig(engine.camera, engine.canvas, {
    bounds: battlefield.grid.halfExtent,
  })

  const portraits = new OffscreenPortraits(engine)
  const tracers = new Tracers(engine)
  const turnManager = new TurnManager(squads, rig)

  // Declare controller before hud so hud handler can reference it
  let controller!: InteractionController

  const hud = new Hud((intent) => {
    controller.handleIntent(intent)
  })

  controller = new InteractionController(
    battlefield,
    squads,
    turnManager,
    rig,
    hud,
    portraits,
    seedLabel,
    tracers,
    engine,
    network,
  )

  network.onMessage = (msg) => {
    controller.handleRemoteNetworkMessage(msg)
  }

  network.onDisconnected = (reason) => {
    const ui = Game.instance().uiRoot
    if (document.getElementById('disconnection-overlay')) return

    const overlay = document.createElement('div')
    overlay.id = 'disconnection-overlay'
    overlay.style.cssText = `
      position: absolute;
      inset: 0;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      background: rgba(10, 14, 20, 0.92);
      backdrop-filter: blur(8px);
      z-index: 10000;
      font-family: inherit;
      color: #e2e8f0;
    `

    overlay.innerHTML = `
      <div style="background: #1e293b; padding: 32px 40px; border-radius: 12px; border: 1px solid #ef4444; box-shadow: 0 20px 25px -5px rgba(0,0,0,0.5); width: 380px; text-align: center;">
        <h2 style="margin: 0 0 8px 0; font-size: 24px; color: #ef4444;">Connection Interrupted</h2>
        <p style="margin: 0 0 24px 0; font-size: 14px; color: #94a3b8;">${reason || 'The opponent has left the match or connection was lost.'}</p>
        <button id="btn-return-menu" style="padding: 12px 24px; background: #ef4444; color: white; border: none; border-radius: 6px; font-weight: 600; cursor: pointer;">Return to Main Menu</button>
      </div>
    `

    ui.appendChild(overlay)

    overlay.querySelector('#btn-return-menu')?.addEventListener('click', () => {
      overlay.remove()
      controller.dispose()
      hud.dispose()
      network.dispose()
      showMenu()
    })
  }
  const myFaction = network.mode !== 'local' ? network.myFaction : Faction.Blue
  const commander = squads.byFaction[myFaction][0]
  if (commander) {
    rig.snapTo(commander.position)
    if (turnManager.activeFaction === myFaction) {
      turnManager.selectSoldier(commander)
    }
  } else {
    rig.snapTo(new Vector3(0, 0, 0))
  }

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
      network,
    },
  })

  console.info(`[tictac] tactical combat ready — mode: ${network.mode}, seed ${seedLabel}`)
}
