import { Faction } from '../config'
import { NetworkManager, type NetworkMessage } from '../game/NetworkManager'
import type { CombatRecording } from '../game/Recording'
import { heldTokens, ServerConnection } from '../game/ServerConnection'
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
  /** The room the server played it in, which is also its match id. */
  roomId: string
}

/**
 * Resolves with the next message a manager's own side receives, once, and
 * rejects if the match stops instead — an `abort` is taken at the edge and
 * never arrives as a message, so a referee that disagreed would otherwise
 * leave this waiting forever.
 *
 * The handler is taken down again on arrival, so anything after it is held
 * by the manager for the next wait rather than spent on this one.
 */
function onceMessage(manager: NetworkManager): Promise<NetworkMessage> {
  const { promise, resolve, reject } = Promise.withResolvers<NetworkMessage>()
  manager.onDisconnected = (reason) => reject(new Error(reason))
  manager.onMessage = (message) => {
    manager.onMessage = null
    resolve(message)
  }
  return promise
}

/**
 * Play one match with `SimMatch`'s own policy, then replay its command
 * stream live through a match server at `url`.
 *
 * One side opens a room, the other joins it by the id the server seated the
 * first in — the order two players in a lobby take — and from there it is the
 * handshake two peers do directly.
 *
 * Sent one command at a time, each awaited until the *other* side's socket
 * has received the referee's relay of it, rather than fired off back to
 * back: two independent sockets give no ordering guarantee against each
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

  // Two windows, each with its own connection to the server: one socket each,
  // as a browser has. Tokens are held in memory — nobody signs in.
  const hostLine = new ServerConnection(url, { tokens: heldTokens() })
  const joinerLine = new ServerConnection(url, { tokens: heldTokens() })
  const host = new NetworkManager()
  const joiner = new NetworkManager()

  let roomId: string
  try {
    // Seated before the other connects, so the room exists to be joined.
    roomId = (await host.enterRoom(hostLine, { kind: 'open' })).roomId
    await joiner.enterRoom(joinerLine, { kind: 'join', roomId })
    // The joiner says hello into the room; the host hears it and states the
    // opening it announced (`restate`) — the same exchange whichever of the
    // two speaks first.
    host.hostMatch(recording.header.seed, recording.header.seedLabel)
    const opening = await joiner.joinMatch()
    if (opening.seed !== recording.header.seed) {
      throw new Error(`the referee opened seed ${opening.seed}, not ${recording.header.seed}`)
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
      await relayed
    }
  } finally {
    host.dispose()
    joiner.dispose()
    hostLine.close()
    joinerLine.close()
  }

  return { outcome, recording, digest: sim.host.digest(), roomId }
}
