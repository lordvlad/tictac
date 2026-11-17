import { ENCOUNTER } from '../config'
import { SPEED_KMH, type LatLng, type Pace } from '../core/Travel'
import { RpcMethods, type JsonRpcFrame, type JsonRpcNotification, type JsonRpcRequest } from '../wire/JsonRpc'
import type { ServerIntent } from '../wire/Lobby'
import { RPC_ERRORS, type RosterEntry, type RpcMethod, type RpcResult, type SessionEnded, type SignedIn, type Squad, type SquadOrder } from '../wire/Rpc'
import type { Transport } from '../wire/Transport'
import type { StandingOrder } from '../wire/Rpc'
import { SERVER_VOICES, versionRefusal, type PeerVersion } from '../version'
import type { AccountsPort } from './AccountsPort'
import type { ServerClock } from './Clock'
import type { Crossings } from './Crossings'
import type { RegionPeers } from './Handover'
import { Refusal, type Lobby } from './Lobby'
import type { RegionStore } from './RegionStore'
import type { Journeys } from './Journeys'
import type { Client } from './Room'
import type { RosterMember } from './Rosters'
import { AuthError } from './WebAuthn'

/**
 * One socket per window, and everything the window asks over it
 * (`src/wire/Rpc.ts`).
 *
 * A socket states its build first (`hello`), and is version-gated on it
 * exactly as before. After that it asks: requests with ids, each answered
 * once, in the order they arrived — sign in, read the roster, subscribe to
 * the lobby, enter a room and leave it again. A request turned down is an
 * error response with a reason the player can read, and the socket stays
 * open; only the gate, and a newer window of the same player, close one —
 * each preceded by `session/ended` (`Lobby.end`). Frames of the match itself are
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
  /** Where it came from, when the host can say (`request.cf` on Cloudflare); never on the Bun server. */
  place?: LatLng | null
}

export interface SessionsOptions {
  lobby: Lobby
  /** Who a player is: signing in, passkeys, names. The directory's, wherever it lives. */
  accounts: AccountsPort
  /** What this region keeps for the players standing in it. */
  region: Pick<RegionStore, 'self' | 'rosters' | 'squads' | 'encounters' | 'matches' | 'enlist'>
  /** Squads on the move: the orders a window gives. */
  journeys: Journeys
  /** Squads crossing into and out of this region (RFC-0002): `region/arrive` and `region/cancelHandover`. */
  crossings: Pick<Crossings, 'arrive' | 'cancel' | 'expects'>
  /**
   * Where a window dials to reach another region (`RegionPeers.urlOf`), for the
   * player this region is not the home of. Unset on a host with no other
   * region, which then has nobody to send away.
   */
  peers?: Pick<RegionPeers, 'urlOf'>
  /** The host's one clock: what travel runs by (`clock/now`). */
  clock: ServerClock
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
  /**
   * Signed in at a region that is not the player's home, because a squad is
   * crossing to it (`Crossings.expects`): the window of a handover signs in at
   * the target before it arrives. Such a socket never enlists: the rows it
   * reads are the ones the handover wrote, and a handover that falls through
   * leaves it with nothing, not with a second squad.
   */
  visiting: boolean
  /** Every request not yet answered, one after another: each starts when the one before it is done. */
  queue: Promise<void>
}

