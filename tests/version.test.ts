import { describe, expect, test } from 'bun:test'
import { BUILD_ID, MY_VERSION, PROTOCOL_VERSION, versionRefusal } from '../src/version'
import { NetworkManager, type NetworkMessage } from '../src/game/NetworkManager'
import { RpcMethods } from '../src/game/JsonRpc'

/** A manager wired to a fake channel, capturing what it would transmit. */
function harness(mode: 'host' | 'join' = 'host') {
  const net = new NetworkManager()
  net.mode = mode
  const sent: unknown[] = []
  net.sendRpc = (frame) => {
    sent.push(frame)
  }
  const refusals: string[] = []
  net.onDisconnected = (reason) => refusals.push(reason ?? 'no reason given')
  const received: NetworkMessage[] = []
  net.onMessage = (msg) => received.push(msg)
  return { net, sent, refusals, received }
}

/**
 * Attach one fake channel and return a way to push frames down it.
 *
 * One channel per link, deliberately: a helper that re-attaches per frame
 * cannot tell "this side stopped listening" from "this side got a fresh
 * connection", and that difference is the subject of a test below.
 */
function link(net: NetworkManager): (frame: unknown) => void {
  let onData: ((data: unknown) => void) | undefined
  let closed = false
  const conn = {
    open: true,
    close: () => {
      closed = true
    },
    on: (event: string, cb: (data: unknown) => void) => {
      if (event === 'data') onData = cb
    },
  }
  ;(net as unknown as { setupConn: (c: typeof conn) => void }).setupConn(conn)
  return (frame) => {
    // A real channel delivers nothing after it is closed; the point of the
    // test is what this side does if one somehow does.
    void closed
    onData?.(frame)
  }
}

/** Feed a single frame in as though it arrived on the data channel. */
function receive(net: NetworkManager, frame: unknown): void {
  link(net)(frame)
}

const init = (over: Record<string, unknown> = {}) => ({
  jsonrpc: '2.0' as const,
  method: RpcMethods.init,
  params: { seed: 7, seedLabel: '7', ...MY_VERSION, ...over },
})

describe('What this build says about itself', () => {
  test('an unbuilt bundle admits it cannot be identified', () => {
    // Nothing injects the id under `bun test`, which is the same situation a
    // development server is in. Claiming a version here would be worse than
    // admitting there is none.
    expect(BUILD_ID).toBe('dev')
    expect(MY_VERSION).toEqual({ protocol: PROTOCOL_VERSION, build: 'dev' })
  })
})

describe('Refusing a peer this build cannot agree with', () => {
  test('the same build on both sides is playable', () => {
    expect(versionRefusal(MY_VERSION)).toBeNull()
  })

  test('a different commit is refused, and the reason names both', () => {
    const reason = versionRefusal({ protocol: PROTOCOL_VERSION, build: 'c0ffee1' })
    expect(reason).not.toBeNull()
    expect(reason).toContain('c0ffee1')
    expect(reason).toContain(BUILD_ID)
  })

  test('a different protocol is refused, and says so as a protocol problem', () => {
    // Distinct from a build mismatch on purpose: one side cannot parse what the
    // other sends, rather than the two merely resolving a shot differently.
    const reason = versionRefusal({ protocol: PROTOCOL_VERSION + 1, build: BUILD_ID })
    expect(reason).toContain('Protocol')
  })

  test('a peer that states nothing is refused rather than trusted', () => {
    // Every build predating the gate sends no version at all. Silence is the
    // strongest evidence available that the other side is old.
    for (const claim of [undefined, null, {}, 'v1', 42, { protocol: '1', build: 'x' }]) {
      expect(versionRefusal(claim)).not.toBeNull()
    }
  })

  test('a protocol that is not a finite number cannot pass as one', () => {
    expect(versionRefusal({ protocol: NaN, build: BUILD_ID })).not.toBeNull()
    expect(versionRefusal({ protocol: Infinity, build: BUILD_ID })).not.toBeNull()
  })
})

