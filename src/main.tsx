import Game from '@mavonengine/core/Game'
import type { Asset } from '@mavonengine/core/Types/Asset'
import type { ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Vector3 } from 'three'
import { OrbitRig } from './camera/OrbitRig'
import { Faction, FACTION_INFO, matchServerFor, SIM } from './config'
import { type CharacterSheet, rollSquadSheets } from './core/Characters'
import { generateMap } from './core/MapGenerator'
import { hashSeed, Rng } from './core/rng'
import { WeaponId } from './core/Arsenal'
import { createGlobalRules } from './ecs/globals'
import { TurnSystem } from './ecs/systems'
import { isCommand } from './rules/Command'
import { World } from './ecs/World'
import { createEngineContext, type EngineContext, onEachFrame, pauseRendering } from './engine'
import './game.css'
import { Account } from './game/Account'
import { consoleHandleAllowed } from './game/DebugAccess'
import { ServerConnection } from './game/ServerConnection'
import { AiOpponent } from './game/AiOpponent'
import { MatchSession, type MatchSessionParts } from './game/MatchSession'
import { Battlefield } from './client/Battlefield'
import { Input } from './client/Input'
import { Presenter } from './client/Presenter'
import { type ServerPorts, serverPortsOver } from './client/ServerAdapters'
import type { Seated } from './wire/Lobby'
import { winnerOf } from './rules/MatchEnd'
import { NetworkManager } from './game/NetworkManager'
import { type MatchLog, type NetworkMessage } from './wire/NetworkMessage'
import { Playback } from './game/Playback'
import { type CombatRecording, parseRecording, RECORDING_VERSION, type RecordingHeader } from './wire/Recording'
import type { Deployment } from './core/Loadout'
import type { Rewindable } from './sim/Rewind'
import { Squads } from './entities/Squads'
import { TurnManager } from './sim/TurnManager'
import { type EncounterPromptHandle, mountEncounterPrompt } from './hud/EncounterPrompt'
import { FpsCounter } from './hud/FpsCounter'
import { FullscreenPrompt } from './hud/FullscreenPrompt'
import { Hud } from './hud/Hud'
import { LoadoutScreen } from './client/LoadoutScreen'
import { closeMap, openMap } from './hud/MapScreen'
import { InterruptedOverlay } from './hud/menu/InterruptedOverlay'
import { StartMenu } from './hud/menu/StartMenu'
import { PlaybackControls } from './hud/PlaybackControls'
import { ReconnectingNotice, ScreenNotice, ScreenOverlay } from './hud/ScreenChrome'
import { SpectatorBar } from './hud/SpectatorBar'
import { RosterScreen } from './hud/RosterScreen'
import { BUILD_ID } from './version'
import { OffscreenPortraits } from './render/Portraits'
import { Tracers } from './render/Tracers'
import { FixedStepLoop } from './sim/FixedStepLoop'
import { RenderSystem } from './render/RenderSystem'
import { SceneCombatFx } from './render/SceneCombatFx'
import { SquadViews } from './render/SquadViews'

const baseUrl = new URL('./', document.baseURI).href

/**
 * A fresh seed for a match this window plays on its own — local, against the
 * AI, peer to peer — when the URL names none (`resolveSeed`).
 *
 * The one place in the game that draws from `Math.random` rather than the
 * match stream, because it is what *creates* a match's seed rather than
 * something the rules resolve — `tests/determinism.test.ts` checks this file
 * for exactly one such draw. A match on a server never asks: its room issues
 * the seed, and a window that chose its own would be refused (`Room`).
 */
function entropy(): number {
  return (Math.random() * 0xffffffff) >>> 0
}

/**
 * The seed of a match this window plays offline: `?seed=` from the URL if
 * present, otherwise `entropy()`. Numeric seeds are used directly so
 * `?seed=1234` is readable. Never read for a match on a server.
 */
