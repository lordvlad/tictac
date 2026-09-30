import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

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
 * through the Worker's routing, static assets serve through it rather than
 * around it, and a WebSocket accepted by one instance relays a frame to
 * another socket on that same instance. It does not exercise a referee — see
 * `workers/MatchDurableObject.ts` for why not yet.
 */

const PORT = 18917
const BASE = `http://127.0.0.1:${PORT}`

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
  })

  test('a plain request serves the built client through the Durable Object', async () => {
    const response = await fetch(`${BASE}/`)
    expect(response.status).toBe(200)
    const body = await response.text()
    expect(body).toContain('<html')
    expect(body.toLowerCase()).toContain('tictac')
  })

  test('two sockets on the single instance relay a frame to each other', async () => {
    const a = new WebSocket(BASE.replace('http://', 'ws://'))
    const b = new WebSocket(BASE.replace('http://', 'ws://'))
    await Promise.all([once(a, 'open'), once(b, 'open')])

    const received = once(b, 'message').then((event) => String((event as MessageEvent).data))
    a.send('hello from a')

    expect(await received).toBe('hello from a')

    a.close()
    b.close()
  })

  test('a lone socket has nobody to relay to, and nothing throws', async () => {
    const ws = new WebSocket(BASE.replace('http://', 'ws://'))
    await once(ws, 'open')
    ws.send('nobody is listening')
    ws.close()
  })
})
