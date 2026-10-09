import type { LatLng } from '../core/Travel'
import type { EncounterEntry, EncounterResult, EncounterStarted, PassedFor } from '../game/Encounter'
import type { LobbyView } from '../game/Lobby'

/**
 * What a window says about the wild encounters on the road (`ITEM-048`): the
 * join prompt, the panel's rule about taking a seat over, and the return feed.
 *
 * Plain functions of what the server told this window and of the server's
 * clock, with no DOM, so every wording and every rule here is tested
 * directly; `EncounterPrompt.tsx` and `EncounterFeed.tsx` only draw them.
 */

const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS

/** Time left to take a fight, as a clock reads: `0:42`. Never below `0:00`, and rounded up so `0:00` means it is over. */
export function formatCountdown(msLeft: number): string {
  const seconds = Math.ceil(Math.max(0, msLeft) / 1000)
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

/** How long ago something was, in the largest unit that is not zero; a clock that is a little ahead reads "just now". */
export function ago(at: number, now: number): string {
  const elapsed = now - at
  if (elapsed < MINUTE_MS) return 'just now'
  if (elapsed < HOUR_MS) return `${Math.floor(elapsed / MINUTE_MS)} min ago`
  if (elapsed < DAY_MS) return `${Math.floor(elapsed / HOUR_MS)} h ago`
  return `${Math.floor(elapsed / DAY_MS)} d ago`
}

/** Where on the planet, rounded to what a player can compare by eye; there is no geocoder behind it. */
export function placeLabel(place: LatLng): string {
  const lat = `${Math.abs(place.lat).toFixed(2)}° ${place.lat < 0 ? 'S' : 'N'}`
  const lng = `${Math.abs(place.lng).toFixed(2)}° ${place.lng < 0 ? 'W' : 'E'}`
  return `${lat}, ${lng}`
}

/** The question the join prompt is asking right now, if any. */
export type Prompt =
  /** A fight is theirs to take until `joinBy` (the server's clock). */
  | { kind: 'offer'; roomId: string; joinBy: number }
  /** The window passed, or the AI already sits: the AI is fighting for the squad. */
  | { kind: 'ai'; roomId: string }

/**
 * What to ask the player, from what this window knows.
 *
 * `you` is the lobby's word on this player's seat — `undefined` before any
 * lobby view has arrived, which is when only `pushed` (the
 * `encounter/started` push) can say a fight is waiting; a window that
 * connected after the push learns the same from `control: 'reserved'`. Where
 * the two disagree the lobby is right: it is the server's state now, the push
 * only its word at one moment. `now` is the server's clock.
 */
export function promptFor(input: {
  pushed: EncounterStarted | null
  you: LobbyView['you'] | undefined
  now: number
}): Prompt | null {
  const { pushed, you, now } = input
  if (you) {
    // A seat the player holds is a match, not a question.
    if (you.control === 'player') return null
    if (you.control === 'reserved' && you.joinBy !== null && now < you.joinBy) {
      return { kind: 'offer', roomId: you.roomId, joinBy: you.joinBy }
    }
    // Reserved and past its time, or already the AI's. A window that was
    // never asked (it connected with the AI already seated) is not told
    // again here: the server panel and the feed say so.
    const asked = you.control === 'reserved' || pushed?.roomId === you.roomId
    return asked ? { kind: 'ai', roomId: you.roomId } : null
  }
  // No seat in the lobby's view yet: the push's own word, while it holds.
  if (pushed && now < pushed.joinBy) return { kind: 'offer', roomId: pushed.roomId, joinBy: pushed.joinBy }
  return null
}

/**
 * Whether the server panel takes a seat back by itself (`resume`) on
 * seeing it. Only a seat the player's own window holds is theirs to take
 * without asking: `reserved` is the prompt's question to ask, and `ai` is not
 * theirs to take any more — they can watch it from the feed.
 */
export function autoResumes(you: LobbyView['you']): boolean {
  return you?.phase === 'playing' && you.control === 'player'
}

const RESULT: Record<EncounterResult, string> = {
  inProgress: 'In progress',
  won: 'Won',
  lost: 'Lost',
  passedBy: 'Passed by',
}

const PASSED_FOR: Record<PassedFor, string> = {
  nobodyFit: 'nobody fit',
  busy: 'you were busy',
}

/** One line of the return feed, in the words it is read in. */
export interface FeedLine {
  when: string
  where: string
  result: string
  /** How the line is coloured: a win, a loss, or neither. */
  tone: 'won' | 'lost' | 'plain'
  /** Who played the player's side; null when there was no fight. */
  played: string | null
  aliens: string
  /** The match to watch back, if there was one. */
  matchId: string | null
}

export function feedLine(entry: EncounterEntry, now: number): FeedLine {
  let result = RESULT[entry.result]
  if (entry.result === 'passedBy' && entry.passedFor) result += `: ${PASSED_FOR[entry.passedFor]}`
  const running = entry.result === 'inProgress'
  let played: string | null = null
  if (entry.playedBy === 'you') played = running ? 'You are playing' : 'You played'
  else if (entry.playedBy === 'ai') played = running ? 'The AI is playing for you' : 'The AI played for you'
  return {
    when: ago(entry.at, now),
    where: placeLabel(entry.place),
    result,
    tone: entry.result === 'won' ? 'won' : entry.result === 'lost' ? 'lost' : 'plain',
    played,
    aliens: entry.aliens === 1 ? '1 alien' : `${entry.aliens} aliens`,
    matchId: entry.matchId,
  }
}

/** How many entries happened after the player last looked (`seenAt`, the server's clock). */
export function unseenCount(entries: readonly EncounterEntry[], seenAt: number): number {
  return entries.filter((entry) => entry.at > seenAt).length
}
