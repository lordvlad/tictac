import Game from '@mavonengine/core/Game'
import type { Asset } from '@mavonengine/core/Types/Asset'
import { createRoot } from 'react-dom/client'
import { Vector3 } from 'three'
import { OrbitRig } from './camera/OrbitRig'
import { Faction, FACTION_INFO, SIM } from './config'
import { type CharacterSheet, rollSquadSheets } from './core/Characters'
import { generateMap } from './core/MapGenerator'
import { hashSeed, matchDice, Rng, type Roll } from './core/rng'
import { WeaponId } from './core/Arsenal'
import { createGlobalRules } from './ecs/globals'
import { TurnSystem } from './ecs/systems'
import { isCommand } from './ecs/systems/CommandSystem'
import { World } from './ecs/World'
import { createEngineContext, type EngineContext } from './engine'
import './game.css'
import { Account } from './game/Account'
import { ServerConnection } from './game/ServerConnection'
import { AiOpponent } from './game/AiOpponent'
import { Battlefield } from './game/Battlefield'
import { InteractionController } from './game/InteractionController'
import type { Seated } from './game/Lobby'
import { winnerOf } from './game/MatchEnd'
import { type MatchLog, NetworkManager, type NetworkMessage } from './game/NetworkManager'
import { Playback } from './game/Playback'
import {
  type CombatRecording,
  type Deployment,
  parseRecording,
  RECORDING_VERSION,
  type RecordingHeader,
} from './game/Recording'
import { captureMoment, restoreMoment, type Rewindable } from './game/Rewind'
import { Squads } from './game/Squads'
import { TurnManager } from './game/TurnManager'
import { FpsCounter } from './hud/FpsCounter'
import { FullscreenPrompt } from './hud/FullscreenPrompt'
import { Hud } from './hud/Hud'
import { LoadoutScreen } from './hud/LoadoutScreen'
import { InterruptedOverlay } from './hud/menu/InterruptedOverlay'
import { StartMenu } from './hud/menu/StartMenu'
import { PlaybackControls } from './hud/PlaybackControls'
import { ReconnectingBanner } from './hud/ReconnectingBanner'
import { SpectatorBar } from './hud/SpectatorBar'
import { RosterScreen } from './hud/RosterScreen'
import { OffscreenPortraits } from './render/Portraits'
import { Tracers } from './render/Tracers'

const baseUrl = new URL('./', document.baseURI).href

/**
 * Resolve the map seed: `?seed=` from the URL if present, otherwise random.
 * Numeric seeds are used directly so `?seed=1234` is readable.
 *
 * The one place in the game that draws from `Math.random` rather than the
 * match stream, because it is what *creates* a match's seed rather than
 * something the rules resolve — `tests/determinism.test.ts` checks this file
 * for exactly one such draw, the same way it once checked `core/rng.ts`.
 */
function resolveSeed(): { seed: number; label: string } {
  const param = new URLSearchParams(window.location.search).get('seed')
  if (param !== null && param.length > 0) {
    const numeric = Number(param)
    if (Number.isFinite(numeric)) {
      return { seed: numeric >>> 0, label: String(numeric >>> 0) }
    }
    return { seed: hashSeed(param), label: param }
  }
  const seed = (Math.random() * 0xffffffff) >>> 0
  return { seed, label: String(seed) }
}

/**
 * Whether a match server answers a WebSocket upgrade at this page's own
 * origin, and what url that is.
 *
 * GitHub Pages serves no backend at all, so this resolves `null` there; the
 * Cloudflare Durable Object deployment (`[ITEM-045]`) serves its referee
 * from the exact origin the page itself loaded from, so this resolves that
 * origin's own `wss://` url there. Nothing about either host is named here
 * — the same probe answers correctly wherever the client is served from,
 * including a developer's own machine if `bun run cf:dev` happens to be
 * what served this page.
 */
