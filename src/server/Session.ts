import { SPEED_KMH, type LatLng, type Pace } from '../core/Travel'
import { RpcMethods, type JsonRpcFrame, type JsonRpcNotification, type JsonRpcRequest } from '../game/JsonRpc'
import type { ServerIntent } from '../game/Lobby'
import { RPC_ERRORS, type RosterEntry, type RpcMethod, type RpcResult, type SignedIn, type SquadOrder } from '../game/Rpc'
import type { Transport } from '../game/Transport'
import { OLDEST_SERVED_PROTOCOL, SERVER_VOICES, versionRefusal, type PeerVersion } from '../version'
import { Refusal, type Lobby } from './Lobby'
import type { Persistence } from './Persistence'
import type { Journeys } from './Journeys'
import type { Client } from './Room'
import type { RosterMember } from './Rosters'
import { AuthError } from './WebAuthn'

/**
 * One socket per window, and everything the window asks over it
 * (`src/game/Rpc.ts`).
 *
 * A socket states its build first (`hello`), and is version-gated on it
 * exactly as before. After that it asks: requests with ids, each answered
 * once, in the order they arrived — sign in, read the roster, subscribe to
 * the lobby, enter a room and leave it again. A request turned down is an
 * error response with a reason the player can read, and the socket stays
 * open; only the gate, and a newer window of the same player
 * (`session/replaced`), close one. Frames of the match itself are
 * notifications, as they always were, and go to the room the socket is in.
 *
 * What a socket *is* to the rooms — its player, its seat — is the lobby's
 * (`Client`, `Lobby`); what is here is the conversation: the gate, the
 * dispatch, which account signed in and with which token, and where the
 * connection came from.
 *
 * Free of anything only one host has, so the Bun server and the Durable
 * Object attach their sockets to the same thing.
 */

/** What a host knows about a socket from the request that opened it. */
export interface Upgrade {
  /** The url it was opened at. Read for nothing but a protocol-6 page's keyed resume (`resumeOf6`). */
  url: string
  /** Where it came from, when the host can say (`request.cf` on Cloudflare); never on the Bun server. */
  place?: LatLng | null
}

export interface SessionsOptions {
  lobby: Lobby
  /** The accounts and rosters asked about over a socket. */
  persistence: Pick<Persistence, 'accounts' | 'rosters' | 'squads'>
  /** Squads on the move: the orders a window gives. */
  journeys: Journeys
  /** The clock travel runs by (`clock/now`); the wall clock unless a host or a test says otherwise. */
  now?: () => number
  /** Called for anything worth a line in a server log. */
  log?: (message: string) => void
}

/** One socket's half of the conversation, beyond what the lobby keeps of it. */
interface Session {
  readonly client: Client
  /** The account this socket signed in as, and the token that proved it — what `signOut` revokes. */
  account: SignedIn | null
  /**
   * Where the connection came from, when its host could tell: what a new
   * player's squad is placed near (`Squads`), read off the socket rather than
   * off anything the page says, and written down nowhere.
   */
  readonly place: LatLng | null
  /** The seat a protocol-6 page's url takes back. Goes with protocol 6 (`resume6`). */
  readonly resume6: { roomId: string; seatKey: string } | null
  /** Every request not yet answered, one after another: each starts when the one before it is done. */
  queue: Promise<void>
}

type Fields = Record<string, unknown>

/** Answers one method: reads its params, and answers by calling `reply` with its result. */
type Handler<M extends RpcMethod> = (
  session: Session,
  params: Fields,
  reply: (result: RpcResult<M>) => void,
) => Promise<void> | void

const HELLO_FIRST = 'This page has to state its version before it asks the match server anything. Reload the page.'
const NO_INTENT = 'That request does not say which match to open, join or watch.'
const SIGN_IN_FIRST = 'sign in first'
const EXPIRED = 'that sign-in has expired; sign in again'
const FAILED = 'the server failed'

export class Sessions {
  private readonly lobby: Lobby
  private readonly persistence: Pick<Persistence, 'accounts' | 'rosters' | 'squads'>
  private readonly journeys: Journeys
  private readonly now: () => number
  private readonly log: (message: string) => void

  constructor(options: SessionsOptions) {
    this.lobby = options.lobby
    this.persistence = options.persistence
    this.journeys = options.journeys
    this.now = options.now ?? (() => Date.now())
    this.log = options.log ?? ((message) => console.info(`[session] ${message}`))
  }

