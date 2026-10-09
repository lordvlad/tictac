import { Faction } from '../config'
import { isCommand } from '../ecs/systems/CommandSystem'
import type { NetworkMessage } from '../game/NetworkManager'
import { compareDigests, type Divergence } from '../game/StateDigest'
import type { MatchHost } from './MatchHost'
import { Policy, type StandingOrder } from './Policy'

/**
 * How much the AI minds standing near its own squad, in expected hit points per
 * squadmate inside a frag's blast. One metre of closing is worth 2 to it, so
 * this is a nudge — it still advances as a group, just not as a clump.
 */
const SPACING = 2

export interface AiPlayerOptions {
  /** The side it plays: either, since a server seats it at whichever chair nobody is in. */
  faction: Faction
  /**
   * Put a frame on the wire to the other side: an intent it chose, already
   * carried out on its own world, or the fingerprint of that world just
   * before a handover.
   */
  send(message: NetworkMessage): void
  /**
   * A pause between its units, which is the caller's to give: a page takes a
   * frame to draw what has been decided so far. Without one it only lets the
   * frame that handed it the turn finish, which is all a server wants — and
   * it has no clock to wait on.
   */
  breathe?(): Promise<void>
  /** The other side's fingerprint is not this side's. */
  diverged(what: string, found: readonly Divergence[]): void
  /** Something went wrong, and it went on: an intent the other side sent that its rules refuse. */
  failed(problem: string): void
  /** It gave up the match: its policy threw, and it will play no more. Nobody else will play its side for it. */
  stalled?(problem: string): void
  /** What its side fights to; `stand` when absent (`Policy`). */
  order?: StandingOrder
  /**
   * The turn after which it stops waiting a stalemate out and gets out
   * (`evade`). Absent for the browser's opponent, whose player ends the
   * match when they like. A fight between two of these would otherwise be
   * free to go on for ever, and about one in a hundred does
   * (`tests/aiPlayer.test.ts`). One still going at twice the limit is given
   * up (`stalled`).
   */
  turnLimit?: number
}

/**
 * One side of a match played by the machine, over a world of its own.
 *
 * Nothing in a played match knows an AI exists: this is a peer. It keeps a
 * {@link MatchHost}, the scene-free world a referee uses, in step with the
 * other side's by applying every intent it hears, and when it is its side's
 * turn the {@link Policy} the balance sweep measures the game with plays it,
 * every intent it applies handed to `send` as it goes. The browser's
 * opponent (`AiOpponent`) and a server's seat (`AiSeat`) are this, and differ
 * only in how they reach the other side and what they pause on.
 *
 * It draws no randomness of its own and never the match's: every choice is a
 * function of the world it sees, and the dice are the rules' (ADR-0004).
 */
export class AiPlayer {
  private readonly policy: Policy
  private playing = false
  private stopped = false

  constructor(
    private readonly host: MatchHost,
    private readonly options: AiPlayerOptions,
  ) {
    this.policy = new Policy(
      host,
      (command) => {
        // Said before it is carried out, because carrying it out may be what
        // decides the match: the intent that does so still has to be sent.
        const decided = this.decided
        const applied = host.apply(command)
        if (applied.applied && !decided && !this.stopped) options.send(command)
        return applied
      },
      {
        watching: { [Faction.Blue]: true, [Faction.Red]: true },
        spacing: SPACING,
        orders: { [options.faction]: options.order ?? 'stand' },
        // The fingerprint is of the world as this side hands it over.
        observer: { ending: () => options.send({ type: 'digest', digest: host.digest() }) },
      },
    )
  }

  /** Whether somebody has won: a side with nobody left on the field, killed or retreated. */
  private get decided(): boolean {
    const living = this.host.living
    return living[Faction.Blue] === 0 || living[Faction.Red] === 0
  }

  /** Take in what the other side sent: the intents that move the world on, and the fingerprint that checks it. */
  hear(message: NetworkMessage): void {
    if (this.stopped) return
    const { host } = this
    if (message.type === 'digest') {
      const { digest } = message
      const found = compareDigests(host.digest(), digest, (entityId) => `#${entityId}`)
      if (found.length > 0) this.options.diverged(`state at the end of turn ${digest.turn}`, found)
      return
    }
    if (!isCommand(message)) return
    const applied = host.apply(message)
    if (!applied.applied) {
      this.options.failed(`the other side's ${message.type} was refused (${applied.reason}): the two sides disagree`)
      return
    }
    this.consider()
  }

  /**
   * Play if it is this side's turn.
   *
   * Deferred, never run from inside the frame that announced the turn: the
   * other side is still applying the intent that handed over, and a reply
   * delivered into the middle of that would be applied before it finished.
   */
  consider(): void {
    if (this.playing || this.stopped || this.decided || this.host.activeFaction !== this.options.faction) return
    this.playing = true
    this.play().catch((error: unknown) => {
      this.stopped = true
      const problem = `gave up the match: ${error instanceof Error ? error.message : String(error)}`
      this.options.failed(problem)
      this.options.stalled?.(problem)
    })
  }

  /** Say nothing more and play nothing more. */
  stop(): void {
    this.stopped = true
  }

  private async play(): Promise<void> {
    const { faction, turnLimit } = this.options
    try {
      await this.options.breathe?.()
      if (turnLimit !== undefined && this.host.turnNumber > turnLimit) {
        // Getting out takes a turn or two. A side still here at twice the limit
        // cannot get out, and a fight between two of these that nothing ends
        // would hold the event loop for ever: give it up instead.
        if (this.host.turnNumber > turnLimit * 2) throw new Error(`the fight is still going at turn ${this.host.turnNumber}`)
        this.policy.setOrder(faction, 'evade')
      }
      for (const _unit of this.policy.steps()) {
        await this.options.breathe?.()
        if (this.stopped || this.decided) return
      }
    } finally {
      // Released the moment the handover is sent, not a tick later: the other
      // side may answer it at once, and a reply that finds this side still
      // "playing" would never be played.
      this.playing = false
    }
  }
}