function resolveSeed(): ChosenSeed {
  const param = new URLSearchParams(window.location.search).get('seed')
  if (param !== null && param.length > 0) {
    const numeric = Number(param)
    if (Number.isFinite(numeric)) {
      return { seed: numeric >>> 0, label: String(numeric >>> 0) }
    }
    return { seed: hashSeed(param), label: param }
  }
  const seed = entropy()
  return { seed, label: String(seed) }
}

/** A seed this window chose, and how the match names it on screen. */
interface ChosenSeed {
  seed: number
  label: string
}

/**
 * Entropy for dealing a squad: per peer, from the platform CSPRNG.
 *
 * Two peers must not deal the same people, and the sheets travel in `ready` as
 * data, so nothing needs to reproduce them from the match seed. This is setup
 * entropy, not gameplay randomness, and deliberately not `Math.random`:
 * `entropy` is the one such draw `tests/determinism.test.ts` allows here.
 */
function setupRng(): Rng {
  const [word] = crypto.getRandomValues(new Uint32Array(1))
  return new Rng(word!)
}

/**
 * What is on this window's screen, and the one way off it.
 *
 * Created once the game has loaded and handed to every flow, so that nothing a
 * screen puts up lives in module state where only a page reload could clear it:
 *
 * - the **overlays** — the start menu, the interrupted-match notice, the
 *   flashed line, the reconnecting line — are React roots made here, once, and
 *   drawn into or emptied. There is never a second set to find by DOM id.
 * - the **current screen** (a loadout, a match, a watcher's view, a replay) is
 *   whatever was last `present`ed: its disposer, and with it the window's
 *   network for the match, are what `leaveMatch` puts away.
 * - the **connection to the match server** outlives every screen (it is the
 *   lobby and the sign-in as much as it is the match), so it is held here and
 *   is not part of a screen's teardown: leaving a match leaves the server
 *   connected, and Back from the server panel (`leaveServer`) ends it.
 */
class ScreenController {
  /** The window's connection, and the narrow views of it the screens are given. */
  private server: { connection: ServerConnection; ports: ServerPorts } | null = null
  private prompt: EncounterPromptHandle | null = null
  private screen: (() => void) | null = null
  private network: NetworkManager | null = null
  private noticeTimer: number | undefined
  private menuKey = 0
  private menuUp = false
  private map: Promise<void> | null = null
  /** The roster screen on screen, if any: dismissed if an encounter takes over. */
  roster: RosterScreen | null = null

  private readonly menuRoot: Root
  private readonly interruptedRoot: Root
  private readonly noticeRoot: Root
  private readonly reconnectingRoot: Root

  constructor(
    ui: HTMLElement,
    private readonly flows: {
      /** The start menu, as it is drawn when the player is back at it. */
      menu: (notice: string | undefined) => ReactElement
      /** Play a recording from the return feed. */
      watch: (recording: CombatRecording) => void
    },
  ) {
    const mount = (): Root => {
      const element = document.createElement('div')
      element.className = 'hud-mount'
      ui.appendChild(element)
      return createRoot(element)
    }
    this.menuRoot = mount()
    this.interruptedRoot = mount()
    this.noticeRoot = mount()
    this.reconnectingRoot = mount()
  }

  // ---------------------------------------------------------------------------
  // The match server
  // ---------------------------------------------------------------------------

  /** The window's connection to the match server: the existing one if it is still alive. */
  private openServer(): { connection: ServerConnection; ports: ServerPorts } {
    if (this.server && this.server.connection.state.kind !== 'closed') return this.server
    this.server?.connection.close()
    const connection = new ServerConnection(matchServerFor(new URL(window.location.href)))
    this.server = { connection, ports: serverPortsOver(connection) }
    this.prompt?.follow(this.server.ports.prompt)
    return this.server
  }

  connectionToServer(): ServerConnection {
    return this.openServer().connection
  }

  /** The same connection, as the screens that show it are given it (`hud/ServerPorts`). */
  serverPorts(): ServerPorts {
    return this.openServer().ports
  }

