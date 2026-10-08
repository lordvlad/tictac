import { describe, expect, test } from 'bun:test'
import { Faction } from '../src/config'
import { rollSquadSheets } from '../src/core/Characters'
import { Rng } from '../src/core/rng'
import { isJsonRpcFrame, type JsonRpcFrame } from '../src/game/JsonRpc'
import { isCommand } from '../src/ecs/systems/CommandSystem'
import { defaultLoadout } from '../src/game/Loadout'
import type { Seated } from '../src/game/Lobby'
import { NetworkManager, type NetworkMessage, type Resync } from '../src/game/NetworkManager'
import { RECORDING_VERSION, type Deployment, type RecordingHeader } from '../src/game/Recording'
import type { Player } from '../src/game/Rpc'
import { heldTokens, ServerConnection } from '../src/game/ServerConnection'
import { PROTOCOL_VERSION } from '../src/version'
import type { Transport } from '../src/game/Transport'
import { openPersistence } from '../src/server/db/BunSqlDb'
import { Lobby } from '../src/server/Lobby'
import type { Persistence } from '../src/server/Persistence'
import type { RefereeVerdict, Room } from '../src/server/Room'
import { Sessions } from '../src/server/Session'
import { STOCK_PLAN } from '../src/sim/Balance'
import { MatchHost } from '../src/sim/MatchHost'
import { replay } from '../src/sim/Replay'
import { simulateOverWire, type WireMatchResult } from '../src/sim/WireMatch'

/**
 * A match server on a real socket, in-process, and windows that talk to it
 * the way a browser does: one `ServerConnection` each, a `NetworkManager`
 * playing over it.
 *
 * The loopback tests cover what the referee decides; this covers the thing they
 * cannot — that `NetworkManager`s reach each other *through* a server over a
 * real WebSocket, that the server relays to the other side and not back to
 * the sender, that what it wrote down refights, and that a window gets back
 * to its seat by itself when the server under it restarts.
 *
 * Who a window is signed in as is stated in its url (`?as=`), and presented
 * as a token that is simply the player's id: passkeys are the accounts'
 * business and tested there, and this is about what the lobby does with a
 * player once it has one.
 *
 * Port 0 the first time, so the test cannot collide with anything, including
 * itself; the same port after a `restart`, because a redeployed server is
 * found where the old one was.
 */
async function lobbyOnASocket() {
  const persistence = await openPersistence()
  const store = persistence.matches
  const verdicts: RefereeVerdict[] = []
  const accounts = {
    playerFor: async (token: string): Promise<Player | null> =>
      token.startsWith('id-') ? { id: token, name: token.slice(3) } : null,
  }
  const newLobby = () =>
    new Lobby({ matches: store, rooms: persistence.rooms, log: () => {}, onVerdict: (verdict) => verdicts.push(verdict) })
  let lobby = newLobby()
  const sessionsOver = (over: Lobby) =>
    new Sessions({
      lobby: over,
      persistence: { accounts, rosters: {} } as unknown as Pick<Persistence, 'accounts' | 'rosters'>,
      log: () => {},
    })
  let sessions = sessionsOver(lobby)
  const windows: ServerConnection[] = []

  const serve = (port: number): Serving => {
    const sockets = new WeakMap<object, { deliver: (raw: string) => void; closed: () => void }>()
    const server = Bun.serve({
      port,
      fetch: (request, server) => (server.upgrade(request, { data: { url: request.url } }) ? undefined : new Response('no')),
      websocket: {
        data: {} as { url: string },
        open(ws) {
          const frames: ((frame: JsonRpcFrame) => void)[] = []
          const closers: ((reason: string) => void)[] = []
          const transport: Transport = {
            send: (frame) => ws.send(JSON.stringify(frame)),
            onFrame: (handler) => frames.push(handler),
            onClosed: (handler) => closers.push(handler),
            close: () => ws.close(),
          }
          sockets.set(ws, {
            deliver: (raw) => {
              const parsed = JSON.parse(raw)
              if (isJsonRpcFrame(parsed)) for (const handler of frames) handler(parsed)
            },
            closed: () => {
              for (const handler of closers) handler('closed')
            },
          })
          sessions.attach(transport, { url: ws.data.url })
        },
        message(ws, message) {
          sockets.get(ws)?.deliver(String(message))
        },
        close(ws) {
          sockets.get(ws)?.closed()
        },
      },
    })
    return { port: server.port!, stop: () => server.stop(true) }
  }
  let server: Serving | null = serve(0)
  const port = server.port

  const site = {
    get lobby() {
      return lobby
    },
    store,
    verdicts,
    url: `ws://127.0.0.1:${port}/`,
    as: (name: string) => `ws://127.0.0.1:${port}/?as=${name}`,
    /**
     * A window's connection to `url`, signed in as the url's `?as=` if it
     * names anybody. Closed with the site.
     */
    window: (url: string): ServerConnection => {
      const name = new URL(url).searchParams.get('as')
      const connection = new ServerConnection(url, { tokens: heldTokens(name ? `id-${name}` : null) })
      windows.push(connection)
      return connection
    },
    /** The process going away under a deploy: every socket dropped, nothing said to it. */
    crash: async () => {
      await lobby.dispose()
      server?.stop()
      server = null
    },
    /** The new process: the rooms read back from the same database, on the same port. */
    boot: async () => {
      lobby = newLobby()
      await lobby.restore()
      sessions = sessionsOver(lobby)
      server = serve(port)
    },
    restart: async () => {
      await site.crash()
      await site.boot()
    },
    stop: async () => {
      for (const window of windows) window.close()
      await lobby.dispose()
      server?.stop()
      await persistence.close()
    },
  }
  return site
}