describe('The gate on the wire', () => {
  test('a matching init is accepted and the seed still arrives', () => {
    const { net, refusals, received } = harness('join')
    receive(net, init())

    expect(refusals).toEqual([])
    expect(received.map((m) => m.type)).toEqual(['init'])
  })

  test('a mismatched init is refused before its seed is forwarded', () => {
    // The seed is the first thing a match is built from, so the gate has to sit
    // in front of it: a peer on another build is not a peer whose numbers mean
    // anything here.
    const { net, refusals, received } = harness('join')
    receive(net, init({ build: 'deadbee' }))

    expect(refusals).toHaveLength(1)
    expect(refusals[0]).toContain('deadbee')
    expect(received).toEqual([])
  })

  test("a joiner's hello is checked too, so the host refuses an old client", () => {
    const { net, refusals } = harness('host')
    receive(net, { jsonrpc: '2.0', method: RpcMethods.hello, params: { build: 'deadbee', protocol: PROTOCOL_VERSION } })

    expect(refusals).toHaveLength(1)
  })

  test('an accepted hello is not forwarded as a command', () => {
    // It states a version and nothing else; there is no intent in it to replay.
    const { net, refusals, received } = harness('host')
    receive(net, { jsonrpc: '2.0', method: RpcMethods.hello, params: { ...MY_VERSION } })

    expect(refusals).toEqual([])
    expect(received).toEqual([])
  })

  test('a refused peer does not get a second chance on the same channel', () => {
    // There is no partial compatibility to negotiate, so the decision latches:
    // a peer turned away cannot follow up with an acceptable frame and be
    // heard. Closing the channel is what stops this in practice; the latch is
    // what stops it mattering whether the close was honoured.
    const { net, received, refusals } = harness('join')
    const send = link(net)

    send(init({ protocol: PROTOCOL_VERSION + 5 }))
    send(init())

    expect(refusals).toHaveLength(1)
    expect(received).toEqual([])
  })
})

/**
 * Two real managers wired to each other: the host's outbound frames become the
 * joiner's inbound and vice versa.
 *
 * This is the handshake end to end, minus WebRTC — which is the part neither a
 * test nor a browser on this machine can exercise, and the part least likely to
 * be where a version check goes wrong.
 */
function couple(a: NetworkManager, b: NetworkManager): void {
  // A fake *connection*, not a fake `sendRpc`: stubbing the send method would
  // step over the check that a closed channel transmits nothing, which is
  // half of what refusing a peer does.
  const channel = (deliver: () => ((frame: unknown) => void) | undefined) => {
    let inbound: ((data: unknown) => void) | undefined
    const conn = {
      open: true,
      send: (frame: unknown) => deliver()?.(frame),
      close: () => {
        conn.open = false
      },
      on: (event: string, cb: (data: unknown) => void) => {
        if (event === 'data') inbound = cb
      },
    }
    return { conn, feed: (frame: unknown) => inbound?.(frame) }
  }

  // Each side's outbound frames become the other's inbound. The closures are
  // lazy so the two halves can name each other.
  const sideA = channel(() => (frame) => sideB.feed(frame))
  const sideB = channel(() => (frame) => sideA.feed(frame))
  ;(a as unknown as { setupConn: (c: unknown) => void }).setupConn(sideA.conn)
  ;(b as unknown as { setupConn: (c: unknown) => void }).setupConn(sideB.conn)
}

describe('A whole handshake between two managers', () => {
  test('matching builds exchange a seed and start', () => {
    const host = new NetworkManager()
    host.mode = 'host'
    const joiner = new NetworkManager()
    joiner.mode = 'join'
    const seen: NetworkMessage[] = []
    joiner.onMessage = (msg) => seen.push(msg)
    const refusals: string[] = []
    host.onDisconnected = (reason) => refusals.push(reason ?? '')
    joiner.onDisconnected = (reason) => refusals.push(reason ?? '')
    couple(host, joiner)

    // What the two sides actually say first, in the order they say it.
    joiner.send({ type: 'hello', ...MY_VERSION })
    host.send({ type: 'init', seed: 99, seedLabel: '99', ...MY_VERSION })

    expect(refusals).toEqual([])
    const init = seen.find((m) => m.type === 'init')
    expect(init).toMatchObject({ seed: 99, seedLabel: '99' })
  })

  test("a host on another build refuses the joiner's hello, and never sends a seed", () => {
    // The host is the side that holds the match: if it turns the joiner away
    // before `init`, the joiner cannot start a match at all — which is the
    // outcome, rather than two clients playing different games.
    const host = new NetworkManager()
    host.mode = 'host'
    const joiner = new NetworkManager()
    joiner.mode = 'join'
    const refusals: string[] = []
    host.onDisconnected = (reason) => refusals.push(reason ?? '')
    const seen: NetworkMessage[] = []
    joiner.onMessage = (msg) => seen.push(msg)
    couple(host, joiner)

    joiner.send({ type: 'hello', protocol: PROTOCOL_VERSION, build: 'c0ffee1' })

    expect(refusals).toHaveLength(1)
    expect(refusals[0]).toContain('c0ffee1')
    // And a refused host stays refused: the seed it would have sent is not read.
    host.send({ type: 'init', seed: 99, seedLabel: '99', ...MY_VERSION })
    expect(seen).toEqual([])
  })
})
