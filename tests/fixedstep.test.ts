import { describe, expect, test } from 'bun:test'
import { FixedStepLoop } from '../src/sim/FixedStepLoop'

// Powers of two throughout, so the accumulator's remainders are exact.
describe('FixedStepLoop', () => {
  test('runs whole steps and carries the remainder to the next frame', () => {
    const steps: number[] = []
    const loop = new FixedStepLoop(0.25, 4, (step) => steps.push(step))

    loop.advance(0.625)
    expect(steps).toEqual([0.25, 0.25])

    // The 0.125 left over completes a step with the next 0.125.
    loop.advance(0.125)
    expect(steps).toHaveLength(3)
  })

  test('drops time beyond the catch-up ceiling rather than owing it', () => {
    let ticks = 0
    const loop = new FixedStepLoop(0.25, 1, () => ticks++)

    loop.advance(30)
    expect(ticks).toBe(4)

    loop.advance(0)
    expect(ticks).toBe(4)
  })

  test('scales incoming time by the factor read at each frame', () => {
    let speed = 1
    let ticks = 0
    const loop = new FixedStepLoop(0.25, 16, () => ticks++, () => speed)

    loop.advance(1)
    expect(ticks).toBe(4)

    speed = 2
    loop.advance(1)
    expect(ticks).toBe(12)
  })
})
