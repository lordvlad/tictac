import { DurableObject } from 'cloudflare:workers'
import { apiHandler } from '../src/server/Api'
import {
  LOCAL_RELYING_PARTY,
  persistenceOverDb,
  type Persistence,
  type RelyingParty,
} from '../src/server/Persistence'
import { Referee } from '../src/server/Referee'
import { socketTransport } from '../src/server/SocketTransport'
import { dbOverSqlStorage } from './DoSqliteDb'
import type { Env } from './index'

/**
 * One Durable Object for the whole deployment (`[ITEM-045]`).
 *
 * A match server is one referee, so there is exactly one instance: the Worker
 * always addresses it by the same fixed name (see `index.ts`), never by a
 * name derived from the request. Everything the Worker receives — a page
 * load, an asset, an `/api/…` call, a WebSocket upgrade — arrives here.
 *
 * `Referee`, `Persistence` and `apiHandler` are the same classes
 * `startGameServer` (`src/server/GameServer.ts`) runs behind a Bun process —
 * nothing about them is Bun-specific once they are handed a `Db`
 * (`DoSqliteDb.ts` is that `Db`, over `ctx.storage.sql`) and a transport with
 * `send`/`close` (`socketTransport`, already exported for exactly this).
 *
 * **A match socket does not hibernate.** `Referee` keeps a match's open
 * state — `this.clients`, `this.host`, `this.sides` — in memory, with no
 * durable backing; hibernation evicts the whole object, and there is
 * nothing this class could deserialize a live `MatchHost` back out of. So a
 * WebSocket here is accepted with plain `server.accept()`, not
 * `ctx.acceptWebSocket()`: as long as a match socket is open, the runtime
 * keeps this instance resident rather than evicting it between messages,
 * the ordinary cost of a stateful connection rather than the hibernatable
 * one this class first shipped with. Once every socket closes, nothing
 * pins the instance and it can be evicted like any other idle Durable
 * Object; static-asset and `/api/…` traffic never needed to be exempt from
 * that, since both are stateless replies against durable storage.
 */
export class MatchDurableObject extends DurableObject<Env> {
  private readonly log = (message: string): void => console.info(`[referee] ${message}`)

  /**
   * Set inside `blockConcurrencyWhile`, which is also what makes every
   * `fetch` wait for it: the runtime does not dispatch a request to this
   * object until the block's promise has settled.
   */
  private persistence!: Persistence
  private referee!: Referee
  private api!: (request: Request) => Promise<Response | null>

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    ctx.blockConcurrencyWhile(async () => {
      const party = relyingPartyOf(env)
      this.persistence = await persistenceOverDb(dbOverSqlStorage(ctx.storage.sql), party)
      this.referee = new Referee({
        matches: this.persistence.matches,
        rosters: this.persistence.rosters,
        log: this.log,
        onVerdict: (verdict) => {
          this.log(`verdict on ${verdict.matchId}: ${verdict.reason}`)
          for (const found of verdict.found) {
            this.log(`  ${found.unit ?? ''} ${found.what}: referee ${found.mine}, client ${found.theirs}`)
          }
        },
      })
      this.api = apiHandler(this.persistence, party, this.log)
    })
  }

  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get('upgrade')?.toLowerCase() === 'websocket') {
      // A ticket is how an account reaches a socket: a browser cannot put an
      // `Authorization` header on a WebSocket, and a session token in a url
      // is a session token in somebody's logs.
      const ticket = new URL(request.url).searchParams.get('ticket')
      const playerId = ticket ? this.persistence.accounts.redeemTicket(ticket) : null
      if (ticket && !playerId) {
        return Response.json(
          { error: 'that sign-in ticket is not valid; sign in again' },
          { status: 401 },
        )
      }

      const pair = new WebSocketPair()
      const client = pair[0]
      const server = pair[1]
      server.accept()
      const transport = socketTransport(server, this.log)
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
      this.referee.attach(transport, playerId)
      this.log(`a client connected${playerId ? ' signed in' : ''}`)
      return new Response(null, { status: 101, webSocket: client })
    }

    const answered = await this.api(request)
    if (answered) return answered

    // Not a socket and not `/api/…`: the built client, served through this
    // object rather than around it, because the deployment asked for one
    // Durable Object that serves both.
    return this.env.ASSETS.fetch(request)
  }
}

/**
 * The relying party a deploy's passkeys are bound to, from the Worker's own
 * vars when a real domain has been chosen (`wrangler.jsonc`'s `vars`, or
 * `wrangler secret`), falling back to the same local default `bun run dev`
 * uses. Nothing sets these vars yet — a real `wrangler deploy` still needs a
 * chosen domain to configure them with.
 */
function relyingPartyOf(env: Env): RelyingParty {
  if (!env.RELYING_PARTY_ID) return LOCAL_RELYING_PARTY
  return {
    id: env.RELYING_PARTY_ID,
    origins: (env.RELYING_PARTY_ORIGINS ?? '').split(',').map((origin) => origin.trim()).filter(Boolean),
  }
}
