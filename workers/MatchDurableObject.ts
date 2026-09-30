import { DurableObject } from 'cloudflare:workers'
import type { Env } from './index'

/**
 * One Durable Object for the whole deployment (`[ITEM-045]`).
 *
 * A match server is one referee, so there is exactly one instance: the Worker
 * always addresses it by the same fixed name (see `index.ts`), never by a
 * name derived from the request. Everything the Worker receives — a page
 * load, an asset, a WebSocket upgrade — arrives here, because a durable
 * object is the only piece of this deployment with a place to keep state
 * between requests; the Worker itself has none.
 *
 * **This is the planted shape, not the finished one.** It proves the parts
 * that have to be true before anything else can be built on top: a static
 * asset serves through the object rather than around it, a socket opens and
 * stays open, and two sockets held by the same instance can reach each
 * other. What it does with a message is a bare relay, not the referee.
 *
 * The referee does not move in yet because of a real, specific gap: `Db`
 * (`src/server/db/Db.ts`) is an async port — `transaction<T>(fn: (tx: Db) =>
 * Promise<T>)` — built around `Bun.SQL`'s genuinely asynchronous wire
 * protocol. A Durable Object's SQLite storage (`ctx.storage.sql`) is
 * synchronous, and its own transaction primitive, `transactionSync`,
 * requires a callback that is not `async` and contains no `await` at all —
 * which `Db.transaction`'s callers (`migrate.ts`, `Rosters.settle`, …)
 * are not. Wrapping the sync engine in `async` functions to satisfy `Db`'s
 * shape only hides the mismatch: everything after the first `await` inside
 * a multi-statement transaction would run *after* `transactionSync`'s
 * callback had already returned, outside the transaction it was meant to be
 * in. Writing a `Db` adapter over `ctx.storage.sql` that is honest about
 * this — rather than one that merely typechecks — is the next step, not
 * this one.
 */
export class MatchDurableObject extends DurableObject<Env> {
  /**
   * Every socket this instance is currently holding, so a frame can be
   * relayed to the others. Rebuilt from the runtime's own record on
   * construction, not assumed empty: hibernatable sockets
   * (`ctx.acceptWebSocket`) survive this object being evicted between
   * messages, and a fresh instance may already have some open.
   */
  private readonly sockets = new Set<WebSocket>()

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    for (const ws of ctx.getWebSockets()) this.sockets.add(ws)
  }

  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get('upgrade')?.toLowerCase() === 'websocket') {
      const pair = new WebSocketPair()
      const client = pair[0]
      const server = pair[1]
      // Hibernatable, not `server.accept()`: the runtime may evict this
      // object between messages and wake it again on the next one, calling
      // `webSocketMessage` below exactly as if nothing had happened. A
      // referee that stopped charging for idle connections is the whole
      // point of a Durable Object over a Bun process that must stay resident.
      this.ctx.acceptWebSocket(server)
      this.sockets.add(server)
      return new Response(null, { status: 101, webSocket: client })
    }
    // Not a socket: an asset request, served by this object rather than
    // around it, because the deployment asked for one Durable Object that
    // serves both.
    return this.env.ASSETS.fetch(request)
  }

  /**
   * Relay, not a referee. Every text frame this instance receives is
   * broadcast to every *other* open socket, unexamined — enough to prove two
   * clients on this instance can reach each other, nothing more. A real
   * match wires `Referee`/`GameServer`'s existing `socketTransport` in here
   * once a `Db` adapter exists (see the class doc); `socketTransport` itself
   * needs nothing beyond `send`/`close`, which a Cloudflare `WebSocket`
   * already has.
   */
  override webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
    for (const other of this.sockets) {
      if (other === ws) continue
      other.send(message)
    }
  }

  override webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean): void {
    this.sockets.delete(ws)
    // Completes the closing handshake regardless of `wasClean`: the
    // hibernation API expects this call, it does not perform it implicitly.
    ws.close(code, reason)
  }

  override webSocketError(ws: WebSocket): void {
    this.sockets.delete(ws)
  }
}
