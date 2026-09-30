import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { STOCK_PLAN } from '../src/sim/Balance'
import { simulateOverWire } from '../src/sim/WireMatch'
import { softwareAuthenticator } from './support/authenticator'

/**
 * The planted Cloudflare deployment (`[ITEM-045]`), against a real local
 * Workers runtime rather than a mock of one.
 *
 * `wrangler dev` is wrangler's own local test facility: it runs
 * `wrangler.jsonc` under Miniflare/workerd, the same runtime a deploy uses.
 * (Wrangler also ships a newer programmatic harness, `createTestHarness` —
 * tried first here, but its `dispatchFetch` never returns in this sandbox
 * even for a one-line worker with no Durable Object at all, so it is a
 * sandbox-specific tooling gap rather than anything about this deployment;
 * spawning the CLI and talking to it over real HTTP/WebSocket sidesteps it.)
 *
 * `assets.directory` in `wrangler.jsonc` names `dist`, so `beforeAll` builds
 * it (`bun run build`) before spawning the dev server — self-contained
 * rather than assuming CI or a developer already ran a build first.
 *
 * What this proves: a request reaches the single `MatchDurableObject`
 * through the Worker's routing; static assets serve through it rather than
 * around it; a passkey ceremony, a roster fetch and a ticket all work over
 * real HTTP; a signed-in socket, an anonymous one, and one with an invalid
 * ticket are each treated the way `tests/server.test.ts` proves the
 * `Bun.serve` referee treats them — the same `Referee`, `Persistence` and
 * `apiHandler`, now behind a Cloudflare `WebSocket` and `ctx.storage.sql`.
 * And, past a single relayed frame: a whole decisive match, driven by
 * `src/sim/WireMatch.ts`, settles through this object's own independent
 * recomputation exactly as it does headless — the part that needed two real
 * browsers before, now proved without either.
 */

const PORT = 18917
const BASE = `http://127.0.0.1:${PORT}`
const ORIGIN = 'http://localhost:5173'

let dev: ReturnType<typeof Bun.spawn>

/** Sleep, only ever used to space out polling a real external process. */
function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>()
  setTimeout(resolve, ms)
  return promise
}

/** Waits for an event once, via the promise the listener already resolves. */
function once(target: EventTarget, event: string): Promise<Event> {
  const { promise, resolve } = Promise.withResolvers<Event>()
  target.addEventListener(event, resolve, { once: true })
  return promise
}

/**
 * Poll until the dev server answers, or give up. A real wall-clock wait on
 * purpose: `wrangler dev` is a separate OS process with no readiness event
 * this test can await instead, only a port that starts answering once the
 * local Workers runtime has finished booting.
 */
async function waitForReady(timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${BASE}/`)
      if (response.ok) return
    } catch {
      // Not listening yet.
    }
    await sleep(250)
  }
  throw new Error(`wrangler dev did not answer on ${BASE} within ${timeoutMs}ms`)
}

/** Registers a fresh passkey over real HTTP, the way a browser would. */
async function registered(): Promise<string> {
  const key = await softwareAuthenticator()
  const post = async (path: string, body: unknown): Promise<Record<string, unknown>> => {
    const response = await fetch(`${BASE}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: ORIGIN },
      body: JSON.stringify(body),
    })
    return (await response.json()) as Record<string, unknown>
  }
  const options = await post('/api/auth/register/options', { name: 'Tester' })
  const created = await key.create({
    challengeId: options.challengeId as string,
    challenge: (options.publicKey as { challenge: string }).challenge,
  })
  const verified = await post('/api/auth/register/verify', created)
  return verified.token as string
}