  leaveServer(): void {
    this.server?.connection.close()
    this.server = null
    this.prompt?.follow(null)
  }

  /**
   * Mount the join prompt for a fight on the road (`ITEM-048`), following
   * whichever connection the window has.
   */
  followEncounters(take: (roomId: string) => Promise<void>): void {
    this.prompt = mountEncounterPrompt({
      // A fight is taken over from the menu or the map. In a match or a replay
      // there is nothing to take it over from: the player is already somewhere
      // the prompt has no business, and the AI plays it.
      available: () => (this.menuUp || this.map !== null) && this.roster === null,
      take,
      showFeed: () => void this.showMap(),
    })
    if (this.server) this.prompt.follow(this.server.ports.prompt)
  }

  // ---------------------------------------------------------------------------
  // Overlays
  // ---------------------------------------------------------------------------

  /** Draw the start menu, replacing any that is up (and so starting it afresh). */
  showMenu(notice?: string): void {
    this.menuUp = true
    this.menuRoot.render(<ScreenOverlay key={++this.menuKey}>{this.flows.menu(notice)}</ScreenOverlay>)
  }

  closeMenu(): void {
    this.menuUp = false
    this.menuRoot.render(null)
  }

  /** Show why a match stopped, over it, with the way back to the menu. */
  showInterrupted(reason: string | undefined): void {
    this.hideReconnecting()
    this.interruptedRoot.render(
      <ScreenOverlay>
        <InterruptedOverlay reason={reason} onReturn={() => this.leaveMatch()} />
      </ScreenOverlay>,
    )
  }

  /**
   * Say something briefly over whatever is on screen.
   *
   * For news the player did not ask for and cannot act on — being put back in
   * a match they already had — so it goes away by itself rather than waiting
   * to be dismissed.
   */
  flash(text: string): void {
    window.clearTimeout(this.noticeTimer)
    this.noticeRoot.render(<ScreenNotice text={text} />)
    this.noticeTimer = window.setTimeout(() => this.noticeRoot.render(null), 6000)
  }

  /**
   * Say so while `network` gets its seat back after a drop, whatever is on
   * screen — the loadout, the match, the watcher's view — and nothing once it
   * is back. A window that gives up is told why by whatever ends the screen
   * (`showInterrupted`, `leaveMatch`), which takes the line down first.
   */
  followReconnects(network: NetworkManager): void {
    network.onReconnecting = (attempt) => this.reconnectingRoot.render(<ReconnectingNotice attempt={attempt} />)
    network.onReconnected = () => this.hideReconnecting()
  }

  private hideReconnecting(): void {
    this.reconnectingRoot.render(null)
  }

  // ---------------------------------------------------------------------------
  // The map
  // ---------------------------------------------------------------------------

  /**
   * Open the map over everything else, once: asking again while it is open
   * (the join prompt's link to the feed) is the same map.
   */
  showMap(): Promise<void> {
    this.map ??= (async () => {
      // The game's own canvas is covered by the map, which draws its own
      // frames: two render loops would share the GPU for nothing.
      const resume = pauseRendering(Game.instance())
      try {
        await openMap(this.serverPorts().map, baseUrl, this.flows.watch)
      } finally {
        resume()
        this.map = null
      }
    })()
    return this.map
  }

  /** Put the map away, resolving once it has gone: something else needs the screen. */
  async dismissMap(): Promise<void> {
    closeMap()
    await this.map
  }

  // ---------------------------------------------------------------------------
  // Screens
  // ---------------------------------------------------------------------------

  /** The window's network for the screen being shown, to close when it is left. */
  holdNetwork(network: NetworkManager): void {
    this.network = network
  }

  /** Show `screen` as the current one, putting away whatever was. */
  present(screen: () => void): void {
    this.dismiss()
    this.screen = screen
  }

  /** Put the current screen away, leaving the network (a match rebuilt in place keeps its own). */
  dismiss(): void {
    const screen = this.screen
    this.screen = null
    screen?.()
  }

