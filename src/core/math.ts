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
