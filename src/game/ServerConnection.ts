import { MY_VERSION } from '../version'
import { type JsonRpcFrame, type JsonRpcNotification, RpcMethods } from './JsonRpc'
import type { LobbyView, Seated, ServerIntent } from './Lobby'
import {
  RPC_ERRORS,
  SESSION_REPLACED,
  type Player,
  type RpcMethod,
  type RpcParams,
  type RpcPushes,
  type RpcResult,
  type SignedIn,
} from './Rpc'
import { SocketTransport } from './SocketTransport'
import type { Transport } from './Transport'

/**
 * A window's one socket to its match server (`ITEM-060`, `src/game/Rpc.ts`).
 *
 * Opened when the window needs the server — the server panel opening — and
 * kept until the window leaves it: signing in, the roster, the lobby and the
 * room it plays or watches in all travel over it. It outlives every drop it
 * can: a socket that closes under it is dialled again, and on the new one the
 * window is put back exactly where it was — signed in, subscribed, seated.
 *
 * Refusals are answers, not endings. A room that is gone, a token the server
 * no longer honours, a roster that is full: each is an error response the
 * caller shows, and the socket stays up. Only three things end it: the
 * version gate, the window being replaced by a newer one of its player, and
 * the window giving up after a drop.
 */

/**
 * How long a window waits before each try at getting back after a drop, in
 * order; the last is repeated until it gives up. Quick at first, because the
 * usual cause is a server restarting under a deploy, which takes about a
 * second.
 *
 * Capped at one second rather than backing off further: the stall a player
 * sees is however long the server was away *plus* the wait that happens to
 * be running when it comes back, and a try against a server that is down is
 * a refused connection that costs nobody anything. A 4 s cap measured as up
 * to four extra seconds on the reconnecting banner after the server was
 * already back.
 */
export const RECONNECT_DELAYS_MS: readonly number[] = [250, 500, 1000]

/**
 * How long a window keeps trying before it calls the connection lost: the
 * server's grace for a dropped seat (`GRACE_MS`), after which there is no
 * seat to take back.
 */
export const RECONNECT_GIVE_UP_MS = 120_000

/**
 * One try that has not been put back where it was by now is abandoned for the
 * next. A socket to a host that has gone quiet can sit in `CONNECTING` far
 * longer than the whole backoff — and so can one accepted by a proxy while
 * the server behind it is still booting, which is exactly a deploy. A healthy
 * server answers the whole way back in well under a second; at 5 s, a try
 * that happened to start just before the server came back measured as five
 * extra seconds of reconnecting banner.
 */
const ATTEMPT_TIMEOUT_MS = 2000

/**
 * How long a request may go unanswered, and how long a window's very first
 * socket may take to open. Longer than a reconnect try because nothing is
 * stalled behind it but the one thing the player asked for, and a server
 * that has just been woken can take a few seconds to answer the first time.
 */
export const REQUEST_TIMEOUT_MS = 10_000

/** What the player is told once a window has stopped trying to get back to its server. */
export const CONNECTION_LOST = 'Lost the connection to the match server.'

/** What a window's first socket failing to open says: there is nothing there to be refused by. */
export const UNREACHABLE = 'No match server answers at that address.'

/** A request the server never answered. */
export const NO_ANSWER = 'The match server did not answer.'

/** A request whose socket went before its answer came. */
const DROPPED = 'The connection to the match server dropped.'

/** The window's own decision to leave the server: nobody is shown this. */
const LEFT = 'This window left the match server.'

/** An error the server answered with: its words, and the code they came under (`RPC_ERRORS`). */
export class RpcError extends Error {
  constructor(
    message: string,
    readonly code: number,
  ) {
    super(message)
  }
}

/** Where a window keeps its session token for one server. */
export interface TokenStore {
  get(): string | null
  set(token: string | null): void
}

/**
 * The browser's `localStorage`, keyed by the server's origin over HTTP —
 * the key a token has always been kept under — because two servers are two
 * different sets of people.
 */
