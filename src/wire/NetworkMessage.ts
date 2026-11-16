import type { Faction } from '../config'
import type { Command } from '../rules/Command'
import type { Deployment } from '../core/Loadout'
import type { StateDigest } from '../rules/StateDigest'
import type { RecordedEvent, RecordingHeader } from './Recording'

/** A match so far, as a match server states it to a socket taking a seat in it or watching it. */
export interface MatchLog {
  matchId: string
  header: RecordingHeader
  events: RecordedEvent[]
}

/**
 * Everything one side says to the other: session frames around the commands.
 *
 * Only intent travels (ADR-0004), so the commands themselves are the rules'
 * ({@link Command}); what this adds is the handshake, the digest, the header a
 * referee needs and the verdicts.
 */
export type NetworkMessage = SessionMessage | Command

type SessionMessage =
  // Both first frames state the build they came from: the host's `init` and
  // the joiner's `hello`. A match between two different builds is refused
  // before it starts — see `src/version.ts`.
  | { type: 'init'; seed: number; seedLabel: string; protocol: number; build: string }
  | { type: 'hello'; protocol: number; build: string }
  /**
   * A fingerprint of the sender's whole world, sent immediately before it hands
   * over. Not an intent: it asks the other side to *do* nothing, and it is not
   * recorded, because a replay derives its state rather than checking it.
   */
  | { type: 'digest'; digest: StateDigest }
  /**
   * The opening position, stated to a referee.
   *
   * A referee refights the match from its intents, so it needs what the
   * intents are *about*: the seed, both squads' people and both squads' kit.
   * None of that is derivable from the stream — a loadout reaches a peer as
   * replicated component state, which is state its owner is authoritative for
   * rather than something anybody declared — so a refereed match declares it
   * once, at the start.
   */
  | { type: 'matchHeader'; header: RecordingHeader }
  /**
   * The match so far: its opening position and every intent the referee has
   * accepted. Sent by a match server to a socket that is seated in a match
   * already playing, or watching one — which is how a second window takes a
   * match over and how a spectator catches up (`src/wire/Lobby.ts`). Follows
   * the answer to `room/enter` (`src/wire/Rpc.ts`), never asked for itself.
   */
  | { type: 'log'; matchId: string; header: RecordingHeader; events: RecordedEvent[] }
  /**
   * The match is over because it stopped being one match.
   *
   * Named side and stated reason, because "desynchronised" is not something a
   * player can act on — and because a verdict nobody can read is indistinguishable
   * from a crash.
   */
  | { type: 'abort'; reason: string; side: Faction | null }
  /**
   * This side has finished equipping: its people, what they are carrying, and
   * what state they start in — one entry per soldier.
   *
   * The kit rides along because a referee refights the match from its intents
   * and a loadout is not one of them — it reaches a *peer* as replicated
   * component state, which is state its owner is authoritative for rather than
   * something anybody declared. Both sides know who they brought at exactly
   * this moment, and not before.
   *
   * State's `hp` is the same reasoning applied to wounds: absent everywhere
   * except a kept server match, where a starting HP has to be something both
   * peers and the referee agree on before the first digest, or the referee
   * accuses an honest client of a foul.
   */
  | { type: 'ready'; squad: Deployment[] }