/** Where a signed-in player belongs, from the region serving them (`Sessions.placed`). */
type Placement = { kind: 'home' } | { kind: 'visiting' } | { kind: 'elsewhere'; ended: SessionEnded }

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
  private readonly accounts: AccountsPort
  private readonly region: SessionsOptions['region']
  private readonly journeys: Journeys
  private readonly crossings: SessionsOptions['crossings']
  private readonly peers: SessionsOptions['peers']
  private readonly clock: ServerClock
  private readonly log: (message: string) => void

  constructor(options: SessionsOptions) {
    this.lobby = options.lobby
    this.accounts = options.accounts
    this.region = options.region
    this.journeys = options.journeys
    this.clock = options.clock
    this.crossings = options.crossings
    this.peers = options.peers
    this.log = options.log ?? ((message) => console.info(`[session] ${message}`))
  }

  /** Take a socket: everything it says from now on, until it closes. */
  attach(transport: Transport, upgrade: Upgrade): void {
    const client: Client = { transport, player: null, version: null, room: null, faction: null, gone: false }
    const session: Session = {
      client,
      account: null,
      place: upgrade.place ?? null,
      visiting: false,
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
   * The protocol gate, on a socket's first word.
   *
   * Before it is admitted, the only thing a socket can usefully say is which
   * build it is, so `hello` is the only first word accepted; anything else
   * (an `init`, as a client from before `hello` opened with) is turned away with the
   * same reload text as a client that stated nothing. The gate comes before
   * anything else: a client on another build diverges for innocent reasons,
   * and a referee that accused it would be naming somebody whose browser
   * cached yesterday's bundle. Stated in the server's own voice, because the
   * reader is the client being turned away and needs to see both hashes: a
   * Worker deployed without its build id says `dev` here, which is a server
   * to redeploy rather than a page to reload.
   */
  private gate(session: Session, frame: JsonRpcNotification): void {
    const admitted = this.admission(frame.method === RpcMethods.hello ? frame.params : undefined)
    if (typeof admitted === 'string') return this.lobby.end(session.client, { reason: admitted, reconnect: 'never' })
    session.client.version = admitted
  }

  /**
   * The version a socket is admitted as, from what it `stated` about itself,
   * or the reason it is turned away.
   *
   * This server's protocol is admitted at any build: a page still running
   * the build before a deploy has a match to finish here, so what a page may
   * start is weighed when it asks (`Lobby.enter`), not here. Any other
   * protocol is refused by the gate.
   */
  private admission(stated: unknown): PeerVersion | string {
    const mine = this.lobby.version
    const refusal = versionRefusal(stated, mine, SERVER_VOICES)
    if (refusal === null) return { ...mine }
    const { protocol, build } = typeof stated === 'object' && stated !== null ? (stated as Partial<PeerVersion>) : {}
    return typeof build === 'string' && build.length > 0 && protocol === mine.protocol ? { protocol, build } : refusal
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
      reply(await this.accounts.registrationOptions(text(params, 'name')))
    },
    'tictac/api/account/registerVerify': async (session, params, reply) => {
      // A new player's home is the region that serves their registration:
      // where the connection was routed by its place, and so where `adopt`
      // makes their roster and squad.
      const minted = await this.accounts.register(
        {
          challengeId: text(params, 'challengeId'),
          credentialId: text(params, 'credentialId'),
          clientDataJSON: text(params, 'clientDataJSON'),
          authenticatorData: text(params, 'authenticatorData'),
          publicKey: text(params, 'publicKey'),
          publicKeyAlgorithm: number(params, 'publicKeyAlgorithm'),
        },
        this.region.self,
      )
      await this.adopt(session, minted, reply)
    },
    'tictac/api/account/loginOptions': async (_session, _params, reply) => {
      reply(await this.accounts.loginOptions())
    },
    'tictac/api/account/loginVerify': async (session, params, reply) => {
      const minted = await this.accounts.login({
        challengeId: text(params, 'challengeId'),
        credentialId: text(params, 'credentialId'),
        clientDataJSON: text(params, 'clientDataJSON'),
        authenticatorData: text(params, 'authenticatorData'),
        signature: text(params, 'signature'),
      })
      await this.adopt(session, minted, reply)
    },
    'tictac/api/account/signIn': async (session, params, reply) => {
      const token = text(params, 'token')
      const player = await this.accounts.playerFor(token)
      if (!player) throw new Refusal(RPC_ERRORS.signInFirst, EXPIRED)
      const placed = await this.placed(player.id)
      if (placed.kind === 'elsewhere') {
        reply({ player })
        return this.lobby.end(session.client, placed.ended)
      }
      // Whoever's enlist failed after they registered is healed here, on the
      // first sign-in that finds their home region holding nothing of theirs.
      if (placed.kind === 'home') await this.region.enlist(player.id, session.place)
      session.visiting = placed.kind === 'visiting'
      this.lobby.bind(session.client, player)
      session.account = { token, player }
      reply({ player })
    },
    'tictac/api/account/signOut': async (session, _params, reply) => {
      const account = signedIn(session)
      await this.accounts.logout(account.token)
      session.account = null
      this.lobby.unbind(session.client)
      reply(null)
    },
    'tictac/api/account/me': (session, _params, reply) => {
      reply({ player: session.account?.player ?? null })
    },
    'tictac/api/roster/list': async (session, _params, reply) => {
      const { player } = signedIn(session)
      await this.kept(session)
      const members = await this.region.rosters.active(player.id)
      reply({ roster: members.map(entry) })
    },
    'tictac/api/roster/recruit': async (session, _params, reply) => {
      reply({ member: entry(await this.region.rosters.recruit(signedIn(session).player.id)) })
    },
    'tictac/api/squad/get': async (session, _params, reply) => {
      reply({ squad: await this.kept(session) })
    },
    'tictac/api/clock/now': (_session, _params, reply) => {
      reply({ now: this.clock.now() })
    },
    'tictac/api/squad/order': async (session, params, reply) => {
      const player = signedIn(session).player
      reply({ squad: await this.journeys.order(player.id, orderOf(params.order)) })
    },
    'tictac/api/squad/standing': async (session, params, reply) => {
      const player = signedIn(session).player
      reply({ squad: await this.journeys.standing(player.id, standingOf(params.order)) })
    },
    'tictac/api/encounter/feed': async (session, _params, reply) => {
      reply({ entries: await this.region.encounters.feed(signedIn(session).player.id, ENCOUNTER.feedLimit) })
    },
    'tictac/api/match/recording': async (session, params, reply) => {
      const player = signedIn(session).player
      const matchId = text(params, 'matchId')
      const recording = await this.region.matches.match(matchId)
      if (!recording) throw new Refusal(RPC_ERRORS.gone, 'There is no such match.')
      // Only a player in the match may watch it back: a fight is somebody's
      // squad's, and its log shows what their characters carried.
      if (!(await this.region.encounters.involved(player.id, matchId))) {
        throw new Refusal(RPC_ERRORS.notYours, 'You were not in that match.')
      }
      reply({ recording: { header: recording.header, events: recording.events } })
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
    'tictac/api/region/arrive': async (session, params, reply) => {
      const { player } = signedIn(session)
      reply(await this.crossings.arrive(player.id, text(params, 'handoverId'), text(params, 'token'), text(params, 'squadId')))
    },
    'tictac/api/region/cancelHandover': async (session, params, reply) => {
      const { player } = signedIn(session)
      reply(await this.crossings.cancel(player.id, text(params, 'handoverId'), text(params, 'reason')))
    },
  }

  /**
   * Where `playerId` belongs, as this region sees it: it is their home; it is
   * not, but a squad of theirs is crossing here and the window that signed in
   * is the one that takes it (`Crossings.expects`); or their squad is kept by
   * another region, whose address they are sent to.
   *
   * What the player is routed by on first contact is the place of the
   * connection (`workers/index.ts`), which is only right for a stranger: a
   * returning player's squad is where they left it, and dealing them a second
   * one at whichever region the network happened to send them to is the bug
   * this settles.
   */
  private async placed(playerId: string): Promise<Placement> {
    const home = await this.accounts.home(playerId)
    if (home === null || home === this.region.self) return { kind: 'home' }
    if (this.crossings.expects(playerId)) return { kind: 'visiting' }
    const url = this.peers?.urlOf(home)
    if (url === undefined) {
      throw new Refusal(RPC_ERRORS.conflict, `Your squad is kept by ${home}, which this server has no way to send you to.`)
    }
    return { kind: 'elsewhere', ended: { reason: `Your squad is in ${home}.`, reconnect: 'elsewhere', url } }
  }

  /**
   * The squad of the player this socket is signed in as. At their home region
   * it is the one door by which the roster and squad come to exist
   * (`RegionStore.enlist`); a visiting socket reads what the handover wrote
   * and never deals anything.
   */
  private async kept(session: Session): Promise<Squad> {
    const { player } = signedIn(session)
    if (!session.visiting) return this.region.enlist(player.id, session.place)
    const squad = await this.region.squads.of(player.id)
    if (!squad) throw new Refusal(RPC_ERRORS.gone, 'Your squad is not here.')
    return squad
  }

  /**
   * Bind the socket to a session a passkey ceremony just started, and answer
   * with it. One this socket may not be bound to (`Lobby.bind`) is revoked on
   * the spot, rather than left behind with nobody holding its token. A player
   * whose home is another region is answered with the session — its token is
   * the directory's, good there too — and then sent on (`placed`), unbound,
   * with nothing made for them here.
   */
  private async adopt(session: Session, minted: SignedIn, reply: (result: SignedIn) => void): Promise<void> {
    const placed = await this.placed(minted.player.id)
    if (placed.kind === 'elsewhere') {
      reply(minted)
      return this.lobby.end(session.client, placed.ended)
    }
    // Registration spans two stores, so a player may have an account and no
    // roster here; the first thing a session is bound to does the region's
    // half, and does it again for one that has it already without harm.
    if (placed.kind === 'home') await this.region.enlist(minted.player.id, session.place)
    try {
      this.lobby.bind(session.client, minted.player)
    } catch (error) {
      await this.accounts.logout(minted.token)
      throw error
    }
    session.visiting = placed.kind === 'visiting'
    session.account = minted
    reply(minted)
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
      // A key without its room names nothing, and proves nothing. A room
      // without a key is a signed-in player taking their own match over —
      // a fight the server kept a seat in for them (`ITEM-048`) — which the
      // lobby holds to the seat they have (`Lobby.place`).
      if (intent.seatKey == null) {
        if (intent.roomId == null) return { kind: 'resume' }
        if (usable(intent.roomId)) return { kind: 'resume', roomId: intent.roomId }
        break
      }
      if (usable(intent.roomId) && usable(intent.seatKey)) {
        return { kind: 'resume', roomId: intent.roomId, seatKey: intent.seatKey }
      }
      break
  }
  throw new Refusal(RPC_ERRORS.invalidParams, NO_INTENT)
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
    case 'crossBorder':
      if (!usable(order.destinationRegion)) {
        throw new Refusal(RPC_ERRORS.invalidParams, 'That order does not say which region to cross into.')
      }
      return { kind: 'crossBorder', to: placeIn(order.to), destinationRegion: order.destinationRegion }
    case 'stop':
      return { kind: 'stop' }
    default:
      throw new Refusal(RPC_ERRORS.invalidParams, 'That order is not one a squad takes.')
  }
}

/** Every order a squad's AI can fight to, so that one added to `StandingOrder` is added here. */
const STANDING_ORDERS: Record<StandingOrder, true> = { stand: true, cautious: true, opportunist: true, evade: true }

/** The order a `squad/standing` states. Peer input: checked, not trusted. */
function standingOf(value: unknown): StandingOrder {
  if (typeof value === 'string' && Object.hasOwn(STANDING_ORDERS, value)) return value as StandingOrder
  throw new Refusal(RPC_ERRORS.invalidParams, 'That is not a standing order: stand, cautious, opportunist or evade.')
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
