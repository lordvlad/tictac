import { Faction } from '../../src/config'
import { maxHpOf, sanitizeSheet, type CharacterSheet } from '../../src/core/Characters'
import { RpcMethods, type JsonRpcFrame, type JsonRpcNotification } from '../../src/game/JsonRpc'
import type { ServerIntent } from '../../src/game/Lobby'
import type { NetworkMessage } from '../../src/game/NetworkManager'
import type { CombatRecording, Deployment, RecordingHeader } from '../../src/game/Recording'
import { loopback } from '../../src/game/Transport'
import type { Player } from '../../src/server/Accounts'
import type { Lobby } from '../../src/server/Lobby'
import type { Persistence } from '../../src/server/Persistence'
import { STOCK_PLAN } from '../../src/sim/Balance'
import { SimMatch } from '../../src/sim/SimMatch'
import { MY_VERSION, type PeerVersion } from '../../src/version'

/**
 * A socket to a lobby, held the way a client holds one, spoken in raw
 * JSON-RPC frames rather than through `NetworkManager` — so what is under test
 * is the server's half of the conversation and nothing else.
 */
export interface Connection {
  send(message: NetworkMessage): void
  /** Everything the server sent, in order. */
  received: NetworkMessage[]
  /** Everything of one type the server sent, in order. */
  of<T extends NetworkMessage['type']>(type: T): Extract<NetworkMessage, { type: T }>[]
  /** True once the server has closed this socket. */
  readonly closed: boolean
  /** Hang up, as a tab closing does. */
  close(): void
}

/**
 * Connect to `lobby` as `player` (null for anonymous), asking for `intent`.
 *
 * States `version` (this build, unless a test is an older or newer page)
 * straight away, as every client's first frame does, unless `hello: false` —
 * for a test that wants to say something else first.
 */
export function connect(
  lobby: Lobby,
  player: Player | null,
  intent: ServerIntent | null,
  { hello = true, version = MY_VERSION }: { hello?: boolean; version?: PeerVersion } = {},
): Connection {
  const [mine, theirs] = loopback()
  const received: NetworkMessage[] = []
  let closed = false
  mine.onFrame((frame) => {
    if (!('method' in frame)) return
    const params = (frame as JsonRpcNotification).params as Record<string, unknown>
    for (const [type, method] of Object.entries(RpcMethods)) {
      if (method === frame.method) received.push({ ...params, type } as NetworkMessage)
    }
  })
  mine.onClosed(() => {
    closed = true
  })
  lobby.attach(theirs, player, intent)

  const send = (message: NetworkMessage): void => {
    const params = { ...message } as Record<string, unknown>
    delete params.type
    mine.send({ jsonrpc: '2.0', method: RpcMethods[message.type], params } as JsonRpcFrame)
  }
  if (hello) send({ type: 'hello', ...version })

  return {
    send,
    received,
    of: <T extends NetworkMessage['type']>(type: T) =>
      received.filter((message): message is Extract<NetworkMessage, { type: T }> => message.type === type),
    get closed() {
      return closed
    },
    close: () => mine.close(),
  }
}

/**
 * Resolves once the server has answered `connection`'s `hello` — seated it,
 * or turned it away. A seat taken back by key is placed only after its key is
 * hashed, which WebCrypto does asynchronously; everything else is answered at
 * once and resolves straight away.
 */
export async function answered(connection: Connection): Promise<Connection> {
  for (let waited = 0; waited < 1_000; waited++) {
    if (connection.of('seated').length > 0 || connection.of('abort').length > 0) return connection
    await Bun.sleep(1)
  }
  throw new Error(`never answered; received ${connection.received.map((m) => m.type).join(', ')}`)
}

/** The seat key a connection was handed, read off its `seated` frame. */
export function keyOf(connection: Connection): string {
  const key = connection.of('seated')[0]?.seatKey
  if (!key) throw new Error(`no seat key; received ${connection.received.map((m) => m.type).join(', ')}`)
  return key
}

/** The room a connection was placed in, read off its `seated` frame. */
export function roomOf(connection: Connection): string {
  const seated = connection.of('seated')[0]
  if (!seated) throw new Error(`never seated; received ${connection.received.map((m) => m.type).join(', ')}`)
  return seated.roomId
}

/** One room with both seats taken: `blue` opened it and `red` joined it. */
export function seatBoth(
  lobby: Lobby,
  blue: Player | null,
  red: Player | null,
  options: { version?: PeerVersion } = {},
) {
  const host = connect(lobby, blue, { kind: 'open' }, options)
  const roomId = roomOf(host)
  const joiner = connect(lobby, red, { kind: 'join', roomId }, options)
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
