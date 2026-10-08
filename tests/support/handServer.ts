import type { JsonRpcFrame, JsonRpcRequest } from '../../src/game/JsonRpc'
import { RpcMethods } from '../../src/game/JsonRpc'
import { loopback, type Transport } from '../../src/game/Transport'

export interface HandClock {
  schedule(fn: () => void, ms: number): () => void
  /**
   * Run every timer due within `ms`, in the order they fall due, letting
   * whatever each one set going settle before the next — as it would, in
   * the real time between them.
   */
  advance(ms: number): Promise<void>
  readonly now: number
}

/**
 * Every promise continuation queued so far, run. `setImmediate` comes after
 * the whole microtask queue, chains included, and waits for no duration.
 */
const settled = (): Promise<void> => {
  const { promise, resolve } = Promise.withResolvers<void>()
  setImmediate(resolve)
  return promise
}

/**
 * Timers on a clock the test turns by hand: what a window waits for between
 * tries, and how long it keeps trying, without a test that takes two minutes.
 */
export function handClock(): HandClock {
  let now = 0
  const timers: { at: number; fn: () => void; live: boolean }[] = []
  return {
    schedule: (fn: () => void, ms: number) => {
      const timer = { at: now + ms, fn, live: true }
      timers.push(timer)
      return () => {
        timer.live = false
      }
    },
    async advance(ms: number) {
      const until = now + ms
      await settled()
      for (;;) {
        const due = timers.filter((t) => t.live && t.at <= until).sort((a, b) => a.at - b.at)[0]
        if (!due) break
        now = due.at
        due.live = false
        due.fn()
        await settled()
      }
      now = until
    },
    get now() {
      return now
    },
  }
}

/** One socket a window opened to a `handServer`, with the server's end in the test's hand. */
export interface HandSocket {
  url: URL
  /** When, on the hand clock, it was opened. */
  at: number
  /** Everything the window said on it, in order. */
  heard: JsonRpcFrame[]
  /** The methods of `heard`, which is most of what a test asks of it. */
  readonly methods: string[]
  send(frame: JsonRpcFrame): void
  reply(id: number, result: unknown): void
  refuse(id: number, code: number, message: string): void
  /** The server's end going away, as a crash or a network does. */
  drop(): void
}

/**
 * A match server as a window meets it: every socket it opens, when, by which
 * url, and everything said on it. `answer` is how the server takes each
 * request, as it arrives; left unset, nobody answers. `down` closes a socket
 * the moment it says hello.
 */
export interface HandServer {
  sockets: HandSocket[]
  down: boolean
  answer: ((socket: HandSocket, request: JsonRpcRequest) => void) | null
  /**
   * How the server tells its time (`clock/now`), which every window asks as
   * its socket opens: the hand clock unless a test says otherwise. Kept out
   * of `heard`, like the answer to it, so a test about something else lists
   * only what it is about.
   */
  tellTime: (socket: HandSocket, request: JsonRpcRequest) => void
  connect(url: string): Transport
  readonly last: HandSocket
}

export function handServer(clock: HandClock): HandServer {
  const sockets: HandSocket[] = []
  const server: HandServer = {
    sockets,
    down: false,
    answer: null,
    tellTime: (socket, request) => socket.reply(request.id as number, { now: clock.now }),
    connect: (url: string): Transport => {
      const [ours, theirs] = loopback()
      const socket: HandSocket = {
        url: new URL(url),
        at: clock.now,
        heard: [],
        get methods() {
          return socket.heard.map((frame) => ('method' in frame ? frame.method : '<response>'))
        },
        send: (frame) => theirs.send(frame),
        reply: (id, result) => theirs.send({ jsonrpc: '2.0', id, result }),
        refuse: (id, code, message) => theirs.send({ jsonrpc: '2.0', id, error: { code, message } }),
        drop: () => theirs.close(),
      }
      theirs.onFrame((frame) => {
        if ('method' in frame && frame.method === 'tictac/api/clock/now') {
          server.tellTime(socket, frame as JsonRpcRequest)
          return
        }
        socket.heard.push(frame)
        if (!('method' in frame)) return
        if (frame.method === RpcMethods.hello) {
          if (server.down) socket.drop()
          return
        }
        if ('id' in frame && typeof frame.id === 'number') server.answer?.(socket, frame as JsonRpcRequest)
      })
      sockets.push(socket)
      return ours
    },
    get last(): HandSocket {
      return sockets[sockets.length - 1]!
    },
  }
  return server
}