export function browserTokens(url: string): TokenStore {
  const parsed = new URL(url)
  const protocol = parsed.protocol === 'wss:' ? 'https:' : parsed.protocol === 'ws:' ? 'http:' : parsed.protocol
  const key = `tictac.session:${protocol}//${parsed.host}`
  return {
    get: () => localStorage.getItem(key),
    set: (token) => (token === null ? localStorage.removeItem(key) : localStorage.setItem(key, token)),
  }
}

/** A token kept in memory only, for a window with nowhere to keep one: a test, a headless match. */
export function heldTokens(token: string | null = null): TokenStore {
  let held = token
  return {
    get: () => held,
    set: (next) => {
      held = next
    },
  }
}

/** What a connection is made of beyond itself; the defaults are the browser's. */
export interface ServerLink {
  /** Open a socket to `url`. */
  connect?: (url: string) => Transport
  /** Run `fn` in `ms`; returns what cancels it. */
  schedule?: (fn: () => void, ms: number) => () => void
  /** How long to keep trying to get back after a drop (`RECONNECT_GIVE_UP_MS`). */
  giveUpMs?: number
  tokens?: TokenStore
}

export type ConnectionState =
  /** The window's first socket, on its way to being open. */
  | { kind: 'connecting' }
  | { kind: 'open' }
  /** The socket dropped; this is try `attempt` at getting back. */
  | { kind: 'reconnecting'; attempt: number }
  /** For good, and why. */
  | { kind: 'closed'; reason: string }

/**
 * Whoever sits in the room a connection entered for them — `NetworkManager` —
 * as the connection needs them across a drop.
 */
export interface RoomMember {
  /** What takes this window back to its place: its seat by key, or watching again. */
  rejoin(): ServerIntent
  /**
   * Where the server put this window: on entering, and again on every way
   * back. Called as the answer is read, so before any frame that follows it —
   * the `log` of a match being played comes straight after.
   */
  seated(seat: Seated): void
  /** The socket dropped and this is try `attempt` at getting back; nothing sent now arrives. */
  dropped(attempt: number): void
}

type Outcome<T> = { ok: true; result: T } | { ok: false; error: Error }

/** One socket, from being dialled to being let go of. */
interface Socket {
  transport: Transport
  /** Requests on this socket awaiting their one answer, by id. */
  pending: Map<number, (outcome: Outcome<unknown>) => void>
  /** Whether the lobby subscription is live on this socket. */
  lobby: boolean
  /**
   * Whether a `room/enter` has been answered on this socket. Before that, an
   * `abort` can only be the version gate turning the window away; after it,
   * it is the room's.
   */
  entered: boolean
  /** Let go of: nothing it says is read again. */
  done: boolean
  cancelDeadline: (() => void) | null
}

/** A room this window is in, or is asking to be. */
interface Room {
  member: RoomMember
  frames: ((frame: JsonRpcFrame) => void)[]
  closers: ((reason: string) => void)[]
  /** Set once the server has put the window in it; until then a refusal or a drop is a failure to enter. */
  seated: boolean
  /** The socket the room is live on: match frames go out on nothing else. */
  socket: Socket | null
}

export class ServerConnection {
  private readonly connect: (url: string) => Transport
  private readonly schedule: (fn: () => void, ms: number) => () => void
  private readonly giveUpMs: number
  private readonly tokens: TokenStore

  private current: ConnectionState = { kind: 'connecting' }
  /** Whether any socket has been open: only one that was can be dialled again. */
  private everOpen = false
  private socket: Socket | null = null
  private lastId = 0
  /** Asked for while there was no open socket to ask on, in the order they were asked. */
  private readonly waiters: PromiseWithResolvers<Socket>[] = []
  private attempt = 0
  private cancelRetry: (() => void) | null = null
  private cancelGiveUp: (() => void) | null = null
  private room: Room | null = null
  private readonly lobbyListeners = new Set<(view: LobbyView) => void>()
  private readonly squadListeners = new Set<(pushed: RpcPushes['tictac/api/squad/changed']) => void>()
  private lobbyView: LobbyView | null = null
  private readonly listeners = new Set<() => void>()

  /** Who this socket is bound to, by the server's own answer. */
  player: Player | null = null
  /**
   * Why the stored token did not sign this window in, when the reason is not
   * that the server forgot it (that token is simply dropped): the player's
   * match is in a room this page's build cannot carry on.
   */
  signInRefused: string | null = null

