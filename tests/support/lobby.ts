import { RpcMethods, type JsonRpcFrame, type JsonRpcNotification } from '../../src/game/JsonRpc'
import type { ServerIntent } from '../../src/game/Lobby'
import type { NetworkMessage } from '../../src/game/NetworkManager'
import type { CombatRecording } from '../../src/game/Recording'
import { loopback } from '../../src/game/Transport'
import type { Player } from '../../src/server/Accounts'
import type { Lobby } from '../../src/server/Lobby'
import { STOCK_PLAN } from '../../src/sim/Balance'
import { SimMatch } from '../../src/sim/SimMatch'
import { MY_VERSION } from '../../src/version'

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
 * States this build straight away, as every client's first frame does, unless
 * `hello: false` — for a test that wants to say something else first.
 */
export function connect(
  lobby: Lobby,
  player: Player | null,
  intent: ServerIntent | null,
  { hello = true }: { hello?: boolean } = {},
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
  if (hello) send({ type: 'hello', ...MY_VERSION })

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

/** The room a connection was placed in, read off its `seated` frame. */
export function roomOf(connection: Connection): string {
  const seated = connection.of('seated')[0]
  if (!seated) throw new Error(`never seated; received ${connection.received.map((m) => m.type).join(', ')}`)
  return seated.roomId
}

/** One room with both seats taken: `blue` opened it and `red` joined it. */
export function seatBoth(lobby: Lobby, blue: Player | null, red: Player | null) {
  const host = connect(lobby, blue, { kind: 'open' })
  const roomId = roomOf(host)
  const joiner = connect(lobby, red, { kind: 'join', roomId })
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
