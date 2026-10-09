import { Faction } from '../../src/config'
import { maxHpOf, sanitizeSheet, type CharacterSheet } from '../../src/core/Characters'
import { RpcMethods, type JsonRpcFrame, type JsonRpcNotification } from '../../src/game/JsonRpc'
import type { LobbyView, ServerIntent } from '../../src/game/Lobby'
import type { NetworkMessage } from '../../src/game/NetworkManager'
import type { CombatRecording, Deployment, RecordingHeader } from '../../src/game/Recording'
import type { Player, RpcMethod, RpcParams, RpcResult } from '../../src/game/Rpc'
import { loopback } from '../../src/game/Transport'
import type { Lobby } from '../../src/server/Lobby'
import type { Persistence } from '../../src/server/Persistence'
import type { Journeys } from '../../src/server/Journeys'
import { Sessions } from '../../src/server/Session'
import { STOCK_PLAN } from '../../src/sim/Balance'
import { SimMatch } from '../../src/sim/SimMatch'
import { MY_VERSION, PROTOCOL_VERSION, type PeerVersion } from '../../src/version'

/**
 * A socket to a lobby, held the way a window holds one, spoken in raw
 * JSON-RPC frames rather than through `ServerConnection`/`NetworkManager` —
 * so what is under test is the server's half of the conversation and nothing
 * else.
 *
 * The match's own notifications are collected as `NetworkMessage`s, and so
 * is the answer to the room this socket asked for: a seat as `seated`, a
 * refusal as `abort` with the server's reason — the two shapes these tests
 * have always read a room's answer in, whether it came as a notification
 * (protocol 6) or as the response to `room/enter` (protocol 7).
 */
export interface Connection {
  send(message: NetworkMessage): void
  /** Ask the server something on this socket, as a window does; rejects with the server's reason. */
  request<M extends RpcMethod>(method: M, params: RpcParams<M>): Promise<RpcResult<M>>
  /** Everything the server sent, in order. */
  received: NetworkMessage[]
  /** Everything of one type the server sent, in order. */
  of<T extends NetworkMessage['type']>(type: T): Extract<NetworkMessage, { type: T }>[]
  /** Every lobby view pushed to this socket (`lobby/changed`), in order. */
  lobby: LobbyView[]
  /** Every other `tictac/api/*` notification the server pushed to this socket, in order: `encounter/started` and the like. */
  pushed: JsonRpcNotification[]
  /**
   * The first pushed view that satisfies `ready` — one already here, or the
   * next to arrive. Pushes are gathered into one per change and sent a
   * moment after it, so this is how a test waits for one: by the push
   * itself, never by a guessed delay.
   */
  lobbyWhere(ready: (view: LobbyView) => boolean): Promise<LobbyView>
  /** True once the server has closed this socket. */
  readonly closed: boolean
  /** Hang up, as a tab closing does. */
  close(): void
}

/**
 * The session layer over each lobby, as a host builds one: every socket a
 * test connects goes through it. Players sign in with a token that is simply
 * their id — the accounts behind `Sessions` are what `tests/session.test.ts`
 * is about, not these.
 */
interface Layer {
  sessions: Sessions
  /** Players whose id is a token the layer's accounts honour. */
  known: Map<string, Player>
}

const layers = new WeakMap<Lobby, Layer>()

function layerOf(lobby: Lobby): Layer {
  let layer = layers.get(lobby)
  if (!layer) {
    const known = new Map<string, Player>()
    const accounts = { playerFor: async (token: string) => known.get(token) ?? null }
    const sessions = new Sessions({
      lobby,
      persistence: { accounts, rosters: {}, squads: {} } as unknown as Pick<Persistence, 'accounts' | 'rosters' | 'squads' | 'encounters' | 'matches'>,
      // Nothing here travels.
      journeys: {} as Journeys,
      log: () => {},
    })
    layer = { sessions, known }
    layers.set(lobby, layer)
  }
  return layer
}

/**
 * Connect to `lobby` as `player` (null for anonymous), asking for `intent`,
 * and resolve once the server has answered it — the way a window does it:
 * `hello` with `version`, `account/signIn` when there is a player, then
 * `room/enter`. A page on the protocol before this one (`version`) asks for a
 * keyed resume the only way it can, in its url.
 *
 * `hello: false` states nothing at all, for a test that wants to say
 * something else first; nothing is asked then either.
 */