  constructor(
    /** The server's plain url: nothing about who is asking or what for rides in it. */
    readonly url: string,
    link: ServerLink = {},
  ) {
    this.connect = link.connect ?? ((target) => new SocketTransport(new WebSocket(target)))
    this.schedule =
      link.schedule ??
      ((fn, ms) => {
        const timer = setTimeout(fn, ms)
        return () => clearTimeout(timer)
      })
    this.giveUpMs = link.giveUpMs ?? RECONNECT_GIVE_UP_MS
    this.tokens = link.tokens ?? browserTokens(url)
    this.dial()
  }

  get state(): ConnectionState {
    return this.current
  }

  /** Hear about every change of state or of who this window is signed in as; returns what stops it. */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /**
   * Ask the server something, once the socket is open. Rejects with an
   * `RpcError` carrying the server's own words for a refusal, and with a
   * plain `Error` for a request that never got an answer — the socket went,
   * or nothing came within `REQUEST_TIMEOUT_MS`.
   */
  request<M extends RpcMethod>(method: M, params: RpcParams<M>): Promise<RpcResult<M>> {
    const { promise, resolve, reject } = Promise.withResolvers<RpcResult<M>>()
    let asked: { socket: Socket; id: number } | null = null
    const cancel = this.schedule(() => {
      asked?.socket.pending.delete(asked.id)
      reject(new Error(NO_ANSWER))
    }, REQUEST_TIMEOUT_MS)
    this.whenOpen().then(
      (socket) => {
        const id = this.ask(socket, method, params, (outcome) => {
          cancel()
          if (outcome.ok) resolve(outcome.result)
          else reject(outcome.error)
        })
        asked = { socket, id }
      },
      (error: Error) => {
        cancel()
        reject(error)
      },
    )
    return promise
  }

  /**
   * The lobby as it is now and every time it changes, pushed by the server
   * (`lobby/subscribe`) — never polled. Returns what stops it; the
   * subscription itself ends with its last listener.
   */
  watchLobby(listener: (view: LobbyView) => void): () => void {
    this.lobbyListeners.add(listener)
    if (this.lobbyListeners.size === 1) {
      // Asked now if the socket is open; otherwise the way to open asks it.
      if (this.current.kind === 'open' && this.socket) this.subscribeOn(this.socket).catch(warnLobby)
    } else if (this.lobbyView) {
      listener(this.lobbyView)
    }
    return () => {
      if (!this.lobbyListeners.delete(listener) || this.lobbyListeners.size > 0) return
      this.lobbyView = null
      const socket = this.socket
      if (socket?.lobby && this.current.kind === 'open') {
        socket.lobby = false
        this.ask(socket, 'tictac/api/lobby/unsubscribe', {}, () => {})
      }
    }
  }

  /**
   * Every new route the server pushes for this player's squad
   * (`squad/changed`): an order from any of their windows, or an arrival.
   * Returns what stops it. Nothing to subscribe to: the server pushes to the
   * player's window regardless.
   */
  watchSquad(listener: (pushed: RpcPushes['tictac/api/squad/changed']) => void): () => void {
    this.squadListeners.add(listener)
    return () => this.squadListeners.delete(listener)
  }

  /**
   * A passkey ceremony made this socket somebody (`registerVerify`,
   * `loginVerify` already bound it on the server): keep the token, so every
   * socket this window opens from now on presents it.
   */
  signedIn(signed: SignedIn): void {
    this.tokens.set(signed.token)
    this.identify(signed.player, null)
  }

  /** The session is over; this window is anonymous on every socket from now on. */
  signedOut(): void {
    this.tokens.set(null)
    this.identify(null, null)
  }

