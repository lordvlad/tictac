import { DurableObject } from 'cloudflare:workers'
import type { LatLng } from '../src/core/Travel'
import type { AccountsPort } from '../src/server/AccountsPort'
import { type AccountsReply, type AccountsRequest, accountsOverRpc, serveAccounts } from '../src/server/AccountsRpc'
import { LOCAL_RELYING_PARTY, type RelyingParty } from '../src/server/AccountStore'
import { WALL_CLOCK } from '../src/server/Clock'
import { createMatchServer, type MatchServer } from '../src/server/MatchServer'
import { DIRECTORY_REGION, SINGLETON_REGION } from '../src/server/Owner'
import { persistenceOverDb } from '../src/server/Persistence'
import { regionStoreOverDb, type RegionStore } from '../src/server/RegionStore'
import { socketTransport } from '../src/server/SocketTransport'
import { dbOverStorage } from './DoSqliteDb'
import type { Env } from './index'

/**
 * A match server on Cloudflare: one Durable Object per region (`[ITEM-045]`,
 * RFC-0002).
 *
 * What this is, is `createMatchServer` (`src/server/MatchServer.ts`), the same
 * server `startGameServer` runs behind a Bun process; this file is only what
 * Cloudflare adds to it — `ctx.storage.sql` for the database (`DoSqliteDb.ts`
 * is that `Db`), `ctx.storage.setAlarm` for the schedule's one alarm,
 * `request.cf` for where a connection came from, a `WebSocketPair` for the
 * sockets (`socketTransport`, already exported for exactly this), and the
 * built client for whatever the match server does not answer itself. A window
 * asks everything over its one socket (`Session.ts`), so there is no HTTP API
 * here: what is not a socket is a static asset.
 *
 * There is one region today, so one instance: the Worker always addresses it
 * by the same name (see `index.ts`), `singleton`, which is also the directory
 * — it holds the account store as well as its own region's, in the one
 * database, and answers every region's `AccountsPort` by RPC ({@link accounts}).
 * An instance with any other name is a region only: its database holds no
 * account, and it asks the directory's.
 *
 * **A match socket does not hibernate, and a room outlives the instance
 * anyway.** The lobby keeps its live state — sockets, spectators, each
 * room's `MatchHost` — in memory, and a WebSocket here is accepted with plain
 * `server.accept()`, not `ctx.acceptWebSocket()`: as long as any socket is
 * open, the runtime keeps this instance resident rather than evicting it
 * between messages. What it cannot keep resident across is a deploy, a
 * restart or an eviction once every socket has closed — and none of those
 * loses a room any more. Every room is written to `ctx.storage.sql` as it
 * changes (`RoomStore`), and the constructor restores them all before the
 * first request is let in, so a deploy looks to every window like a dropped
 * connection: it reconnects to its own seat with its key, and the match goes
 * on (`docs/architecture/deployment.md` §2.3). Static-asset traffic never
 * needed any of this.
 */
