import { PLAYBACK } from '../config'
import type { CombatRecording } from '../wire/Recording'
import type { NetworkMessage } from '../wire/NetworkMessage'
import type { Moment, Rewindable } from '../sim/Rewind'
import type { PlaybackSpeed } from '../ui/Playback'

/** The match as it is now. Only between commands: nothing walking, nothing queued. */
function captureMoment(match: Rewindable): Moment {
  return {
    units: match.world.snapshot(match.unitIds),
    walls: match.walls.kinds(match.world),
    ground: match.world.snapshot([match.ground.entity]),
    dice: match.dice.snapshot(),
    activeFaction: match.turns.activeFaction,
    turnNumber: match.turns.turnNumber,
  }
}

/**
 * Put the match back to `moment`.
 *
 * Private to this module on purpose: it writes the world, the walls, the
 * ground, the dice and the turn straight past the command path, which is only
 * acceptable while presenting a recording. Nothing that plays a live match can
 * import it.
 *
 * Routes first: a unit's path is the one piece of movement state that is not
 * a component, so a restored unit would otherwise walk on along a path it is
 * no longer on. The same for whatever the rules had queued for a broken unit:
 * it was decided about the moment being left.
 */
function restoreMoment(match: Rewindable, moment: Moment): void {
  match.movement.clearRoutes(match.world, match.unitIds)
  match.commands.clear()
  match.world.restore(moment.units)
  match.walls.restoreKinds(match.world, moment.walls)
  match.world.restore(moment.ground)
  // The grid is an index over the ground component; catch it up now rather
  // than on the next tick, so the restored moment is whole at once.
  match.ground.update(0, match.world)
  match.dice.restore(moment.dice)
  match.turns.activeFaction = moment.activeFaction
  match.turns.turnNumber = moment.turnNumber
}

export interface PlaybackDeps {
  recording: CombatRecording
  /** Apply one recorded command to the match. */
  apply: (command: NetworkMessage) => void
  /** True while something is still animating; the next event waits for false. */
  busy: () => boolean
  /** The match, as the parts a moment is taken from and put back into. */
  match: Rewindable
  /** The view's catch-up after a moment is put back: selection, fog, scene. */
  afterRestore: () => void
}

/**
 * Owns the clock and the only way back. It never touches a soldier, a component
 * or the scene: applying a command and catching the view up are handed in.
 * Putting state back (`restoreMoment`) is done here and nowhere else — a rewind
 * is the presentation of a recording, never a move in live play, so no match,
 * host or controller is given a way to do it.
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
    this.frames.push(captureMoment(deps.match))
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
    restoreMoment(this.deps.match, frame)
    this.deps.afterRestore()
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
    this.frames[this.cursor] ??= captureMoment(this.deps.match)
    this.deps.apply(event.command)
    this.cursor += 1
    this.dwell = PLAYBACK.eventDwell
  }
}
