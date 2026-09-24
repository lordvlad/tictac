import Game from '@mavonengine/core/Game'
import type { Asset } from '@mavonengine/core/Types/Asset'
import { Vector3 } from 'three'
import { OrbitRig } from './camera/OrbitRig'
import { createEngineContext } from './engine'
import { Faction, SIM } from './config'
import { matchDice, resolveSeed } from './core/rng'
import { type CharacterSheet, rollSquadSheets } from './core/Characters'
import { generateMap } from './core/MapGenerator'
import { Battlefield } from './game/Battlefield'
import { InteractionController } from './game/InteractionController'
import { Squads } from './game/Squads'
import { TurnManager } from './game/TurnManager'
import { Hud } from './hud/Hud'
import { OffscreenPortraits } from './render/Portraits'
import { Tracers } from './render/Tracers'
import { LoadoutScreen } from './hud/LoadoutScreen'
import { FullscreenPrompt } from './hud/FullscreenPrompt'
import { FpsCounter } from './hud/FpsCounter'
import type { SquadLoadout } from './game/Loadout'
import './game.css'
import { NetworkManager } from './game/NetworkManager'
import { World } from './ecs/World'
import { createGlobalRules } from './ecs/globals'
import { TurnSystem } from './ecs/systems'
import { Playback } from './game/Playback'
import { PlaybackControls } from './hud/PlaybackControls'
import {
  type CombatRecording,
  parseRecording,
  RECORDING_VERSION,
  type RecordingHeader,
} from './game/Recording'

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
  // Both outlive every screen: the prompt hides itself in fullscreen and comes
  // back on exit, and the counter measures frames wherever the game is drawing.
  new FullscreenPrompt()
  new FpsCounter()
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
  container.addEventListener('pointerdown', (e) => e.stopPropagation())
  container.addEventListener('mousedown', (e) => e.stopPropagation())
  container.addEventListener('click', (e) => e.stopPropagation())
  container.innerHTML = `
    <div style="background: #1e293b; padding: 32px 40px; border-radius: 12px; border: 1px solid #334155; box-shadow: 0 20px 25px -5px rgba(0,0,0,0.5); width: 380px; text-align: center;">
      <h1 style="margin: 0 0 8px 0; font-size: 28px; letter-spacing: 2px; color: #38bdf8;">TICTAC P2P</h1>
      <p style="margin: 0 0 24px 0; font-size: 14px; color: #94a3b8;">Tactical Combat Engine</p>
      
      <div id="menu-actions" style="display: flex; flex-direction: column; gap: 12px;">
        <button id="btn-local" style="padding: 12px; background: #3b82f6; color: white; border: none; border-radius: 6px; font-weight: 600; cursor: pointer;">Local Versus (Same Screen)</button>
        <button id="btn-host-mode" style="padding: 12px; background: #0ea5e9; color: white; border: none; border-radius: 6px; font-weight: 600; cursor: pointer;">Host P2P Match</button>
        <button id="btn-join-mode" style="padding: 12px; background: #6366f1; color: white; border: none; border-radius: 6px; font-weight: 600; cursor: pointer;">Join P2P Match</button>
        <button id="btn-server-mode" style="padding: 12px; background: #14b8a6; color: white; border: none; border-radius: 6px; font-weight: 600; cursor: pointer;">Play on a Match Server</button>
        <button id="btn-load-recording" style="padding: 12px; background: #475569; color: white; border: none; border-radius: 6px; font-weight: 600; cursor: pointer;">Load Recording (Spectate)</button>
        <input id="recording-file" type="file" accept="application/json,.json" style="display: none;" />
      </div>

      <div id="menu-details" style="margin-top: 20px; display: none;"></div>
    </div>
  `

  ui.appendChild(container)

  const actionsEl = container.querySelector('#menu-actions') as HTMLElement
  const detailsEl = container.querySelector('#menu-details') as HTMLElement

  // Both peers equip before the match: every attack travels with the numbers
  // the acting peer resolved, so the two squads may be kitted out differently.
  container.querySelector('#btn-local')?.addEventListener('click', () => {
    container.remove()
    const { seed, label } = resolveSeed()
    equipThenStart(seed, label, new NetworkManager())
  })

  // Spectating a file, not playing a match: no loadout screen, no peer, no
  // handshake. Everything the replay needs is in the recording.
  const fileEl = container.querySelector('#recording-file') as HTMLInputElement
  container.querySelector('#btn-load-recording')?.addEventListener('click', () => fileEl.click())
  fileEl.addEventListener('change', async () => {
    const file = fileEl.files?.[0]
    if (!file) return
    try {
      // `File.text()`, never `FileReader`: this codebase reads files
      // asynchronously and nothing here needs a progress event.
      const recording = parseRecording(JSON.parse(await file.text()))
      container.remove()
      startPlayback(recording)
    } catch (err) {
      fileEl.value = ''
      detailsEl.style.display = 'block'
      detailsEl.innerHTML = `<p style="font-size: 12px; color: #ef4444; margin: 0;">${
        err instanceof Error ? err.message : 'could not read that file'
      }</p>`
    }
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
      // Only once a peer is attached, which is what makes `ready` deliverable.
      equipThenStart(seed, label, network)
    }
  })

  // Refereed play. Both sides connect to the same referee, which relays between
  // them as well as recomputing the match: one of them opens it, the other
  // joins. What the referee adds is a third opinion when the two disagree, a
  // log that outlives the tab, and a way back in after losing one.
  container.querySelector('#btn-server-mode')?.addEventListener('click', () => {
    actionsEl.style.display = 'none'
    detailsEl.style.display = 'block'
    detailsEl.innerHTML = `
      <p style="font-size: 14px; color: #2dd4bf; margin-bottom: 8px;">Play on a Match Server</p>
      <input id="server-url" value="ws://localhost:5174/" style="width: 100%; box-sizing: border-box; padding: 8px; background: #0f172a; border: 1px solid #475569; color: #f8fafc; border-radius: 4px; font-family: monospace; font-size: 12px; margin-bottom: 12px;" />
      <div style="display: flex; gap: 8px;">
        <button id="btn-server-host" style="flex: 1; padding: 10px; background: #0d9488; color: white; border: none; border-radius: 4px; font-weight: 600; cursor: pointer;">Open a Match</button>
        <button id="btn-server-join" style="flex: 1; padding: 10px; background: #14b8a6; color: white; border: none; border-radius: 4px; font-weight: 600; cursor: pointer;">Join the Match</button>
        <button id="btn-server-back" style="padding: 10px; background: #475569; color: white; border: none; border-radius: 4px; cursor: pointer;">Back</button>
      </div>
      <p id="server-status" style="font-size: 12px; color: #94a3b8; margin-top: 8px;">Run one with <code>bun run serve:match</code>.</p>
    `

    const urlOf = () => (container.querySelector('#server-url') as HTMLInputElement).value.trim()
    const statusEl = () => container.querySelector('#server-status') as HTMLElement

    container.querySelector('#btn-server-back')?.addEventListener('click', () => {
      detailsEl.style.display = 'none'
      actionsEl.style.display = 'flex'
    })

    container.querySelector('#btn-server-host')?.addEventListener('click', () => {
      const url = urlOf()
      if (!url) return
      const { seed, label } = resolveSeed()
      const network = new NetworkManager()
      statusEl().style.color = '#38bdf8'
      statusEl().textContent = 'Waiting for an opponent to join…'
      // No `onConnected` here: a socket opens as soon as the referee answers,
      // long before anybody is on the other side of it. The barrier that
      // matters is `ready`, which `equipThenStart` already waits on.
      network.onDisconnected = (reason) => {
        statusEl().style.color = '#ef4444'
        statusEl().textContent = reason ?? 'The match server closed the connection.'
      }
      network.hostOnServer(url, seed, label)
      container.remove()
      equipThenStart(seed, label, network)
    })

    container.querySelector('#btn-server-join')?.addEventListener('click', async () => {
      const url = urlOf()
      if (!url) return
      statusEl().style.color = '#38bdf8'
      statusEl().textContent = 'Connecting…'
      const network = new NetworkManager()
      try {
        const opening = await network.joinOnServer(url)
        container.remove()
        equipThenStart(opening.seed, opening.seedLabel, network)
      } catch (err) {
        statusEl().style.color = '#ef4444'
        statusEl().textContent =
          err instanceof Error && err.message.length > 0
            ? err.message
            : 'Could not join a match there.'
      }
    })
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
      setTimeout(() => (container.querySelector('#join-peer-id') as HTMLInputElement)?.focus(), 50)

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
        equipThenStart(initData.seed, initData.seedLabel, network)
      } catch (err) {
        statusEl.style.color = '#ef4444'
        // The reason, when there is one: a refused build states why it was
        // refused, and "verify Peer ID" would send the player to check the one
        // thing that was not wrong.
        statusEl.textContent =
          err instanceof Error && err.message.length > 0
            ? err.message
            : 'Failed to connect. Verify Peer ID.'
      }
    })
  })
}