function probeOwnOriginServer(): Promise<string | null> {
  const guess = `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/`
  return new Promise((resolve) => {
    let settled = false
    const settle = (value: string | null): void => {
      if (settled) return
      settled = true
      resolve(value)
    }
    const probe = new WebSocket(guess)
    probe.addEventListener('open', () => {
      probe.close()
      settle(guess)
    })
    probe.addEventListener('error', () => settle(null))
    // A probe that neither opens nor errors within a couple of seconds is
    // not one worth waiting on further; the menu does not block on this.
    setTimeout(() => settle(null), 2000)
  })
}

/**
 * The window's one connection to a match server, while it is on one
 * (`ITEM-060`, `src/game/ServerConnection.ts`).
 *
 * Held here, outside every screen, because it outlives them: the server
 * panel opens it and a match plays over it, so the lobby, the sign-in and the
 * room are one socket rather than one each. Leaving the server (Back from its
 * panel) or typing another address ends it; so does the page reload that
 * takes a finished match back to the menu (`backToMenu`).
 */
let server: ServerConnection | null = null

/** The connection to `url`: this window's existing one if it is to that server and still alive. */
function connectionFor(url: string): ServerConnection {
  if (server && server.url === url && server.state.kind !== 'closed') return server
  server?.close()
  server = new ServerConnection(url)
  return server
}

function leaveServer(): void {
  server?.close()
  server = null
}

const ASSETS: Asset[] = [
  { name: 'character', type: 'gltfModel', path: `${baseUrl}character.glb` },
  ...Object.values(WeaponId).map(
    (id): Asset => ({ name: `weapon-${id}`, type: 'gltfModel', path: `${baseUrl}weapons/${id}.glb` }),
  ),
]

const game = new Game(ASSETS)
game.resources.loaders.gltfLoader.dracoLoader?.setDecoderPath(`${baseUrl}draco/`)

