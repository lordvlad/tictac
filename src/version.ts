/**
 * What build this is, and whether another peer's build can be played against.
 *
 * Two peers that run different code diverge for entirely innocent reasons, and
 * this project deploys on every push — so a player whose browser cached
 * yesterday's bundle is the *ordinary* case, not an exotic one. Under
 * [ADR-0004](../docs/design/adr/0004-full-knowledge-lockstep.md) a match is a
 * stream of intents that both sides recompute, which makes "we run the same
 * rules" a precondition rather than a nicety: once disagreement is grounds for
 * naming a cheat, a stale cache would be the first thing accused.
 *
 * So mismatched builds are refused at the door. That turns the whole class into
 * a connection error with a stated cause, before it can become a foul with a
 * wronged party.
 */

/**
 * Bumped by hand when the shape of the wire changes.
 *
 * Distinct from the build id on purpose: it says *how* two peers failed to
 * match. A protocol difference means one side cannot even parse what the other
 * sends; a build difference means they agree on the envelope and might still
 * resolve a shot differently.
 *
 * 3: `ready` carries one `Deployment[]` (`ITEM-043`) instead of separate
 * `sheets`, `loadout` and `hp` fields — a peer speaking version 2 states a
 * shape this build no longer parses.
 *
 * 4: the `retreat` command, and `health.withdrawn` on every unit (`ITEM-051`).
 *
 * 5: `throwGrenade` carries `targetLevel`, the storey aimed at, which decides
 * whether the throw is lobbed or thrown low under a roof.
 */
export const PROTOCOL_VERSION = 5

/**
 * The commit this bundle was built from, or `dev` when it was not built.
 *
 * Injected at build time by `bun build --define:__BUILD_ID__`. `typeof` rather
 * than a direct read because the identifier genuinely does not exist in a
 * development server's bundle, where no define ran.
 */
export const BUILD_ID: string =
  typeof __BUILD_ID__ === 'string' && __BUILD_ID__.length > 0 ? __BUILD_ID__ : 'dev'

declare const __BUILD_ID__: string | undefined

/** What a peer states about itself when it opens a connection. */
export interface PeerVersion {
  protocol: number
  build: string
}

export const MY_VERSION: PeerVersion = { protocol: PROTOCOL_VERSION, build: BUILD_ID }

/**
 * Who the two sides of a refusal are, in words the player reading it can use.
 *
 * The same gate runs in three places and the player is not in the same seat in
 * each: between two peers, "the other player" is another browser; on a
 * referee, the refusal is written by the server and read by the client it just
 * turned away, so "this build" would name the wrong machine. Naming both sides
 * explicitly is what makes a mismatch diagnosable rather than merely fatal —
 * `[ITEM-045]`'s deploy shipped a Worker stamped `dev` against a client
 * stamped with its commit, and the refusal said "this page is running dev",
 * which is the one thing that was not true.
 */
export interface VersionVoices {
  /** The side doing the refusing, as the reader should think of it. */
  mine: string
  /** The side being refused. */
  theirs: string
  /** What the reader can do about it. */
  remedy: string
}

/** Two browsers, refusing each other directly. */
export const PEER_VOICES: VersionVoices = {
  mine: 'this page',
  theirs: 'the other player',
  remedy: 'Both of you need to reload to the same version.',
}

/**
 * A referee refusing a client. The reader is the client, so `theirs` is the
 * page they are looking at and `mine` is the server that turned it away.
 */
export const SERVER_VOICES: VersionVoices = {
  mine: 'the match server',
  theirs: 'this page',
  remedy:
    'Reload the page. If it still says this, the server is serving a client it was not deployed with and has to be redeployed.',
}

/**
 * Why this peer will not play against `theirs`, or `null` when it will.
 *
 * Peer input, so it is checked rather than trusted — and note that a peer
 * predating the gate states nothing at all, which is itself a refusal: a build
 * old enough to omit its version is certainly old enough to disagree about the
 * rules.
 *
 * Returns prose because the reason is shown to a player. "Refused" on its own
 * is indistinguishable from a broken connection, and the whole point of
 * refusing here is that the cause is knowable — so every refusal that *has*
 * two versions to compare quotes both of them, labelled by who is running
 * which.
 */
export function versionRefusal(
  theirs: unknown,
  mine: PeerVersion = MY_VERSION,
  voices: VersionVoices = PEER_VOICES,
): string | null {
  const subject = voices.theirs.charAt(0).toUpperCase() + voices.theirs.slice(1)
  const unreported = `${subject} is running an older build that does not report its version. ${voices.remedy}`
  if (!theirs || typeof theirs !== 'object') return unreported
  const stated = theirs as Partial<PeerVersion>
  if (typeof stated.protocol !== 'number' || !Number.isFinite(stated.protocol)) return unreported
  if (stated.protocol !== mine.protocol) {
    return `Protocol mismatch: ${voices.mine} speaks protocol ${mine.protocol}, ${voices.theirs} speaks protocol ${stated.protocol}. ${voices.remedy}`
  }
  if (typeof stated.build !== 'string' || stated.build.length === 0) {
    return `${subject} did not report which build it is running. ${voices.remedy}`
  }
  if (stated.build !== mine.build) {
    return `Build mismatch: ${voices.mine} is running build ${mine.build}, ${voices.theirs} is running build ${stated.build}. ${voices.remedy}`
  }
  return null
}
