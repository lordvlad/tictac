import Game from '@mavonengine/core/Game'
import type { Asset } from '@mavonengine/core/Types/Asset'
import { createRoot } from 'react-dom/client'
import { Vector3 } from 'three'
import { OrbitRig } from './camera/OrbitRig'
import { Faction, SIM } from './config'
import { type CharacterSheet, rollSquadSheets } from './core/Characters'
import { generateMap } from './core/MapGenerator'
import { hashSeed, matchDice, Rng } from './core/rng'
import { WeaponId } from './core/Arsenal'
import { createGlobalRules } from './ecs/globals'
import { TurnSystem } from './ecs/systems'
import { World } from './ecs/World'
import { createEngineContext } from './engine'
import './game.css'
import { Account, type Player, type RosterEntry } from './game/Account'
import { AiOpponent } from './game/AiOpponent'
import { Battlefield } from './game/Battlefield'
import { InteractionController } from './game/InteractionController'
import { NetworkManager } from './game/NetworkManager'
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
   * What a signed-in player deploys, and where they connect.
   *
   * Signed in: the whole roster this server keeps. Anonymous: neither —
   * the plain url and a fresh squad, exactly as before.
   */
  const joining = async (
    url: string,
  ): Promise<{ account: Account | null; roster: RosterEntry[] | null }> => {
    const it = new Account(url)
    if (!it.token) return { account: null, roster: null }
    const roster = await it.roster()
    // An empty roster has nobody to send, and the referee would refuse it
    // anyway; recruit first.
    if (roster.length === 0) {
      throw new Error('Nobody is left on your roster. Recruit before deploying.')
    }
    return { account: it, roster }
  }

  /**
   * Let a signed-in player choose who deploys (`[ITEM-042]`), then mint the
   * ticketed url only once they have — a ticket is worth one connection and
   * expires in a minute, so it must not be spent sitting on a screen the
   * player might linger on. Anonymous: the plain url and nothing chosen.
   */
  const equip = async (
    url: string,
    account: Account | null,
    roster: RosterEntry[] | null,
  ): Promise<{
    url: string
    sheets?: CharacterSheet[]
    hp?: number[]
    fatigue?: number[]
    characterIds?: string[]
  }> => {
    if (!account || !roster) return { url }
    const screen = new RosterScreen(roster, () => account.recruit())
    const picked = await screen.pick()
    return {
      url: await account.socketUrl(url),
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
      onServerHost={async (typed) => {
        const { seed, label } = resolveSeed()
        const { account, roster } = await joining(typed)
        const { url, sheets, hp, fatigue, characterIds } = await equip(typed, account, roster)
        const network = new NetworkManager()
        network.hostOnServer(url, seed, label)
        closeMenu()
        equipThenStart(seed, label, network, sheets, hp, characterIds, fatigue)
      }}
      onServerJoin={async (typed) => {
        const network = new NetworkManager()
        const { account, roster } = await joining(typed)
        const { url, sheets, hp, fatigue, characterIds } = await equip(typed, account, roster)
        const opening = await network.joinOnServer(url)
        closeMenu()
        equipThenStart(opening.seed, opening.seedLabel, network, sheets, hp, characterIds, fatigue)
      }}
      probeOwnOriginServer={probeOwnOriginServer}
    />,
  )
}

/**
 * Equip the squad this player commands, then start the match once the peer has
 * equipped too.
 *
 * The barrier matters because Blue moves first and the host is Blue: without it
 * the host could fire while the joiner is still choosing kit, and with no
 * `onMessage` attached yet those commands would be dropped outright.
 *
 * `sheets` is the squad that deploys. A local or peer-to-peer match rolls a
 * fresh one; a match on a server the player is signed in to brings the roster
 * that server keeps, which is the squad its referee will check and settle.
 */
function equipThenStart(
  seed: number,
  label: string,
  network: NetworkManager,
  sheets: CharacterSheet[] = rollSquadSheets(),
  /** This side's roster HP, present only when signed in to a match server. */
  hp?: number[],
  /** This side's roster character ids, present only when signed in (`[ITEM-042]`). */
  characterIds?: string[],
  /** This side's roster fatigue, present only when signed in (`[ITEM-039]`). */
  fatigue?: number[],
): void {
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

function start(
  seed: number,
  seedLabel: string,
  network: NetworkManager,
  deployed: Record<Faction, Deployment[]>,
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
  const squads = new Squads(world, battlefield.grid, battlefield.spawns, deployed)

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
      [Faction.Blue]: squads.deploymentsOf(Faction.Blue),
      [Faction.Red]: squads.deploymentsOf(Faction.Red),
    },
  }

  // A referee is told the opening position once, by the side hosting the
  // match: it needs the seed, both squads' people and both squads' kit, none of
  // which is derivable from the stream of intents that follows.
  if (network.mode === 'host') network.send({ type: 'matchHeader', header: recordingHeader })

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

    ui.appendChild(overlay)

    const root = createRoot(overlay)
    root.render(
      <InterruptedOverlay
        reason={reason}
        onReturn={() => {
          root.unmount()
          overlay.remove()
          controller.dispose()
          hud.dispose()
          network.dispose()
          showMenu()
        }}
      />,
    )
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
  const squads = new Squads(world, battlefield.grid, battlefield.spawns, header.squads)

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
  const dice = new Rng(header.seed)

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
    // Every outcome is resolved here, from the dice the match was fought
    // with. Held as the generator rather than a wrapped stream, because
    // stepping back has to put the dice back as well as the world.
    () => dice.next(),
    tracers,
    engine,
    null,
  )
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