  /**
   * Take a seat or a spectator's place (`room/enter`), and keep it across
   * drops: after one, the room is entered again with `member.rejoin()` once
   * the window is signed in and subscribed again.
   *
   * The answer is `member.seated`; the room's own frames — the match — reach
   * whoever listens on the returned channel, which is how a `NetworkManager`
   * plays over this socket exactly as over a data channel. Its `onClosed`
   * fires once the place is gone for good: refused on the way in or back,
   * the connection given up on or replaced. Its `close` is the window standing
   * up (`room/leave`), and fires nothing.
   */
  enter(intent: ServerIntent, member: RoomMember): Transport {
    if (this.room) this.leave(this.room)
    const room: Room = { member, frames: [], closers: [], seated: false, socket: null }
    this.room = room
    const cancel = this.schedule(() => {
      if (!room.seated) this.lose(room, NO_ANSWER)
    }, REQUEST_TIMEOUT_MS)
    this.whenOpen().then(
      (socket) => {
        if (this.room !== room) return
        this.askToEnter(socket, room, intent, cancel, (error) => {
          cancel()
          this.lose(room, error.message)
        })
      },
      (error: Error) => {
        cancel()
        this.lose(room, error.message)
      },
    )
    return {
      send: (frame) => {
        const live = room.socket
        if (live && live === this.socket && !live.done) live.transport.send(frame)
      },
      onFrame: (handler) => room.frames.push(handler),
      onClosed: (handler) => room.closers.push(handler),
      close: () => this.leave(room),
    }
  }

  /** Leave the server: the socket closes and is not dialled again. */
  close(): void {
    this.terminate(LEFT)
  }

  private changed(): void {
    for (const listener of this.listeners) listener()
  }

  private setState(next: ConnectionState): void {
    this.current = next
    this.changed()
  }

  private identify(player: Player | null, refused: string | null): void {
    this.player = player
    this.signInRefused = refused
    this.changed()
  }

  /** Send a request on `socket`; `settle` is called as its answer is read, before any frame after it. */
  private ask<M extends RpcMethod>(
    socket: Socket,
    method: M,
    params: RpcParams<M>,
    settle: (outcome: Outcome<RpcResult<M>>) => void,
  ): number {
    const id = ++this.lastId
    socket.pending.set(id, settle as (outcome: Outcome<unknown>) => void)
    socket.transport.send({ jsonrpc: '2.0', id, method, params: params as Record<string, unknown> })
    return id
  }

  private call<M extends RpcMethod>(socket: Socket, method: M, params: RpcParams<M>): Promise<RpcResult<M>> {
    const { promise, resolve, reject } = Promise.withResolvers<RpcResult<M>>()
    this.ask(socket, method, params, (outcome) => (outcome.ok ? resolve(outcome.result) : reject(outcome.error)))
    return promise
  }

  private whenOpen(): Promise<Socket> {
    if (this.current.kind === 'open' && this.socket) return Promise.resolve(this.socket)
    if (this.current.kind === 'closed') return Promise.reject(new Error(this.current.reason))
    const waiter = Promise.withResolvers<Socket>()
    this.waiters.push(waiter)
    return waiter.promise
  }

  /** One socket, and the way back to where the window was on it. */
  private dial(): void {
    let transport: Transport
    try {
      transport = this.connect(this.url)
    } catch {
      // A url no socket can be opened to at all.
      this.retry()
      return
    }
    const socket: Socket = { transport, pending: new Map(), lobby: false, entered: false, done: false, cancelDeadline: null }
    this.socket = socket
    transport.onFrame((frame) => this.receive(socket, frame))
    transport.onClosed(() => {
      if (socket.done) return
      this.abandon(socket, DROPPED)
      this.retry()
    })
    // Armed before anything is said: a socket that answers its first word at
    // once must find this try's deadline there to cancel.
    socket.cancelDeadline = this.schedule(
      () => this.giveUpOn(socket),
      this.everOpen ? ATTEMPT_TIMEOUT_MS : REQUEST_TIMEOUT_MS,
    )
    this.establish(socket).then(
      () => {
        if (!socket.done) this.opened(socket)
      },
      () => this.giveUpOn(socket),
    )
  }

  /**
   * Put the window back where it was, in the one order that works: the
   * version first, because nothing is answered before it; who it is, because
   * the lobby's `you` and a seat's owner depend on it; the lobby, so the room
   * list is current the moment the banner goes; and its room last, whose
   * answer is followed by the match itself.
   */
  private async establish(socket: Socket): Promise<void> {
    socket.transport.send({ jsonrpc: '2.0', method: RpcMethods.hello, params: { ...MY_VERSION } })
    const token = this.tokens.get()
    if (token) await this.presentToken(socket, token)
    if (this.lobbyListeners.size > 0) {
      try {
        await this.subscribeOn(socket)
      } catch (error) {
        // A refusal is the server's answer and the way back goes on; a
        // socket that went is the end of the try.
        if (!(error instanceof RpcError)) throw error
        warnLobby(error)
      }
    }
    const room = this.room
    if (room?.seated) await this.reenter(socket, room)
  }