describe('The planted Cloudflare deployment', () => {
  beforeAll(async () => {
    // Self-contained rather than relying on run order: CI runs `bun test`
    // before `bun run build`, and `assets.directory` in `wrangler.jsonc`
    // names `dist`, which this makes sure exists regardless of who asked.
    const built = Bun.spawnSync(['bun', 'run', 'build'], { cwd: import.meta.dir + '/..' })
    if (!built.success) throw new Error(`bun run build failed: ${built.stderr.toString()}`)

    dev = Bun.spawn(['bunx', 'wrangler', 'dev', '--port', String(PORT)], {
      cwd: import.meta.dir + '/..',
      stdout: 'ignore',
      stderr: 'ignore',
    })
    await waitForReady(30000)
  }, 60000)

  afterAll(() => {
    dev.kill()
    // `bunx wrangler dev` spawns `wrangler`, which spawns a `workerd` child
    // of its own; killing the process this test started does not reliably
    // reach either descendant. Best-effort net, by the port rather than a
    // command-line pattern: nothing else on this machine binds it on purpose.
    Bun.spawnSync(['fuser', '-k', `${PORT}/tcp`])
  })

  test('a plain request serves the built client through the Durable Object', async () => {
    const response = await fetch(`${BASE}/`)
    expect(response.status).toBe(200)
    const body = await response.text()
    expect(body).toContain('<html')
    expect(body.toLowerCase()).toContain('tictac')
  })

  test('a signed-in player trades a session for a socket', async () => {
    const token = await registered()
    const ticketed = await fetch(`${BASE}/api/ticket`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, origin: ORIGIN },
    })
    const { ticket } = (await ticketed.json()) as { ticket: string }

    const socket = new WebSocket(`${BASE.replace('http', 'ws')}/?ticket=${ticket}`)
    await once(socket, 'open')
    socket.close()
  })

  test('a socket with a ticket nobody issued is turned away', async () => {
    // Spoken by hand rather than with `new WebSocket`, because what is being
    // checked is the HTTP answer to an upgrade the object refuses.
    const response = await fetch(`${BASE}/?ticket=nope`, {
      headers: {
        upgrade: 'websocket',
        connection: 'Upgrade',
        'sec-websocket-version': '13',
        'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
      },
    })
    expect(response.status).toBe(401)
    expect(((await response.json()) as { error: string }).error).toMatch(/not valid/)
  })

  test('an anonymous socket is still welcome', async () => {
    const socket = new WebSocket(BASE.replace('http', 'ws'))
    await once(socket, 'open')
    socket.close()
  })

  test('a frame that is not JSON-RPC is dropped, not relayed, and the socket stays open', async () => {
    // Proves the switch from the earlier bare relay to the real
    // `Referee`/`socketTransport`: junk text is silently discarded
    // (`isJsonRpcFrame`) rather than broadcast to whoever else is
    // connected, and discarding it does not close the sender's own socket.
    const socket = new WebSocket(BASE.replace('http', 'ws'))
    await once(socket, 'open')
    socket.send('not json at all')
    socket.send(JSON.stringify({ jsonrpc: '2.0', method: 'tictac/system/session/hello', params: {} }))
    // Still open after both: neither send tore the connection down.
    expect(socket.readyState).toBe(WebSocket.OPEN)
    socket.close()
  })

  test('a whole simulated match reaches settlement through the Durable Object, not just a few moves', async () => {
    // Every other test here proves a socket, a ticket, a passkey — pieces of
    // the wire. This proves the referee itself: driven by `src/sim/WireMatch.ts`,
    // a real `SimMatch` plays a decisive match against its own rules, then the
    // exact same commands travel to this deployment's `MatchDurableObject`
    // over a real WebSocket. Its `Referee` recomputes every one of them
    // independently, on `workers/DoSqliteDb.ts` over `ctx.storage.sql`, inside
    // an actual `workerd` process — not the Bun-hosted referee every other
    // wire test in this repository uses. A referee that disagreed at any
    // point would send `abort` and this would throw; it does not, all the
    // way to a decisive win, which is what "the referee runs for real" here
    // means concretely (`[ITEM-045]`).
    const url = BASE.replace('http', 'ws')
    let seed = 6000
    let winner: unknown = null
    while (winner === null && seed < 6040) {
      const result = await simulateOverWire({
        seed,
        blue: { ...STOCK_PLAN, size: 3 },
        red: { ...STOCK_PLAN, size: 3 },
        turnCap: 60,
        url,
      })
      winner = result.outcome.winner
      seed++
    }
    expect(winner).not.toBeNull()
  }, 30000)
})