/** A listening `Bun.serve`, as much of it as a restart needs. */
interface Serving {
  port: number
  stop(): void
}

const SHEETS = {
  [Faction.Blue]: rollSquadSheets(new Rng(1)),
  [Faction.Red]: rollSquadSheets(new Rng(2)),
}

function squadOf(faction: Faction): Deployment[] {
  const kit = defaultLoadout()
  return SHEETS[faction].map((sheet, i) => ({ sheet, loadout: kit[i]! }))
}

function header(seed: number): RecordingHeader {
  return {
    version: RECORDING_VERSION,
    seed,
    seedLabel: String(seed),
    source: 'live',
    createdAt: new Date().toISOString(),
    turnCap: null,
    squads: { [Faction.Blue]: squadOf(Faction.Blue), [Faction.Red]: squadOf(Faction.Red) },
  }
}

/**
 * Resolves with the next intent `manager` hears, held for it if it came
 * already. Session frames on the way (an opening restated, the header the
 * host opened the match with) are passed over: they are not moves.
 */
function nextIntent(manager: NetworkManager): Promise<NetworkMessage> {
  const { promise, resolve } = Promise.withResolvers<NetworkMessage>()
  manager.onMessage = (message) => {
    if (!isCommand(message)) return
    manager.onMessage = null
    resolve(message)
  }
  return promise
}

/**
 * Open a room at `hostUrl`, join it from `joinerUrl`, deploy both stock
 * squads and open the match — everything two players in a lobby do before the
 * first shot.
 */
async function playing(window: (url: string) => ServerConnection, hostUrl: string, joinerUrl: string, seed: number) {
  const host = new NetworkManager()
  const joiner = new NetworkManager()
  const opened = await host.enterRoom(window(hostUrl), { kind: 'open' })
  const joined = await joiner.enterRoom(window(joinerUrl), { kind: 'join', roomId: opened.roomId })
  host.hostMatch(seed, String(seed))
  const opening = await joiner.joinMatch()
  host.send({ type: 'ready', squad: squadOf(Faction.Blue) })
  joiner.send({ type: 'ready', squad: squadOf(Faction.Red) })
  const [seenByHost, seenByJoiner] = await Promise.all([host.waitForPeerReady(), joiner.waitForPeerReady()])
  host.send({ type: 'matchHeader', header: header(seed) })
  return { host, joiner, roomId: opened.roomId, opened, joined, opening, seenByHost, seenByJoiner }
}

