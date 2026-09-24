import type { Faction } from '../config'
import type { Combatant } from './Combatant'
import type { Tile } from './Grid'

/**
 * Sound, as the rules model it.
 *
 * A noise has a source tile and a **loudness**, stated as the distance in
 * metres at which an ordinary ear can just hear it. It falls off with the
 * square of distance — intensity `L² / d²` against an ear's threshold — so a
 * noise four times as loud carries twice as far, which is how a gunshot and a
 * footstep differ. Every listener has its own threshold: **hearing** is a
 * multiplier on the distance it hears anything at (Intelligence sets it; see
 * `CHARACTER.hearing`), so a sharp ear hears a crouched step beside it that a
 * dull one misses.
 *
 * Distance only, not ray-marching: walls do not muffle. Sound gets round
 * corners and through doors, which is what makes it a different channel from
 * sight rather than a worse copy of it.
 *
 * Deterministic by construction: squared tile distances against a squared
 * range, nothing but multiplication, so two peers agree about who heard what.
 *
 * What hearing *gives* is deliberately little: that something is there,
 * roughly where (see {@link roughly}). Never a firing solution — a shot still
 * needs sight.
 */

/** Loudness of the things that are not weapons, in metres an ordinary ear hears them at. */
export const NOISE = {
  /** A standing step. Carries a few tiles. */
  step: 4,
  /**
   * A crouched step: heard beside you by a sharp ear, not by an ordinary one.
   * Just under a metre, because a neighbouring tile is exactly one away and an
   * ordinary ear must not catch it.
   */
  crouchStep: 0.9,
  /** What a suppressor leaves of a shot's loudness. */
  suppressed: 0.25,
  /** How coarse "roughly where" is: noises are placed to the middle of a block this many tiles wide. */
  blur: 3,
}

/** Something made a sound. */
export interface Noise {
  at: Tile
  /** Metres an ordinary ear hears it at. */
  loudness: number
  /** Whose noise it was: only the other side is listening for it. */
  faction: Faction
}

/** A listener: where it stands, how well it hears, and whether it can. */
export interface Ear {
  tile: Tile
  readonly faction: Faction
  readonly isDead: boolean
  /** Multiplier on the distance this ear hears anything at; 1 is ordinary. */
  readonly hearing: number
}

/** Whether `ear` hears `noise`. Nobody listens for their own side. */
export function hears(ear: Ear, noise: Noise): boolean {
  if (ear.isDead || ear.faction === noise.faction) return false
  const dx = ear.tile.x - noise.at.x
  const dy = ear.tile.y - noise.at.y
  const reach = noise.loudness * ear.hearing
  return dx * dx + dy * dy <= reach * reach
}

/**
 * Where a noise seemed to come from: the middle of the {@link NOISE.blur}-wide
 * block it was made in. Enough to know which room, not which tile — a hint to
 * go and look, never a place to shoot at.
 */
export function roughly(at: Tile): Tile {
  const b = NOISE.blur
  const half = (b - 1) / 2
  return { x: Math.floor(at.x / b) * b + half, y: Math.floor(at.y / b) * b + half }
}

/**
 * What one step makes, from the stance it is taken in. The move preview and
 * the rules both ask here, so the route a player is shown as quiet is quiet.
 */
export function stepLoudness(crouching: boolean): number {
  return crouching ? NOISE.crouchStep : NOISE.step
}

/** What a shot from `shooter`'s weapon makes: its own report, less what a suppressor takes off. */
export function shotLoudness(shooter: Combatant): number {
  return shooter.weapon.loudness * (shooter.silenced ? NOISE.suppressed : 1)
}
