/**
 * Which match server owns what (RFC-0002 §5): the one lookup that a world
 * split into regions (`ITEM-046`) replaces.
 *
 * One Durable Object holds the whole world today, so the answer is always
 * the same. What matters is that nothing names that instance directly: the
 * Worker routes through `MATCH_SERVER`, and squad requests through
 * `ownerOf`, so splitting the world means changing these and nothing that
 * calls them.
 */

/**
 * The Durable Object every connection reaches today. Its name is the
 * deployment's identity, not a label: renaming it would address a new, empty
 * object and leave every player and room behind in the old one.
 */
export const MATCH_SERVER = 'singleton'

/** The match server that owns `squad`: the one there is, until the world is split. */
export function ownerOf(_squad: { id: string }): string {
  return MATCH_SERVER
}
