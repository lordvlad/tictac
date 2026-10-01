import { Faction } from '../config'
import { rollSquadSheets } from '../core/Characters'
import { isCommand } from '../ecs/systems/CommandSystem'
import { MatchHost } from '../sim/MatchHost'
import { Policy } from '../sim/Policy'
import { defaultLoadout } from './Loadout'
import { NetworkManager, type NetworkMessage } from './NetworkManager'
import type { Deployment } from './Recording'
import { compareDigests, reportDivergence } from './StateDigest'
import { loopback, type Transport } from './Transport'

/**
 * How much the AI minds standing near its own squad, in expected hit points per
 * squadmate inside a frag's blast. One metre of closing is worth 2 to it, so
 * this is a nudge — it still advances as a group, just not as a clump.
 */
const SPACING = 2

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
 * What it brings is a {@link MatchHost}, the scene-free world a referee uses,
 * kept in step with the player's by applying every command it receives, and the
 * {@link Policy} the balance sweep measures the game with. When the host says
 * it is Red's turn, the policy plays it and every intent it applies is sent to
 * the player as it goes.
 */
export class AiOpponent {
  private readonly network = new NetworkManager()
  private host: MatchHost | null = null
  private policy: Policy | null = null
  private playing = false
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
      const host = new MatchHost(message.header)
      this.host = host
      this.policy = new Policy(
        host,
        (command) => {
          const applied = host.apply(command)
          if (applied.applied) this.network.send(command)
          return applied
        },
        {
          watching: { [Faction.Blue]: true, [Faction.Red]: true },
          spacing: SPACING,
          // The fingerprint is of the world as this side hands it over.
          observer: { ending: () => this.network.send({ type: 'digest', digest: host.digest() }) },
        },
      )
      return
    }
    const { host } = this
    if (!host) return
    if (message.type === 'digest') {
      const { digest } = message
      reportDivergence(
        `state at the end of turn ${digest.turn}`,
        compareDigests(host.digest(), digest, (entityId) => `#${entityId}`),
      )
      return
    }
    if (!isCommand(message)) return
    const applied = host.apply(message)
    if (!applied.applied) {
      console.error(`[ai] the player's ${message.type} was refused (${applied.reason}): the two sides disagree`)
      return
    }
    this.consider()
  }

  private get over(): boolean {
    const living = this.host?.living
    return !living || living[Faction.Blue] === 0 || living[Faction.Red] === 0
  }

  /**
   * Play if it is this side's turn.
   *
   * Deferred, never run from inside the frame that announced the turn: the
   * player's side is still applying the intent that handed over, and a reply
   * delivered into the middle of that would be applied before it finished.
   */
  private consider(): void {
    if (this.playing || this.closed || this.over || this.host?.activeFaction !== Faction.Red) return
    this.playing = true
    this.play()
      .catch((err: unknown) => {
        this.closed = true
        console.error('[ai] gave up the match:', err)
      })
  }

  private async play(): Promise<void> {
    const breathe = () => new Promise<void>((resolve) => setTimeout(resolve, 0))
    try {
      await breathe()
      // A breath between units too, so the page draws what has been decided so far.
      for (const _unit of this.policy!.steps()) {
        await breathe()
        if (this.closed || this.over) return
      }
    } finally {
      // Released the moment the handover is sent, not a tick later: the player
      // may answer it at once, and a reply that finds this side still "playing"
      // would never be played.
      this.playing = false
    }
  }
}