export class MatchDurableObject extends DurableObject<Env> {
  /**
   * Set inside `blockConcurrencyWhile`, which is also what makes every
   * `fetch` wait for it: the runtime does not dispatch a request to this
   * object until the block's promise has settled — so no socket reaches the
   * lobby before every room it held before this instance has been restored.
   */
  private server!: MatchServer
  /** The account store's own accounts: set on the directory only, which answers {@link accounts}. */
  private directoryAccounts: AccountsPort | null = null

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    ctx.blockConcurrencyWhile(async () => {
      // One clock for everything this object constructs. Its alarm is the
      // travel schedule's; the timers a seat's grace runs on are the
      // runtime's own, as they always were.
      const clock = WALL_CLOCK
      const db = dbOverStorage(ctx.storage)
      const party = relyingPartyOf(env)
      const self = ctx.id.name ?? SINGLETON_REGION
      let accounts: AccountsPort
      let region: RegionStore
      if (self === DIRECTORY_REGION) {
        // The directory keeps its accounts and its own region side by side in
        // the one database it has always had (`store_migrations` keeps the
        // two ledgers apart, and the singleton's pre-split tables are adopted).
        const persistence = await persistenceOverDb(db, clock, { party, self })
        accounts = persistence.accounts.accounts
        region = persistence.region
        this.directoryAccounts = accounts
      } else {
        const directory = env.MATCH.get(env.MATCH.idFromName(DIRECTORY_REGION))
        accounts = accountsOverRpc((request) => directory.accounts(request))
        region = await regionStoreOverDb(db, clock, accounts, self)
      }
      this.server = await createMatchServer({
        clock,
        accounts,
        region,
        // The object's one alarm: armed for the earliest moment any squad has
        // due, and kept in storage, so it fires even if this instance was
        // evicted in between — and delivered to `alarm` below, which is why
        // there is no callback to hand it.
        alarm: {
          arm: (at) => {
            if (at === null) void ctx.storage.deleteAlarm()
            else void ctx.storage.setAlarm(at)
          },
        },
        placeOf: (request) => placeOf(request.cf),
        party,
        // Read at every check, so a changed variable is the next check's.
        playerEncounters: () => env.PLAYER_ENCOUNTERS !== 'off',
      })
    })
  }

  /**
   * The directory's half of `AccountsPort`, for the regions that are not the
   * directory: one call, as data, answered against the account store this
   * object holds. Anything but the directory is no place to ask.
   */
  async accounts(request: AccountsRequest): Promise<AccountsReply> {
    if (!this.directoryAccounts) throw new Error('this Durable Object is not the directory: it holds no accounts')
    return serveAccounts(this.directoryAccounts, request)
  }

  /** The alarm the travel schedule armed: whatever is due runs, and the next moment is armed. */
  override async alarm(): Promise<void> {
    await this.server.alarm()
  }

  override async fetch(request: Request): Promise<Response> {
    const answered = await this.server.http(request)
    if (answered) return answered
    if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
      // The built client, served through this object rather than around it,
      // because the deployment asked for one Durable Object that serves both.
      return this.env.ASSETS.fetch(request)
    }

    const pair = new WebSocketPair()
    const client = pair[0]
    const server = pair[1]
    server.accept()
    const transport = socketTransport(server, (message) => console.info(`[referee] ${message}`))
    server.addEventListener('message', (event) => {
      const raw = typeof event.data === 'string' ? event.data : new TextDecoder().decode(event.data)
      transport.deliver(raw)
    })
    server.addEventListener('close', (event) => {
      transport.closed(event.reason || `the socket closed (code ${event.code})`)
    })
    server.addEventListener('error', () => {
      transport.closed('the socket errored')
    })
    this.server.accept(transport, request)
    return new Response(null, { status: 101, webSocket: client })
  }
}

/**
 * Where Cloudflare places the connection (`request.cf`, which the Worker's
 * `stub.fetch(request)` carries through to here), or null where it does not
 * say — `wrangler dev`, or a zone without geolocation. Its coordinates are
 * decimal strings.
 */
export function placeOf(cf: unknown): LatLng | null {
  if (typeof cf !== 'object' || cf === null) return null
  const { latitude, longitude } = cf as { latitude?: unknown; longitude?: unknown }
  const place = { lat: Number(latitude), lng: Number(longitude) }
  const known = typeof latitude === 'string' && typeof longitude === 'string'
  return known && Number.isFinite(place.lat) && Number.isFinite(place.lng) ? place : null
}

/**
 * The relying party a deploy's passkeys are bound to, from the Worker's own
 * vars (`wrangler.jsonc`'s `vars`, or `wrangler secret`), falling back to the
 * same local default `bun run dev` uses. Also what `index.ts` publishes as the
 * related origins (`src/server/RelatedOrigins.ts`).
 */
export function relyingPartyOf(env: Env): RelyingParty {
  if (!env.RELYING_PARTY_ID) return LOCAL_RELYING_PARTY
  return {
    id: env.RELYING_PARTY_ID,
    origins: (env.RELYING_PARTY_ORIGINS ?? '').split(',').map((origin) => origin.trim()).filter(Boolean),
  }
}
