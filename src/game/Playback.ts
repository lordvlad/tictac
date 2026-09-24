import { PLAYBACK } from '../config'
import type { CombatRecording } from './Recording'
import type { NetworkMessage } from './NetworkManager'
import type { Moment } from './Rewind'

export type PlaybackSpeed = 0.5 | 1 | 2

export interface PlaybackDeps {
  recording: CombatRecording
  /** Apply one recorded command to the match. */
  apply: (command: NetworkMessage) => void
  /** True while something is still animating; the next event waits for false. */
  busy: () => boolean
  capture: () => Moment
  restore: (frame: Moment) => void
}

/**
 * Where a replay has got to, and how fast it is getting there.
 *
 * Owns only the clock. It never touches a soldier, a component or the scene:
 * applying a command and putting state back are both handed in, so the same
 * class paces a rendered replay and could pace a headless one.
 *
 * Stepping *forward* is cheap — it is the command stream, played on. Stepping
 * *backward* is not possible at all by replaying, because nothing a command
 * does can be undone: damage is applied, points are spent, statuses stack. So
 * every boundary crossed is kept, and going back means putting one of them
 * back. Frames are only ever taken while nothing is animating, which is why a
 * restored moment never has a unit half-way between two tiles.
 */
export class Playback {
  readonly total: number

  /** `frames[i]` is the state immediately before event `i` was applied. */
  private readonly frames: Moment[] = []
  private cursor = 0
  private running = false
  private rate: PlaybackSpeed = 1
  private dwell = 0

  onChanged?: () => void

  constructor(private readonly deps: PlaybackDeps) {
    this.total = deps.recording.events.length
    this.frames.push(deps.capture())
  }

  get index(): number {
    return this.cursor
  }

  get playing(): boolean {
    return this.running
  }

  get speed(): PlaybackSpeed {
    return this.rate
  }

  get finished(): boolean {
    return this.cursor >= this.total
  }

  /** The turn the next event belongs to, or the last one's once it is over. */
  get turn(): number {
    const events = this.deps.recording.events
    return events[this.cursor]?.turn ?? events[events.length - 1]?.turn ?? 1
  }

  get turns(): number {
    const events = this.deps.recording.events
    let highest = 1
    for (const event of events) if (event.turn > highest) highest = event.turn
    return highest
  }

  play(speed: PlaybackSpeed): void {
    this.rate = speed
    if (this.finished) return
    this.running = true
    this.onChanged?.()
  }

  pause(): void {
    this.running = false
    this.onChanged?.()
  }

  /**
   * Apply the next event, then stop. A move still animates out.
   *
   * Refused while something is animating: the event already in flight is the
   * step being watched, and dispatching over it would both skip past it and
   * take a boundary snapshot of a unit standing between two tiles.
   */
  stepForward(): void {
    this.running = false
    if (!this.deps.busy()) this.applyNext()
    this.onChanged?.()
  }

  /** Put back the boundary before the previous event, then stop. */
  stepBackward(): void {
    this.running = false
    if (this.cursor === 0) return
    const frame = this.frames[this.cursor - 1]
    if (!frame) return
    this.deps.restore(frame)
    this.cursor -= 1
    this.frames.length = this.cursor + 1
    this.dwell = PLAYBACK.eventDwell
    this.onChanged?.()
  }

  /**
   * Advance the clock.
   *
   * `delta` is expected to have been scaled by {@link speed} already, so the
   * animations and the event pacing speed up together — a 2× replay that only
   * dispatched faster would show the same walk at the same pace with less
   * breathing room between moves.
   */
  update(delta: number): void {
    if (!this.running) return
    if (this.finished) {
      this.pause()
      return
    }
    // A unit mid-stride is the pacing: nothing is dispatched over the top of it.
    if (this.deps.busy()) return

    this.dwell -= delta
    if (this.dwell > 0) return
    this.applyNext()
    if (this.finished) this.pause()
    else this.onChanged?.()
  }

  private applyNext(): void {
    const event = this.deps.recording.events[this.cursor]
    if (!event) return
    // Taken before the command lands — and only ever here, where nothing is
    // animating — so this is exactly what stepping back one event returns to.
    this.frames[this.cursor] ??= this.deps.capture()
    this.deps.apply(event.command)
    this.cursor += 1
    this.dwell = PLAYBACK.eventDwell
  }
}
