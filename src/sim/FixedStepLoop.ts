/**
 * Turns the engine's variable frames into the fixed steps the rules run in.
 *
 * The same accumulator was copied into every screen that ticks a match; one
 * copy means one place the catch-up ceiling and the leftover are right.
 *
 * Time arriving faster than `maxCatchUp` is dropped, not owed: browsers hand a
 * hidden tab seconds at once, and running them all back to back would be a
 * lurch where a pause belongs.
 */
export class FixedStepLoop {
  private accumulator = 0

  /**
   * @param onStep Called once per whole step, with the step length.
   * @param scale Multiplier on incoming time, read every frame. It goes into
   *   the accumulator rather than into whatever `onStep` paces, so a replay at
   *   2x runs its animations fast along with its dispatch.
   */
  constructor(
    private readonly step: number,
    private readonly maxCatchUp: number,
    private readonly onStep: (step: number) => void,
    private readonly scale: () => number = () => 1,
  ) {}

  /** Feed one frame's elapsed seconds; runs as many steps as it completes. */
  advance(delta: number): void {
    this.accumulator = Math.min(this.accumulator + delta * this.scale(), this.maxCatchUp)
    while (this.accumulator >= this.step) {
      this.accumulator -= this.step
      this.onStep(this.step)
    }
  }
}