export async function connect(
  lobby: Lobby,
  player: Player | null,
  intent: ServerIntent | null,
  { hello = true, version = MY_VERSION }: { hello?: boolean; version?: PeerVersion } = {},
): Promise<Connection> {
  const { sessions, known } = layerOf(lobby)
  const [mine, theirs] = loopback()
  const received: NetworkMessage[] = []
  const views: LobbyView[] = []
  const pushed: JsonRpcNotification[] = []
  const lobbyWaiters = new Set<{ ready: (view: LobbyView) => boolean; resolve: (view: LobbyView) => void }>()
  /** Requests awaiting their answer, by id; `read` sees a result as it arrives, before any frame after it. */
  const pending = new Map<number, { waiting: PromiseWithResolvers<unknown>; read?: (result: unknown) => void }>()
  let lastId = 0
  let closed = false
  mine.onFrame((frame) => {
    if (!('method' in frame)) {
      const asked = typeof frame.id === 'number' ? pending.get(frame.id) : undefined
      if (!asked) return
      pending.delete(frame.id as number)
      if ('error' in frame) {
        asked.waiting.reject(new Error(frame.error.message))
        return
      }
      asked.read?.(frame.result)
      asked.waiting.resolve(frame.result)
      return
    }
    const params = (frame as JsonRpcNotification).params as Record<string, unknown>
    // The window being replaced by a newer one of its player: read as the
    // `abort` it was before protocol 7, which is what these tests check for.
    if (frame.method === 'tictac/api/session/replaced') {
      received.push({ type: 'abort', reason: String(params.reason), side: null })
      return
    }
    if (frame.method.startsWith('tictac/api/') && frame.method !== 'tictac/api/lobby/changed') {
      pushed.push(frame as JsonRpcNotification)
    }
    if (frame.method === 'tictac/api/lobby/changed') {
      const view = params as unknown as LobbyView
      views.push(view)
      for (const waiter of [...lobbyWaiters]) {
        if (!waiter.ready(view)) continue
        lobbyWaiters.delete(waiter)
        waiter.resolve(view)
      }
      return
    }
    for (const [type, method] of Object.entries(RpcMethods)) {
      if (method === frame.method) received.push({ ...params, type } as NetworkMessage)
    }
  })
  mine.onClosed(() => {
    closed = true
    for (const { waiting } of pending.values()) waiting.reject(new Error('the socket closed'))
    pending.clear()
  })

  const older = version.protocol < PROTOCOL_VERSION
  const url = older && intent?.kind === 'resume' ? `ws://lobby.test/?intent=resume&room=${intent.roomId}&seat=${intent.seatKey}` : 'ws://lobby.test/'
  sessions.attach(theirs, { url })

  const send = (message: NetworkMessage): void => {
    const params = { ...message } as Record<string, unknown>
    delete params.type
    mine.send({ jsonrpc: '2.0', method: RpcMethods[message.type], params } as JsonRpcFrame)
  }
  const ask = <M extends RpcMethod>(
    method: M,
    params: RpcParams<M>,
    read?: (result: RpcResult<M>) => void,
  ): Promise<RpcResult<M>> => {
    const id = ++lastId
    const waiting = Promise.withResolvers<unknown>()
    pending.set(id, { waiting, read: read as ((result: unknown) => void) | undefined })
    mine.send({ jsonrpc: '2.0', id, method, params: params as Record<string, unknown> })
    return waiting.promise as Promise<RpcResult<M>>
  }
  const request = <M extends RpcMethod>(method: M, params: RpcParams<M>): Promise<RpcResult<M>> => ask(method, params)
  const connection: Connection = {
    send,
    request,
    received,
    lobby: views,
    pushed,
    lobbyWhere: (ready) => {
      const already = views.find(ready)
      if (already) return Promise.resolve(already)
      const { promise, resolve } = Promise.withResolvers<LobbyView>()
      lobbyWaiters.add({ ready, resolve })
      return promise
    },
    of: <T extends NetworkMessage['type']>(type: T) =>
      received.filter((message): message is Extract<NetworkMessage, { type: T }> => message.type === type),
    get closed() {
      return closed
    },
    close: () => mine.close(),
  }
  if (!hello) return connection
  send({ type: 'hello', ...version })
  if (older) {
    // A protocol-6 page asks for nothing: its url said it all, and the
    // answer is a notification. Wait for it.
    await answered(connection)
    return connection
  }
  try {
    if (player) {
      known.set(player.id, player)
      await request('tictac/api/account/signIn', { token: player.id })
    }
    if (intent) {
      // The seat is recorded as its answer is read — before the `log` that
      // follows it — as a window takes it.
      await ask('tictac/api/room/enter', { intent }, (seated) => received.push({ type: 'seated', ...seated }))
    }
  } catch (error) {
    // A refusal — or a socket the gate already closed — read as a room's
    // `abort` with the server's reason, unless the server sent one itself.
    if (connection.of('abort').length === 0) {
      received.push({ type: 'abort', reason: error instanceof Error ? error.message : String(error), side: null })
    }
  }
  return connection
}

/**
 * Resolves once the server has answered `connection` — seated it, or turned
 * it away. `connect` already waits for its own answer; this is for a
 * protocol-6 page, whose answer is a notification.
 */