describe('Two clients playing through a match server', () => {
  test('they reach each other over sockets, and the referee keeps the match', async () => {
    const { lobby, store, url, window, stop } = await lobbyOnASocket()
    const seed = 777
    const { host, joiner, roomId, opened, joined, opening, seenByHost, seenByJoiner } = await playing(window, url, url, seed)

    // The lobby seated them where they asked, and the seed came from the
    // host, through the server, over a socket.
    expect(opened).toEqual({ roomId, faction: Faction.Blue, phase: 'waiting', redirected: false, seatKey: expect.any(String) })
    expect(joined).toEqual({ roomId, faction: Faction.Red, phase: 'deploying', redirected: false, seatKey: expect.any(String) })
    // A secret per seat, so neither can take the other's back.
    expect(opened.seatKey).not.toBe(joined.seatKey)
    expect(opening.seed).toBe(seed)
    expect([host.mode, joiner.mode]).toEqual(['host', 'join'])

    // Both sides learn who the other brought *and* what they are carrying —
    // the kit is what a referee cannot derive from the intents.
    expect(seenByHost?.squad.map((d) => d.sheet)).toEqual(SHEETS[Faction.Red])
    expect(seenByJoiner?.squad.map((d) => d.sheet)).toEqual(SHEETS[Faction.Blue])
    expect(seenByHost?.squad.every((d) => d.loadout !== undefined)).toBe(true)

    host.send({
      type: 'moveUnit',
      faction: Faction.Blue,
      squadIndex: 0,
      path: [{ x: 20, y: 5 }, { x: 20, y: 6 }],
    })
    host.send({ type: 'endTurn', faction: Faction.Blue })
    expect((await nextIntent(joiner)).type).toBe('moveUnit')
    expect((await nextIntent(joiner)).type).toBe('endTurn')
    joiner.send({ type: 'toggleCover', faction: Faction.Red, squadIndex: 1 })

    // Relayed to the other side, never back to the sender: a frame that echoed
    // would be applied twice by the client that sent it. Anything the host
    // had been sent would be held for it in order, so the first thing it
    // hears is the first thing anybody said to it.
    expect((await nextIntent(host)).type).toBe('toggleCover')

    // And the referee's own log, kept under the room's id, refights: what it
    // kept is a match, not a note about one.
    await lobby.idle()
    const stored = (await store.match(roomId))!
    expect(stored.events).toHaveLength(3)
    const refought = replay(stored)
    expect(refought.skipped).toEqual([])
    expect(refought.digest.total).toBe(lobby.room(roomId)!.digest()!.total)

    host.dispose()
    joiner.dispose()
    await stop()
  })

  test('a window on another build may sign in and look, but is not seated in a match it cannot agree with', async () => {
    // The same gate as peer-to-peer play, over a different channel: the server
    // refuses a build it cannot agree with rather than accusing it later. It
    // refuses the room, not the socket — a page on a stale build still needs
    // the lobby to be told why, and a reload is all it takes to fix.
    const { url, stop } = await lobbyOnASocket()
    // Spoken by hand rather than through a `ServerConnection`, because the
    // point is a window this build would never produce: one claiming another.
    const socket = new WebSocket(url)
    const opened = Promise.withResolvers<void>()
    socket.addEventListener('open', () => opened.resolve())
    await opened.promise
    const answer = Promise.withResolvers<{ error?: { message: string } }>()
    socket.addEventListener('message', (event) => {
      const frame = JSON.parse(String(event.data))
      if (frame.id === 1) answer.resolve(frame)
    })
    socket.send(
      JSON.stringify({ jsonrpc: '2.0', method: 'tictac/system/session/hello', params: { protocol: PROTOCOL_VERSION, build: 'c0ffee1' } }),
    )
    socket.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tictac/api/room/enter', params: { intent: { kind: 'open' } } }))

    expect((await answer.promise).error?.message).toContain('c0ffee1')
    expect(socket.readyState).toBe(WebSocket.OPEN)
    socket.close()
    await stop()
  })

  test('a room that is not there is a reason, not a hang', async () => {
    const { url, window, stop } = await lobbyOnASocket()
    const lost = new NetworkManager()
    await expect(lost.enterRoom(window(url), { kind: 'join', roomId: 'nowhere' })).rejects.toThrow('gone')
    lost.dispose()
    await stop()
  })

  test('a player who opens a second window takes their match with them, rebuilt to the same world', async () => {
    const { lobby, as, window, stop } = await lobbyOnASocket()
    const { host, joiner, roomId } = await playing(window, as('alice'), as('bob'), 4242)

    // A few intents in, so there is a match to rebuild rather than an opening.
    const moved = nextIntent(joiner)
    host.send({ type: 'moveUnit', faction: Faction.Blue, squadIndex: 0, path: [{ x: 20, y: 5 }, { x: 20, y: 6 }] })
    await moved
    const ended = nextIntent(joiner)
    host.send({ type: 'endTurn', faction: Faction.Blue })
    await ended

    // The window being replaced is told why, in so many words.
    const superseded = Promise.withResolvers<string>()
    host.onDisconnected = (reason) => superseded.resolve(reason ?? '')

    const second = new NetworkManager()
    const seat = await second.enterRoom(window(as('alice')), { kind: 'resume' })
    expect(seat).toEqual({ roomId, faction: Faction.Blue, phase: 'playing', redirected: false, seatKey: expect.any(String) })
    expect(second.mode).toBe('host')
    expect(await superseded.promise).toContain('another window')

    // The log rebuilds the referee's world exactly: same opening, same
    // intents, same dice drawn in the same order.
    const log = await second.waitForLog()
    expect(log.matchId).toBe(roomId)
    expect(log.events.map((e) => e.command.type)).toEqual(['moveUnit', 'endTurn'])
    const rebuilt = new MatchHost(log.header)
    for (const event of log.events) rebuilt.apply(event.command)
    expect(rebuilt.digest()).toEqual(lobby.room(roomId)!.digest()!)

    // And the match goes on in the new window: the opponent's next intent
    // arrives there, held until something is listening.
    joiner.send({ type: 'toggleCover', faction: Faction.Red, squadIndex: 1 })
    expect((await nextIntent(second)).type).toBe('toggleCover')

    // Asking for anything else while that match is on puts the player back
    // in it, and says so.
    const third = new NetworkManager()
    const back = await third.enterRoom(window(as('alice')), { kind: 'open' })
    expect(back).toEqual({ roomId, faction: Faction.Blue, phase: 'playing', redirected: true, seatKey: expect.any(String) })
    expect((await third.waitForLog()).events).toHaveLength(3)

    for (const manager of [host, joiner, second, third]) manager.dispose()
    await stop()
  })

  test('a spectator is shown the match so far, then follows it live without a word', async () => {
    const { lobby, url, window, stop } = await lobbyOnASocket()
    const { host, joiner, roomId } = await playing(window, url, url, 99)
    const moved = nextIntent(joiner)
    host.send({ type: 'moveUnit', faction: Faction.Blue, squadIndex: 0, path: [{ x: 20, y: 5 }, { x: 20, y: 6 }] })
    await moved

    const watcher = new NetworkManager()
    const seat = await watcher.enterRoom(window(url), { kind: 'watch', roomId })
    expect(seat).toEqual({ roomId, faction: null, phase: 'playing', redirected: false, seatKey: null })
    expect(watcher.mode).toBe('spectate')
    const log = await watcher.waitForLog()
    expect(log.events.map((e) => e.command.type)).toEqual(['moveUnit'])

    // Every intent after that reaches the watcher as it is played, and the
    // log plus what followed it is the referee's match exactly.
    const relayed = nextIntent(watcher)
    host.send({ type: 'endTurn', faction: Faction.Blue })
    const live = await relayed
    expect(live.type).toBe('endTurn')
    const watched = new MatchHost(log.header)
    for (const event of log.events) watched.apply(event.command)
    watched.apply(live)
    await lobby.idle()
    expect(watched.digest()).toEqual(lobby.room(roomId)!.digest()!)

    for (const manager of [host, joiner, watcher]) manager.dispose()
    await stop()
  })

  test('a whole simulated match reaches settlement live, the same as it does headless', async () => {
    // `SimMatch` already plays a decisive match in milliseconds; this is the
    // one that reuses that instead of scripting a handful of moves by hand,
    // to reach the part the other tests in this file do not: a real winner,
    // over a real socket, refereed by a *second*, independent recomputation
    // of the same match (`src/sim/WireMatch.ts`).
    const { lobby, store, url, window, stop } = await lobbyOnASocket()

    let seed = 5000
    let result: WireMatchResult | undefined
    let room: Room | undefined
    while (!result && seed < 5040) {
      const attempt = await simulateOverWire({
        seed,
        blue: { ...STOCK_PLAN, size: 3 },
        red: { ...STOCK_PLAN, size: 3 },
        turnCap: 60,
        url,
      })
      // Taken at once: a settled room is let go once its sockets have closed.
      room = lobby.room(attempt.roomId)
      if (attempt.outcome.winner !== null) result = attempt
      else seed++
    }
    if (!result) throw new Error('no decisive seed found in range')

    // Independently recomputed twice — once by this side's own `SimMatch`,
    // once by the referee watching the wire — and they agree bit for bit.
    await lobby.idle()
    expect(room!.digest()).toEqual(result.digest)

    // What the referee kept is the whole match, not a sample of it, and
    // refighting the log it wrote reaches the exact same state a third time.
    const stored = (await store.match(result.roomId))!
    expect(stored.events).toHaveLength(result.recording.events.length)
    const refought = replay(stored)
    expect(refought.skipped).toEqual([])
    expect(refought.digest.total).toBe(result.digest.total)

    await stop()
  })
})

