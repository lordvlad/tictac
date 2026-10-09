/**
 * Every moment the match server has to wake for, behind the host's one alarm
 * (GDD-WORLD §3, `ITEM-064`).
 *
 * A Durable Object has a single alarm, and the world has many squads, each
 * with something due: an arrival today; a checkpoint's encounter roll
 * (`ITEM-048`) or a planned meeting of two routes (`ITEM-053`) later. This
 * keeps the next due moment of each kind for each entity and arms the alarm
 * for the earliest of them all. One mechanism, so those later kinds are a
 * handler each rather than a second scheduler.
 *
 * The alarm is never armed further ahead than `MAX_SLEEP_MS`: a far-future
 * alarm is one wrong clock or one lost write from never firing, and an hourly
 * look costs nothing when nothing is due. Handlers are told the moment their
 * work was due, not when the alarm went off, so lateness never piles up.
 *
 * The host supplies the clock and the alarm: `ctx.storage.setAlarm` on the
 * Durable Object, a timer on the Bun server, a hand-turned clock in a test.
 */

/** The longest the host's alarm is ever set ahead. */
export const MAX_SLEEP_MS = 3_600_000

/** What runs when a moment of its kind falls due: `id` is the entity, `at` when it was due. */
export type DueHandler = (id: string, at: number) => Promise<void>

export interface ScheduleHost {
  now(): number
  /** Arm the host's one alarm for `at`, replacing any other; null disarms it. */
  arm(at: number | null): void
}

interface Due {
  kind: string
  id: string
  at: number
}

export class Schedule {
  private readonly due = new Map<string, Due>()
  private readonly handlers = new Map<string, DueHandler>()
  /** One firing at a time: a timer that goes off while a slow firing is still writing waits for it. */
  private firing: Promise<void> = Promise.resolve()

  constructor(private readonly host: ScheduleHost) {}

  /** Who handles moments of `kind`. */
  handle(kind: string, handler: DueHandler): void {
    this.handlers.set(kind, handler)
  }

  /** `id`'s next moment of `kind` is `at`, replacing whatever was due before. */
  set(kind: string, id: string, at: number): void {
    this.due.set(keyOf(kind, id), { kind, id, at })
    this.arm()
  }

  /** Nothing of `kind` is due for `id` any more. */
  clear(kind: string, id: string): void {
    if (this.due.delete(keyOf(kind, id))) this.arm()
  }

  /**
   * The alarm went off: run every moment due by now, earliest first, each
   * removed before its handler runs so the handler can set the next one, then
   * arm for whatever is left. The earliest is looked for again after every
   * handler, so a moment a handler sets that falls before the others still
   * due runs before them: time order holds across everything, not only
   * within what was due when the alarm went off.
   */
  fire(): Promise<void> {
    this.firing = this.firing.then(async () => {
      const now = this.host.now()
      for (let due = this.earliestBy(now); due; due = this.earliestBy(now)) {
        this.due.delete(keyOf(due.kind, due.id))
        await this.handlers.get(due.kind)?.(due.id, due.at)
      }
      this.arm()
    })
    return this.firing
  }

  private earliestBy(now: number): Due | null {
    let earliest: Due | null = null
    for (const due of this.due.values()) {
      if (due.at <= now && (earliest === null || due.at < earliest.at)) earliest = due
    }
    return earliest
  }

  private arm(): void {
    let earliest: number | null = null
    for (const due of this.due.values()) earliest = earliest === null ? due.at : Math.min(earliest, due.at)
    this.host.arm(earliest === null ? null : Math.min(earliest, this.host.now() + MAX_SLEEP_MS))
  }
}

function keyOf(kind: string, id: string): string {
  return `${kind}\u0000${id}`
}