  /**
   * The one way out of a match, a loadout, a watcher's view or a replay: the
   * screen, then the network, then every overlay and line that went with
   * them, then the menu — with `notice` on it, when something sent the player
   * back rather than the player choosing to go.
   */
  leaveMatch(notice?: string): void {
    this.dismiss()
    this.network?.dispose()
    this.network = null
    this.hideReconnecting()
    this.interruptedRoot.render(null)
    window.clearTimeout(this.noticeTimer)
    this.noticeRoot.render(null)
    delete (window as unknown as Record<string, unknown>).tictac
    this.showMenu(notice)
  }
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
  const screens: ScreenController = new ScreenController(game.uiRoot, {
    menu: (notice) => startMenu(screens, notice),
    watch: (recording) => void playBack(screens, recording),
  })
  screens.followEncounters((roomId) => takeEncounter(screens, roomId))
  screens.showMenu()
})

/**
 * The start menu, optionally stating why the player is back at it.
 *
 * `notice` is how a match that never started says so: a referee that refuses
 * a build sends `abort` before either side has a controller to show the usual
 * interrupted overlay, and without this the screen would simply reappear with
 * no explanation at all.
 */
function startMenu(screens: ScreenController, notice?: string): ReactElement {
  /**
   * Who a signed-in player deploys (`[ITEM-042]`): chosen from the roster
   * that server keeps. Anonymous: nobody chosen, and the squad is rolled as
   * in any other match.
   */
  const pickSquad = async (account: Account | null): Promise<Picked> => {
    if (!account) return {}
    const roster = await account.roster()
    if (roster.length === 0) {
      throw new Error('Nobody is left on your roster. Recruit before deploying.')
    }
    const screen = new RosterScreen(roster, () => account.recruit())
    screens.roster = screen
    try {
      const picked = await screen.pick()
      return {
        sheets: picked.map((entry) => entry.sheet),
        hp: picked.map((entry) => entry.hp),
        fatigue: picked.map((entry) => entry.fatigue),
        characterIds: picked.map((entry) => entry.characterId),
      }
    } finally {
      if (screens.roster === screen) screens.roster = null
    }
  }

  return (
    <StartMenu
      notice={notice}
      onLocalVersus={() => {
        screens.closeMenu()
        const chosen = resolveSeed()
        equipThenStart(screens, chosen, new NetworkManager())
      }}
      onPlayAi={() => {
        screens.closeMenu()
        const chosen = resolveSeed()
        const network = new NetworkManager()
        AiOpponent.join(network, setupRng())
        network.hostMatch(chosen.seed, chosen.label)
        equipThenStart(screens, chosen, network)
      }}
      onLoadRecording={async (file) => {
        // `File.text()`, never `FileReader`: this codebase reads files
        // asynchronously and nothing here needs a progress event.
        const recording = parseRecording(JSON.parse(await file.text()))
        screens.closeMenu()
        startPlayback(screens, recording)
      }}
      onInitHost={async () => {
        const chosen = resolveSeed()
        const network = new NetworkManager()
        const hostId = await network.initHost(chosen.seed, chosen.label)
        network.onConnected = () => {
          screens.closeMenu()
          // Only once a peer is attached, which is what makes `ready` deliverable.
          equipThenStart(screens, chosen, network)
        }
        return hostId
      }}
      onJoinP2p={async (hostId) => {
        const network = new NetworkManager()
        const initData = await network.initJoin(hostId)
        screens.closeMenu()
        equipThenStart(screens, { seed: initData.seed, label: initData.seedLabel }, network)
      }}
      openServer={() => screens.serverPorts().panel}
      leaveServer={() => screens.leaveServer()}
      onServerConnect={async (intent) => {
        const connection = screens.connectionToServer()
        const account = connection.player ? new Account(connection) : null
        // Only a seat in a room still being set up deploys anybody. Watching
        // brings nobody, and a match taken back already has its squad.
        const squad = intent.kind === 'open' || intent.kind === 'join' ? await pickSquad(account) : {}
        const network = new NetworkManager()
        try {
          await takeSeat(screens, network, await network.enterRoom(connection, intent), squad)
        } catch (err) {
          // Whatever seat was taken is stood up from; the connection stays,
          // and the panel shows the reason on it.
          network.dispose()
          throw err
        }
      }}
      onOpenMap={() => screens.showMap()}
    />
  )
}

