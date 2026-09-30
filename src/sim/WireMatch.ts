import { Faction } from '../config'
import { NetworkManager, type NetworkMessage } from '../game/NetworkManager'
import type { CombatRecording } from '../game/Recording'
import { SocketTransport } from '../game/SocketTransport'
import type { StateDigest } from '../game/StateDigest'
import { SimMatch, type MatchOutcome, type MatchSetup } from './SimMatch'

/**
 * `simulate`, but the same command stream travels through a real referee
 * instead of only being applied in memory.
 *
 * `SimMatch` already plays a whole match deterministically, both sides, in a
 * few milliseconds — which is also the one thing a browser-driven two-client
 * test cannot give: a long, decisive match, on demand, at a chosen seed. This
 * reuses that: play it headless first, exactly as `simulate` does, then
 * re-issue the very same commands over two real `NetworkManager`s connected
 * to a referee, one per side, the way two real clients would. It proves a
 * referee — any referee reachable at `url`, `Bun.serve` or a Cloudflare
 * Durable Object alike — reproduces the same match end to end, without
 * needing two browsers to do it.
 */
export interface WireMatchOptions extends MatchSetup {
  /** A referee to play the match through: `ws://…` or `wss://…`. */
  url: string
}

export interface WireMatchResult {
  /** What the match was, computed purely in memory — the ground truth. */
  outcome: MatchOutcome
  /** The exact command stream this match's own policy chose. */
  recording: CombatRecording
  /** This side's own final state, once every command has round-tripped. */
  digest: StateDigest
}

/** Resolves with the next message a manager's own side receives, once. */
function onceMessage(manager: NetworkManager): Promise<NetworkMessage> {
  return new Promise((resolve) => {
    manager.onMessage = resolve
  })
}

/**
 * A `WebSocket` to `url`, resolved once it has actually opened.
 *
 * A referee registers a socket as a client synchronously, before its own
 * handshake response reaches the far end (`MatchDurableObject.fetch` calls
 * `Referee.attach` before returning the `101`, and `GameServer.ts`'s
 * `websocket.open` runs before `Bun.serve` reports the socket open to the
 * other side either) — so a socket's own `open` event is already proof the
 * referee knows about it. Waited for explicitly, and *before* either side is
 * told to speak, because two independent connections give no guarantee that
 * the second one has been registered before the first one's opening frame
 * arrives; over one process that race is too fast to ever lose, over a real
 * network it decided this function's very first draft.
 */
function connectedSocket(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url)
    socket.addEventListener('open', () => resolve(socket), { once: true })
    socket.addEventListener('error', () => reject(new Error(`could not connect to ${url}`)), { once: true })
  })
}

/**
 * Play one match with `SimMatch`'s own policy, then replay its command
 * stream live through a referee at `url`.
 *
 * Sent one command at a time, each awaited until the *other* side's socket
 * has received the referee's relay of it, rather than fired off back to
 * back: a referee only accepts a side's commands during that side's own
 * turn, and two independent sockets give no ordering guarantee against each
 * other the way one connection gives against itself. Waiting for the relay
 * is also how a disagreement is caught immediately — the referee's own
 * recomputation runs the same command through the same rules a moment after
 * this function does, and a referee that reached a different answer says so
 * with `abort` before relaying anything, never silently.
 */
export async function simulateOverWire(options: WireMatchOptions): Promise<WireMatchResult> {
  const { url, ...setup } = options
  const sim = new SimMatch({ ...setup, record: true })
  const outcome = sim.run()
  const recording = sim.recording
  if (!recording) throw new Error('simulateOverWire needs a recording; SimMatch was not asked to keep one')

  const host = new NetworkManager()
  const joiner = new NetworkManager()

  try {
    const [hostSocket, joinerSocket] = await Promise.all([connectedSocket(url), connectedSocket(url)])
    joiner.attach(new SocketTransport(joinerSocket))
    const opening = joiner.joinMatch()
    host.attach(new SocketTransport(hostSocket))
    host.hostMatch(recording.header.seed, recording.header.seedLabel)
    const opened = await opening
    if (opened.seed !== recording.header.seed) {
      throw new Error(`the referee opened seed ${opened.seed}, not ${recording.header.seed}`)
    }

    host.send({ type: 'ready', squad: recording.header.squads[Faction.Blue] })
    joiner.send({ type: 'ready', squad: recording.header.squads[Faction.Red] })
    await Promise.all([host.waitForPeerReady(), joiner.waitForPeerReady()])
    host.send({ type: 'matchHeader', header: recording.header })

    for (const event of recording.events) {
      const sender = event.faction === Faction.Blue ? host : joiner
      const receiver = event.faction === Faction.Blue ? joiner : host
      const relayed = onceMessage(receiver)
      sender.send(event.command)
      const message = await relayed
      if (message.type === 'abort') {
        throw new Error(`the referee aborted the match at seq ${event.seq}: ${message.reason}`)
      }
    }
  } finally {
    host.dispose()
    joiner.dispose()
  }

  return { outcome, recording, digest: sim.host.digest() }
}
