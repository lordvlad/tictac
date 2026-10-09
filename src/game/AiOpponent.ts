import { Faction } from '../config'
import { rollSquadSheets } from '../core/Characters'
import { AiPlayer } from '../sim/AiPlayer'
import { MatchHost } from '../sim/MatchHost'
import { defaultLoadout } from './Loadout'
import { NetworkManager, type NetworkMessage } from './NetworkManager'
import type { Deployment } from './Recording'
import { reportDivergence } from './StateDigest'
import { loopback, type Transport } from './Transport'

/** A turn of the event loop, so the page draws what has been decided so far. */
function breathe(): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>()
  setTimeout(resolve, 0)
  return promise
}

/**
 * A match against the machine: an opponent that is a *peer*.
 *
 * Nothing in the played game knows an AI exists. The opponent is the joining
 * side of an ordinary match, reached over an in-process {@link loopback}
 * instead of a data channel: it takes the same handshake, deploys through the
 * same `ready` frame, and receives and sends the same intents. So the player's
 * controller needs no AI mode — everything it does for a human on the other end
 * of a wire it does here, including resolving every intent itself and
 * comparing state digests (ADR-0004).
 *
 * What it brings is an {@link AiPlayer}: a scene-free world kept in step with
 * the player's by applying every command it receives, and the policy the
 * balance sweep measures the game with. When it is Red's turn the policy plays
 * it, and every intent it applies is sent to the player as it goes. The same
 * player sits in a server's seat (`AiSeat`); what is here is only how this one
 * reaches the page.
 */
export class AiOpponent {
  private readonly network = new NetworkManager()
  private player: AiPlayer | null = null
  private closed = false

  private constructor() {}

  /**
   * Sit down across from `network`, which must be about to host.
   *
   * Attached before the host announces the match, because the announcement is
   * delivered synchronously and an opponent that is not there yet misses it.
   */
  static join(network: NetworkManager): void {
    const [mine, theirs] = loopback()
    network.attach(mine)
    new AiOpponent().sit(theirs)
  }

  private sit(transport: Transport): void {
    this.network.attach(transport)
    this.network.onDisconnected = () => {
      this.closed = true
      this.player?.stop()
    }
    this.network.onMessage = (message) => this.receive(message)
    this.network
      .joinMatch()
      .then(() => this.deploy())
      .catch((err: unknown) => {
        this.closed = true
        console.error('[ai] could not join the match:', err)
      })
  }

  /** Send the squad this side brings. A fresh roll, with the stock kit. */
  private deploy(): void {
    const sheets = rollSquadSheets()
    const loadout = defaultLoadout(sheets.length)
    const squad: Deployment[] = sheets.map((sheet, i) => ({ sheet, loadout: loadout[i]! }))
    this.network.send({ type: 'ready', squad })
  }

  private receive(message: NetworkMessage): void {
    if (this.closed) return
    if (message.type === 'matchHeader') {
      this.player = new AiPlayer(new MatchHost(message.header), {
        faction: Faction.Red,
        send: (sent) => this.network.send(sent),
        breathe,
        diverged: reportDivergence,
        failed: (problem) => console.error(`[ai] ${problem}`),
      })
      return
    }
    this.player?.hear(message)
  }
}