  private async presentToken(socket: Socket, token: string): Promise<void> {
    try {
      const { player } = await this.call(socket, 'tictac/api/account/signIn', { token })
      this.identify(player, null)
    } catch (error) {
      if (!(error instanceof RpcError)) throw error
      // A token the server no longer honours is forgotten. Any other refusal
      // keeps it: the player is still who it says, only this page cannot
      // take their match over, and a page that can still finish it should
      // find the token where it left it.
      const forgotten = error.code === RPC_ERRORS.signInFirst
      if (forgotten) this.tokens.set(null)
      this.identify(null, forgotten ? null : error.message)
    }
  }

  private subscribeOn(socket: Socket): Promise<void> {
    const { promise, resolve, reject } = Promise.withResolvers<void>()
    this.ask(socket, 'tictac/api/lobby/subscribe', {}, (outcome) => {
      if (!outcome.ok) {
        reject(outcome.error)
        return
      }
      if (this.lobbyListeners.size > 0) {
        socket.lobby = true
        this.showLobby(outcome.result)
      } else {
        // Everybody stopped listening while it was being asked.
        this.ask(socket, 'tictac/api/lobby/unsubscribe', {}, () => {})
      }
      resolve()
    })
    return promise
  }

  private showLobby(view: LobbyView): void {
    this.lobbyView = view
    for (const listener of this.lobbyListeners) listener(view)
  }

  /**
   * Ask for `room` on `socket`. The seat is taken as the answer is read —
   * not a microtask later — because the match's `log` is the very next frame,
   * and it has to find the window already seated.
   */
  private askToEnter(
    socket: Socket,
    room: Room,
    intent: ServerIntent,
    then: () => void,
    failed: (error: Error) => void,
  ): void {
    this.ask(socket, 'tictac/api/room/enter', { intent }, (outcome) => {
      if (this.room !== room) {
        // Left, or given up on, while asking: a place the server gave anyway
        // is stood up from at once, or this socket would be in a room nobody
        // is playing.
        if (outcome.ok && !socket.done) this.ask(socket, 'tictac/api/room/leave', {}, () => {})
        return
      }
      if (!outcome.ok) {
        failed(outcome.error)
        return
      }
      socket.entered = true
      room.seated = true
      room.socket = socket
      room.member.seated(outcome.result)
      then()
    })
  }

  /**
   * Back into the room after a drop. A refusal ends the room, not the try:
   * the server is there and has said where the window stands, which is in
   * its lobby.
   */
  private reenter(socket: Socket, room: Room): Promise<void> {
    const { promise, resolve, reject } = Promise.withResolvers<void>()
    this.askToEnter(socket, room, room.member.rejoin(), resolve, (error) => {
      if (!(error instanceof RpcError)) {
        reject(error)
        return
      }
      this.lose(room, error.message)
      resolve()
    })
    return promise
  }

  private opened(socket: Socket): void {
    socket.cancelDeadline?.()
    socket.cancelDeadline = null
    this.cancelGiveUp?.()
    this.cancelGiveUp = null
    this.attempt = 0
    this.everOpen = true
    this.setState({ kind: 'open' })
    for (const waiter of this.waiters.splice(0)) waiter.resolve(socket)
    // A listener that arrived after the way back had passed the lobby.
    if (this.lobbyListeners.size > 0 && !socket.lobby) this.subscribeOn(socket).catch(warnLobby)
  }

