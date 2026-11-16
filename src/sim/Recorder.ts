import type { Faction } from '../config'
import type { NetworkMessage } from '../wire/NetworkMessage'
import { type CombatRecording, type RecordedEvent, type RecordingHeader, SESSION_COMMANDS } from '../wire/Recording'

/** Where the recorder reads the turn context it stamps onto each event. */
export type RecordingClock = () => { turn: number; faction: Faction }

export class Recorder {
  private readonly events: RecordedEvent[] = []

  constructor(
    private readonly header: RecordingHeader,
    private readonly clock: RecordingClock,
  ) {}

  get eventCount(): number {
    return this.events.length
  }

  /**
   * Append a command.
   *
   * Copied structurally, because a caller is free to reuse the object it
   * handed over — and a recording that aliased live state would rewrite its
   * own past.
   */
  record(command: NetworkMessage): void {
    if (SESSION_COMMANDS[command.type]) return
    const { turn, faction } = this.clock()
    this.events.push({
      seq: this.events.length,
      turn,
      faction,
      command: structuredClone(command),
    })
  }

  clear(): void {
    this.events.length = 0
  }

  toJSON(): CombatRecording {
    return { header: this.header, events: this.events }
  }

  filename(): string {
    return `tictac-${this.header.source}-${this.header.seedLabel}-${this.events.length}.json`
  }
}
