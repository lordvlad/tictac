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
 */
export const PROTOCOL_VERSION = 1

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
 * Why this peer will not play against `theirs`, or `null` when it will.
 *
 * Peer input, so it is checked rather than trusted — and note that a peer
 * predating the gate states nothing at all, which is itself a refusal: a build
 * old enough to omit its version is certainly old enough to disagree about the
 * rules.
 *
 * Returns prose because the reason is shown to a player. "Refused" on its own
 * is indistinguishable from a broken connection, and the whole point of
 * refusing here is that the cause is knowable.
 */
export function versionRefusal(theirs: unknown, mine: PeerVersion = MY_VERSION): string | null {
  if (!theirs || typeof theirs !== 'object') {
    return 'The other player is running an older build that does not report its version.'
  }
  const stated = theirs as Partial<PeerVersion>
  if (typeof stated.protocol !== 'number' || !Number.isFinite(stated.protocol)) {
    return 'The other player is running an older build that does not report its version.'
  }
  if (stated.protocol !== mine.protocol) {
    return `Protocol mismatch: this build speaks ${mine.protocol}, the other player speaks ${stated.protocol}. One of you needs to reload.`
  }
  if (typeof stated.build !== 'string' || stated.build.length === 0) {
    return 'The other player did not report which build they are running.'
  }
  if (stated.build !== mine.build) {
    return `Build mismatch: this page is running ${mine.build}, the other player is running ${stated.build}. Both of you need to reload to the same version.`
  }
  return null
}