/**
 * Equip the squad this player commands, then start the match once the peer has
 * equipped too.
 *
 * The barrier matters because Blue moves first and the host is Blue: without it
 * the host could fire while the joiner is still choosing kit, and with no
 * `onMessage` attached yet those commands would be dropped outright.
 */
function equipThenStart(seed: number, label: string, network: NetworkManager): void {
  const engine = createEngineContext(Game.instance())
  const faction = network.mode === 'local' ? Faction.Blue : network.myFaction
  const screen = new LoadoutScreen(engine, new OffscreenPortraits(engine), seed, faction)

  // The squad the player was shown while equipping is the squad that deploys:
  // the screen rolled it, so read it back rather than rolling a second one
  // here. Rolled per peer, never from the match seed — that seed is the host's
  // map. Local play needs an opposing squad too, and there is no peer to bring
  // one.
  const mySheets = screen.sheets
  const localEnemySheets = rollSquadSheets()

  // A peer that drops while the player is still equipping would otherwise hang
  // the screen: there is no controller yet to show the usual overlay. `start`
  // reassigns this to the in-match overlay rather than adding a second handler.
  network.onDisconnected = () => {
    screen.dispose()
    network.dispose()
    showMenu()
  }

  void screen.show().then(async (loadout) => {
    network.send({ type: 'ready', sheets: mySheets, loadout })
    if (network.mode !== 'local') screen.markWaiting('Waiting for opponent to deploy…')
    const peer = await network.waitForPeerReady()
    screen.dispose()
    const other = faction === Faction.Blue ? Faction.Red : Faction.Blue
    start(
      seed,
      label,
      network,
      loadout,
      {
        [faction]: mySheets,
        [other]: peer?.sheets ?? localEnemySheets,
      } as Record<Faction, CharacterSheet[]>,
      // The peer's kit, when it sent kit this build could read. Without it the
      // other squad deploys on the stock spread — which is what every match
      // did before a referee needed to know what both sides were carrying.
      peer?.loadout ?? undefined,
    )
  })
}