game.on('documentReady', () => {
  const ui = game.uiRoot
  const loadingBar = document.createElement('div')
  loadingBar.id = 'loadingBar'
  const bootLabel = document.createElement('div')
  bootLabel.id = 'bootLabel'
  bootLabel.textContent = 'Deploying...'
  ui.append(loadingBar, bootLabel)
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

/**
 * Draw the start menu, optionally stating why the player is back at it.
 *
 * `notice` is how a match that never started says so: a referee that refuses
 * a build sends `abort` before either side has a controller to show the usual
 * interrupted overlay, and without this the screen would simply reappear with
 * no explanation at all.
 */
function showMenu(notice?: string): void {
  reconnecting.hide()
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
    /* #ui is pointer-events: none and only its buttons opt back in, so without
       this a menu <input> is click-through: it never takes focus and a phone
       never raises its keyboard. */
    pointer-events: auto;
  `
  container.addEventListener('pointerdown', (e) => e.stopPropagation())
  container.addEventListener('mousedown', (e) => e.stopPropagation())
  container.addEventListener('click', (e) => e.stopPropagation())
  ui.appendChild(container)

  const root = createRoot(container)

  const closeMenu = () => {
    root.unmount()
    container.remove()
  }

  /**
   * Who a signed-in player deploys (`[ITEM-042]`): chosen from the roster
   * that server keeps. Anonymous: nobody chosen, and the squad is rolled as
   * in any other match.
   */
  const pickSquad = async (account: Account | null): Promise<Picked> => {
    if (!account) return {}
    const roster = await account.roster()
    // An empty roster has nobody to send, and the referee would refuse it
    // anyway; recruit first.
    if (roster.length === 0) {
      throw new Error('Nobody is left on your roster. Recruit before deploying.')
    }
    const picked = await new RosterScreen(roster, () => account.recruit()).pick()
    return {
      sheets: picked.map((entry) => entry.sheet),
      hp: picked.map((entry) => entry.hp),
      fatigue: picked.map((entry) => entry.fatigue),
      characterIds: picked.map((entry) => entry.characterId),
    }
  }

  root.render(
    <StartMenu
      notice={notice}
      onLocalVersus={() => {
        closeMenu()
        const { seed, label } = resolveSeed()
        equipThenStart(seed, label, new NetworkManager())
      }}
      onPlayAi={() => {
        closeMenu()
        const { seed, label } = resolveSeed()
        const network = new NetworkManager()
        AiOpponent.join(network)
        network.hostMatch(seed, label)
        equipThenStart(seed, label, network)
      }}
      onLoadRecording={async (file) => {
        // `File.text()`, never `FileReader`: this codebase reads files
        // asynchronously and nothing here needs a progress event.
        const recording = parseRecording(JSON.parse(await file.text()))
        closeMenu()
        startPlayback(recording)
      }}
      onInitHost={async () => {
        const { seed, label } = resolveSeed()
        const network = new NetworkManager()
        const hostId = await network.initHost(seed, label)
        network.onConnected = () => {
          closeMenu()
          // Only once a peer is attached, which is what makes `ready` deliverable.
          equipThenStart(seed, label, network)
        }
        return hostId
      }}
      onJoinP2p={async (hostId) => {
        const network = new NetworkManager()
        const initData = await network.initJoin(hostId)
        closeMenu()
        equipThenStart(initData.seed, initData.seedLabel, network)
      }}
      connectionFor={connectionFor}
      leaveServer={leaveServer}
      onServerConnect={async (typed, intent) => {
        const connection = connectionFor(typed)
        const account = connection.player ? new Account(connection) : null
        // Only a seat in a room still being set up deploys anybody. Watching
        // brings nobody, and a match taken back already has its squad.
        const squad = intent.kind === 'open' || intent.kind === 'join' ? await pickSquad(account) : {}
        const network = new NetworkManager()
        try {
          await takeSeat(network, await network.enterRoom(connection, intent), squad, closeMenu)
        } catch (err) {
          // Whatever seat was taken is stood up from; the connection stays,
          // and the panel shows the reason on it.
          network.dispose()
          throw err
        }
      }}
      probeOwnOriginServer={probeOwnOriginServer}
    />,
  )
}


/**
 * The squad a signed-in player brought from the roster their server keeps:
 * who, and how worn. Empty for everybody else, whose squad is rolled.
 */
interface Picked {
  sheets?: CharacterSheet[]
  /** This side's roster HP. */
  hp?: number[]
  /** This side's roster character ids (`[ITEM-042]`). */
  characterIds?: string[]
  /** This side's roster fatigue (`[ITEM-039]`). */
  fatigue?: number[]
}

/**
 * Go wherever the match server put this socket (`src/game/Lobby.ts`).
 *
 * Resolves once the menu has gone and something has taken its place — the
 * loadout screen, the match, the watcher's view — and rejects with a reason
 * the server panel shows if the seat turns out to lead nowhere: the opening
 * never came, or the log of a match to take back never did.
 *
 * Where the server put the socket is not always where it was asked to go: a
 * player who already holds a seat in a match being played is put back in it,
 * whatever they asked for, and is told so.
 */
async function takeSeat(network: NetworkManager, seat: Seated, squad: Picked, closeMenu: () => void): Promise<void> {
  followReconnects(network)
  const redirected = seat.redirected
    ? 'You already have a match on this server, so you are back in it.'
    : null

  if (seat.faction === null) {
    closeMenu()
    watchMatch(network, seat)
    return
  }

  if (seat.phase === 'playing') {
    const log = await network.waitForLog()
    closeMenu()
    resumeMatch(network, log)
    flashNotice(redirected ?? 'Your match continues here; any other window it was open in has been closed.')
    return
  }

  // A room still being set up goes on exactly as a match between two peers
  // does: Blue announces it, Red waits to hear it.
  if (seat.faction === Faction.Blue) {
    const { seed, label } = resolveSeed()
    network.hostMatch(seed, label)
    closeMenu()
    equipThenStart(seed, label, network, squad)
  } else {
    const opening = await network.joinMatch()
    closeMenu()
    equipThenStart(opening.seed, opening.seedLabel, network, squad)
  }
  if (redirected) flashNotice(redirected)
}

/**
 * Say something briefly over whatever is on screen.
 *
 * For news the player did not ask for and cannot act on — being put back in
 * a match they already had — so it goes away by itself rather than waiting
 * to be dismissed.
 */
function flashNotice(text: string): void {
  const notice = document.createElement('div')
  notice.textContent = text
  notice.style.cssText = `
    position: absolute;
    top: 16px;
    left: 50%;
    transform: translateX(-50%);
    z-index: 10001;
    padding: 8px 14px;
    border-radius: 6px;
    background: rgba(10, 14, 20, 0.92);
    border: 1px solid rgba(148, 163, 184, 0.4);
    color: #e2e8f0;
    font-size: 13px;
    pointer-events: none;
  `
  Game.instance().uiRoot.appendChild(notice)
  setTimeout(() => notice.remove(), 6000)
}

/** The one window's word that it is getting its seat back; a page plays one match at a time. */
const reconnecting = new ReconnectingBanner()

/**
 * Say so while `network` gets its seat back after a drop, whatever is on
 * screen — the loadout, the match, the watcher's view — and nothing once it
 * is back. A window that gives up is told why by whatever ends the screen
 * (`showInterrupted`, `showMenu`), which takes the banner down first.
 */
function followReconnects(network: NetworkManager): void {
  network.onReconnecting = (attempt) => reconnecting.show(attempt)
  network.onReconnected = () => reconnecting.hide()
}

/**
 * Equip the squad this player commands, then start the match once the peer has
 * equipped too.
 *
 * The barrier matters because Blue moves first and the host is Blue: without it
 * the host could fire while the joiner is still choosing kit, at a squad it has
 * not been told about.
 *
 * `squad` is who deploys. A local or peer-to-peer match rolls a fresh one; a
 * match on a server the player is signed in to brings the roster that server
 * keeps, which is the squad its referee will check and settle.
 */
function equipThenStart(seed: number, label: string, network: NetworkManager, squad: Picked = {}): void {
  const { sheets = rollSquadSheets(), hp, characterIds, fatigue } = squad
  const engine = createEngineContext(Game.instance())
  const faction = network.mode === 'local' ? Faction.Blue : network.myFaction
  const screen = new LoadoutScreen(engine, new OffscreenPortraits(engine, { [faction]: sheets }), seed, faction, sheets)

  // The squad the player was shown while equipping is the squad that deploys.
  // Rolled per peer, never from the match seed — that seed is the host's map.
  // Local play needs an opposing squad too, and there is no peer to bring one.
  const mySheets = screen.sheets
  const localEnemySheets = rollSquadSheets()

  // A peer that drops while the player is still equipping would otherwise hang
  // the screen: there is no controller yet to show the usual overlay. `start`
  // reassigns this to the in-match overlay rather than adding a second handler.
  network.onDisconnected = (reason) => {
    screen.dispose()
    network.dispose()
    showMenu(reason)
  }

  void screen.show().then(async (loadout) => {
    const mySquad: Deployment[] = mySheets.map((sheet, i) => ({
      sheet,
      loadout: loadout[i]!,
      ...(characterIds?.[i] !== undefined ? { characterId: characterIds[i]! } : {}),
      ...(hp?.[i] !== undefined
        ? { state: { hp: hp[i]!, ...(fatigue?.[i] !== undefined ? { fatigue: fatigue[i]! } : {}) } }
        : {}),
    }))
    network.send({ type: 'ready', squad: mySquad })
    if (network.mode !== 'local') screen.markWaiting('Waiting for opponent to deploy…')
    const peer = await network.waitForPeerReady()
    screen.dispose()
    const other = faction === Faction.Blue ? Faction.Red : Faction.Blue
    // The peer's squad, when it sent one this build could read. Without a
    // peer at all (local play) the enemy is a fresh roll with no kit of its
    // own — the stock spread, same as every match before a referee needed to
    // know what both sides were carrying.
    const otherSquad: Deployment[] = peer?.squad ?? localEnemySheets.map((sheet) => ({ sheet }))
    start(seed, label, network, {
      [faction]: mySquad,
      [other]: otherSquad,
    } as Record<Faction, Deployment[]>)
  })
}

/** The ground a match is fought on, and who is standing on it. */
interface Field {
  world: World
  battlefield: Battlefield
  squads: Squads
}

/**
 * Lay out the terrain and deploy both squads onto it.
 *
 * Apart from `buildMatch` because a match started here has to describe its
 * own opening position, and can only read it back off the squads once they
 * exist (see `start`); everything else is built from that description.
 */
function buildField(
  engine: EngineContext,
  seed: number,
  map: RecordingHeader['map'],
  deployed: Record<Faction, Deployment[]>,
): Field {
  const world = new World()
  createGlobalRules(world)
  // Terrain first, as data; the battlefield is the view of it. Not in any
  // header or log: regenerated from the seed, which is the only reason a
  // forty-turn fight fits in fifteen kilobytes.
  const battlefield = new Battlefield(generateMap(seed, map), engine)
  const squads = new Squads(world, battlefield.grid, battlefield.spawns, deployed)
  return { world, battlefield, squads }
}

/** A match on screen: the field, the camera, the HUD and the controller that runs it. */
interface MatchScene extends Field {
  rig: OrbitRig
  portraits: OffscreenPortraits
  tracers: Tracers
  turnSystem: TurnSystem
  turnManager: TurnManager
  hud: Hud
  controller: InteractionController
}

/**
 * Everything a match on screen is built from, in the one order it has to be
 * built in — whoever is going to drive it: a player starting a match, a
 * player taking one back, a watcher, or a recording.
 *
 * `dice` is the match's stream, from the match's seed, so both peers, a
 * replay and a sweep draw the same numbers in the same order. `network` is
 * null where nothing is transmitted; `recordingHeader` is the opening a
 * recording armed from the debug panel replays from, and what the end screens
 * draw who carried out from.
 */
function buildMatch(
  engine: EngineContext,
  field: Field,
  seedLabel: string,
  dice: Roll,
  network: NetworkManager | null,
  recordingHeader: RecordingHeader | null,
): MatchScene {
  const { world, battlefield, squads } = field
  const rig = new OrbitRig(engine.camera, engine.canvas, {
    bounds: battlefield.grid.halfExtent,
  })
  const portraits = new OffscreenPortraits(engine, {
    [Faction.Blue]: squads.byFaction[Faction.Blue].map((s) => s.sheet),
    [Faction.Red]: squads.byFaction[Faction.Red].map((s) => s.sheet),
  })
  const tracers = new Tracers(engine)
  const turnSystem = new TurnSystem()
  const turnManager = new TurnManager(world, turnSystem, squads, rig)

  // Declared before the hud so the hud's handler can reference it.
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
  return { ...field, rig, portraits, tracers, turnSystem, turnManager, hud, controller }
}

/**
 * Take a match off the screen entirely, for one built again in its place
 * (a resync that found this window out of step with the server). Whoever
 * ticks it (`Game.onUpdate`, which has no way to unregister) has to stop on
 * its own.
 */
function disposeScene(scene: MatchScene): void {
  scene.controller.dispose()
  scene.hud.dispose()
  scene.rig.dispose()
  scene.portraits.dispose()
  scene.tracers.dispose()
  scene.battlefield.dispose()
  scene.squads.dispose()
}

/** Where the camera was, to put it back after a rebuild. */
interface CameraView {
  focus: Vector3
  zoom: number
  azimuth: number
}

function restoreCamera(rig: OrbitRig, view: CameraView): void {
  rig.snapTo(view.focus)
  rig.zoom = view.zoom
  rig.azimuth = view.azimuth
}

/** The match on `window.tictac`, for the console and the browser tests. */
function expose(scene: MatchScene, more: Record<string, unknown>): void {
  const { battlefield, squads, rig, turnManager, hud, controller, tracers } = scene
  Object.assign(window as unknown as Record<string, unknown>, {
    tictac: { game: Game.instance(), battlefield, squads, rig, turnManager, hud, controller, tracers, ...more },
  })
}

/**
 * Show why a match stopped, over it, with the way back to the menu.
 *
 * `teardown` is whatever the screen behind it needs putting away first.
 */
function showInterrupted(reason: string | undefined, teardown: () => void): void {
  reconnecting.hide()
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

  ui.appendChild(overlay)

  const root = createRoot(overlay)
  root.render(
    <InterruptedOverlay
      reason={reason}
      onReturn={() => {
        root.unmount()
        overlay.remove()
        teardown()
        showMenu()
      }}
    />,
  )
}

function start(
  seed: number,
  seedLabel: string,
  network: NetworkManager,
  deployed: Record<Faction, Deployment[]>,
): void {
  const engine = createEngineContext(Game.instance())
  const field = buildField(engine, seed, undefined, deployed)

  // The opening position, captured before anything can move it. A recording
  // armed later still replays from here, which is the only point a stream can
  // start from and be replayable at all. Read back off the squads rather than
  // `deployed` itself: a soldier whose kit could not be read deployed on the
  // stock spread, and the header has to say what actually fought, not what
  // was asked for.
  const recordingHeader: RecordingHeader = {
    version: RECORDING_VERSION,
    seed,
    seedLabel,
    source: 'live',
    createdAt: new Date().toISOString(),
    turnCap: null,
    squads: {
      [Faction.Blue]: field.squads.deploymentsOf(Faction.Blue),
      [Faction.Red]: field.squads.deploymentsOf(Faction.Red),
    },
  }

  // A referee is told the opening position once, by the side hosting the
  // match: it needs the seed, both squads' people and both squads' kit, none of
  // which is derivable from the stream of intents that follows.
  if (network.mode === 'host') network.send({ type: 'matchHeader', header: recordingHeader })

  playMatch(buildMatch(engine, field, seedLabel, matchDice(seed), network, recordingHeader), network, recordingHeader)
}

/**
 * Take back a seat in a match already being played, from the server's log.
 *
 * The match is rebuilt from the opening position the log states and every
 * intent in it, applied through the same rules every other window applied
 * them with, from the same dice — so this window reaches the very world the
 * opponent and the referee hold, and the digests at the next handover say so.
 * Then it is simply the match: the same side, the same controls.
 *
 * `matchHeader` is not sent again: the referee opened this match long ago.
 * `camera` is where the window was looking, when this is a match rebuilt in
 * place after a resync rather than one arrived at from the menu.
 */
function resumeMatch(network: NetworkManager, log: MatchLog, camera?: CameraView): void {
  const { header } = log
  const engine = createEngineContext(Game.instance())
  const field = buildField(engine, header.seed, header.map, header.squads)
  const scene = buildMatch(engine, field, header.seedLabel, matchDice(header.seed), network, header)
  catchUp(scene, log)
  playMatch(scene, network, header)
  if (camera) restoreCamera(scene.rig, camera)
}

/**
 * Apply a log's intents to a freshly built match, at once (`InteractionController.catchUp`).
 *
 * Timed, because how long a window takes to arrive in a long match is
 * something a player feels and nothing else measures.
 */
function catchUp(scene: MatchScene, log: MatchLog): void {
  const started = performance.now()
  scene.controller.catchUp(
    log.events.map((event) => event.command),
    SIM.step,
    (step) => scene.tracers.update(step),
  )
  console.info(
    `[tictac] caught up with ${log.events.length} intents of ${log.matchId} in ${Math.round(performance.now() - started)} ms`,
  )
}

/** Hand a built match to the player who commands one of its sides. */
function playMatch(scene: MatchScene, network: NetworkManager, header: RecordingHeader): void {
  const { battlefield, squads, rig, tracers, turnManager, hud, controller } = scene
  const myFaction = network.mode !== 'local' ? network.myFaction : Faction.Blue
  let replaced = false

  // Assigned last thing before play, because it is what releases whatever the
  // other side sent while this one was still being built.
  network.onMessage = (msg) => {
    controller.handleRemoteNetworkMessage(msg)
  }

  network.onDisconnected = (reason) => {
    showInterrupted(reason, () => {
      controller.dispose()
      hud.dispose()
      network.dispose()
    })
  }

  // Back from a drop to find the server never got something this window
  // played: the match is the server's log, built again in place exactly as a
  // window taking it over builds it. What was relayed while it was away
  // (`caughtUp`) has already gone to `onMessage` and needs nothing here.
  network.onResync = (resync) => {
    if (resync.kind !== 'rebuild') return
    replaced = true
    const camera = { focus: rig.focusPoint.clone(), zoom: rig.zoom, azimuth: rig.azimuth }
    disposeScene(scene)
    resumeMatch(network, resync.log, camera)
    flashNotice('Your last move never reached the server, so the match has been rebuilt to where the server has it.')
  }

  const commander = squads.getLiving(myFaction)[0]
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
    if (replaced) return
    accumulator = Math.min(accumulator + delta, SIM.maxCatchUp)
    while (accumulator >= SIM.step) {
      accumulator -= SIM.step
      tracers.update(SIM.step)
      controller.update(SIM.step)
    }
    battlefield.flush()
  })

  expose(scene, { seed: header.seed, seedLabel: header.seedLabel, network })
  console.info(`[tictac] tactical combat ready — mode: ${network.mode}, seed ${header.seedLabel}`)
}

/**
 * Watch a match on a server, without a seat in it.
 *
 * A recording that is still being written: the world is built from the log
 * the way a replay is built from its file — every field revealed, the HUD
 * away, the controller told it is spectating and given no network — and the
 * intents the players send after that are applied the same way, as they
 * arrive. Nothing is ever sent back (`NetworkManager` in `spectate` mode).
 *
 * A room that has not started yet has no log to build from, so the watcher
 * waits — with the way out already on screen — until it does.
 */
function watchMatch(network: NetworkManager, seat: Seated): void {
  let scene: MatchScene | null = null
  let left = false
  const leave = (): void => {
    left = true
    bar.dispose()
    scene?.controller.dispose()
    scene?.hud.dispose()
    network.dispose()
  }
  const bar = new SpectatorBar(() => {
    leave()
    showMenu()
  })
  bar.render({ roomId: seat.roomId, progress: { kind: 'waiting' } })
  // The room aborted, or this player opened another window: said over
  // whatever is showing, as a player's interrupted match is.
  network.onDisconnected = (reason) => showInterrupted(reason, leave)

  /** The match as the log has it, then live as it is played. */
  const show = (log: MatchLog): MatchScene => {
    const { header } = log
    const engine = createEngineContext(Game.instance())
    const field = buildField(engine, header.seed, header.map, header.squads)
    const built = buildMatch(engine, field, header.seedLabel, matchDice(header.seed), null, null)
    scene = built
    const { battlefield, squads, rig, tracers, turnManager, hud, controller } = built
    controller.spectating = true
    hud.setHidden(true)
    turnManager.autoSelectFirst()
    controller.recomputeVisibility()
    catchUp(built, log)

    // Held here rather than queued in the rules: a replay applies a command
    // only once the one before it has finished walking, and so does this.
    // Assigning the handler releases whatever arrived during the catch-up.
    const live: NetworkMessage[] = []
    network.onMessage = (msg) => {
      if (isCommand(msg)) live.push(msg)
    }

    const commander = squads.getLiving(turnManager.activeFaction)[0]
    rig.snapTo(commander ? commander.position : new Vector3(0, 0, 0))

    let accumulator = 0
    Game.instance().onUpdate((delta) => {
      // Stops for good once this scene has been left or shown again.
      if (left || scene !== built) return
      accumulator = Math.min(accumulator + delta, SIM.maxCatchUp)
      while (accumulator >= SIM.step) {
        accumulator -= SIM.step
        while (live.length > 0 && !controller.busy) controller.applyRecordedCommand(live.shift()!)
        tracers.update(SIM.step)
        controller.update(SIM.step)
      }
      battlefield.flush()
      // Decided once everything sent has been played out: the last shot's
      // walk and reactions are part of how it ended.
      const winner = live.length === 0 && !controller.busy ? winnerOf(squads) : null
      bar.render({
        roomId: seat.roomId,
        progress:
          winner !== null
            ? { kind: 'decided', winner: FACTION_INFO[winner].name }
            : { kind: 'playing', turn: turnManager.turnNumber, acting: FACTION_INFO[turnManager.activeFaction].name },
      })
    })

    expose(built, { seed: header.seed, seedLabel: header.seedLabel, network })
    console.info(`[tictac] watching ${seat.roomId} — seed ${header.seedLabel}`)
    return built
  }

  // Back from a drop to a log that is not the match this window was shown:
  // shown again from the log, as it was the first time, from where the
  // watcher was looking. Relays it missed (`caughtUp`) are already queued.
  network.onResync = (resync) => {
    if (resync.kind !== 'rebuild' || !scene) return
    const { rig } = scene
    const camera = { focus: rig.focusPoint.clone(), zoom: rig.zoom, azimuth: rig.azimuth }
    disposeScene(scene)
    restoreCamera(show(resync.log).rig, camera)
  }

  void network.waitForLog().then(
    (log) => {
      if (!left) show(log)
    },
    // The connection ended before the room started; `onDisconnected` has
    // already said why.
    () => {},
  )
}

/**
 * Watch a recording instead of playing a match.
 *
 * The same construction a match uses, with three differences: both squads are
 * equipped from the file rather than one from a loadout screen, there is no
 * network (nothing to transmit, nothing to record), and the controller is told
 * it is spectating — which reveals the whole field and takes the player's
 * hands off the units.
 */
function startPlayback(recording: CombatRecording): void {
  const { header } = recording
  const engine = createEngineContext(Game.instance())
  const field = buildField(engine, header.seed, header.map, header.squads)
  // Every outcome is resolved here, from the dice the match was fought with.
  // Held as the generator rather than a wrapped stream, because stepping back
  // has to put the dice back as well as the world.
  const dice = new Rng(header.seed)
  const scene = buildMatch(engine, field, header.seedLabel, () => dice.next(), null, null)
  const { world, battlefield, squads, rig, tracers, turnSystem, turnManager, hud, controller } = scene
  controller.spectating = true
  hud.setHidden(true)
  turnManager.autoSelectFirst()
  controller.recomputeVisibility()

  const rewindable: Rewindable = {
    world,
    unitIds: squads.soldiers.map((soldier) => soldier.entityId),
    walls: controller.wallSystem,
    ground: controller.groundSystem,
    turns: turnSystem,
    dice,
    movement: controller.movementSystem,
    commands: controller.commands,
  }

  const playback = new Playback({
    recording,
    apply: (command) => controller.applyRecordedCommand(command),
    busy: () => controller.busy,
    capture: () => captureMoment(rewindable),
    restore: (moment) => {
      restoreMoment(rewindable, moment)
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

  expose(scene, { playback, seed: header.seed, seedLabel: header.seedLabel })

  console.info(
    `[tictac] replay ready — ${recording.events.length} events, ${header.source} seed ${header.seedLabel}`,
  )
}