export async function answered(connection: Connection): Promise<Connection> {
  for (let waited = 0; waited < 1_000; waited++) {
    if (connection.of('seated').length > 0 || connection.of('abort').length > 0) return connection
    await Bun.sleep(1)
  }
  throw new Error(`never answered; received ${connection.received.map((m) => m.type).join(', ')}`)
}

/** The seat key a connection was handed, read off its `seated` answer. */
export function keyOf(connection: Connection): string {
  const key = connection.of('seated')[0]?.seatKey
  if (!key) throw new Error(`no seat key; received ${connection.received.map((m) => m.type).join(', ')}`)
  return key
}

/** The room a connection was placed in, read off its `seated` answer. */
export function roomOf(connection: Connection): string {
  const seated = connection.of('seated')[0]
  if (!seated) throw new Error(`never seated; received ${connection.received.map((m) => m.type).join(', ')}`)
  return seated.roomId
}

/** One room with both seats taken: `blue` opened it and `red` joined it. */
export async function seatBoth(
  lobby: Lobby,
  blue: Player | null,
  red: Player | null,
  options: { version?: PeerVersion } = {},
) {
  const host = await connect(lobby, blue, { kind: 'open' }, options)
  const roomId = roomOf(host)
  const joiner = await connect(lobby, red, { kind: 'join', roomId }, options)
  return { blue: host, red: joiner, roomId }
}

/** A recorded match that somebody actually won, from the first seed that produces one. */
export function decisive(from = 4242): CombatRecording {
  for (let seed = from; seed < from + 40; seed++) {
    const match = new SimMatch({ seed, blue: STOCK_PLAN, red: STOCK_PLAN, turnCap: 60, record: true })
    const outcome = match.run()
    if (outcome.winner !== null && match.recording) return match.recording
  }
  throw new Error('no decisive match in 40 seeds')
}

/** The people a header's squad states, for tests that only want the sheet. */
export function sheetsOf(header: RecordingHeader, faction: Faction): CharacterSheet[] {
  return header.squads[faction].map((deployment) => deployment.sheet)
}

/**
 * The same header, with each side's `state.hp` and `state.fatigue` stamped —
 * what a signed-in client's `ready` actually carries (`[ITEM-039]`: the
 * referee checks fatigue the same strict way it checks hp, so a test cannot
 * leave it implicit). `fatigue` defaults to 0, every fixture roster's own
 * starting level.
 */
export function withStartingHp(
  header: RecordingHeader,
  hp: Record<Faction, readonly number[]>,
  fatigue?: Record<Faction, readonly number[]>,
): RecordingHeader {
  const stamp = (faction: Faction): Deployment[] =>
    header.squads[faction].map((deployment, i) => ({
      ...deployment,
      state: { ...deployment.state, hp: hp[faction][i], fatigue: fatigue?.[faction]?.[i] ?? 0 },
    }))
  return { ...header, squads: { [Faction.Blue]: stamp(Faction.Blue), [Faction.Red]: stamp(Faction.Red) } }
}

/**
 * The same header, with each side's `characterId` stamped as given — the
 * referee now checks the *stated id* against the roster (`[ITEM-042]`), not
 * a bare positional sheet compare, so a signed-in test has to name real ones.
 */
export function withCharacterIds(
  header: RecordingHeader,
  ids: Record<Faction, readonly string[]>,
): RecordingHeader {
  const stamp = (faction: Faction): Deployment[] =>
    header.squads[faction].map((deployment, i) => ({ ...deployment, characterId: ids[faction][i] }))
  return { ...header, squads: { [Faction.Blue]: stamp(Faction.Blue), [Faction.Red]: stamp(Faction.Red) } }
}

/**
 * Enlist `blue` and `red` with exactly the squads `header` deploys, and the
 * header an honest signed-in client would state for them: their own character
 * ids, at the health and fatigue the roster keeps. A match played from it is
 * one the referee settles onto both rosters.
 */
export async function enlistFor(
  persistence: Persistence,
  header: RecordingHeader,
  blue: Player,
  red: Player,
): Promise<RecordingHeader> {
  for (const { id, name } of [blue, red]) {
    await persistence.db
      .query`INSERT INTO players (id, name, created_at) VALUES (${id}, ${name}, ${'2026-01-01T00:00:00Z'})`
  }
  await persistence.rosters.enlist(persistence.db, blue.id, sheetsOf(header, Faction.Blue))
  await persistence.rosters.enlist(persistence.db, red.id, sheetsOf(header, Faction.Red))
  const ids = async (player: Player) => (await persistence.rosters.active(player.id)).map((m) => m.characterId)
  const hp = (faction: Faction) => sheetsOf(header, faction).map((sheet) => maxHpOf(sanitizeSheet(sheet)))
  return withStartingHp(
    withCharacterIds(header, { [Faction.Blue]: await ids(blue), [Faction.Red]: await ids(red) }),
    { [Faction.Blue]: hp(Faction.Blue), [Faction.Red]: hp(Faction.Red) },
  )
}