function start(
  seed: number,
  seedLabel: string,
  network: NetworkManager,
  loadout?: SquadLoadout,
  sheets?: Record<Faction, CharacterSheet[]>,
  peerLoadout?: SquadLoadout,
): void {
  const engine = createEngineContext(Game.instance())

  // The match's dice, from the match's seed — so both peers, a replay and a
  // sweep draw the same numbers in the same order.
  const dice = matchDice(seed)

  const world = new World()
  createGlobalRules(world)

  // Terrain first, as data; the battlefield is the view of it.
  const battlefield = new Battlefield(generateMap(seed), engine)
  const myFaction = network.mode !== 'local' ? network.myFaction : Faction.Blue
  const squads = new Squads(world, battlefield.grid, battlefield.spawns, loadout, myFaction, sheets)
  // The other squad's kit, when the peer sent some. It arrives in `ready`
  // rather than only as replicated component state so that a referee — which
  // holds no components until the intents start — can refight the match.
  if (peerLoadout) {
    squads.equipFaction(myFaction === Faction.Blue ? Faction.Red : Faction.Blue, peerLoadout)
  }

  // The opening position, captured before anything can move it. A recording
  // armed later still replays from here, which is the only point a stream can
  // start from and be replayable at all.
  const recordingHeader: RecordingHeader = {
    version: RECORDING_VERSION,
    seed,
    seedLabel,
    source: 'live',
    createdAt: new Date().toISOString(),
    turnCap: null,
    sheets: sheets ?? { [Faction.Blue]: [], [Faction.Red]: [] },
    loadouts: {
      [Faction.Blue]: squads.loadoutOf(Faction.Blue),
      [Faction.Red]: squads.loadoutOf(Faction.Red),
    },
  }

  // A referee is told the opening position once, by the side hosting the
  // match: it needs the seed, both squads' people and both squads' kit, none of
  // which is derivable from the stream of intents that follows.
  if (network.mode === 'host') network.send({ type: 'matchHeader', header: recordingHeader })

  const rig = new OrbitRig(engine.camera, engine.canvas, {
    bounds: battlefield.grid.halfExtent,
  })

  const portraits = new OffscreenPortraits(engine)
  const tracers = new Tracers(engine)
  const turnSystem = new TurnSystem()
  const turnManager = new TurnManager(world, turnSystem, squads, rig)

  // Declare controller before hud so hud handler can reference it
  let controller!: InteractionController
  const hud = new Hud((intent) => {
    controller.handleIntent(intent)
  })

  controller = new InteractionController(
    world,
    battlefield,
    squads,
    turnManager,
    rig,
    hud,
    portraits,
    seedLabel,
    dice,
    tracers,
    engine,
    network,
    recordingHeader,
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
    overlay.addEventListener('pointerdown', (e) => e.stopPropagation())
    overlay.addEventListener('mousedown', (e) => e.stopPropagation())
    overlay.addEventListener('click', (e) => e.stopPropagation())

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

/**
 * Watch a recording instead of playing a match.
 *
 * The same construction order a match uses, with three differences: both
 * squads are equipped from the file rather than one from a loadout screen,
 * there is no network (nothing to transmit, nothing to record), and the
 * controller is told it is spectating — which reveals the whole field and takes
 * the player's hands off the units.
 *
 * The terrain is not in the file. It is regenerated from the seed, which is the
 * only reason a recording of a forty-turn fight is fifteen kilobytes.
 */
function startPlayback(recording: CombatRecording): void {
  const { header } = recording
  const engine = createEngineContext(Game.instance())

  const world = new World()
  createGlobalRules(world)

  const battlefield = new Battlefield(generateMap(header.seed, header.map), engine)
  const squads = new Squads(
    world,
    battlefield.grid,
    battlefield.spawns,
    undefined,
    Faction.Blue,
    header.sheets,
  )
  // Both sides, from the file: a replay resolves nothing itself, but every
  // panel reads the kit, and half a squad on the stock spread would be a
  // different fight on screen than the one that was recorded.
  squads.equipFaction(Faction.Blue, header.loadouts[Faction.Blue])
  squads.equipFaction(Faction.Red, header.loadouts[Faction.Red])

  const rig = new OrbitRig(engine.camera, engine.canvas, {
    bounds: battlefield.grid.halfExtent,
  })

  const portraits = new OffscreenPortraits(engine)
  const tracers = new Tracers(engine)
  const turnSystem = new TurnSystem()
  const turnManager = new TurnManager(world, turnSystem, squads, rig)

  let controller!: InteractionController
  const hud = new Hud((intent) => {
    controller.handleIntent(intent)
  })

  controller = new InteractionController(
    world,
    battlefield,
    squads,
    turnManager,
    rig,
    hud,
    portraits,
    header.seedLabel,
    // A playback resolves nothing itself — every outcome comes off the file —
    // but the resolvers still need a stream, and the recording's own seed is
    // the one the match was fought with.
    matchDice(header.seed),
    tracers,
    engine,
    null,
  )
  controller.spectating = true
  hud.setHidden(true)
  turnManager.autoSelectFirst()
  controller.recomputeVisibility()

  // Only the soldiers: no recorded command can change a wall, and snapshotting
  // a map's worth of wall entities at every event would cost a great deal to
  // restore terrain that never moved.
  const soldierIds = squads.soldiers.map((soldier) => soldier.entityId)

  const playback = new Playback({
    recording,
    apply: (command) => controller.applyRecordedCommand(command),
    busy: () => controller.busy,
    capture: () => ({
      entities: world.snapshot(soldierIds),
      activeFaction: turnSystem.activeFaction,
      turnNumber: turnSystem.turnNumber,
    }),
    restore: (frame) => {
      // Routes first: `pathIndices` is the one piece of movement state that is
      // not a component, so a restored unit would otherwise resume walking a
      // path it is no longer on. The same for whatever the rules still meant a
      // broken unit to do: that was decided about the moment being left.
      controller.movementSystem.clearRoutes(world, soldierIds)
      controller.commands.clear()
      world.restore(frame.entities)
      turnSystem.activeFaction = frame.activeFaction
      turnSystem.turnNumber = frame.turnNumber
      turnManager.autoSelectFirst()
      controller.recomputeVisibility()
      battlefield.flush()
    },
  })

  const controls = new PlaybackControls((command) => {
    switch (command.type) {
      case 'play':
        playback.play(command.speed)
        break
      case 'pause':
        playback.pause()
        break
      case 'stepForward':
        playback.stepForward()
        break
      case 'stepBackward':
        playback.stepBackward()
        break
    }
  })

  const renderControls = (): void => {
    controls.render({
      playing: playback.playing,
      speed: playback.speed,
      index: playback.index,
      total: playback.total,
      turn: playback.turn,
      turns: playback.turns,
      seedLabel: header.seedLabel,
    })
  }
  playback.onChanged = renderControls
  renderControls()

  const commander = squads.byFaction[Faction.Blue][0]
  rig.snapTo(commander ? commander.position : new Vector3(0, 0, 0))

  let accumulator = 0
  Game.instance().onUpdate((delta) => {
    // The speed multiplier goes into the accumulator rather than into the event
    // pacing alone, so animations and dispatch run fast together: a 2x replay
    // that only dispatched faster would show the same walk at the same pace
    // with less room to breathe between moves.
    const scale = playback.playing ? playback.speed : 1
    accumulator = Math.min(accumulator + delta * scale, SIM.maxCatchUp)
    while (accumulator >= SIM.step) {
      accumulator -= SIM.step
      tracers.update(SIM.step)
      controller.update(SIM.step)
      playback.update(SIM.step)
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
      playback,
      seed: header.seed,
      seedLabel: header.seedLabel,
    },
  })

  console.info(
    `[tictac] replay ready — ${recording.events.length} events, ${header.source} seed ${header.seedLabel}`,
  )
}
