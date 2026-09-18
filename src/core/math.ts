/**
 * Small numeric helpers shared by camera, planner and effects code.
 *
 * These exist because each formula had three or more copies that must stay in
 * lockstep — a divergent clamp or a hand-inlined easing curve is invisible in
 * review but shows up as a jerk on screen.
 */

/** Constrain `value` to the inclusive `[min, max]` range. */
export function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value
}

/**
 * Hermite ease of `t` clamped to `[0, 1]`: flat at both ends, steepest in the
 * middle. Used for every "start gently, finish gently" ramp in the game.
 */
export function smoothstep(t: number): number {
  const x = t < 0 ? 0 : t > 1 ? 1 : t
  return x * x * (3 - 2 * x)
}

/**
 * Straight-line distance, from squares and one square root.
 *
 * Deliberately not `Math.hypot`. IEEE 754 requires `sqrt` to be correctly
 * rounded, so two engines agree on it bit for bit; `Math.hypot` is a library
 * routine whose accuracy is implementation-defined, and it feeds every range
 * check, hit chance and blast radius in the game. Under
 * [ADR-0004](../../docs/design/adr/0004-full-knowledge-lockstep.md) both peers
 * recompute a match, so a last-bit disagreement about a distance is a
 * disagreement about whether a shot was in range at all.
 *
 * Overflow is why `hypot` exists, and it cannot happen here: these are tile
 * and metre coordinates on a grid tens of units across.
 */
export function distance(dx: number, dy: number, dz = 0): number {
  return Math.sqrt(dx * dx + dy * dy + dz * dz)
}

/** Rounding step for a stored facing: about a twentieth of a degree. */
const FACING_STEP = 1000

/**
 * The yaw that points along `(dx, dz)`, quantised.
 *
 * `Math.atan2` is implementation-defined to the last bit, and a facing is not
 * a private detail: it is replicated, it is part of the state digest, and a
 * future melee rule wants to ask whether an attack came from behind. Rounding
 * to a step far finer than anything a player can see makes it a number two
 * engines cannot disagree about.
 */
export function facingYaw(dx: number, dz: number): number {
  return Math.round(Math.atan2(dx, dz) * FACING_STEP) / FACING_STEP
}