  /** Take a socket: everything it says from now on, until it closes. */
  attach(transport: Transport, upgrade: Upgrade): void {
    const client: Client = { transport, player: null, version: null, room: null, faction: null, gone: false }
    const session: Session = {
      client,
      account: null,
      place: upgrade.place ?? null,
      resume6: resumeOf6(upgrade.url),
      queue: Promise.resolve(),
    }
    this.lobby.arrive(client)
    transport.onFrame((frame) => this.receive(session, frame))
    transport.onClosed((reason) => this.lobby.closed(client, reason))
  }

  private receive(session: Session, frame: JsonRpcFrame): void {
    const { client } = session
    // A response from a window answers nothing this server asked.
    if (client.gone || !('method' in frame) || typeof frame.method !== 'string') return
    if ('id' in frame) return this.request(session, frame)
    if (!client.version) return this.gate(session, frame)
    this.lobby.receive(client, frame)
  }

  /**
   * The version gate, on a socket's first word.
   *
   * Before it is admitted, the only thing a socket can usefully say is which
   * build it is. The gate comes before anything else: a client on another
   * build diverges for innocent reasons, and a referee that accused it would
   * be naming somebody whose browser cached yesterday's bundle. Stated in the
   * server's own voice, because the reader is the client being turned away
   * and needs to see both hashes: a Worker deployed without its build id says
   * `dev` here, which is a server to redeploy rather than a page to reload.
   * An `init` is gated too, since an older client opens with one.
   */
  private gate(session: Session, frame: JsonRpcNotification): void {
    if (frame.method !== RpcMethods.hello && frame.method !== RpcMethods.init) return
    const stated = frame.params
    const refusal = this.admission(session, stated)
    if (refusal) return this.lobby.turnAway(session.client, refusal)
    if (frame.method !== RpcMethods.hello) return
    // Both fields were read and checked by the gate a line ago.
    session.client.version = { protocol: Number(stated.protocol), build: String(stated.build) }
    if (session.client.version.protocol < this.lobby.version.protocol) void this.resume6(session)
  }

  /**
   * Why a socket is turned away by what it `stated` about itself, or null
   * to admit it.
   *
   * This server's protocol is admitted at any build: a page still running
   * the build before a deploy has a match to finish here, so what a page may
   * start is weighed when it asks (`Lobby.enter`), not here. The protocol
   * before (`OLDEST_SERVED_PROTOCOL`) is admitted only to take back the seat
   * its url names — the one thing a protocol-6 page could still be doing.
   */
  private admission(session: Session, stated: unknown): string | null {
    const mine = this.lobby.version
    const refusal = versionRefusal(stated, mine, SERVER_VOICES)
    if (!refusal || typeof stated !== 'object' || stated === null) return refusal
    const { protocol, build } = stated as Partial<PeerVersion>
    if (typeof build !== 'string' || build.length === 0) return refusal
    if (protocol === mine.protocol) return null
    const served = typeof protocol === 'number' && protocol >= OLDEST_SERVED_PROTOCOL && protocol < mine.protocol
    return served && session.resume6 ? null : refusal
  }

  /**
   * A protocol-6 page taking its seat back with the key in its url, the way
   * protocol 6 always did it: answered with a `seated` notification and the
   * log, or turned away with an `abort` it can show.
   *
   * Served for one release, so that a match in progress when protocol 7 was
   * deployed finishes across that deploy. Delete this, the branch of `gate`
   * that calls it, `resumeOf6`, `Upgrade.url` and the protocol-6 branch of
   * `Lobby.replace` once `OLDEST_SERVED_PROTOCOL` reaches 7.
   */
  private async resume6(session: Session): Promise<void> {
    const { client, resume6 } = session
    try {
      await this.lobby.enter(client, { kind: 'resume', ...resume6! }, (seated) =>
        client.transport.send({ jsonrpc: '2.0', method: RpcMethods.seated, params: { ...seated } }),
      )
    } catch (error) {
      if (!(error instanceof Refusal)) {
        this.log(`a protocol-6 resume failed: ${error instanceof Error ? error.stack : String(error)}`)
      }
      this.lobby.turnAway(client, error instanceof Refusal ? error.message : FAILED)
    }
  }

