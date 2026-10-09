import type { Faction } from '../config'
import { frameOf, messageOf, type JsonRpcFrame, type JsonRpcNotification } from '../game/JsonRpc'
import type { NetworkMessage } from '../game/NetworkManager'
import type { Transport } from '../game/Transport'
import { AiPlayer } from '../sim/AiPlayer'
import { MatchHost } from '../sim/MatchHost'
import type { StandingOrder } from '../sim/Policy'

/**
 * The game's own player, in a seat of a room (`ITEM-048`).
 *
 * A seat is a socket, so this is one: the room holds one end of a
 * `loopback()` as an ordinary `Client` and this holds the other. It is the
 * browser's opponent (`AiOpponent`) generalised, and it is a *client*, not the
 * referee: the room relays to it and judges what it sends exactly as it does
 * a window's, so an AI that played badly or wrongly would be found out the
 * way any seat is, and its match is recorded, replayed and settled like any
 * other.
 *
 * It learns the match the way a window taking a match over does — from the
 * `log` the room hands every socket it seats in a match being played, a
 * header and every intent so far — builds a world from it, and plays its side
 * whenever it is that side's turn. It may be seated at any moment of a match,
 * on either side: at the start of a fight nobody is present for, or in the
 * middle of one, for a player whose window left (`Room.passToAi`), or after a
 * server restarted.
 *
 * Not `NetworkManager`, which does the same job for a window: that drags the
 * browser's WebRTC library into whatever imports it, and a Worker has none to
 * give it. Everything it needs of the wire is `frameOf` and `messageOf`.
 *
 * It never draws from the match's dice (`matchDice`): it draws nothing, and
 * every choice is a function of the world it holds.
 */

export interface AiSeatOptions {
  /** For a line in a server log. */
  log: (message: string) => void
  /** What the seat fights to; the player's standing order, once there is one to read (`ITEM-052`). */
  order?: StandingOrder
  /** After which turn it gets out of a stalemate (`AiPlayerOptions.turnLimit`). */
  turnLimit?: number
  /**
   * The seat can play no more — it could not learn the match, or its policy
   * gave up — and nobody else will: said once, for the room to call the fight
   * off rather than hold a player to a seat nothing is moving.
   */
  stuck: (problem: string) => void
}

export class AiSeat {
  private player: AiPlayer | null = null
  private ended = false

  /**
   * Sit at `faction`'s side of whichever match the room at the other end of
   * `transport` plays. Nothing happens until the room states it.
   */
  constructor(
    private readonly faction: Faction,
    private readonly transport: Transport,
    private readonly options: AiSeatOptions,
  ) {
    transport.onFrame((frame) => this.receive(frame))
    transport.onClosed(() => this.dispose())
  }

  /** Get up: nothing more is played or said, and what the room says after is not heard. */
  dispose(): void {
    if (this.ended) return
    this.ended = true
    this.player?.stop()
    this.transport.close()
  }

  private receive(frame: JsonRpcFrame): void {
    if (this.ended || !('method' in frame)) return
    const message = messageOf(frame.method, (frame as JsonRpcNotification).params as Record<string, unknown>)
    if (!message) return
    if (message.type === 'abort') {
      this.dispose()
    } else if (message.type === 'log') {
      if (!this.player) this.sit(message)
    } else {
      this.player?.hear(message)
    }
  }

  /** Build the match from the room's log and, if it is this side's turn, play. */
  private sit(log: Extract<NetworkMessage, { type: 'log' }>): void {
    const host = new MatchHost(log.header)
    for (const event of log.events) {
      const applied = host.apply(event.command)
      if (applied.applied) continue
      const problem = `could not rebuild the match, a logged ${event.command.type} was refused (${applied.reason})`
      this.options.log(`ai seat ${log.matchId}: ${problem}`)
      this.dispose()
      this.options.stuck(problem)
      return
    }
    this.player = new AiPlayer(host, {
      faction: this.faction,
      send: (message) => this.transport.send(frameOf(message)),
      diverged: (what, found) =>
        this.options.log(`ai seat ${log.matchId}: ${what}: ${found.length} difference(s) from the other side`),
      failed: (problem) => this.options.log(`ai seat ${log.matchId}: ${problem}`),
      stalled: (problem) => this.options.stuck(problem),
      order: this.options.order,
      turnLimit: this.options.turnLimit,
    })
    this.player.consider()
  }
}