/** Resolves the next time `manager` is back in its own seat after a drop. */
function backInSeat(manager: NetworkManager): Promise<Seated> {
  const { promise, resolve } = Promise.withResolvers<Seated>()
  manager.onReconnected = resolve
  return promise
}

/** Resolves with what `manager` makes of the log it is handed on the way back. */
function resynced(manager: NetworkManager): Promise<Resync> {
  const { promise, resolve } = Promise.withResolvers<Resync>()
  manager.onResync = resolve
  return promise
}

/** Every reason `managers` were told their match was over; a reconnect should leave this empty. */
function endings(...managers: NetworkManager[]): string[] {
  const told: string[] = []
  for (const manager of managers) manager.onDisconnected = (reason) => told.push(reason ?? '')
  return told
}

const MOVE: NetworkMessage = { type: 'moveUnit', faction: Faction.Blue, squadIndex: 0, path: [{ x: 20, y: 5 }, { x: 20, y: 6 }] }

describe('A match server that restarts under its matches', () => {
  test('both players come back to their seats by themselves, and the match carries on, refereed', async () => {
    const site = await lobbyOnASocket()
    const seed = 4242
    const { host, joiner, roomId } = await playing(site.window, site.url, site.url, seed)
    const match = new MatchHost(header(seed))
    const moved = nextIntent(joiner)
    host.send(MOVE)
    await moved
    match.apply(MOVE)

    const told = endings(host, joiner)
    const back = Promise.all([backInSeat(host), backInSeat(joiner)])
    const caught = Promise.all([resynced(host), resynced(joiner)])
    await site.restart()

    // The same seats, in the same match, with the same keys.
    const seats = await back
    expect(seats.map((seat) => [seat.roomId, seat.faction, seat.phase])).toEqual([
      [roomId, Faction.Blue, 'playing'],
      [roomId, Faction.Red, 'playing'],
    ])
    expect(await caught).toEqual([
      { kind: 'caughtUp', missed: 0 },
      { kind: 'caughtUp', missed: 0 },
    ])

    // The next handover is checked by the server that was not there for the
    // first move, from the match it read back, and it agrees.
    const ended = nextIntent(joiner)
    host.send({ type: 'digest', digest: match.digest() })
    host.send({ type: 'endTurn', faction: Faction.Blue })
    expect((await ended).type).toBe('endTurn')
    match.apply({ type: 'endTurn', faction: Faction.Blue })
    const covered = nextIntent(host)
    joiner.send({ type: 'toggleCover', faction: Faction.Red, squadIndex: 1 })
    expect((await covered).type).toBe('toggleCover')
    match.apply({ type: 'toggleCover', faction: Faction.Red, squadIndex: 1 })

    await site.lobby.idle()
    expect(site.verdicts).toEqual([])
    expect(told).toEqual([])
    expect(site.lobby.room(roomId)!.digest()).toEqual(match.digest())
    expect((await site.store.match(roomId))!.events.map((event) => event.command.type)).toEqual([
      'moveUnit',
      'endTurn',
      'toggleCover',
    ])

    host.dispose()
    joiner.dispose()
    await site.stop()
  })

  test('two players still equipping come back to the room, and their squads still meet', async () => {
    const site = await lobbyOnASocket()
    const host = new NetworkManager()
    const joiner = new NetworkManager()
    const opened = await host.enterRoom(site.window(site.url), { kind: 'open' })
    await joiner.enterRoom(site.window(site.url), { kind: 'join', roomId: opened.roomId })
    host.hostMatch(31, '31')
    await joiner.joinMatch()

    const told = endings(host, joiner)
    const back = Promise.all([backInSeat(host), backInSeat(joiner)])
    await site.crash()
    // Both deploy while there is no server to hear it.
    host.send({ type: 'ready', squad: squadOf(Faction.Blue) })
    joiner.send({ type: 'ready', squad: squadOf(Faction.Red) })
    await site.boot()

    expect((await back).map((seat) => seat.phase)).toEqual(['deploying', 'deploying'])
    const [seenByHost, seenByJoiner] = await Promise.all([host.waitForPeerReady(), joiner.waitForPeerReady()])
    expect(seenByHost?.squad.map((d) => d.sheet)).toEqual(SHEETS[Faction.Red])
    expect(seenByJoiner?.squad.map((d) => d.sheet)).toEqual(SHEETS[Faction.Blue])

    // And the match opens and is played on the restarted server.
    host.send({ type: 'matchHeader', header: header(31) })
    const moved = nextIntent(joiner)
    host.send(MOVE)
    expect((await moved).type).toBe('moveUnit')
    expect(told).toEqual([])

    host.dispose()
    joiner.dispose()
    await site.stop()
  })

  test('a move played into a dead socket is not lost silently: the window is rebuilt from the log', async () => {
    const site = await lobbyOnASocket()
    const { host, joiner } = await playing(site.window, site.url, site.url, 4242)
    const moved = nextIntent(joiner)
    host.send(MOVE)
    await moved

    const told = endings(host, joiner)
    const back = Promise.all([backInSeat(host), backInSeat(joiner)])
    const rebuilt = resynced(host)
    await site.crash()
    host.send({ type: 'endTurn', faction: Faction.Blue })
    await site.boot()
    await back

    const resync = await rebuilt
    expect(resync.kind).toBe('rebuild')
    if (resync.kind !== 'rebuild') throw new Error('unreachable')
    expect(resync.log.events.map((event) => event.command.type)).toEqual(['moveUnit'])

    // The rebuilt window hands over again, and this time it arrives.
    const ended = nextIntent(joiner)
    host.send({ type: 'endTurn', faction: Faction.Blue })
    expect((await ended).type).toBe('endTurn')
    expect(told).toEqual([])

    host.dispose()
    joiner.dispose()
    await site.stop()
  })

  test('a spectator comes back to the room it was watching and follows it on', async () => {
    const site = await lobbyOnASocket()
    const { host, joiner, roomId } = await playing(site.window, site.url, site.url, 99)
    const moved = nextIntent(joiner)
    host.send(MOVE)
    await moved
    const watcher = new NetworkManager()
    await watcher.enterRoom(site.window(site.url), { kind: 'watch', roomId })
    await watcher.waitForLog()

    const told = endings(host, joiner, watcher)
    const back = Promise.all([host, joiner, watcher].map(backInSeat))
    const caught = resynced(watcher)
    await site.restart()
    const seats = await back
    expect(seats[2]).toEqual({ roomId, faction: null, phase: 'playing', redirected: false, seatKey: null })
    expect(await caught).toEqual({ kind: 'caughtUp', missed: 0 })

    const relayed = nextIntent(watcher)
    host.send({ type: 'endTurn', faction: Faction.Blue })
    expect((await relayed).type).toBe('endTurn')
    expect(told).toEqual([])

    for (const manager of [host, joiner, watcher]) manager.dispose()
    await site.stop()
  })
})