/** Watch a fight from the return feed: the map and the menu give way to the replay, which is left like any other screen. */
async function playBack(screens: ScreenController, recording: CombatRecording): Promise<void> {
  await screens.dismissMap()
  screens.closeMenu()
  try {
    startPlayback(screens, recording)
  } catch (error) {
    console.error('[tictac] could not play the recording back', error)
    screens.flash('That fight could not be played back.')
  }
}

/**
 * Take a fight on the road over (`ITEM-048`): the seat the server held
 * for this player, resumed exactly as a window taking back its match does.
 * Works from the menu or the map, which give way to the match once the
 * room's log has arrived; rejects, with the server's own reason, if the
 * seat is no longer to be had (the AI has it).
 */
async function takeEncounter(screens: ScreenController, roomId: string): Promise<void> {
  const network = new NetworkManager()
  try {
    const seat = await network.enterRoom(screens.connectionToServer(), { kind: 'resume', roomId })
    screens.roster?.dismiss()
    await screens.dismissMap()
    await takeSeat(screens, network, seat, {})
  } catch (err) {
    network.dispose()
    throw err
  }
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
 * Go wherever the match server put this socket (`src/wire/Lobby.ts`).
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
async function takeSeat(screens: ScreenController, network: NetworkManager, seat: Seated, squad: Picked): Promise<void> {
  screens.followReconnects(network)
  const redirected = seat.redirected
    ? 'You already have a match on this server, so you are back in it.'
    : null

  if (seat.faction === null) {
    screens.closeMenu()
    watchMatch(screens, network, seat)
    return
  }

  if (seat.phase === 'playing') {
    const log = await network.waitForLog()
    screens.closeMenu()
    resumeMatch(screens, network, log)
    screens.flash(redirected ?? 'Your match continues here; any other window it was open in has been closed.')
    return
  }

  // A room still being set up goes on as a match between two peers does, with
  // one difference: the seed is the server's. Blue equips while it waits for
  // an opponent and Red, who is seated only once there is one, hears it at
  // once; neither states one, and the match starts from whatever the room has
  // issued by then (`equipThenStart`).
  if (seat.faction === Faction.Red) await network.joinMatch()
  screens.closeMenu()
  equipThenStart(screens, null, network, squad)
  if (redirected) screens.flash(redirected)
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
function equipThenStart(screens: ScreenController, chosen: ChosenSeed | null, network: NetworkManager, squad: Picked = {}): void {
  const { sheets = rollSquadSheets(setupRng()), hp, characterIds, fatigue } = squad
  const engine = createEngineContext(Game.instance())
  const faction = network.mode === 'local' ? Faction.Blue : network.myFaction
  // The loadout screen's backdrop only: a server's seed may not exist yet
  // while Blue waits for an opponent, and nothing about the match depends on it.
  const backdrop = chosen?.seed ?? entropy()
  const screen = new LoadoutScreen(engine, new OffscreenPortraits(engine, { [faction]: sheets }), backdrop, faction, sheets)

  // The squad the player was shown while equipping is the squad that deploys.
  // Rolled per peer, never from the match seed — that seed is the host's map.
  // Local play needs an opposing squad too, and there is no peer to bring one.
  const mySheets = screen.sheets
  const localEnemySheets = rollSquadSheets(setupRng())

  // A peer that drops while the player is still equipping would otherwise hang
  // the screen: there is no controller yet to show the usual overlay. `start`
  // reassigns this to the in-match overlay rather than adding a second handler.
  network.onDisconnected = (reason) => screens.leaveMatch(reason)
  screens.holdNetwork(network)
  screens.present(() => screen.dispose())

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
    screens.dismiss()
    const other = faction === Faction.Blue ? Faction.Red : Faction.Blue
    // The peer's squad, when it sent one this build could read. Without a
    // peer at all (local play) the enemy is a fresh roll with no kit of its
    // own — the stock spread, same as every match before a referee needed to
    // know what both sides were carrying.
    const otherSquad: Deployment[] = peer?.squad ?? localEnemySheets.map((sheet) => ({ sheet }))
    // A server's room has issued the seed by now: the opponent had to be
    // seated before it could have deployed. Read at this moment so that a
    // seed issued again after a server restart is the one used.
    let opening = chosen
    if (!opening) {
      const issued = await network.awaitOpening()
      opening = { seed: issued.seed, label: issued.seedLabel }
    }
    start(screens, opening.seed, opening.label, network, {
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

/** A match on screen: the field, the camera, the HUD, and the session, presenter and input that run it. */
interface MatchScene extends Field {
  rig: OrbitRig
  portraits: OffscreenPortraits
  tracers: Tracers
  turnSystem: TurnSystem
  turnManager: TurnManager
  hud: Hud
  session: MatchSession
  presenter: Presenter
  input: Input
}

/**
 * Everything a match on screen is built from, in the one order it has to be
 * built in — whoever is going to drive it: a player starting a match, a
 * player taking one back, a watcher, or a recording.
 *
 * `dice` is the match's stream, from the match's seed, so both peers, a
 * replay and a sweep draw the same numbers in the same order. How the window
 * holds the match is `held`: a player has a `network` (null where nothing is
 * transmitted) and a `recordingHeader`, the opening a recording armed from the
 * debug panel replays from and what the end screens draw who carried out from;
 * a watcher has no network and says what it watches (`watching`).
 */
function buildMatch(
  screens: ScreenController,
  engine: EngineContext,
  field: Field,
  seedLabel: string,
  dice: Rng,
  held: Pick<MatchSessionParts, 'network' | 'recordingHeader' | 'watching'>,
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

  // Bodies before the systems that announce to them: the session's combat
  // system draws through these.
  const renderSystem = new RenderSystem()
  const views = new SquadViews(engine, world, squads, renderSystem)

  // Declared before the hud so the hud's handler can reference it.
  let session!: MatchSession
  const hud = new Hud((intent) => {
    session.handleIntent(intent)
  })
  session = new MatchSession({
    world,
    grid: battlefield.grid,
    squads,
    turnManager,
    dice,
    fx: new SceneCombatFx(tracers, views),
    onLeave: () => screens.leaveMatch(),
    ...held,
  })
  const presenter = new Presenter({ session, battlefield, views, renderSystem, rig, hud, portraits, seedLabel, engine })
  const input = new Input(engine, rig, session, presenter)
  return { ...field, rig, portraits, tracers, turnSystem, turnManager, hud, session, presenter, input }
}

/**
 * Take a match off the screen entirely, for one built again in its place
 * (a resync that found this window out of step with the server). Whoever
 * ticks it (`onEachFrame`) has to take its own frames down as well.
 */
function disposeScene(scene: MatchScene): void {
  scene.input.dispose()
  scene.presenter.dispose()
  scene.session.dispose()
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

/**
 * The match on `window.tictac`, for the console and the browser tests — in a
 * development server's bundle only: the handle is the live rules objects, and a
 * shipped build must not give the console a way past the command door.
 */
function expose(scene: MatchScene, more: Record<string, unknown>): void {
  if (!consoleHandleAllowed(BUILD_ID)) return
  const { battlefield, squads, rig, turnManager, hud, session, presenter, tracers } = scene
  Object.assign(window as unknown as Record<string, unknown>, {
    tictac: { game: Game.instance(), battlefield, squads, rig, turnManager, hud, session, presenter, tracers, ...more },
  })
}

function start(
  screens: ScreenController,
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

  playMatch(
    screens,
    buildMatch(screens, engine, field, seedLabel, new Rng(seed), { network, recordingHeader }),
    network,
    recordingHeader,
  )
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
function resumeMatch(screens: ScreenController, network: NetworkManager, log: MatchLog, camera?: CameraView): void {
  const { header } = log
  const engine = createEngineContext(Game.instance())
  const field = buildField(engine, header.seed, header.map, header.squads)
  const scene = buildMatch(screens, engine, field, header.seedLabel, new Rng(header.seed), { network, recordingHeader: header })
  catchUp(scene, log)
  playMatch(screens, scene, network, header)
  if (camera) restoreCamera(scene.rig, camera)
}

/**
 * Apply a log's intents to a freshly built match, at once (`Presenter.catchUp`).
 *
 * Timed, because how long a window takes to arrive in a long match is
 * something a player feels and nothing else measures.
 */
function catchUp(scene: MatchScene, log: MatchLog): void {
  const started = performance.now()
  scene.presenter.catchUp(
    log.events.map((event) => event.command),
    SIM.step,
    (step) => scene.tracers.update(step),
  )
  console.info(
    `[tictac] caught up with ${log.events.length} intents of ${log.matchId} in ${Math.round(performance.now() - started)} ms`,
  )
}

/** Hand a built match to the player who commands one of its sides. */
function playMatch(screens: ScreenController, scene: MatchScene, network: NetworkManager, header: RecordingHeader): void {
  const { battlefield, squads, rig, tracers, turnManager, session, presenter } = scene
  const myFaction = network.mode !== 'local' ? network.myFaction : Faction.Blue

  // Assigned last thing before play, because it is what releases whatever the
  // other side sent while this one was still being built.
  network.onMessage = (msg) => {
    session.handleRemoteNetworkMessage(msg)
  }

  network.onDisconnected = (reason) => screens.showInterrupted(reason)

  // Back from a drop to find the server never got something this window
  // played: the match is the server's log, built again in place exactly as a
  // window taking it over builds it. What was relayed while it was away
  // (`caughtUp`) has already gone to `onMessage` and needs nothing here.
  network.onResync = (resync) => {
    if (resync.kind !== 'rebuild') return
    const camera = { focus: rig.focusPoint.clone(), zoom: rig.zoom, azimuth: rig.azimuth }
    screens.dismiss()
    resumeMatch(screens, network, resync.log, camera)
    screens.flash('Your last move never reached the server, so the match has been rebuilt to where the server has it.')
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

  const loop = new FixedStepLoop(SIM.step, SIM.maxCatchUp, (step) => {
    tracers.update(step)
    presenter.update(step)
  })
  const stopFrames = onEachFrame(Game.instance(), (delta) => {
    loop.advance(delta)
    battlefield.flush()
  })
  screens.holdNetwork(network)
  screens.present(() => {
    stopFrames()
    disposeScene(scene)
  })

  expose(scene, { seed: header.seed, seedLabel: header.seedLabel, network })
  console.info(`[tictac] tactical combat ready — mode: ${network.mode}, seed ${header.seedLabel}`)
}

/**
 * Watch a match on a server, without a seat in it.
 *
 * A recording that is still being written: the world is built from the log
 * the way a replay is built from its file — every field revealed, the HUD
 * away, the session held in `spectate` mode with no network — and the
 * intents the players send after that are applied the same way, as they
 * arrive. Nothing is ever sent back (`NetworkManager` in `spectate` mode).
 *
 * A room that has not started yet has no log to build from, so the watcher
 * waits — with the way out already on screen — until it does.
 */
function watchMatch(screens: ScreenController, network: NetworkManager, seat: Seated): void {
  let scene: MatchScene | null = null
  let stopFrames: (() => void) | null = null
  let left = false
  /** The shown match and the frames that tick it, taken down together. */
  const teardown = (): void => {
    stopFrames?.()
    stopFrames = null
    if (scene) disposeScene(scene)
    scene = null
  }
  const bar = new SpectatorBar(() => screens.leaveMatch())
  bar.render({ roomId: seat.roomId, progress: { kind: 'waiting' } })
  screens.holdNetwork(network)
  screens.present(() => {
    left = true
    bar.dispose()
    teardown()
  })
  // The room aborted, or this player opened another window: said over
  // whatever is showing, as a player's interrupted match is.
  network.onDisconnected = (reason) => screens.showInterrupted(reason)

  /** The match as the log has it, then live as it is played. */
  const show = (log: MatchLog): MatchScene => {
    const { header } = log
    const engine = createEngineContext(Game.instance())
    const field = buildField(engine, header.seed, header.map, header.squads)
    const built = buildMatch(screens, engine, field, header.seedLabel, new Rng(header.seed), { watching: 'spectate' })
    scene = built
    const { battlefield, squads, rig, tracers, turnManager, hud, session, presenter } = built
    hud.setHidden(true)
    turnManager.autoSelectFirst()
    presenter.recomputeVisibility()
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

    const loop = new FixedStepLoop(SIM.step, SIM.maxCatchUp, (step) => {
      while (live.length > 0 && !session.busy) session.applyRecordedCommand(live.shift()!)
      tracers.update(step)
      presenter.update(step)
    })
    stopFrames = onEachFrame(Game.instance(), (delta) => {
      loop.advance(delta)
      battlefield.flush()
      // Decided once everything sent has been played out: the last shot's
      // walk and reactions are part of how it ended.
      const winner = live.length === 0 && !session.busy ? winnerOf(squads) : null
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
    teardown()
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
 * network (nothing to transmit, nothing to record), and the session is held in
 * `replay` mode — which reveals the whole field and takes the player's hands
 * off the units.
 */
function startPlayback(screens: ScreenController, recording: CombatRecording): void {
  const { header } = recording
  const engine = createEngineContext(Game.instance())
  const field = buildField(engine, header.seed, header.map, header.squads)
  // Every outcome is resolved here, from the dice the match was fought with.
  // Held as the generator rather than a wrapped stream, because stepping back
  // has to put the dice back as well as the world.
  const dice = new Rng(header.seed)
  const scene = buildMatch(screens, engine, field, header.seedLabel, dice, { watching: 'replay' })
  const { world, battlefield, squads, rig, tracers, turnSystem, turnManager, hud, session, presenter } = scene
  hud.setHidden(true)
  turnManager.autoSelectFirst()
  presenter.recomputeVisibility()

  const rewindable: Rewindable = {
    world,
    unitIds: squads.soldiers.map((soldier) => soldier.entityId),
    walls: session.wallSystem,
    ground: session.groundSystem,
    turns: turnSystem,
    dice,
    movement: session.movementSystem,
    commands: session.commands,
  }

  const playback = new Playback({
    recording,
    apply: (command) => session.applyRecordedCommand(command),
    busy: () => session.busy,
    match: rewindable,
    afterRestore: () => {
      turnManager.autoSelectFirst()
      presenter.recomputeVisibility()
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
      case 'leave':
        screens.leaveMatch()
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

  const loop = new FixedStepLoop(
    SIM.step,
    SIM.maxCatchUp,
    (step) => {
      tracers.update(step)
      presenter.update(step)
      playback.update(step)
    },
    () => (playback.playing ? playback.speed : 1),
  )
  const stopFrames = onEachFrame(Game.instance(), (delta) => {
    loop.advance(delta)
    battlefield.flush()
  })
  // Taken down with the screen, whoever leaves it: a replay's frames, bar and
  // scene go together, and a second replay does not stand among them.
  screens.present(() => {
    stopFrames()
    controls.dispose()
    disposeScene(scene)
  })

  expose(scene, { playback, seed: header.seed, seedLabel: header.seedLabel })

  console.info(
    `[tictac] replay ready — ${recording.events.length} events, ${header.source} seed ${header.seedLabel}`,
  )
}