  private receive(socket: Socket, frame: JsonRpcFrame): void {
    if (socket.done) return
    if (!('method' in frame)) {
      if (typeof frame.id !== 'number') return
      const settle = socket.pending.get(frame.id)
      if (!settle) return
      socket.pending.delete(frame.id)
      if ('error' in frame) settle({ ok: false, error: new RpcError(frame.error.message, frame.error.code) })
      else settle({ ok: true, result: frame.result })
      return
    }
    const params = (frame as JsonRpcNotification).params
    switch (frame.method) {
      case 'tictac/api/session/replaced': {
        const { reason } = params as Partial<RpcPushes['tictac/api/session/replaced']>
        this.terminate(typeof reason === 'string' && reason.length > 0 ? reason : SESSION_REPLACED)
        return
      }
      case 'tictac/api/lobby/changed':
        if (socket.lobby && this.lobbyListeners.size > 0) this.showLobby(params as unknown as LobbyView)
        return
      case 'tictac/api/squad/changed':
        for (const listener of this.squadListeners) listener(params as unknown as RpcPushes['tictac/api/squad/changed'])
        return
    }
    if (frame.method === RpcMethods.abort && !socket.entered) {
      // The version gate: this page cannot talk to this server at all, and
      // dialling it again would be told the same.
      this.terminate(typeof params.reason === 'string' && params.reason.length > 0 ? params.reason : UNREACHABLE)
      return
    }
    const room = this.room
    // A relay for a room this window has left.
    if (!room || room.socket !== socket) return
    // The room is over on the server's side; the socket is not. Nothing is
    // left to re-enter after a drop, or to stand up from.
    if (frame.method === RpcMethods.abort) this.room = null
    for (const handler of room.frames) handler(frame)
  }

  /** Let go of `socket`: nothing it says is read again, and whatever was asked on it is told `reason`. */
  private abandon(socket: Socket, reason: string): void {
    socket.done = true
    socket.cancelDeadline?.()
    if (this.socket === socket) this.socket = null
    if (this.room?.socket === socket) this.room.socket = null
    const pending = [...socket.pending.values()]
    socket.pending.clear()
    const error = new Error(reason)
    for (const settle of pending) settle({ ok: false, error })
  }

  /** A try that did not get back in time, or failed on the way: closed from this side, which fires nothing. */
  private giveUpOn(socket: Socket): void {
    if (socket.done) return
    this.abandon(socket, DROPPED)
    socket.transport.close()
    this.retry()
  }

  private retry(): void {
    if (this.current.kind === 'closed') return
    // A server that never answered is not one to come back to; the address
    // is more likely wrong than the server away.
    if (!this.everOpen) {
      this.terminate(UNREACHABLE)
      return
    }
    this.cancelGiveUp ??= this.schedule(() => this.terminate(CONNECTION_LOST), this.giveUpMs)
    const delay = RECONNECT_DELAYS_MS[Math.min(this.attempt, RECONNECT_DELAYS_MS.length - 1)]!
    this.attempt++
    this.setState({ kind: 'reconnecting', attempt: this.attempt })
    if (this.room?.seated) this.room.member.dropped(this.attempt)
    this.cancelRetry = this.schedule(() => {
      this.cancelRetry = null
      this.dial()
    }, delay)
  }

  /** The window's place in `room` is gone, and why. */
  private lose(room: Room, reason: string): void {
    if (this.room === room) this.room = null
    room.socket = null
    const closers = room.closers.splice(0)
    for (const handler of closers) handler(reason)
  }

  /** Stand up from `room`: the window's own decision, so nothing is told. */
  private leave(room: Room): void {
    if (this.room !== room) return
    this.room = null
    const socket = room.socket
    room.socket = null
    room.closers.length = 0
    if (room.seated && socket && socket === this.socket && !socket.done) {
      this.ask(socket, 'tictac/api/room/leave', {}, () => {})
    }
  }

  /** The end of this connection, for good. */
  private terminate(reason: string): void {
    if (this.current.kind === 'closed') return
    this.cancelRetry?.()
    this.cancelGiveUp?.()
    this.cancelRetry = this.cancelGiveUp = null
    const socket = this.socket
    if (socket) {
      this.abandon(socket, reason)
      socket.transport.close()
    }
    this.lobbyView = null
    this.setState({ kind: 'closed', reason })
    const error = new Error(reason)
    for (const waiter of this.waiters.splice(0)) waiter.reject(error)
    if (this.room) this.lose(this.room, reason)
  }
}

/** A lobby subscription the server refused: a server bug, with nothing a player could do about it. */
function warnLobby(error: unknown): void {
  console.warn('[server] the lobby could not be subscribed to:', error)
}