  /**
   * One request: answered exactly once, after every request before it on
   * the same socket — so a window may ask to sign in and then to enter a
   * room without waiting, and the room is entered signed in.
   */
  private request(session: Session, frame: JsonRpcRequest): void {
    const { transport } = session.client
    const { id, method } = frame
    if (typeof id !== 'number' && typeof id !== 'string') {
      transport.send({
        jsonrpc: '2.0',
        id: null,
        error: { code: RPC_ERRORS.invalidRequest, message: 'That request has no usable id.' },
      })
      return
    }
    let answered = false
    const reply = (result: unknown): void => {
      if (answered) return
      answered = true
      transport.send({ jsonrpc: '2.0', id, result })
    }
    const fail = (code: number, message: string): void => {
      if (answered) return
      answered = true
      transport.send({ jsonrpc: '2.0', id, error: { code, message } })
    }
    if (!session.client.version) return fail(RPC_ERRORS.helloFirst, HELLO_FIRST)
    if (!Object.hasOwn(this.handlers, method)) {
      return fail(RPC_ERRORS.noSuchMethod, `The match server does not answer ${method}. Reload the page.`)
    }
    const handler = this.handlers[method as RpcMethod] as Handler<RpcMethod>
    session.queue = session.queue.then(async () => {
      if (session.client.gone) return
      try {
        await handler(session, fields(frame.params), reply)
      } catch (error) {
        if (error instanceof Refusal) return fail(error.code, error.message)
        if (error instanceof AuthError) {
          return fail(error.status === 401 ? RPC_ERRORS.signInFirst : RPC_ERRORS.badInput, error.message)
        }
        // Anything else is this server's fault, and the player is told nothing
        // about it beyond that: an internal message is an invitation to probe.
        this.log(`${method} failed: ${error instanceof Error ? error.stack : String(error)}`)
        fail(RPC_ERRORS.serverFailed, FAILED)
      }
    })
  }

  private readonly handlers: { [M in RpcMethod]: Handler<M> } = {
    'tictac/api/account/registerOptions': async (_session, params, reply) => {
      reply(await this.persistence.accounts.registrationOptions(text(params, 'name')))
    },
    'tictac/api/account/registerVerify': async (session, params, reply) => {
      const minted = await this.persistence.accounts.register({
        challengeId: text(params, 'challengeId'),
        credentialId: text(params, 'credentialId'),
        clientDataJSON: text(params, 'clientDataJSON'),
        authenticatorData: text(params, 'authenticatorData'),
        publicKey: text(params, 'publicKey'),
        publicKeyAlgorithm: number(params, 'publicKeyAlgorithm'),
      }, session.place)
      reply(await this.adopt(session, minted))
    },
    'tictac/api/account/loginOptions': async (_session, _params, reply) => {
      reply(await this.persistence.accounts.loginOptions())
    },
    'tictac/api/account/loginVerify': async (session, params, reply) => {
      const minted = await this.persistence.accounts.login({
        challengeId: text(params, 'challengeId'),
        credentialId: text(params, 'credentialId'),
        clientDataJSON: text(params, 'clientDataJSON'),
        authenticatorData: text(params, 'authenticatorData'),
        signature: text(params, 'signature'),
      })
      reply(await this.adopt(session, minted))
    },
    'tictac/api/account/signIn': async (session, params, reply) => {
      const token = text(params, 'token')
      const player = await this.persistence.accounts.playerFor(token)
      if (!player) throw new Refusal(RPC_ERRORS.signInFirst, EXPIRED)
      this.lobby.bind(session.client, player)
      session.account = { token, player }
      reply({ player })
    },
    'tictac/api/account/signOut': async (session, _params, reply) => {
      const account = signedIn(session)
      await this.persistence.accounts.logout(account.token)
      session.account = null
      this.lobby.unbind(session.client)
      reply(null)
    },
    'tictac/api/account/me': (session, _params, reply) => {
      reply({ player: session.account?.player ?? null })
    },
    'tictac/api/roster/list': async (session, _params, reply) => {
      const members = await this.persistence.rosters.active(signedIn(session).player.id)
      reply({ roster: members.map(entry) })
    },
    'tictac/api/roster/recruit': async (session, _params, reply) => {
      reply({ member: entry(await this.persistence.rosters.recruit(signedIn(session).player.id)) })
    },
    'tictac/api/squad/get': async (session, _params, reply) => {
      reply({ squad: await this.persistence.squads.ensure(signedIn(session).player.id, session.place) })
    },
    'tictac/api/clock/now': (_session, _params, reply) => {
      reply({ now: this.now() })
    },
    'tictac/api/squad/order': async (session, params, reply) => {
      const player = signedIn(session).player
      reply({ squad: await this.journeys.order(player.id, session.place, orderOf(params.order)) })
    },
    'tictac/api/lobby/subscribe': (session, _params, reply) => {
      reply(this.lobby.subscribe(session.client))
    },
    'tictac/api/lobby/unsubscribe': (session, _params, reply) => {
      this.lobby.unsubscribe(session.client)
      reply(null)
    },
    'tictac/api/room/enter': (session, params, reply) => this.lobby.enter(session.client, intentOf(params.intent), reply),
    'tictac/api/room/leave': (session, _params, reply) => {
      this.lobby.leave(session.client)
      reply(null)
    },
  }

