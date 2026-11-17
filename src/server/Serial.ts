/**
 * A queue that runs one piece of work at a time, in the order it was handed
 * over: what several writers of the same rows share so none reads a route
 * another is about to write (`Journeys`, `Crossings`). A piece of work that
 * fails fails its own caller and does not stop those behind it.
 */
export type Serially = <T>(work: () => Promise<T>) => Promise<T>

export function serial(): Serially {
  let queue: Promise<unknown> = Promise.resolve()
  return (work) => {
    const done = queue.then(work)
    queue = done.catch(() => {})
    return done
  }
}
