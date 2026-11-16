/**
 * Time, and a way to be woken at one: what the Durable Object's alarm is on
 * Cloudflare, and a timer on the Bun server.
 *
 * A host builds one and hands it to every store and service it constructs, so
 * a squad's route, a handover's expiry and a session's lifetime are all read
 * off the same hands — and a test that turns them by hand turns all of them.
 * Nothing else under `src/server` or `workers` reads the system clock.
 */
export interface ServerClock {
  now(): number
  /** Run `fn` in `ms`; returns what cancels it. */
  schedule(fn: () => void, ms: number): () => void
}

/** The wall clock and `setTimeout`: what a host runs on unless a test turns the clock itself. */
export const WALL_CLOCK: ServerClock = {
  now: () => Date.now(),
  schedule: (fn, ms) => {
    const timer = setTimeout(fn, ms)
    return () => clearTimeout(timer)
  },
}