  /**
   * Bind the socket to a session a passkey ceremony just started. One this
   * socket may not be bound to (`Lobby.bind`) is revoked on the spot, rather
   * than left behind with nobody holding its token.
   */
  private async adopt(session: Session, minted: SignedIn): Promise<SignedIn> {
    try {
      this.lobby.bind(session.client, minted.player)
    } catch (error) {
      await this.persistence.accounts.logout(minted.token)
      throw error
    }
    session.account = minted
    return minted
  }
}

/** The account a request needs, or the refusal a window that has none is answered with. */
function signedIn(session: Session): SignedIn {
  if (!session.account) throw new Refusal(RPC_ERRORS.signInFirst, SIGN_IN_FIRST)
  return session.account
}

/** What a window is shown of a roster member: never the combat log or growth it cannot act on here. */
function entry({ characterId, slot, sheet, hp, fatigue, downtime }: RosterMember): RosterEntry {
  return { characterId, slot, sheet, hp, fatigue, downtime }
}

/** A request's params, which must be an object when present at all. */
function fields(params: unknown): Fields {
  if (params === undefined) return {}
  if (typeof params !== 'object' || params === null || Array.isArray(params)) {
    throw new Refusal(RPC_ERRORS.invalidParams, 'the request params are not an object')
  }
  return params as Fields
}

function text(params: Fields, key: string): string {
  const value = params[key]
  if (typeof value !== 'string') throw new Refusal(RPC_ERRORS.invalidParams, `missing ${key}`)
  return value
}

function number(params: Fields, key: string): number {
  const value = params[key]
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Refusal(RPC_ERRORS.invalidParams, `missing ${key}`)
  }
  return value
}

/** A room id or seat key fit to look up: present, and no longer than any this server mints. */
function usable(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 64
}

/** The intent a `room/enter` states. Peer input: checked, not trusted. */
function intentOf(value: unknown): ServerIntent {
  const intent = (typeof value === 'object' && value !== null ? value : {}) as Fields
  switch (intent.kind) {
    case 'open':
      return { kind: 'open' }
    case 'join':
    case 'watch':
      if (usable(intent.roomId)) return { kind: intent.kind, roomId: intent.roomId }
      break
    case 'resume':
      // Both or neither: a room without its key proves nothing, and a key
      // without its room names nothing.
      if (intent.roomId == null && intent.seatKey == null) return { kind: 'resume' }
      if (usable(intent.roomId) && usable(intent.seatKey)) {
        return { kind: 'resume', roomId: intent.roomId, seatKey: intent.seatKey }
      }
      break
  }
  throw new Refusal(RPC_ERRORS.invalidParams, NO_INTENT)
}

/**
 * The seat a protocol-6 page's url asks to take back
 * (`?intent=resume&room=…&seat=…`), or null for any other url. Goes with
 * protocol 6 (`Sessions.resume6`).
 */
function resumeOf6(url: string): { roomId: string; seatKey: string } | null {
  const params = URL.parse(url)?.searchParams
  if (params?.get('intent') !== 'resume') return null
  const roomId = params.get('room')
  const seatKey = params.get('seat')
  return usable(roomId) && usable(seatKey) ? { roomId, seatKey } : null
}

/** The order a `squad/order` states. Peer input: checked, not trusted. */
function orderOf(value: unknown): SquadOrder {
  const order = (typeof value === 'object' && value !== null ? value : {}) as Fields
  switch (order.kind) {
    case 'goHere':
    case 'goHereNow':
      return { kind: order.kind, to: placeIn(order.to), pace: paceOf(order.pace) }
    case 'goHereFirst':
    case 'goHereNext':
      return { kind: order.kind, to: placeIn(order.to) }
    case 'stop':
      return { kind: 'stop' }
    default:
      throw new Refusal(RPC_ERRORS.invalidParams, 'That order is not one a squad takes.')
  }
}

/** A point on the map: finite, latitude within ±90, longitude within ±180. */
function placeIn(value: unknown): LatLng {
  const point = (typeof value === 'object' && value !== null ? value : {}) as Fields
  const { lat, lng } = point
  const usable =
    typeof lat === 'number' && typeof lng === 'number' && Math.abs(lat) <= 90 && Math.abs(lng) <= 180
  if (!usable) throw new Refusal(RPC_ERRORS.invalidParams, 'That order does not say where on the map.')
  return { lat, lng }
}

function paceOf(value: unknown): Pace {
  if (typeof value === 'string' && Object.hasOwn(SPEED_KMH.foot, value)) return value as Pace
  throw new Refusal(RPC_ERRORS.invalidParams, 'That order does not say how fast: cautious, normal or flat out.')
}
