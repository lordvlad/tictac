import type { ServerClock } from '../../src/server/Clock'

/** A `ServerClock` the test turns by hand: it reads what it was set to and runs a timer only when `advance` passes it. */
export interface TurnedClock extends ServerClock {
  /** Move time on by `ms`, running every timer that falls due on the way, in order. */
  advance(ms: number): void
}

export function turnedClock(start = 0): TurnedClock {
  let at = start
  const timers: { due: number; fn: () => void; live: boolean }[] = []
  return {
    now: () => at,
    schedule(fn, ms) {
      const timer = { due: at + ms, fn, live: true }
      timers.push(timer)
      return () => {
        timer.live = false
      }
    },
    advance(ms) {
      const until = at + ms
      for (;;) {
        const next = timers.filter((timer) => timer.live && timer.due <= until).sort((a, b) => a.due - b.due)[0]
        if (!next) break
        at = next.due
        next.live = false
        next.fn()
      }
      at = until
    },
  }
}
